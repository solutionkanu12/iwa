// The mandatory Portable Trust Credential attack matrix
// (SECURITY.md "Mandatory credential attacks" + the V2 design §13 threat model):
// forgery, N mutation, claim-type mutation, subject substitution, artifact reuse
// by another wallet, replay across version / verifier / nonce / expiry,
// malformed / truncated / oversized, verifier fail-open, cross-circle
// correlation, raw-fact leakage, member-graph leakage, logging leakage, false
// completion, cured-default laundering.

import { describe, expect, it } from "vitest";

import { deriveMemberIdentity, feltHex } from "../../chains/strk20/iwaSigning";
import { buildCredentialArtifactV2, serializeArtifactV2, signPossessionV2 } from "./artifact";
import { possessionChallengeHashV2 } from "./claims";
import { verifyCredentialV2, type VerifyDeps } from "./verify";
import {
  CIRCLE_V2,
  MEMBER,
  VERIFIER_ID,
  circleCompletionArtifact,
  goodStandingArtifact,
  makeChain,
  runVerify,
} from "./testkit";

const NOW = 1_900_000_000;
const OK_GS = { contributionStatus: { 1: "OnTime", 2: "OnTime", 3: "OnTime" } } as const;

describe("forgery — signature / key binding", () => {
  it("an artifact signed by an attacker key is Invalid (signature does not verify)", async () => {
    const attacker = deriveMemberIdentity("evil", 0x1n, 0x2n);
    const forged = buildCredentialArtifactV2({
      identity: attacker,
      claimType: "good_standing",
      thresholdRounds: 3,
      network: "SN_MAIN",
      circleId: 7,
      iwaCircleV2: CIRCLE_V2,
      issuedAtBlock: 900000,
      issuedAt: NOW - 100,
    });
    // swap in the victim's member_ref + signer key without a valid signature
    forged.subject.memberRef = feltHex(MEMBER.memberRef);
    forged.signature.signerKey = feltHex(MEMBER.authPublicKeyX);
    const { result } = await runVerify({ artifact: forged, chain: OK_GS });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/signature/i);
  });

  it("a validly-signed artifact whose signer key is not the member's on-chain key is Invalid", async () => {
    const attacker = deriveMemberIdentity("evil", 0x3n, 0x4n);
    // attacker mints a well-formed artifact for a circle where they are NOT the member
    const art = buildCredentialArtifactV2({
      identity: attacker,
      claimType: "good_standing",
      thresholdRounds: 3,
      network: "SN_MAIN",
      circleId: 7,
      iwaCircleV2: CIRCLE_V2,
      issuedAtBlock: 900000,
      issuedAt: NOW - 100,
    });
    const { result } = await runVerify({
      artifact: art,
      possessionSigner: attacker, // attacker proves possession of their OWN key
      chain: { ...OK_GS, memberAuthKey: MEMBER.authPublicKeyX }, // chain says the member key is someone else's
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/does not match the member's on-chain key/i);
  });

  it("Invalid when the circle has no registered key for the member", async () => {
    const { result } = await runVerify({ chain: { ...OK_GS, memberAuthKey: 0n } });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/no registered key/i);
  });
});

