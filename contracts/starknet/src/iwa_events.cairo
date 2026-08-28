// Event payloads for IwaCircle. The contract Event enum is assembled in Task 6.
// Payloads use member_ref commitments, not wallet addresses (INV-013).

use super::iwa_types::{ContributionStatus, PayoutStatus, SupportedAsset};

#[derive(Drop, starknet::Event)]
pub struct CircleCreated {
    #[key]
    pub circle_id: u32,
    pub asset: SupportedAsset,
    pub contribution_amount: u128,
    pub member_limit: u8,
}

#[derive(Drop, starknet::Event)]
pub struct MemberJoined {
    #[key]
    pub circle_id: u32,
    #[key]
    pub member_ref: felt252,
    pub slot: u8,
}

#[derive(Drop, starknet::Event)]
pub struct CircleActivated {
    #[key]
    pub circle_id: u32,
}

#[derive(Drop, starknet::Event)]
/// An authenticated accounting transition only. This event does not assert
/// ERC-20 or STRK20 settlement.
pub struct ContributionStateUpdated {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub member_ref: felt252,
    pub status: ContributionStatus,
}

/// Authenticated deficit-accounting transition only; no token settlement.
#[derive(Drop, starknet::Event)]
pub struct CureAccountingSettled {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub member_ref: felt252,
}

#[derive(Drop, starknet::Event)]
pub struct RoundFinalized {
    #[key]
    pub circle_id: u32,
    pub round: u32,
}

#[derive(Drop, starknet::Event)]
pub struct PayoutUpdated {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
    pub status: PayoutStatus,
}

/// Deterministic payout accounting only; no token settlement.
#[derive(Drop, starknet::Event)]
pub struct PayoutAccountingPrepared {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
    pub status: PayoutStatus,
}

/// Member-authorized settlement accounting only; no token settlement.
#[derive(Drop, starknet::Event)]
pub struct PayoutSettlementAuthorized {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
}

/// Terminal settlement/recovery requirements are fixed. Tokens have not moved.
#[derive(Drop, starknet::Event)]
pub struct FinalSettlementPrepared {
    #[key]
    pub circle_id: u32,
}

#[derive(Drop, starknet::Event)]
pub struct CirclePaused {
    #[key]
    pub circle_id: u32,
}

#[derive(Drop, starknet::Event)]
pub struct CircleCompleted {
    #[key]
    pub circle_id: u32,
}
