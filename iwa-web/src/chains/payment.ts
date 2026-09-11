// chains/payment.ts — re-export of the chain-neutral payment port.
// Chain adapters import from here or from core/payment; IWA Core owns the types.

export {
  assertExplicitConfirmation,
  circleSettlementRef,
  circleTreasuryRef,
  contributionActionId,
  type ContributionPaymentRequest,
  type ExplicitConfirmation,
  type PreparedContributionAction,
} from "../core/payment";
