// core/payment.ts — chain-neutral contribution payment types.
//
// Adapters bind these opaque refs to chain details. Core never names a
// token, address, or RPC.

export type ExplicitConfirmation =
  | { confirmed: false }
  | { confirmed: true; actionId: string };

export interface ContributionPaymentRequest {
  circleId: string;
  round: number;
  memberRef: string;
  amount: string;
  recipientRef: string;
  /** Opaque connected-account identity this action is bound to. Adapter-formatted. */
  accountRef: string;
  /** Opaque chain identity this action is bound to. Adapter-formatted. */
  chainRef: string;
  /** Opaque settlement-asset identity this action is bound to. Adapter-formatted. */
  assetRef: string;
}

export interface PreparedContributionAction {
  actionId: string;
  request: ContributionPaymentRequest;
  requiresApproval: boolean;
}

/**
 * Every field folded in here becomes part of what a confirmation approves.
 * If any of them changes after `actionId` is computed, re-deriving this id
 * from the (possibly tampered) request no longer matches the id the user
 * actually confirmed.
 */
export function contributionActionId(request: ContributionPaymentRequest): string {
  return [
    request.circleId,
    String(request.round),
    request.memberRef,
    request.amount,
    request.recipientRef,
    request.accountRef,
    request.chainRef,
    request.assetRef,
  ].join(":");
}

/** Opaque settlement recipient: the circle contract, never an EOA treasury. */
export function circleSettlementRef(circleId: string): string {
  return `circle:${circleId}:settlement`;
}

/** @deprecated Use circleSettlementRef. Kept so older tests fail closed if reused. */
export function circleTreasuryRef(circleId: string): string {
  return circleSettlementRef(circleId);
}

export function assertExplicitConfirmation(
  prepared: PreparedContributionAction,
  confirmation: ExplicitConfirmation,
): void {
  if (!confirmation.confirmed) {
    throw new Error("Contribution requires explicit confirmation");
  }
  if (confirmation.actionId !== prepared.actionId) {
    throw new Error("Confirmation does not match the prepared contribution");
  }
}
