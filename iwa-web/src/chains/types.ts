// chains/types.ts — chain-neutral adapter contract.
//
// The ChainAdapter is the boundary between IWA Core/application code and a
// specific blockchain (ARCHITECTURE.md "Chain interface"). It exposes
// capabilities only; no felt/address/RPC/explorer types appear here. The
// Starknet adapter will implement this behind its own config/wallet modules.

import type {
  Circle,
  ContributionObligation,
  CredentialClaim,
  PayoutState,
  SupportedAsset,
} from "../core/domain/types";

export type TransactionStatus = "PENDING" | "CONFIRMED" | "FAILED";

// Parameters for creating a circle. payoutOrder is agreed at creation and
// becomes immutable once contributions begin.
export interface CreateCircleParams {
  asset: SupportedAsset;
  contributionAmount: string; // base units, decimal string
  cadenceSeconds: number;
  gracePeriodSeconds: number;
  memberLimit: number;
  payoutOrder: string[]; // member refs, fixed at creation
}

export interface JoinCircleParams {
  circleId: string;
  memberRef: string; // opaque commitment/reference
}

export interface SubmitContributionParams {
  circleId: string;
  round: number;
  memberRef: string;
}

export interface ClaimPayoutParams {
  circleId: string;
  round: number;
  memberRef: string;
}

// An opaque reference to a submitted transaction. The chainId is a plain
// identifier string; the hash is opaque and never parsed by the domain layer.
export interface TransactionReference {
  chainId: string;
  txHash: string;
}

export interface ChainAdapter {
  createCircle(params: CreateCircleParams): Promise<Circle>;
  joinCircle(params: JoinCircleParams): Promise<Circle>;
  submitContribution(
    params: SubmitContributionParams,
  ): Promise<ContributionObligation>;
  finalizeRound(circleId: string): Promise<Circle>;
  claimPayout(params: ClaimPayoutParams): Promise<PayoutState>;
  getCircleState(circleId: string): Promise<Circle>;
  getContributionState(
    circleId: string,
    round: number,
    memberRef: string,
  ): Promise<ContributionObligation>;
  getTransactionStatus(reference: TransactionReference): Promise<TransactionStatus>;
  // Verifies a scoped claim only; the verifier never receives raw history.
  verifyCredential(
    claim: CredentialClaim,
    proofReference?: string,
  ): Promise<{ valid: boolean }>;
}