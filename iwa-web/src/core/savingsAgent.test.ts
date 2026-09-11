import { describe, expect, it } from "vitest";
import type { Circle, ContributionObligation, PayoutState } from "./domain/types";
import { IwaSavingsAgent } from "./savingsAgent";
import { circleSettlementRef } from "./payment";

const circle: Circle = {
  id: "circle-1",
  asset: "USDC",
  contributionAmount: "5000000",
  cadenceSeconds: 604_800,
  gracePeriodSeconds: 86_400,
  memberLimit: 3,
  currentRound: 1,
  status: "ACTIVE",
  payoutOrder: ["m1", "m2", "m3"],
};

const obligation: ContributionObligation = {
  circleId: "circle-1",
  round: 1,
  memberRef: "m1",
  dueAt: 1_000,
  graceEndsAt: 2_000,
  status: "PENDING",
};

const payout: PayoutState = {
  circleId: "circle-1",
  round: 1,
  scheduledMemberRef: "m2",
  status: "SCHEDULED",
};

describe("IwaSavingsAgent", () => {
  const agent = new IwaSavingsAgent();

  it("reminds when a contribution is due or in grace, and not after miss", () => {
    expect(agent.reminder(obligation, 500).kind).toBe("due");
    expect(agent.reminder(obligation, 1_500).kind).toBe("grace");
    expect(agent.reminder(obligation, 2_500).kind).toBe("none");
    expect(
      agent.reminder({ ...obligation, status: "ON_TIME" }, 500).kind,
    ).toBe("none");
  });

  it("reports current circle status and who is due", () => {
    const view = agent.status(circle, obligation, payout, "m1");
    expect(view.round).toBe(1);
    expect(view.status).toBe("ACTIVE");
    expect(view.obligationStatus).toBe("PENDING");
    expect(agent.dueMember(payout)).toBe("m2");
    expect(view.youAreDueToCollect).toBe(false);
    expect(agent.status(circle, obligation, payout, "m2").youAreDueToCollect).toBe(
      true,
    );
  });

  it("prepares an authorized contribution bound to the circle amount and settlement contract", () => {
    const prepared = agent.prepareContribution(circle, obligation);
    expect(prepared.request.amount).toBe("5000000");
    expect(prepared.request.recipientRef).toBe(circleSettlementRef("circle-1"));
    expect(prepared.request.memberRef).toBe("m1");
    expect(prepared.requiresApproval).toBe(true);
  });

  it("refuses to prepare for the wrong circle, round, member, or status", () => {
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, circleId: "other" }),
    ).toThrow(/circle/);
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, round: 2 }),
    ).toThrow(/round/);
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, memberRef: "stranger" }),
    ).toThrow(/member/);
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, status: "ON_TIME" }),
    ).toThrow(/settled/);
    expect(() =>
      agent.prepareContribution({ ...circle, status: "OPEN_FOR_MEMBERS" }, obligation),
    ).toThrow(/active/);
  });

  it("cannot send funds: there is no send method, and rejection is required", () => {
    expect(Object.getOwnPropertyNames(IwaSavingsAgent.prototype)).not.toContain(
      "send",
    );
    expect(Object.getOwnPropertyNames(IwaSavingsAgent.prototype)).not.toContain(
      "execute",
    );
    const prepared = agent.prepareContribution(circle, obligation);
    expect(() =>
      agent.requireConfirmation(prepared, { confirmed: false }),
    ).toThrow(/explicit confirmation/);
    expect(() =>
      agent.requireConfirmation(prepared, {
        confirmed: true,
        actionId: "forged",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      agent.requireConfirmation(prepared, {
        confirmed: true,
        actionId: prepared.actionId,
      }),
    ).not.toThrow();
  });
});
