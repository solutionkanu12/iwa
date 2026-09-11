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

const IDENTITY = { accountRef: "chain:0xaa", chainRef: "chain:1", assetRef: "chain:token" };

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

  it("prepares an authorized contribution bound to the circle amount, settlement contract, and identity", () => {
    const prepared = agent.prepareContribution(circle, obligation, IDENTITY);
    expect(prepared.request.amount).toBe("5000000");
    expect(prepared.request.recipientRef).toBe(circleSettlementRef("circle-1"));
    expect(prepared.request.memberRef).toBe("m1");
    expect(prepared.request.accountRef).toBe(IDENTITY.accountRef);
    expect(prepared.request.chainRef).toBe(IDENTITY.chainRef);
    expect(prepared.request.assetRef).toBe(IDENTITY.assetRef);
    expect(prepared.requiresApproval).toBe(true);
  });

  it("binds a different actionId when the account, chain, or asset identity differs", () => {
    const base = agent.prepareContribution(circle, obligation, IDENTITY);
    const otherAccount = agent.prepareContribution(circle, obligation, {
      ...IDENTITY,
      accountRef: "chain:0xbb",
    });
    const otherChain = agent.prepareContribution(circle, obligation, {
      ...IDENTITY,
      chainRef: "chain:2",
    });
    const otherAsset = agent.prepareContribution(circle, obligation, {
      ...IDENTITY,
      assetRef: "chain:other-token",
    });
    expect(otherAccount.actionId).not.toBe(base.actionId);
    expect(otherChain.actionId).not.toBe(base.actionId);
    expect(otherAsset.actionId).not.toBe(base.actionId);
  });

  it("refuses to prepare for the wrong circle, round, member, or status", () => {
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, circleId: "other" }, IDENTITY),
    ).toThrow(/circle/);
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, round: 2 }, IDENTITY),
    ).toThrow(/round/);
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, memberRef: "stranger" }, IDENTITY),
    ).toThrow(/member/);
    expect(() =>
      agent.prepareContribution(circle, { ...obligation, status: "ON_TIME" }, IDENTITY),
    ).toThrow(/settled/);
    expect(() =>
      agent.prepareContribution(
        { ...circle, status: "OPEN_FOR_MEMBERS" },
        obligation,
        IDENTITY,
      ),
    ).toThrow(/active/);
  });

  it("cannot send funds: there is no send method, and rejection is required", () => {
    expect(Object.getOwnPropertyNames(IwaSavingsAgent.prototype)).not.toContain(
      "send",
    );
    expect(Object.getOwnPropertyNames(IwaSavingsAgent.prototype)).not.toContain(
      "execute",
    );
    const prepared = agent.prepareContribution(circle, obligation, IDENTITY);
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
