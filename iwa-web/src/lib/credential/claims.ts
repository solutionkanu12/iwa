// lib/credential/claims.ts — Portable Trust Credential V2: claim types, the
// canonical signed payload, and its Poseidon hash.
//
// Design: docs/superpowers/specs/2026-09-04-portable-trust-credential-v2-design.md
// (§5 claims, §6.3 canonical hashing, §7 possession).
//
// The artifact is an OFF-CHAIN presentation of facts that are already public on
// the V2 circle contract, plus a signature by the member's IWA auth key. There
// is NO on-chain credential registry and NO new contract. The verifier
// re-derives every fact from chain; the artifact asserts nothing it cannot
// prove.
//
// PRIVACY: the payload carries the claim type, the threshold N, the circle id,
// the circle-scoped member_ref, timestamps, and the signer public key (all
// already public on chain). It carries NO amounts, NO balances, NO other
// members, NO viewing keys, and NO round-by-round history.

import { iwaHash, shortStringToFelt, type FeltIn } from "../../chains/strk20/iwaSigning";

/** The only schema this module builds or verifies. */
export const CREDENTIAL_SCHEMA_V2 = "iwa-credential/2" as const;

/** Cairo short-string domain tags. Distinct tags keep version + domain separation. */
export const CREDENTIAL_V2_DOMAIN_TAG = "IWA_CREDENTIAL_V2";
export const POSSESSION_V2_DOMAIN_TAG = "IWA_CRED_POSSESS_V2";

export const CLAIM_TYPES = ["good_standing", "circle_completion"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export function isClaimType(v: unknown): v is ClaimType {
  return typeof v === "string" && (CLAIM_TYPES as readonly string[]).includes(v);
}

export interface CredentialClaim {
  type: ClaimType;
  /**
   * Good Standing: the number of qualifying rounds asserted (1..member_limit).
   * Circle Completion: not used — normalised to 0 and bound as 0 so the type
   * alone determines the check.
   */
  params: { thresholdRounds: number };
}

export interface CredentialSubject {
  /** Short string, e.g. "SN_MAIN". Bound into the hash and re-checked by the verifier's config. */
  network: string;
  circleId: number;
  /** The circle-scoped member reference (a Poseidon commitment, not a wallet). 0x-hex felt. */
  memberRef: string;
}

export interface CredentialEvidence {
  /** The IwaCircleV2 contract address the facts were read from. 0x-hex felt. */
  iwaCircleV2: string;
  /** Block number at generation time. */
  issuedAtBlock: number;
  /** Unix seconds at generation time. */
  issuedAt: number;
}

/** The exact object that is hashed and signed. No `signature` field. */
export interface CanonicalCredentialPayloadV2 {
  schema: typeof CREDENTIAL_SCHEMA_V2;
  claim: CredentialClaim;
  subject: CredentialSubject;
  evidence: CredentialEvidence;
}

const u = (n: number, what: string): number => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer`);
  return n;
};

/** Normalises `thresholdRounds` per the claim type (0 for circle_completion). */
export function normalizeClaim(claim: CredentialClaim): CredentialClaim {
  if (claim.type === "circle_completion") {
    return { type: "circle_completion", params: { thresholdRounds: 0 } };
  }
  return {
    type: "good_standing",
    params: { thresholdRounds: u(claim.params.thresholdRounds, "thresholdRounds") },
  };
}

/**
 * `iwa_credential_v2_hash` — Poseidon over the canonical payload, in this exact
 * felt order (design §6.3):
 *
 *   [ IWA_CREDENTIAL_V2 , schema , claimType , thresholdRounds , network ,
 *     circleId , memberRef , iwaCircleV2 , issuedAtBlock , issuedAt ]
 */
export function credentialHashV2(payload: CanonicalCredentialPayloadV2): bigint {
  if (payload.schema !== CREDENTIAL_SCHEMA_V2) {
    throw new Error(`credentialHashV2: wrong schema ${String(payload.schema)}`);
  }
  const claim = normalizeClaim(payload.claim);
  return iwaHash(
    CREDENTIAL_V2_DOMAIN_TAG,
    shortStringToFelt(CREDENTIAL_SCHEMA_V2),
    shortStringToFelt(claim.type),
    u(claim.params.thresholdRounds, "thresholdRounds"),
    shortStringToFelt(payload.subject.network),
    u(payload.subject.circleId, "circleId"),
    payload.subject.memberRef as FeltIn,
    payload.evidence.iwaCircleV2 as FeltIn,
    u(payload.evidence.issuedAtBlock, "issuedAtBlock"),
    u(payload.evidence.issuedAt, "issuedAt"),
  );
}

export interface PossessionChallenge {
  /** Fresh single-use felt from the verifier. 0x-hex or decimal. */
  nonce: string;
  /** Unix seconds; the holder's possession signature is invalid after this. */
  expiry: number;
  /** Identifies the verifier so a possession proof cannot be replayed elsewhere. */
  verifierId: string;
}

/** Poseidon digest of an arbitrary-length UTF-8 string (31-byte chunks). */
export function stringToFeltDigest(s: string): bigint {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length === 0) return 0n;
  const felts: bigint[] = [];
  for (let i = 0; i < bytes.length; i += 31) {
    let acc = 0n;
    for (const b of bytes.slice(i, i + 31)) acc = (acc << 8n) | BigInt(b);
    felts.push(acc);
  }
  return felts.length === 1 ? felts[0] : iwaHash(...(felts as FeltIn[]));
}

/**
 * `iwa_credential_possession_v2_hash` — what the holder signs to prove they
 * still control the key. Binds the schema VERSION, the exact credential hash,
 * the VERIFIER, a fresh NONCE, and an EXPIRY (design §7), so a possession proof
 * cannot replay across versions, artifacts, or verifiers.
 *
 *   [ IWA_CRED_POSSESS_V2 , schema , artifactHash , verifierIdDigest , nonce , expiry ]
 */
export function possessionChallengeHashV2(args: {
  artifactHash: bigint;
  challenge: PossessionChallenge;
}): bigint {
  return iwaHash(
    POSSESSION_V2_DOMAIN_TAG,
    shortStringToFelt(CREDENTIAL_SCHEMA_V2),
    args.artifactHash,
    stringToFeltDigest(args.challenge.verifierId),
    args.challenge.nonce as FeltIn,
    u(args.challenge.expiry, "expiry"),
  );
}