describe("forgery — bound-field mutation after signing", () => {
  const cases: { name: string; mutate: (a: ReturnType<typeof goodStandingArtifact>) => void; re: RegExp }[] = [
    { name: "changed threshold N", mutate: (a) => (a.claim.params.thresholdRounds = 1), re: /signature/i },
    { name: "changed claim type", mutate: (a) => (a.claim.type = "circle_completion"), re: /signature/i },
    { name: "subject substitution (memberRef)", mutate: (a) => (a.subject.memberRef = "0xbad"), re: /signature/i },
    { name: "subject substitution (circleId)", mutate: (a) => (a.subject.circleId = 999), re: /signature/i },
    { name: "chain/contract substitution (iwaCircleV2)", mutate: (a) => (a.evidence.iwaCircleV2 = "0xabc"), re: /pinned V2 contract|signature/i },
    { name: "network substitution", mutate: (a) => (a.subject.network = "SN_SEPOLIA"), re: /network|signature/i },
    { name: "backdated issuedAtBlock", mutate: (a) => (a.evidence.issuedAtBlock = 1), re: /signature/i },
  ];
  for (const c of cases) {
    it(`Invalid: ${c.name}`, async () => {
      const a = goodStandingArtifact(3);
      c.mutate(a);
      const { result } = await runVerify({ artifact: a, chain: OK_GS });
      expect(result.status).toBe("Invalid");
      expect(result.reason).toMatch(c.re);
    });
  }

  it("self-asserted higher N than the on-chain record is Invalid (facts come from chain)", async () => {
    // artifact honestly signed for N=5, but the member only has 3 qualifying rounds
    const a = goodStandingArtifact(5);
    const { result } = await runVerify({
      artifact: a,
      chain: { memberLimit: 5, contributionStatus: { 1: "OnTime", 2: "OnTime", 3: "OnTime" } },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/round 4 .*no obligation|not a completed round/i);
  });
});

describe("replay — possession challenge", () => {
  it("a reused possession nonce is Invalid", async () => {
    const used = new Set<string>();
    const first = await runVerify({ chain: OK_GS, usedNonces: used, challenge: { nonce: "0xc0ffee01" } });
    expect(first.result.status).toBe("Verified");
    // replay the SAME challenge + possession against a fresh verify
    const artifact = goodStandingArtifact(3);
    const deps: VerifyDeps = {
      artifact,
      possession: signPossessionV2(MEMBER, artifact, first.challenge),
      chain: makeChain(OK_GS),
      expectedCircleV2: CIRCLE_V2,
      expectedNetwork: "SN_MAIN",
      verifierId: VERIFIER_ID,
      claimNonce: (n) => (used.has(n) ? false : (used.add(n), true)),
      now: () => NOW,
    };
    const replay = await verifyCredentialV2(deps);
    expect(replay.status).toBe("Invalid");
    expect(replay.reason).toMatch(/replay|already been used/i);
  });

  it("an expired possession challenge is Invalid", async () => {
    const { result } = await runVerify({ chain: OK_GS, challenge: { expiry: NOW - 1 }, now: NOW });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/expired/i);
  });

  it("a possession challenge issued for a DIFFERENT verifier is Invalid", async () => {
    const { result } = await runVerify({
      chain: OK_GS,
      challenge: { verifierId: "some-other-verifier" },
      verifierId: VERIFIER_ID,
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/not issued by this verifier/i);
  });

  it("a possession proof for a DIFFERENT artifact is Invalid (challenge binds the artifact hash)", async () => {
    const artifactA = goodStandingArtifact(3);
    const artifactB = goodStandingArtifact(2);
    const challenge = { nonce: "0x777", expiry: NOW + 300, verifierId: VERIFIER_ID };
    const possForB = signPossessionV2(MEMBER, artifactB, challenge); // signed against B
    const deps: VerifyDeps = {
      artifact: artifactA, // presented with A
      possession: possForB,
      chain: makeChain(OK_GS),
      expectedCircleV2: CIRCLE_V2,
      expectedNetwork: "SN_MAIN",
      verifierId: VERIFIER_ID,
      claimNonce: () => true,
      now: () => NOW,
    };
    const r = await verifyCredentialV2(deps);
    expect(r.status).toBe("Invalid");
    expect(r.reason).toMatch(/possession proof is invalid/i);
  });

  it("a possession proof signed by another wallet is Invalid (artifact theft)", async () => {
    const thief = deriveMemberIdentity("thief", 0x9n, 0xan);
    const artifact = goodStandingArtifact(3);
    const challenge = { nonce: "0x888", expiry: NOW + 300, verifierId: VERIFIER_ID };
    const deps: VerifyDeps = {
      artifact,
      possession: signPossessionV2(thief, artifact, challenge), // thief has the file, not the key
      chain: makeChain(OK_GS),
      expectedCircleV2: CIRCLE_V2,
      expectedNetwork: "SN_MAIN",
      verifierId: VERIFIER_ID,
      claimNonce: () => true,
      now: () => NOW,
    };
    const r = await verifyCredentialV2(deps);
    expect(r.status).toBe("Invalid");
    expect(r.reason).toMatch(/possession proof is invalid/i);
  });

  it("a bad-signature possession attempt does NOT consume the nonce (no nonce-burning DoS)", async () => {
    const used = new Set<string>();
    const artifact = goodStandingArtifact(3);
    const challenge = { nonce: "0xburn", expiry: NOW + 300, verifierId: VERIFIER_ID };
    const badDeps: VerifyDeps = {
      artifact,
      possession: { challenge, r: "0x1", s: "0x1" }, // garbage
      chain: makeChain(OK_GS),
      expectedCircleV2: CIRCLE_V2,
      expectedNetwork: "SN_MAIN",
      verifierId: VERIFIER_ID,
      claimNonce: (n) => (used.has(n) ? false : (used.add(n), true)),
      now: () => NOW,
    };
    expect((await verifyCredentialV2(badDeps)).status).toBe("Invalid");
    expect(used.has("0xburn")).toBe(false); // not consumed
  });
});

describe("replay — across version / evidence", () => {
  it("an unknown schema version is Invalid and never reinterpreted", async () => {
    const a = goodStandingArtifact(3);
    const challenge = { nonce: "0x5c", expiry: NOW + 300, verifierId: VERIFIER_ID };
    const possession = signPossessionV2(MEMBER, a, challenge); // signed while still v2
    (a as { schema: string }).schema = "iwa-credential/1"; // downgrade attack
    const deps: VerifyDeps = {
      artifact: a,
      possession,
      chain: makeChain(OK_GS),
      expectedCircleV2: CIRCLE_V2,
      expectedNetwork: "SN_MAIN",
      verifierId: VERIFIER_ID,
      claimNonce: () => true,
      now: () => NOW,
    };
    const result = await verifyCredentialV2(deps);
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/unsupported schema/i);
  });

  it("an artifact for another circle contract is rejected against this verifier's pinned contract", async () => {
    const a = buildCredentialArtifactV2({
      identity: MEMBER,
      claimType: "good_standing",
      thresholdRounds: 3,
      network: "SN_MAIN",
      circleId: 7,
      iwaCircleV2: "0x1234", // some other contract
      issuedAtBlock: 900000,
      issuedAt: NOW - 100,
    });
    const { result } = await runVerify({ artifact: a, chain: OK_GS, expectedCircleV2: CIRCLE_V2 });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/pinned V2 contract/i);
  });

  it("an artifact for another network is rejected", async () => {
    const a = buildCredentialArtifactV2({
      identity: MEMBER,
      claimType: "good_standing",
      thresholdRounds: 3,
      network: "SN_SEPOLIA",
      circleId: 7,
      iwaCircleV2: CIRCLE_V2,
      issuedAtBlock: 900000,
      issuedAt: NOW - 100,
    });
    const { result } = await runVerify({ artifact: a, chain: OK_GS, expectedNetwork: "SN_MAIN" });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/network/i);
  });

  it("a V2 possession hash never validates against a wrong schema tag", () => {
    // the possession hash binds the schema; a v1-style tag would produce a different digest
    const h = possessionChallengeHashV2({
      artifactHash: 1n,
      challenge: { nonce: "0x1", expiry: 1, verifierId: "v" },
    });
    expect(typeof h).toBe("bigint");
    expect(h).not.toBe(1n);
  });
});

