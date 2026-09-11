// core/savingsAgent.ts — Iwa Savings Agent.
//
// Reminds, reports status, names who is due, and prepares an authorized
// contribution. It never sends a transaction. Money movement requires a
// separate explicit confirmation plus a chain adapter.

import type { Circle, ContributionObligation, PayoutState } from "./domain/types";
import {
  assertExplicitConfirmation,
  circleSettlementRef,
  contributionActionId,
  type ExplicitConfirmation,
  type PreparedContributionAction,
} from "./payment";

export type { ExplicitConfirmation, PreparedContributionAction };

export interface ContributionReminder {
  kind: "due" | "grace" | "none";
  detail: string;
}

export interface CircleMemberStatus {
  circleId: string;
  round: number;
  status: Circle["status"];
  obligationStatus: ContributionObligation["status"];
  scheduledMemberRef: string;
  youAreDueToCollect: boolean;
}

export class IwaSavingsAgent {
  reminder(
    obligation: ContributionObligation,
    now: number,
  ): ContributionReminder {
    if (obligation.status !== "PENDING") {
      return { kind: "none", detail: "No contribution is waiting." };
    }
    if (now <= obligation.dueAt) {
      return { kind: "due", detail: "Your contribution is due this round." };
    }
    if (now <= obligation.graceEndsAt) {
      return {
        kind: "grace",
        detail: "Your contribution is late but still inside the grace window.",
      };
    }
    return { kind: "none", detail: "The grace window has closed." };
  }

  status(
    circle: Circle,
    obligation: ContributionObligation,
    payout: PayoutState,
    memberRef: string,
  ): CircleMemberStatus {
    this.assertSameCircle(circle, obligation, payout);
    return {
      circleId: circle.id,
      round: circle.currentRound,
      status: circle.status,
      obligationStatus: obligation.status,
      scheduledMemberRef: payout.scheduledMemberRef,
      youAreDueToCollect: payout.scheduledMemberRef === memberRef,
    };
  }

  dueMember(payout: PayoutState): string {
    return payout.scheduledMemberRef;
  }

  private assertSameCircle(
    circle: Circle,
    obligation: ContributionObligation,
    payout: PayoutState,
  ): void {
    if (obligation.circleId !== circle.id || payout.circleId !== circle.id) {
      throw new Error("Status refused: circle, obligation, and payout do not match");
    }
  }

  /**
   * Freeze the circle's amount, round, member, settlement contract, and the
   * caller-supplied account/chain/asset identity into one action. Does not
   * contact a wallet and does not send. Core does not verify `identity` —
   * it does not know what a wallet or chain is — an adapter must prove the
   * connected account is bound to `obligation.memberRef` (see
   * `core/accountBinding.ts`) before calling this.
   */
  prepareContribution(
    circle: Circle,
    obligation: ContributionObligation,
    identity: { accountRef: string; chainRef: string; assetRef: string },
  ): PreparedContributionAction {
    if (obligation.circleId !== circle.id) {
      throw new Error("Contribution refused: circle and obligation do not match");
    }
    if (obligation.round !== circle.currentRound) {
      throw new Error("Contribution refused: obligation is not for the current round");
    }
    if (circle.status !== "ACTIVE") {
      throw new Error("Contribution refused: circle is not active");
    }
    if (obligation.status !== "PENDING") {
      throw new Error("Contribution refused: this round is already settled");
    }
    if (!circle.payoutOrder.includes(obligation.memberRef)) {
      throw new Error("Contribution refused: member is not in this circle");
    }
    const request = {
      circleId: circle.id,
      round: obligation.round,
      memberRef: obligation.memberRef,
      amount: circle.contributionAmount,
      recipientRef: circleSettlementRef(circle.id),
      accountRef: identity.accountRef,
      chainRef: identity.chainRef,
      assetRef: identity.assetRef,
    };
    return {
      actionId: contributionActionId(request),
      request,
      requiresApproval: true,
    };
  }

  /** Gate used by adapters. The agent itself has no send path. */
  requireConfirmation(
    prepared: PreparedContributionAction,
    confirmation: ExplicitConfirmation,
  ): void {
    assertExplicitConfirmation(prepared, confirmation);
  }
}
