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
}

export interface PreparedContributionAction {
  actionId: string;
  request: ContributionPaymentRequest;
  requiresApproval: boolean;
}

export function contributionActionId(request: ContributionPaymentRequest): string {
  return [
    request.circleId,
    String(request.round),
    request.memberRef,
    request.amount,
    request.recipientRef,
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
