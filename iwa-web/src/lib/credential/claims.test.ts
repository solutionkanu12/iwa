import { ec } from "starknet";
import { describe, expect, it } from "vitest";

import { shortStringToFelt } from "../../chains/strk20/iwaSigning";
import {
  CREDENTIAL_SCHEMA_V2,
  CREDENTIAL_V2_DOMAIN_TAG,
  POSSESSION_V2_DOMAIN_TAG,
  credentialHashV2,
  isClaimType,
  normalizeClaim,
  possessionChallengeHashV2,
  stringToFeltDigest,
  type CanonicalCredentialPayloadV2,
} from "./claims";

const BASE: CanonicalCredentialPayloadV2 = {
  schema: CREDENTIAL_SCHEMA_V2,
  claim: { type: "good_standing", params: { thresholdRounds: 3 } },
  subject: {
    network: "SN_MAIN",
    circleId: 7,
    memberRef: "0x301473563c9095055be74afaa57bdc8fc13165de2997a759154f30305f23424",
  },
  evidence: {
    iwaCircleV2: "0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a",
    issuedAtBlock: 900000,
    issuedAt: 1_900_000_000,
  },
};

describe("claim types", () => {
  it("only the two approved claim types are recognised", () => {
    expect(isClaimType("good_standing")).toBe(true);
    expect(isClaimType("circle_completion")).toBe(true);
    expect(isClaimType("credit_score")).toBe(false);
    expect(isClaimType("")).toBe(false);
    expect(isClaimType(3)).toBe(false);
  });

  it("normalizeClaim forces thresholdRounds to 0 for circle_completion", () => {
    expect(normalizeClaim({ type: "circle_completion", params: { thresholdRounds: 9 } })).toEqual({
      type: "circle_completion",
      params: { thresholdRounds: 0 },
    });
  });

  it("normalizeClaim keeps thresholdRounds for good_standing and rejects a bad N", () => {
    expect(normalizeClaim({ type: "good_standing", params: { thresholdRounds: 2 } })).toEqual({
      type: "good_standing",
      params: { thresholdRounds: 2 },
    });
    expect(() =>
      normalizeClaim({ type: "good_standing", params: { thresholdRounds: -1 } }),
    ).toThrow(/thresholdRounds/);
    expect(() =>
      normalizeClaim({ type: "good_standing", params: { thresholdRounds: 1.5 } }),
    ).toThrow();
  });
});

describe("credentialHashV2", () => {
  it("is a single Poseidon over the canonical felt list", () => {
    const felts = [
      shortStringToFelt(CREDENTIAL_V2_DOMAIN_TAG),
      shortStringToFelt(CREDENTIAL_SCHEMA_V2),
      shortStringToFelt("good_standing"),
      3n,
      shortStringToFelt("SN_MAIN"),
      7n,
      BigInt(BASE.subject.memberRef),
      BigInt(BASE.evidence.iwaCircleV2),
      900000n,
      1_900_000_000n,
    ];
    expect(credentialHashV2(BASE)).toBe(ec.starkCurve.poseidonHashMany(felts));
  });

  it("changes when ANY bound field changes (tamper sensitivity)", () => {
    const base = credentialHashV2(BASE);
    const mutations: CanonicalCredentialPayloadV2[] = [
      { ...BASE, claim: { type: "circle_completion", params: { thresholdRounds: 0 } } },
      { ...BASE, claim: { type: "good_standing", params: { thresholdRounds: 4 } } },
      { ...BASE, subject: { ...BASE.subject, circleId: 8 } },
      { ...BASE, subject: { ...BASE.subject, memberRef: "0x1" } },
      { ...BASE, subject: { ...BASE.subject, network: "SN_SEPOLIA" } },
      { ...BASE, evidence: { ...BASE.evidence, iwaCircleV2: "0x1" } },
      { ...BASE, evidence: { ...BASE.evidence, issuedAtBlock: 900001 } },
      { ...BASE, evidence: { ...BASE.evidence, issuedAt: 1_900_000_001 } },
    ];
    for (const m of mutations) {
      expect(credentialHashV2(m), JSON.stringify(m.claim)).not.toBe(base);
    }
  });

  it("good_standing N and circle_completion (N=0) produce different hashes for the same subject", () => {
    const gs = credentialHashV2({ ...BASE, claim: { type: "good_standing", params: { thresholdRounds: 0 } } });
    const cc = credentialHashV2({ ...BASE, claim: { type: "circle_completion", params: { thresholdRounds: 0 } } });
    expect(gs).not.toBe(cc); // the claim-type felt differs
  });

  it("rejects a wrong schema", () => {
    expect(() =>
      credentialHashV2({ ...BASE, schema: "iwa-credential/1" as never }),
    ).toThrow(/schema/);
  });
});

describe("possessionChallengeHashV2", () => {
  const artifactHash = 0xabc123n;

  it("binds schema, artifact hash, verifier, nonce and expiry", () => {
    const h = possessionChallengeHashV2({
      artifactHash,
      challenge: { nonce: "0x55", expiry: 1_900_000_300, verifierId: "iwa-verify.example" },
    });
    const expected = ec.starkCurve.poseidonHashMany([
      shortStringToFelt(POSSESSION_V2_DOMAIN_TAG),
      shortStringToFelt(CREDENTIAL_SCHEMA_V2),
      artifactHash,
      stringToFeltDigest("iwa-verify.example"),
      0x55n,
      1_900_000_300n,
    ]);
    expect(h).toBe(expected);
  });

  it("differs for a different artifact / verifier / nonce / expiry", () => {
    const base = possessionChallengeHashV2({
      artifactHash,
      challenge: { nonce: "0x1", expiry: 100, verifierId: "v1" },
    });
    expect(
      possessionChallengeHashV2({ artifactHash: artifactHash + 1n, challenge: { nonce: "0x1", expiry: 100, verifierId: "v1" } }),
    ).not.toBe(base);
    expect(
      possessionChallengeHashV2({ artifactHash, challenge: { nonce: "0x2", expiry: 100, verifierId: "v1" } }),
    ).not.toBe(base);
    expect(
      possessionChallengeHashV2({ artifactHash, challenge: { nonce: "0x1", expiry: 101, verifierId: "v1" } }),
    ).not.toBe(base);
    expect(
      possessionChallengeHashV2({ artifactHash, challenge: { nonce: "0x1", expiry: 100, verifierId: "v2" } }),
    ).not.toBe(base);
  });

  it("stringToFeltDigest handles long verifier ids (> 31 bytes) and is deterministic", () => {
    const long = "https://a-very-long-verifier-origin.example.com/credential/verify";
    const d1 = stringToFeltDigest(long);
    const d2 = stringToFeltDigest(long);
    expect(d1).toBe(d2);
    expect(d1).not.toBe(stringToFeltDigest(long + "x"));
    expect(stringToFeltDigest("")).toBe(0n);
  });
});