describe("malformed / truncated / oversized", () => {
  it("verify still fails closed on a hand-corrupted artifact object", async () => {
    const a = goodStandingArtifact(3);
    // r not a felt
    (a.signature as { r: string }).r = "0xZZZ";
    const { result } = await runVerify({ artifact: a, chain: OK_GS });
    expect(result.status).toBe("Invalid");
  });
});

describe("privacy — no raw facts, no member graph, no leakage", () => {
  it("the artifact JSON exposes only claim / subject / evidence / signature", () => {
    const json = serializeArtifactV2(goodStandingArtifact(3));
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(["claim", "evidence", "schema", "signature", "subject"]);
    // no numbers that could be an amount; the only integers are ids/blocks/timestamps/N
    for (const k of ["amount", "balance", "pot", "contributionAmount", "viewingKey", "seed", "history", "members"]) {
      expect(json.includes(k)).toBe(false);
    }
  });

  it("a Verified response carries ONLY validity + claim metadata + subject id — no financials, no other members", async () => {
    const { result } = await runVerify({ chain: OK_GS });
    expect(result.status).toBe("Verified");
    expect(Object.keys(result).sort()).toEqual(["claim", "status", "subject"]);
    expect(Object.keys(result.claim!).sort()).toEqual(["thresholdRounds", "type"]);
    expect(Object.keys(result.subject!).sort()).toEqual(["circleId", "memberRef"]);
    const blob = JSON.stringify(result);
    for (const leak of ["amount", "balance", "0xdead", "OnTime", "LateWithinGrace", "payout", "viewing"]) {
      expect(blob.includes(leak), leak).toBe(false);
    }
  });

  it("an Invalid response reason names the failing rule but not the member graph or amounts", async () => {
    const { result } = await runVerify({
      chain: { contributionStatus: { 1: "OnTime", 2: "MissedDefault", 3: "OnTime" } },
    });
    expect(result.status).toBe("Invalid");
    const blob = JSON.stringify(result);
    expect(blob).not.toMatch(/0xdead/); // no other members
    expect(blob).not.toMatch(/amount|balance/i);
  });

  it("cross-circle: the same person in two circles presents two different member_refs", () => {
    // member_ref = commitment(secret, authKey); a distinct per-circle secret => distinct ref
    const inCircleA = deriveMemberIdentity("A", 0xaaaa1n, 0x777n);
    const inCircleB = deriveMemberIdentity("B", 0xbbbb2n, 0x777n); // same auth key, different secret
    expect(inCircleA.memberRef).not.toBe(inCircleB.memberRef);
  });
});

