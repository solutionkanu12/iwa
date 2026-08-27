// Contract tests for the chain-neutral ChainAdapter interface.
//
// The interface must be implementable without any chain-specific type
// (no felt, no address, no RPC types). A minimal in-memory fake stands in for
// the future Starknet adapter and must round-trip the domain objects exactly
// as the interface declares.

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ChainAdapter,
  ClaimPayoutParams,
  CreateCircleParams,
  JoinCircleParams,
  SubmitContributionParams,
  TransactionReference,
} from "./types";
import type {
  Circle,
  ContributionObligation,
  CredentialClaim,
  Member,
  PayoutState,
  SupportedAsset,
} from "../core/domain/types";
import { classifyContribution } from "../core/domain/contributionStatus";

const PAYOUT_ORDER = ["m1", "m2", "m3"];

class FakeAdapter implements ChainAdapter {
  private circles = new Map<string, Circle>();
  private obligations = new Map<string, ContributionObligation>();
  private members = new Map<string, Member[]>();

  async createCircle(params: CreateCircleParams): Promise<Circle> {
    const circle: Circle = {
      id: `circle-${this.circles.size}`,
      asset: params.asset,
      contributionAmount: params.contributionAmount,
      cadenceSeconds: params.cadenceSeconds,
      gracePeriodSeconds: params.gracePeriodSeconds,
      memberLimit: params.memberLimit,
      currentRound: 1,
      status: "OPEN_FOR_MEMBERS",
      payoutOrder: [...params.payoutOrder],
    };
    this.circles.set(circle.id, circle);
    this.members.set(circle.id, []);
    return circle;
  }

  async joinCircle(params: JoinCircleParams): Promise<Circle> {
    const circle = this.circles.get(params.circleId);
    if (!circle) throw new Error("circle not found");
    if (circle.status !== "OPEN_FOR_MEMBERS") throw new Error("join closed");
    const existing = this.members.get(params.circleId) ?? [];
    existing.push({
      circleId: params.circleId,
      memberRef: params.memberRef,
      slot: existing.length,
    });
    this.members.set(params.circleId, existing);
    const next = {
      ...circle,
      status:
        existing.length >= circle.memberLimit
          ? ("ACTIVE" as const)
          : circle.status,
    };
    this.circles.set(params.circleId, next);
    return next;
  }

  async submitContribution(
    params: SubmitContributionParams,
  ): Promise<ContributionObligation> {
    const circle = this.circles.get(params.circleId);
    if (!circle) throw new Error("circle not found");
    const dueAt = 1_000;
    const obligation: ContributionObligation = {
      circleId: params.circleId,
      round: params.round,
      memberRef: params.memberRef,
      dueAt,
      graceEndsAt: dueAt + circle.gracePeriodSeconds,
      status: classifyContribution(
        dueAt + 500,
        dueAt,
        dueAt + circle.gracePeriodSeconds,
        dueAt + 500,
      ),
    };
    this.obligations.set(
      `${params.circleId}:${params.round}:${params.memberRef}`,
      obligation,
    );
    return obligation;
  }

  async finalizeRound(circleId: string): Promise<Circle> {
    const circle = this.circles.get(circleId);
    if (!circle) throw new Error("circle not found");
    const next = { ...circle, currentRound: circle.currentRound + 1 };
    this.circles.set(circleId, next);
    return next;
  }

  async claimPayout(params: ClaimPayoutParams): Promise<PayoutState> {
    return {
      circleId: params.circleId,
      round: params.round,
      scheduledMemberRef: "m1",
      status: "SCHEDULED",
    };
  }

  async getCircleState(circleId: string): Promise<Circle> {
    const circle = this.circles.get(circleId);
    if (!circle) throw new Error("circle not found");
    return circle;
  }

  async getContributionState(
    circleId: string,
    round: number,
    memberRef: string,
  ): Promise<ContributionObligation> {
    const obligation = this.obligations.get(
      `${circleId}:${round}:${memberRef}`,
    );
    if (!obligation) throw new Error("obligation not found");
    return obligation;
  }

  async getTransactionStatus(
    _reference: TransactionReference,
  ): Promise<"PENDING" | "CONFIRMED" | "FAILED"> {
    return "CONFIRMED";
  }

  async verifyCredential(claim: CredentialClaim): Promise<{ valid: boolean }> {
    return { valid: claim.type === "no_defaults" };
  }
}

