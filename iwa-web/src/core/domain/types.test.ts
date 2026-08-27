// Unit tests for chain-neutral domain types.
// These must be constructible without felt/address/RPC/Cairo types.

import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Circle,
  CircleStatus,
  ContributionObligation,
  ContributionStatus,
  CredentialClaim,
  Member,
  PayoutState,
  PayoutStatus,
  SupportedAsset,
} from "./types";

describe("chain-neutral domain types", () => {
  it("locks contribution, circle, asset, and payout unions", () => {
    expectTypeOf<ContributionStatus>().toEqualTypeOf<
      "PENDING" | "ON_TIME" | "LATE_WITHIN_GRACE" | "MISSED_DEFAULT"
    >();
    expectTypeOf<CircleStatus>().toEqualTypeOf<
      | "CREATED"
      | "OPEN_FOR_MEMBERS"
      | "ACTIVE"
      | "PAUSED_FOR_NEW_ACTIONS"
      | "COMPLETED"
    >();
    expectTypeOf<SupportedAsset>().toEqualTypeOf<"USDC" | "STRK">();
    expectTypeOf<PayoutStatus>().toEqualTypeOf<
      "SCHEDULED" | "DEFERRED_LOCKED" | "PAID" | "RECOVERED"
    >();
  });

  it("constructs domain objects from opaque ids, decimal amounts, and seconds", () => {
    const circle: Circle = {
      id: "circle-1",
      asset: "USDC",
      contributionAmount: "5000000",
      cadenceSeconds: 604_800,
      gracePeriodSeconds: 86_400,
      memberLimit: 3,
      currentRound: 1,
      status: "CREATED",
      payoutOrder: ["m1", "m2", "m3"],
    };
    const member: Member = {
      circleId: circle.id,
      memberRef: "m1",
      slot: 0,
    };
    const obligation: ContributionObligation = {
      circleId: circle.id,
      round: 1,
      memberRef: member.memberRef,
      dueAt: 1_000,
      graceEndsAt: 2_000,
      status: "PENDING",
    };
    const payout: PayoutState = {
      circleId: circle.id,
      round: 1,
      scheduledMemberRef: member.memberRef,
      status: "DEFERRED_LOCKED",
    };
    const recovered: PayoutState = { ...payout, status: "RECOVERED" };
    const claim: CredentialClaim = {
      type: "completed_cycles",
      threshold: 3,
    };

    expect(circle.status).toBe("CREATED");
    expect(member.slot).toBe(0);
    expect(obligation.status).toBe("PENDING");
    expect(payout.status).toBe("DEFERRED_LOCKED");
    expect(recovered.status).toBe("RECOVERED");
    expect(claim).toEqual({ type: "completed_cycles", threshold: 3 });
  });
});
