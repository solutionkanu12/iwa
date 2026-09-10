//! IwaCircle **V2** domain types — the minimal delta over `iwa_types` for
//! Candidate P private pot collection (`docs/strk20/V2_ALT_PRIVATE_PAYOUT_RESEARCH.md`).
//!
//! V1 (`iwa_types`, `iwa_circle`, `iwa_strk20_helper`) is UNTOUCHED. This module
//! adds only what the precommitted-private-destination payout needs:
//!   * `PayoutStatusV2` with `PrivateSettlementAuthorized` / `PrivatelyPaid`
//!   * a member-auth-key-signed destination-registration authorization
//!     (`IWA_PAYOUT_DEST_V2` / `IWA_RECOVERY_DEST_V2`) that binds the exact
//!     open-note id, the state-derived amount, a monotonic epoch and an expiry,
//!     and is produced BEFORE the STRK20 transaction is assembled.
//!
//! There is no assembly-time settlement signature in V2: the registration IS
//! the authorization, and settlement only checks `open_note_id == registered`.

use core::ec::stark_curve;
use core::ecdsa::check_ecdsa_signature;
use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;
use crate::iwa_types::is_valid_auth_public_key;

/// Bumped by any future V2 authorization-encoding change. Bound into every hash.
pub const IWA_PROTOCOL_VERSION_V2: felt252 = 2;

pub const PAYOUT_DEST_V2_DOMAIN_TAG: felt252 = 'IWA_PAYOUT_DEST_V2';
pub const RECOVERY_DEST_V2_DOMAIN_TAG: felt252 = 'IWA_RECOVERY_DEST_V2';

/// V2 error codes. Distinct file so no V1 constant module is edited.
pub mod errors_v2 {
    pub const DEST_ZERO_NOTE: felt252 = 'IWA2: zero note';
    pub const DEST_STALE_EPOCH: felt252 = 'IWA2: stale epoch';
    pub const DEST_NONCE_USED: felt252 = 'IWA2: dest nonce used';
    pub const DEST_NOT_REGISTERED: felt252 = 'IWA2: no destination';
    pub const DEST_MISMATCH: felt252 = 'IWA2: destination mismatch';
    pub const DEST_EXPIRED: felt252 = 'IWA2: authorization expired';
    pub const PAYOUT_NOT_AUTHORIZED: felt252 = 'IWA2: payout not authorized';
    pub const ALREADY_PRIVATELY_PAID: felt252 = 'IWA2: already privately paid';
    pub const NO_ASSEMBLY_SIGNATURE: felt252 = 'IWA2: no assembly signature';
    pub const RECOVERY_NOT_AUTHORIZED: felt252 = 'IWA2: recovery not authorized';
    pub const ALREADY_PRIVATELY_RECOVERED: felt252 = 'IWA2: already recovered';
}

/// Deterministic V2 payout state for a round.
#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum PayoutStatusV2 {
    /// Accounting-ready. No member action, no destination, no token movement.
    Scheduled,
    /// Preserved for the scheduled member while a round deficit is unresolved.
    DeferredLocked,
    /// The scheduled member registered a private destination note + authorized
    /// the exact state-derived amount. Tokens have NOT moved.
    PrivateSettlementAuthorized,
    /// Terminal success: verified private value movement to the registered
    /// member-controlled open note.
    PrivatelyPaid,
    /// Final deterministic net-funded recovery accounting exists for the same
    /// rightful member. Tokens have NOT moved.
    RecoveryPending,
    /// Terminal success: verified private recovery movement.
    PrivatelyRecovered,
    /// The round has no funded value for recovery. Terminal, no token movement.
    NoFundedRecovery,
}

#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct PayoutStateV2 {
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
    /// Locked rotating-pot amount. Accounting, not a transfer claim.
    pub amount: u128,
    pub status: PayoutStatusV2,
}

/// A member's registered private destination for one (circle, round).
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct RegisteredDestinationV2 {
    pub note_id: felt252,
    pub amount: u128,
    pub dest_epoch: u64,
    pub expiry: u64,
}

fn dest_hash(
    tag: felt252,
    circle_contract: ContractAddress,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    note_id: felt252,
    amount: u128,
    dest_epoch: u64,
    expiry: u64,
    nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            tag, IWA_PROTOCOL_VERSION_V2, circle_contract.into(), helper.into(), pool.into(),
            token.into(), circle_id.into(), round.into(), member_ref, note_id, amount.into(),
            dest_epoch.into(), expiry.into(), nonce,
        ]
            .span(),
    )
}

pub fn payout_dest_v2_hash(
    circle_contract: ContractAddress,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    note_id: felt252,
    amount: u128,
    dest_epoch: u64,
    expiry: u64,
    nonce: felt252,
) -> felt252 {
    dest_hash(
        PAYOUT_DEST_V2_DOMAIN_TAG, circle_contract, helper, pool, token, circle_id, round,
        member_ref, note_id, amount, dest_epoch, expiry, nonce,
    )
}

pub fn recovery_dest_v2_hash(
    circle_contract: ContractAddress,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    note_id: felt252,
    amount: u128,
    dest_epoch: u64,
    expiry: u64,
    nonce: felt252,
) -> felt252 {
    dest_hash(
        RECOVERY_DEST_V2_DOMAIN_TAG, circle_contract, helper, pool, token, circle_id, round,
        member_ref, note_id, amount, dest_epoch, expiry, nonce,
    )
}

/// Canonical Stark-curve ECDSA verification with the same range + low-s guards
/// V1's `iwa_types::verify_settlement_hash` enforces. No custom algorithm.
pub fn verify_dest_v2_signature(
    public_key: felt252, message_hash: felt252, signature_r: felt252, signature_s: felt252,
) -> bool {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let r: u256 = signature_r.into();
    let s: u256 = signature_s.into();
    if !is_valid_auth_public_key(public_key)
        || signature_r == 0
        || signature_s == 0
        || r >= ORDER_U256
        || s >= ORDER_U256
        || s > ORDER_U256 / 2 {
        return false;
    }
    check_ecdsa_signature(message_hash, public_key, signature_r, signature_s)
}
