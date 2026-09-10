// lib/credential/testkit.ts — shared fixtures for the credential test suites.
// Not a `.test.ts` file, so vitest does not run it directly; the describe
// blocks live in verify.test.ts / credentialSecurity.test.ts / generate.test.ts.

import { deriveMemberIdentity, feltHex } from "../../chains/strk20/iwaSigning";
import {
  buildCredentialArtifactV2,
  signPossessionV2,
  type CredentialArtifactV2,
} from "./artifact";
import {
  verifyCredentialV2,
  type CredentialChainReader,
  type VerifyDeps,
} from "./verify";

export const MEMBER = deriveMemberIdentity("member", 0xa11ce5eedn, 0xbeefn);
export const CIRCLE_V2 = "0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a";
export const VERIFIER_ID = "iwa-credential-verifier";
export const NOW = 1_900_000_000;

/** A configurable in-memory model of the V2 circle for the verifier to read. */
export interface ChainModel {
  memberAuthKey?: bigint; // default: MEMBER's key
  isMember?: boolean; // default true
  memberLimit?: number; // default 5
  currentRound?: number; // default 6
  circleStatus?: string; // default "SettlementPending"
  /** round -> ContributionStatus name (or absent -> null) */
  contributionStatus?: Record<number, string>;
  finalSettlementPrepared?: boolean; // default false
  payoutOrder?: string[]; // default [MEMBER, other x4]
  /** round -> PayoutStatusV2 name (or absent -> null) */
  payoutStatus?: Record<number, string>;
  /** make a specific read throw (chain unavailable) */
  throwOn?: keyof CredentialChainReader;
}

const OTHER = (i: number) => `0x${(0xdead0000 + i).toString(16)}`;

export function makeChain(m: ChainModel = {}): CredentialChainReader {
  const guard = (name: keyof CredentialChainReader) => {
    if (m.throwOn === name) throw new Error(`RPC down for ${name}`);
  };
  return {
    async getMemberAuthKey() {
      guard("getMemberAuthKey");
      return m.memberAuthKey ?? MEMBER.authPublicKeyX;
    },
    async isMember() {
      guard("isMember");
      return m.isMember ?? true;
    },
    async getCircle() {
      guard("getCircle");
      return {
        memberLimit: m.memberLimit ?? 5,
        currentRound: m.currentRound ?? 6,
        status: m.circleStatus ?? "SettlementPending",
      };
    },
    async getContributionStatus(_c, round) {
      guard("getContributionStatus");
      return m.contributionStatus?.[round] ?? null;
    },
    async isFinalSettlementPrepared() {
      guard("isFinalSettlementPrepared");
      return m.finalSettlementPrepared ?? false;
    },
    async getPayoutOrder() {
      guard("getPayoutOrder");
      return m.payoutOrder ?? [feltHex(MEMBER.memberRef), OTHER(1), OTHER(2), OTHER(3), OTHER(4)];
    },
    async getPayoutStatusV2(_c, round) {
      guard("getPayoutStatusV2");
      return m.payoutStatus?.[round] ?? null;
    },
  };
}

export function goodStandingArtifact(n = 3): CredentialArtifactV2 {
  return buildCredentialArtifactV2({
    identity: MEMBER,
    claimType: "good_standing",
    thresholdRounds: n,
    network: "SN_MAIN",
    circleId: 7,
    iwaCircleV2: CIRCLE_V2,
    issuedAtBlock: 900000,
    issuedAt: NOW - 100,
  });
}

export function circleCompletionArtifact(): CredentialArtifactV2 {
  return buildCredentialArtifactV2({
    identity: MEMBER,
    claimType: "circle_completion",
    network: "SN_MAIN",
    circleId: 7,
    iwaCircleV2: CIRCLE_V2,
    issuedAtBlock: 900000,
    issuedAt: NOW - 100,
  });
}

export interface HarnessOpts {
  artifact?: CredentialArtifactV2;
  chain?: ChainModel;
  possessionSigner?: ReturnType<typeof deriveMemberIdentity>;
  challenge?: { nonce?: string; expiry?: number; verifierId?: string };
  now?: number;
  usedNonces?: Set<string>;
  expectedCircleV2?: string;
  expectedNetwork?: string;
  verifierId?: string;
}

/** Full verify round-trip: fresh challenge, holder signs it, verifier checks everything. */
export async function runVerify(opts: HarnessOpts = {}) {
  const artifact = opts.artifact ?? goodStandingArtifact();
  const used = opts.usedNonces ?? new Set<string>();
  const challenge = {
    nonce: opts.challenge?.nonce ?? "0x" + (0x1000 + used.size).toString(16),
    expiry: opts.challenge?.expiry ?? (opts.now ?? NOW) + 300,
    verifierId: opts.challenge?.verifierId ?? opts.verifierId ?? VERIFIER_ID,
  };
  const signer = opts.possessionSigner ?? MEMBER;
  const possession = signPossessionV2(signer, artifact, challenge);

  const deps: VerifyDeps = {
    artifact,
    possession,
    chain: makeChain(opts.chain),
    expectedCircleV2: opts.expectedCircleV2 ?? CIRCLE_V2,
    expectedNetwork: opts.expectedNetwork ?? "SN_MAIN",
    verifierId: opts.verifierId ?? VERIFIER_ID,
    claimNonce: (n) => (used.has(n) ? false : (used.add(n), true)),
    now: () => opts.now ?? NOW,
  };
  return { result: await verifyCredentialV2(deps), possession, challenge, used };
}
