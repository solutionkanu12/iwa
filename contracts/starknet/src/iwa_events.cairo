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
pub struct ContributionRecorded {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub member_ref: felt252,
    pub status: ContributionStatus,
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