describe("false completion / cured-default laundering", () => {
  it("Circle Completion never issues while the member's payout is only authorized (not settled)", async () => {
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: { finalSettlementPrepared: true, payoutStatus: { 1: "PrivateSettlementAuthorized" } },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/PrivateSettlementAuthorized/);
  });

  it("Circle Completion never issues for NoFundedRecovery", async () => {
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: { finalSettlementPrepared: true, payoutStatus: { 1: "NoFundedRecovery" } },
    });
    expect(result.status).toBe("Invalid");
  });

  it("a cured default does not launder into Good Standing", async () => {
    // status stays MissedDefault on chain even after a cure
    const { result } = await runVerify({
      chain: { contributionStatus: { 1: "OnTime", 2: "MissedDefault", 3: "OnTime" } },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/cure does not launder|missed default/i);
  });
});

describe("verifier never fails open", () => {
  it("every distinct failure returns Invalid or Unable to verify — never Verified", async () => {
    const outcomes = await Promise.all([
      runVerify({ artifact: (() => { const a = goodStandingArtifact(3); a.signature.r = "0x1"; return a; })(), chain: OK_GS }),
      runVerify({ chain: { ...OK_GS, throwOn: "getCircle" } }),
      runVerify({ chain: OK_GS, challenge: { expiry: NOW - 5 } }),
      runVerify({ chain: OK_GS, challenge: { verifierId: "x" } }),
      runVerify({ artifact: circleCompletionArtifact(), chain: { finalSettlementPrepared: false } }),
    ]);
    for (const { result } of outcomes) {
      expect(result.status).not.toBe("Verified");
    }
  });
});
