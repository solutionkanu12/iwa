import { describe, expect, it } from "vitest";

import { feltHex } from "../../chains/strk20/iwaSigning";
import { MEMBER, circleCompletionArtifact, goodStandingArtifact, runVerify, type ChainModel } from "./testkit";

describe("verifyCredentialV2 — Good Standing", () => {
  it("Verified when every round 1..N is OnTime / LateWithinGrace", async () => {
    const { result } = await runVerify({
      chain: { contributionStatus: { 1: "OnTime", 2: "LateWithinGrace", 3: "OnTime" } },
    });
    expect(result.status).toBe("Verified");
    expect(result.claim).toEqual({ type: "good_standing", thresholdRounds: 3 });
    expect(result.subject).toEqual({ circleId: 7, memberRef: feltHex(MEMBER.memberRef) });
  });

  it("Invalid when a round in 1..N was a MissedDefault — even if later cured", async () => {
    const { result } = await runVerify({
      chain: { contributionStatus: { 1: "OnTime", 2: "MissedDefault", 3: "OnTime" } },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/missed default|cure does not launder/i);
  });

  it("Invalid when a round in 1..N is still Pending (not completed)", async () => {
    const { result } = await runVerify({
      chain: { contributionStatus: { 1: "OnTime", 2: "Pending", 3: "OnTime" } },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/pending/i);
  });

  it("Invalid when a round in 1..N has no obligation at all", async () => {
    const { result } = await runVerify({ chain: { contributionStatus: { 1: "OnTime", 2: "OnTime" } } });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/no obligation|not a completed round/i);
  });

  it("Invalid when N exceeds the circle size", async () => {
    const { result } = await runVerify({
      artifact: goodStandingArtifact(9),
      chain: { memberLimit: 5, contributionStatus: { 1: "OnTime", 2: "OnTime", 3: "OnTime", 4: "OnTime", 5: "OnTime" } },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/exceeds the circle size/i);
  });
});

describe("verifyCredentialV2 — Circle Completion", () => {
  const finalized = (payoutStatus: Record<number, string>): ChainModel => ({
    finalSettlementPrepared: true,
    payoutStatus,
  });

  it("Verified for PrivatelyPaid on the member's own round", async () => {
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: finalized({ 1: "PrivatelyPaid" }),
    });
    expect(result.status).toBe("Verified");
    expect(result.claim).toEqual({ type: "circle_completion", thresholdRounds: 0 });
  });

  it("Verified for PrivatelyRecovered on the member's own round", async () => {
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: finalized({ 1: "PrivatelyRecovered" }),
    });
    expect(result.status).toBe("Verified");
  });

  for (const bad of [
    "Scheduled",
    "DeferredLocked",
    "PrivateSettlementAuthorized",
    "RecoveryPending",
    "NoFundedRecovery",
  ]) {
    it(`Invalid for ${bad} — an incomplete / private payout never completes the circle`, async () => {
      const { result } = await runVerify({
        artifact: circleCompletionArtifact(),
        chain: finalized({ 1: bad }),
      });
      expect(result.status).toBe("Invalid");
      expect(result.reason).toMatch(new RegExp(bad));
    });
  }

  it("Invalid when the circle has not reached terminal settlement", async () => {
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: { finalSettlementPrepared: false, payoutStatus: { 1: "PrivatelyPaid" } },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/terminal settlement/i);
  });

  it("Invalid when the subject is not in the payout order", async () => {
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: {
        finalSettlementPrepared: true,
        payoutOrder: ["0xaaa", "0xbbb"],
        payoutStatus: { 1: "PrivatelyPaid" },
      },
    });
    expect(result.status).toBe("Invalid");
    expect(result.reason).toMatch(/payout order/i);
  });

  it("checks the member's OWN round, not round 1 blindly", async () => {
    // MEMBER is slot 2 (0-indexed 1) -> round 2
    const order = ["0xaaa", feltHex(MEMBER.memberRef), "0xccc"];
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: {
        finalSettlementPrepared: true,
        payoutOrder: order,
        payoutStatus: { 1: "PrivatelyPaid", 2: "PrivatelyPaid" },
      },
    });
    expect(result.status).toBe("Verified");

    const { result: r2 } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: {
        finalSettlementPrepared: true,
        payoutOrder: order,
        payoutStatus: { 1: "PrivatelyPaid", 2: "NoFundedRecovery" },
      },
    });
    expect(r2.status).toBe("Invalid"); // the member's own round did not complete
  });
});

describe("verifyCredentialV2 — fail-closed on chain errors", () => {
  it("returns 'Unable to verify' (never Verified) when a chain read throws", async () => {
    for (const throwOn of [
      "getMemberAuthKey",
      "isMember",
      "getCircle",
      "getContributionStatus",
    ] as const) {
      const { result } = await runVerify({
        chain: { throwOn, contributionStatus: { 1: "OnTime", 2: "OnTime", 3: "OnTime" } },
      });
      expect(result.status, throwOn).toBe("Unable to verify");
    }
  });

  it("returns 'Unable to verify' when the completion payout read throws", async () => {
    const { result } = await runVerify({
      artifact: circleCompletionArtifact(),
      chain: { finalSettlementPrepared: true, throwOn: "getPayoutStatusV2" },
    });
    expect(result.status).toBe("Unable to verify");
  });
});
