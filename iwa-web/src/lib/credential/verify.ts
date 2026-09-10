// lib/credential/verify.ts — Portable Trust Credential V2: the pure verification
// core. Shared by any UI or backend. No network here — chain access is an
// injected `CredentialChainReader`.
//
// Every path FAILS CLOSED. Three outcomes only:
//   "Verified"          — signature + possession + every on-chain fact check out
//   "Invalid"           — a definite failure (with a reason)
//   "Unable to verify"  — the chain could not be read; NEVER treated as valid
//
// Verifier response carries only validity + claim metadata + subject id. It
// never carries amounts, balances, other members, viewing keys, or history.

import {
  CREDENTIAL_SCHEMA_V2,
  credentialHashV2,
  possessionChallengeHashV2,
  type ClaimType,
} from "./claims";
import {
  stripSignature,
  verifyArtifactSignatureV2,
  type CredentialArtifactV2,
  type PossessionResponse,
} from "./artifact";
import { verifyIwa } from "../../chains/strk20/iwaSigning";

export type VerifyStatus = "Verified" | "Invalid" | "Unable to verify";

export interface VerifyResult {
  status: VerifyStatus;
  reason?: string;
  /** Only on "Verified". Claim metadata only. */
  claim?: { type: ClaimType; thresholdRounds: number };
  subject?: { circleId: number; memberRef: string };
}

export interface CredentialChainReader {
  /** `get_member_auth_key(circle, memberRef)`. Throws on any chain error. */
  getMemberAuthKey(circleId: number, memberRef: string): Promise<bigint>;
  isMember(circleId: number, memberRef: string): Promise<boolean>;
  getCircle(circleId: number): Promise<{
    memberLimit: number;
    currentRound: number;
    status: string;
  }>;
  /** `ContributionStatus` name, or null when the round has no obligation for the member. */
  getContributionStatus(circleId: number, round: number, memberRef: string): Promise<string | null>;
  isFinalSettlementPrepared(circleId: number): Promise<boolean>;
  /** Payout order as 0x-hex member refs. */
  getPayoutOrder(circleId: number): Promise<string[]>;
  /** `PayoutStatusV2` name, or null when the round has no payout state. */
  getPayoutStatusV2(circleId: number, round: number): Promise<string | null>;
}

export interface VerifyDeps {
  artifact: CredentialArtifactV2;
  possession: PossessionResponse;
  chain: CredentialChainReader;
  /** The V2 contract this verifier trusts. Chain evidence is NEVER taken from the artifact alone. */
  expectedCircleV2: string;
  /** e.g. "SN_MAIN". */
  expectedNetwork: string;
  /** This verifier's identifier; must equal the possession challenge's `verifierId`. */
  verifierId: string;
  /** Returns true (and marks used) iff this possession nonce has not been seen. Single-use. */
  claimNonce: (nonce: string) => boolean;
  /** Unix seconds. */
  now: () => number;
}

const QUALIFYING = new Set(["OnTime", "LateWithinGrace"]);
const COMPLETION_OK = new Set(["PrivatelyPaid", "PrivatelyRecovered"]);

function feltEq(a: string | bigint, b: string | bigint): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

const invalid = (reason: string): VerifyResult => ({ status: "Invalid", reason });
const unable = (reason: string): VerifyResult => ({ status: "Unable to verify", reason });

