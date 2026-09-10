//! V2-specific event payloads. V1 `iwa_events` is untouched.

use crate::iwa_types_v2::PayoutStatusV2;

#[derive(Drop, starknet::Event)]
pub struct PayoutAccountingPreparedV2 {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
    pub status: PayoutStatusV2,
}

/// The scheduled member registered a private destination note and authorized
/// the exact state-derived amount. No token movement.
#[derive(Drop, starknet::Event)]
pub struct PrivateDestinationRegistered {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
    pub dest_epoch: u64,
    pub is_recovery: bool,
}

/// Terminal private-settlement success. Emitted in the same STRK20 transaction
/// as the verified private value movement.
#[derive(Drop, starknet::Event)]
pub struct PrivatelySettled {
    #[key]
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
    pub amount: u128,
    pub is_recovery: bool,
}

#[derive(Drop, starknet::Event)]
pub struct FinalSettlementPreparedV2 {
    #[key]
    pub circle_id: u32,
}
