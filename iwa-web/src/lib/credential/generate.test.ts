import { describe, expect, it } from "vitest";

import { deriveMemberIdentity, feltHex } from "../../chains/strk20/iwaSigning";
import { verifyArtifactSignatureV2 } from "./artifact";
import { generateCredentialV2 } from "./generate";
import { makeChain, MEMBER, CIRCLE_V2 } from "./testkit";

const BASE = {
  network: "SN_MAIN",
  circleId: 7,
  iwaCircleV2: CIRCLE_V2,
  issuedAtBlock: 900_000,
  issuedAt: 1_900_000_000,
};

describe("generateCredentialV2", () => {
  it("issues a signed Good Standing artifact when the claim holds on chain", async () => {
    const res = await generateCredentialV2({
      ...BASE,
      identity: MEMBER,
      claimType: "good_standing",
      thresholdRounds: 3,
      chain: makeChain({ contributionStatus: { 1: "OnTime", 2: "LateWithinGrace", 3: "OnTime" } }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifact.claim).toEqual({ type: "good_standing", params: { thresholdRounds: 3 } });
    expect(res.artifact.subject.memberRef).toBe(feltHex(MEMBER.memberRef));
    expect(verifyArtifactSignatureV2(res.artifact)).toBe(true);
  });

  it("REFUSES to issue when the claim does not hold (a missed default in range)", async () => {
    const res = await generateCredentialV2({
      ...BASE,
      identity: MEMBER,
      claimType: "good_standing",
      thresholdRounds: 3,
      chain: makeChain({ contributionStatus: { 1: "OnTime", 2: "MissedDefault", 3: "OnTime" } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/missed default/i);
  });

  it("REFUSES when the member is not in the circle", async () => {
    const res = await generateCredentialV2({
      ...BASE,
      identity: MEMBER,
      claimType: "good_standing",
      thresholdRounds: 3,
      chain: makeChain({ isMember: false, contributionStatus: { 1: "OnTime", 2: "OnTime", 3: "OnTime" } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/not a member/i);
  });

  it("REFUSES when the identity key is not the member's on-chain key", async () => {
    const other = deriveMemberIdentity("other", 0x1n, 0x2n);
    const res = await generateCredentialV2({
      ...BASE,
      identity: MEMBER,
      claimType: "good_standing",
      thresholdRounds: 3,
      chain: makeChain({
        memberAuthKey: other.authPublicKeyX,
        contributionStatus: { 1: "OnTime", 2: "OnTime", 3: "OnTime" },
      }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/on-chain key/i);
  });

  it("REFUSES Circle Completion for a private-but-incomplete payout", async () => {
    const res = await generateCredentialV2({
      ...BASE,
      identity: MEMBER,
      claimType: "circle_completion",
      chain: makeChain({ finalSettlementPrepared: true, payoutStatus: { 1: "PrivateSettlementAuthorized" } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/PrivateSettlementAuthorized/);
  });

  it("issues Circle Completion for a settled private payout, normalised to thresholdRounds 0", async () => {
    const res = await generateCredentialV2({
      ...BASE,
      identity: MEMBER,
      claimType: "circle_completion",
      thresholdRounds: 9, // ignored
      chain: makeChain({ finalSettlementPrepared: true, payoutStatus: { 1: "PrivatelyRecovered" } }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.artifact.claim.params.thresholdRounds).toBe(0);
  });

  it("REFUSES (does not throw, does not issue) when a chain read fails", async () => {
    const res = await generateCredentialV2({
      ...BASE,
      identity: MEMBER,
      claimType: "good_standing",
      thresholdRounds: 3,
      chain: makeChain({ throwOn: "getContributionStatus" }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/could not confirm/i);
  });
});