export async function verifyCredentialV2(deps: VerifyDeps): Promise<VerifyResult> {
  const { artifact: a, possession: p, chain } = deps;

  // 0. Version — never reinterpret an unknown schema.
  if (a.schema !== CREDENTIAL_SCHEMA_V2) {
    return invalid(`unsupported schema version ${JSON.stringify(a.schema)}`);
  }

  // 1. Chain-evidence binding — the verifier's pinned contract, not the artifact's word.
  if (!feltEq(a.evidence.iwaCircleV2, deps.expectedCircleV2)) {
    return invalid("artifact circle address does not match the verifier's pinned V2 contract");
  }
  if (a.subject.network !== deps.expectedNetwork) {
    return invalid(`artifact network ${JSON.stringify(a.subject.network)} is not this verifier's network`);
  }

  // 2. Integrity — signature over the canonical hash.
  if (!verifyArtifactSignatureV2(a)) {
    return invalid("artifact signature is invalid");
  }

  // 3. Possession — a fresh, verifier-bound, single-use challenge response.
  let artifactHash: bigint;
  try {
    artifactHash = credentialHashV2(stripSignature(a));
  } catch (e) {
    return invalid(`could not hash the artifact: ${msg(e)}`);
  }
  if (typeof p.challenge.verifierId !== "string" || p.challenge.verifierId !== deps.verifierId) {
    return invalid("possession challenge was not issued by this verifier");
  }
  if (
    typeof p.challenge.expiry !== "number" ||
    !Number.isInteger(p.challenge.expiry) ||
    p.challenge.expiry <= 0
  ) {
    return invalid("possession challenge expiry is malformed");
  }
  if (typeof p.challenge.nonce !== "string" || p.challenge.nonce.length === 0) {
    return invalid("possession challenge nonce is malformed");
  }
  if (deps.now() > p.challenge.expiry) {
    return invalid("possession challenge has expired");
  }
  let possessionOk = false;
  try {
    const h = possessionChallengeHashV2({ artifactHash, challenge: p.challenge });
    possessionOk = verifyIwa(BigInt(a.signature.signerKey), h, BigInt(p.r), BigInt(p.s));
  } catch {
    possessionOk = false;
  }
  if (!possessionOk) {
    return invalid("possession proof is invalid (wrong key, wrong challenge, or not signed)");
  }
  // Consume the nonce LAST, so a bad-signature attempt cannot burn a victim's nonce.
  if (!deps.claimNonce(p.challenge.nonce)) {
    return invalid("possession nonce has already been used (replay)");
  }

  // 4. On-chain re-derivation. Any read failure => "Unable to verify", never valid.
  try {
    const onchainKey = await chain.getMemberAuthKey(a.subject.circleId, a.subject.memberRef);
    if (onchainKey === 0n) {
      return invalid("the circle has no registered key for this member");
    }
    if (!feltEq(onchainKey, a.signature.signerKey)) {
      return invalid("signer key does not match the member's on-chain key");
    }
    if (!(await chain.isMember(a.subject.circleId, a.subject.memberRef))) {
      return invalid("subject is not a member of the circle");
    }

    const claimFailure = await evaluateClaimOnChain(chain, {
      claimType: a.claim.type,
      thresholdRounds: a.claim.params.thresholdRounds,
      circleId: a.subject.circleId,
      memberRef: a.subject.memberRef,
    });
    if (claimFailure) return claimFailure;
  } catch (e) {
    return unable(`could not read circle state: ${msg(e)}`);
  }

  return {
    status: "Verified",
    claim: { type: a.claim.type, thresholdRounds: a.claim.params.thresholdRounds },
    subject: { circleId: a.subject.circleId, memberRef: a.subject.memberRef },
  };
}

/** The claim under test, independent of the artifact/signature envelope. */
export interface ClaimUnderTest {
  claimType: ClaimType;
  thresholdRounds: number;
  circleId: number;
  memberRef: string;
}

/**
 * The single source of truth for "does this claim hold on chain?", shared by
 * the verifier and the generator so a credential can never be issued for a
 * claim the verifier would reject. Returns an `Invalid` result when the claim
 * does NOT hold, or `null` when it does. May throw — a chain read failure is
 * the caller's to classify (verifier → "Unable to verify"; generator → refuse).
 */
export async function evaluateClaimOnChain(
  chain: CredentialChainReader,
  claim: ClaimUnderTest,
): Promise<VerifyResult | null> {
  return claim.claimType === "good_standing"
    ? checkGoodStanding(chain, claim)
    : checkCircleCompletion(chain, claim);
}

async function checkGoodStanding(
  chain: CredentialChainReader,
  claim: ClaimUnderTest,
): Promise<VerifyResult | null> {
  const n = claim.thresholdRounds;
  if (n < 1) return invalid("thresholdRounds must be at least 1 for Good Standing");
  const circle = await chain.getCircle(claim.circleId);
  if (n > circle.memberLimit) {
    return invalid(`thresholdRounds ${n} exceeds the circle size ${circle.memberLimit}`);
  }
  for (let r = 1; r <= n; r++) {
    const st = await chain.getContributionStatus(claim.circleId, r, claim.memberRef);
    if (st === null) return invalid(`round ${r} has no obligation for the member — not a completed round`);
    if (st === "MissedDefault") {
      return invalid(`round ${r} was a missed default — Good Standing does not hold (a later cure does not launder it)`);
    }
    if (st === "Pending") return invalid(`round ${r} is still pending — not a completed round`);
    if (!QUALIFYING.has(st)) return invalid(`round ${r} has an unexpected status "${st}"`);
  }
  return null;
}

async function checkCircleCompletion(
  chain: CredentialChainReader,
  claim: ClaimUnderTest,
): Promise<VerifyResult | null> {
  if (!(await chain.isFinalSettlementPrepared(claim.circleId))) {
    return invalid("the circle has not reached terminal settlement accounting");
  }
  const order = await chain.getPayoutOrder(claim.circleId);
  const idx = order.findIndex((ref) => feltEq(ref, claim.memberRef));
  if (idx < 0) return invalid("subject is not in the circle's payout order");
  const round = idx + 1;
  const st = await chain.getPayoutStatusV2(claim.circleId, round);
  if (st === null) return invalid(`the member's round ${round} has no payout state`);
  if (!COMPLETION_OK.has(st)) {
    return invalid(
      `the member's payout is not a completed private settlement (status: ${st}) — ` +
        "Circle Completion issues only for PrivatelyPaid or PrivatelyRecovered",
    );
  }
  return null;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
}