describe("ChainAdapter contract", () => {
  it("is implementable without chain-specific types (felt/address/RPC)", () => {
    const adapter: ChainAdapter = new FakeAdapter();
    expectTypeOf(adapter.createCircle).returns.toEqualTypeOf<
      Promise<Circle>
    >();
    expectTypeOf(adapter.getCircleState).returns.toEqualTypeOf<Promise<Circle>>();
    expectTypeOf(adapter.getTransactionStatus).returns.toEqualTypeOf<
      Promise<"PENDING" | "CONFIRMED" | "FAILED">
    >();
    expectTypeOf(adapter.verifyCredential).returns.toEqualTypeOf<
      Promise<{ valid: boolean }>
    >();
  });

  it("creates a circle with a locked payout order and reads it back", async () => {
    const adapter = new FakeAdapter();
    const created = await adapter.createCircle({
      asset: "USDC",
      contributionAmount: "5000000",
      cadenceSeconds: 604_800,
      gracePeriodSeconds: 86_400,
      memberLimit: 3,
      payoutOrder: PAYOUT_ORDER,
    });

    expect(created.status).toBe("OPEN_FOR_MEMBERS");
    expect(created.payoutOrder).toEqual(PAYOUT_ORDER);
    expect(created.asset).toBe("USDC");
    expect(created.currentRound).toBe(1);

    const read = await adapter.getCircleState(created.id);
    expect(read).toEqual(created);
  });

  it("accepts only allowlisted assets on the circle", async () => {
    const adapter = new FakeAdapter();
    const circle = await adapter.createCircle({
      asset: "STRK",
      contributionAmount: "1000000000000000000",
      cadenceSeconds: 86_400,
      gracePeriodSeconds: 43_200,
      memberLimit: 2,
      payoutOrder: ["a", "b"],
    });
    expectTypeOf(circle.asset).toEqualTypeOf<SupportedAsset>();
    expect(circle.asset).toBe("STRK");
  });

  it("classifies a contribution through the adapter using the locked grace rule", async () => {
    const adapter = new FakeAdapter();
    const circle = await adapter.createCircle({
      asset: "USDC",
      contributionAmount: "5000000",
      cadenceSeconds: 1_000,
      gracePeriodSeconds: 1_000,
      memberLimit: 2,
      payoutOrder: ["m1", "m2"],
    });
    const obligation = await adapter.submitContribution({
      circleId: circle.id,
      round: 1,
      memberRef: "m1",
    });
    expect(obligation.status).toBe("LATE_WITHIN_GRACE");
    expect(obligation.dueAt).toBe(1_000);
    expect(obligation.graceEndsAt).toBe(2_000);
  });

  it("exposes a deterministic claim payout path and scoped credential verification", async () => {
    const adapter = new FakeAdapter();
    const payout = await adapter.claimPayout({
      circleId: "circle-0",
      round: 1,
      memberRef: "m1",
    });
    expect(payout.status).toBe("SCHEDULED");
    expect(payout.scheduledMemberRef).toBe("m1");

    const verification = await adapter.verifyCredential({
      type: "no_defaults",
    });
    expect(verification.valid).toBe(true);
  });

  it("joins members while open, activates at capacity, and finalizes a round", async () => {
    const adapter = new FakeAdapter();
    const created = await adapter.createCircle({
      asset: "USDC",
      contributionAmount: "5000000",
      cadenceSeconds: 604_800,
      gracePeriodSeconds: 86_400,
      memberLimit: 2,
      payoutOrder: ["m1", "m2"],
    });

    const afterFirst = await adapter.joinCircle({
      circleId: created.id,
      memberRef: "m1",
    });
    expect(afterFirst.status).toBe("OPEN_FOR_MEMBERS");

    const afterSecond = await adapter.joinCircle({
      circleId: created.id,
      memberRef: "m2",
    });
    expect(afterSecond.status).toBe("ACTIVE");

    const finalized = await adapter.finalizeRound(created.id);
    expect(finalized.currentRound).toBe(created.currentRound + 1);
  });

  it("reads contribution and transaction status through the adapter", async () => {
    const adapter = new FakeAdapter();
    const circle = await adapter.createCircle({
      asset: "STRK",
      contributionAmount: "1",
      cadenceSeconds: 1_000,
      gracePeriodSeconds: 1_000,
      memberLimit: 2,
      payoutOrder: ["m1", "m2"],
    });
    const obligation = await adapter.submitContribution({
      circleId: circle.id,
      round: 1,
      memberRef: "m1",
    });
    const read = await adapter.getContributionState(circle.id, 1, "m1");
    expect(read).toEqual(obligation);

    const txStatus = await adapter.getTransactionStatus({
      chainId: "test",
      txHash: "tx-1",
    });
    expect(txStatus).toBe("CONFIRMED");
  });
});