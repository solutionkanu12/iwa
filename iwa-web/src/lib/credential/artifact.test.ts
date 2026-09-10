import { describe, expect, it } from "vitest";

import { deriveMemberIdentity, feltHex } from "../../chains/strk20/iwaSigning";
import { credentialHashV2 } from "./claims";
import {
  ArtifactParseError,
  buildCredentialArtifactV2,
  parseArtifactV2,
  serializeArtifactV2,
  signPossessionV2,
  stripSignature,
  verifyArtifactSignatureV2,
} from "./artifact";

const IDENTITY = deriveMemberIdentity("m", 0xabc1n, 0xdef1n);
const CIRCLE_V2 = "0x07744b6a83f5f7b24ece1e42d9d4116077ee04f3899bfe4e48e93c0a0bb0015a";

function gsArtifact() {
  return buildCredentialArtifactV2({
    identity: IDENTITY,
    claimType: "good_standing",
    thresholdRounds: 3,
    network: "SN_MAIN",
    circleId: 7,
    iwaCircleV2: CIRCLE_V2,
    issuedAtBlock: 900000,
    issuedAt: 1_900_000_000,
  });
}

describe("buildCredentialArtifactV2", () => {
  it("binds the member_ref and signer key to the identity, and self-checks the signature", () => {
    const a = gsArtifact();
    expect(a.schema).toBe("iwa-credential/2");
    expect(a.subject.memberRef).toBe(feltHex(IDENTITY.memberRef));
    expect(a.signature.signerKey).toBe(feltHex(IDENTITY.authPublicKeyX));
    expect(verifyArtifactSignatureV2(a)).toBe(true);
  });

  it("normalises circle_completion to thresholdRounds 0", () => {
    const a = buildCredentialArtifactV2({
      identity: IDENTITY,
      claimType: "circle_completion",
      thresholdRounds: 9,
      network: "SN_MAIN",
      circleId: 1,
      iwaCircleV2: CIRCLE_V2,
      issuedAtBlock: 1,
      issuedAt: 1,
    });
    expect(a.claim).toEqual({ type: "circle_completion", params: { thresholdRounds: 0 } });
    expect(verifyArtifactSignatureV2(a)).toBe(true);
  });

  it("the artifact contains NO amounts / balances / other members / viewing keys / history", () => {
    const json = serializeArtifactV2(gsArtifact());
    for (const forbidden of [
      "amount",
      "balance",
      "contribution",
      "payout",
      "viewing",
      "seed",
      "privateKey",
      "history",
      "members",
      "graph",
    ]) {
      expect(json.toLowerCase().includes(forbidden.toLowerCase()), forbidden).toBe(false);
    }
    // only these top-level keys
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(
      ["claim", "evidence", "schema", "signature", "subject"].sort(),
    );
  });
});

describe("verifyArtifactSignatureV2 — tamper sensitivity", () => {
  it("fails when any signed field is changed after signing", () => {
    const a = gsArtifact();
    const mutations: ((c: typeof a) => void)[] = [
      (c) => (c.claim.params.thresholdRounds = 4),
      (c) => (c.claim.type = "circle_completion"),
      (c) => (c.subject.circleId = 8),
      (c) => (c.subject.memberRef = "0x1"),
      (c) => (c.evidence.iwaCircleV2 = "0x1"),
      (c) => (c.subject.network = "SN_SEPOLIA"),
      (c) => (c.evidence.issuedAtBlock = 900001),
    ];
    for (const m of mutations) {
      const clone = structuredClone(a);
      m(clone);
      expect(verifyArtifactSignatureV2(clone)).toBe(false);
    }
  });

  it("fails when the signerKey is swapped to an attacker key", () => {
    const a = gsArtifact();
    const attacker = deriveMemberIdentity("evil", 0x1n, 0x2n);
    a.signature.signerKey = feltHex(attacker.authPublicKeyX);
    expect(verifyArtifactSignatureV2(a)).toBe(false);
  });
});

describe("parseArtifactV2 — strict", () => {
  it("round-trips a valid artifact", () => {
    const a = gsArtifact();
    const p = parseArtifactV2(serializeArtifactV2(a));
    expect(p).toEqual(a);
    expect(credentialHashV2(stripSignature(p))).toBe(credentialHashV2(stripSignature(a)));
  });

  it("rejects an unknown / older schema version — never reinterpreted", () => {
    const a = JSON.parse(serializeArtifactV2(gsArtifact()));
    a.schema = "iwa-credential/1";
    expect(() => parseArtifactV2(JSON.stringify(a))).toThrow(ArtifactParseError);
    a.schema = "iwa-credential/3";
    expect(() => parseArtifactV2(JSON.stringify(a))).toThrow(/unsupported schema/);
  });

  it("rejects malformed JSON, non-objects, and oversized input", () => {
    expect(() => parseArtifactV2("{not json")).toThrow(/valid JSON/);
    expect(() => parseArtifactV2("[]")).toThrow(/object/);
    expect(() => parseArtifactV2('"x"')).toThrow(/object/);
    expect(() => parseArtifactV2("{}".padEnd(5000, " "))).toThrow(/exceeds/);
  });

  it("rejects wrong-typed / missing / truncated fields", () => {
    const good = JSON.parse(serializeArtifactV2(gsArtifact()));
    const bad = (mut: (o: Record<string, unknown>) => void) => {
      const o = structuredClone(good);
      mut(o);
      return () => parseArtifactV2(JSON.stringify(o));
    };
    expect(bad((o) => delete o.signature)).toThrow(ArtifactParseError);
    expect(bad((o) => ((o.subject as Record<string, unknown>).circleId = "7"))).toThrow(/circleId/);
    expect(bad((o) => ((o.subject as Record<string, unknown>).circleId = -1))).toThrow();
    expect(bad((o) => ((o.subject as Record<string, unknown>).memberRef = "not-hex"))).toThrow(/memberRef/);
    expect(bad((o) => ((o.claim as Record<string, unknown>).type = "credit_score"))).toThrow(/claim\.type/);
    expect(
      bad((o) => {
        (o.claim as Record<string, unknown>).type = "circle_completion";
        ((o.claim as Record<string, unknown>).params as Record<string, unknown>).thresholdRounds = 5;
      }),
    ).toThrow(/circle_completion/);
    expect(bad((o) => ((o.signature as Record<string, unknown>).r = "0xZZ"))).toThrow(/signature\.r/);
    expect(bad((o) => ((o.evidence as Record<string, unknown>).issuedAtBlock = 1.5))).toThrow();
  });
});

describe("signPossessionV2", () => {
  it("signs the possession challenge with the same key and is bound to the artifact", () => {
    const a = gsArtifact();
    const challenge = { nonce: "0x99", expiry: 1_900_000_300, verifierId: "verifier-x" };
    const resp = signPossessionV2(IDENTITY, a, challenge);
    expect(resp.challenge).toEqual(challenge);
    expect(typeof resp.r).toBe("string");
    expect(typeof resp.s).toBe("string");
  });
});
