import { describe, expect, it } from "vitest";
import { standingFrom } from "../lib/standing";
import { ContributionHistory } from "./contributionHistory";

describe("ContributionHistory", () => {
  it("records a confirmed on-time contribution and feeds standing", () => {
    const history = new ContributionHistory();
    const obligation = history.recordConfirmed({
      circleId: "circle-1",
      round: 1,
      memberRef: "m1",
      dueAt: 1_000,
      graceEndsAt: 2_000,
      settledAt: 900,
      txHash: "0xabc",
    });
    expect(obligation.status).toBe("ON_TIME");
    expect(history.get("circle-1", 1, "m1")?.txHash).toBe("0xabc");
    expect(standingFrom(history.standingOutcomes()).completedCycles).toBe(1);
    expect(standingFrom(history.standingOutcomes()).onTimeCount).toBe(1);
  });

  it("records a late-within-grace payment", () => {
    const history = new ContributionHistory();
    const obligation = history.recordConfirmed({
      circleId: "circle-1",
      round: 1,
      memberRef: "m1",
      dueAt: 1_000,
      graceEndsAt: 2_000,
      settledAt: 1_500,
      txHash: "0xdef",
    });
    expect(obligation.status).toBe("LATE_WITHIN_GRACE");
    expect(history.standingOutcomes()).toEqual(["LateWithinGrace"]);
  });

  it("does not mark a contribution complete without a tx or after grace", () => {
    const history = new ContributionHistory();
    expect(() =>
      history.recordConfirmed({
        circleId: "circle-1",
        round: 1,
        memberRef: "m1",
        dueAt: 1_000,
        graceEndsAt: 2_000,
        settledAt: 900,
        txHash: "",
      }),
    ).toThrow(/transaction/);
    expect(() =>
      history.recordConfirmed({
        circleId: "circle-1",
        round: 1,
        memberRef: "m1",
        dueAt: 1_000,
        graceEndsAt: 2_000,
        settledAt: 2_500,
        txHash: "0xabc",
      }),
    ).toThrow(/grace/);
    expect(history.list()).toHaveLength(0);
  });

  it("rejects a duplicate settlement for the same member and round", () => {
    const history = new ContributionHistory();
    const input = {
      circleId: "circle-1",
      round: 1,
      memberRef: "m1",
      dueAt: 1_000,
      graceEndsAt: 2_000,
      settledAt: 900,
      txHash: "0x1",
    };
    history.recordConfirmed(input);
    expect(() => history.recordConfirmed({ ...input, txHash: "0x2" })).toThrow(
      /already recorded/,
    );
  });
});
