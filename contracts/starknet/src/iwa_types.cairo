// Chain-neutral IWA domain types for the Cairo implementation.
// Identities are felt252 commitments (INV-013), never ContractAddress.
// Token addresses stay in chain config; the domain allowlist is this enum.

use core::ec::{EcPointTrait, stark_curve};
use core::ecdsa::check_ecdsa_signature;
use core::poseidon::poseidon_hash_span;
use starknet::ContractAddress;

/// Domain-separated invite commitment. Off-chain invite secrets never appear
/// in storage or events. Join proves possession of the preimage.
pub const INVITE_DOMAIN_TAG: felt252 = 'IWA_INVITE_V1';
pub const CONTRIBUTION_AUTH_DOMAIN_TAG: felt252 = 'IWA_CONTRIBUTION_V1';
pub const CURE_AUTH_DOMAIN_TAG: felt252 = 'IWA_CURE_V1';
pub const PAYOUT_AUTH_DOMAIN_TAG: felt252 = 'IWA_PAYOUT_V1';
pub const CONTRIBUTION_SETTLEMENT_DOMAIN_TAG: felt252 = 'IWA_CONTRIBUTION_SETTLEMENT_V1';
pub const CURE_SETTLEMENT_DOMAIN_TAG: felt252 = 'IWA_CURE_SETTLEMENT_V1';
pub const PAYOUT_SETTLEMENT_DOMAIN_TAG: felt252 = 'IWA_PAYOUT_SETTLEMENT_V1';
pub const RECOVERY_SETTLEMENT_DOMAIN_TAG: felt252 = 'IWA_RECOVERY_SETTLEMENT_V1';

/// Binds an invite to the exact authentication key the organizer intends the
/// member to register. A leaked `secret` alone is useless: presenting it with
/// any other key produces a different commitment, which matches no slot in the
/// locked payout order. The commitment stays one felt, so `member_ref` and every
/// downstream obligation, nonce, payout-order and signature path are unchanged,
/// and membership remains unbound to any Starknet caller address.
pub fn invite_commitment(secret: felt252, auth_public_key: felt252) -> felt252 {
    poseidon_hash_span(array![INVITE_DOMAIN_TAG, secret, auth_public_key].span())
}

/// A member authentication key is an x-coordinate on the Stark curve. It is
/// independent of any Starknet account and is registered once during join.
pub fn is_valid_auth_public_key(public_key: felt252) -> bool {
    public_key != 0 && EcPointTrait::new_nz_from_x(public_key).is_some()
}

/// Legacy accounting-preparation message retained for explicit domain
/// separation tests. It cannot drive financial state; helper settlement uses
/// `IWA_CONTRIBUTION_SETTLEMENT_V1` below.
pub fn contribution_authorization_hash(
    circle_id: u32, round: u32, member_ref: felt252, amount: u128, nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            CONTRIBUTION_AUTH_DOMAIN_TAG, circle_id.into(), round.into(), member_ref, amount.into(),
            nonce,
        ]
            .span(),
    )
}

/// Verifies a canonical Stark-curve ECDSA signature using Cairo corelib.
/// Explicit range and low-s checks close the malleability cases documented by
/// `core::ecdsa::check_ecdsa_signature`.
pub fn verify_contribution_authorization(
    public_key: felt252,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    amount: u128,
    nonce: felt252,
    signature_r: felt252,
    signature_s: felt252,
) -> bool {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let r: u256 = signature_r.into();
    let s: u256 = signature_s.into();
    if !is_valid_auth_public_key(public_key)
        || signature_r == 0
        || signature_s == 0
        || r >= ORDER_U256
        || s >= ORDER_U256
        || s > ORDER_U256
        / 2 {
        return false;
    }
    check_ecdsa_signature(
        contribution_authorization_hash(circle_id, round, member_ref, amount, nonce),
        public_key,
        signature_r,
        signature_s,
    )
}

/// Legacy cure-preparation message. It cannot settle a deficit financially;
/// helper settlement uses `IWA_CURE_SETTLEMENT_V1` below.
pub fn cure_authorization_hash(
    circle_id: u32, round: u32, member_ref: felt252, amount: u128, nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            CURE_AUTH_DOMAIN_TAG, circle_id.into(), round.into(), member_ref, amount.into(), nonce,
        ]
            .span(),
    )
}

/// Uses the same established Stark-curve verifier and canonical signature
/// constraints as contribution authorization, under the distinct cure tag.
pub fn verify_cure_authorization(
    public_key: felt252,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    amount: u128,
    nonce: felt252,
    signature_r: felt252,
    signature_s: felt252,
) -> bool {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let r: u256 = signature_r.into();
    let s: u256 = signature_s.into();
    if !is_valid_auth_public_key(public_key)
        || signature_r == 0
        || signature_s == 0
        || r >= ORDER_U256
        || s >= ORDER_U256
        || s > ORDER_U256
        / 2 {
        return false;
    }
    check_ecdsa_signature(
        cure_authorization_hash(circle_id, round, member_ref, amount, nonce),
        public_key,
        signature_r,
        signature_s,
    )
}

/// Domain-separated authorization of one exact, already-accounted payout.
/// This authorizes later settlement; it does not attest token movement.
pub fn payout_authorization_hash(
    circle_id: u32, round: u32, member_ref: felt252, amount: u128, nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            PAYOUT_AUTH_DOMAIN_TAG, circle_id.into(), round.into(), member_ref, amount.into(),
            nonce,
        ]
            .span(),
    )
}

pub fn verify_payout_authorization(
    public_key: felt252,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    amount: u128,
    nonce: felt252,
    signature_r: felt252,
    signature_s: felt252,
) -> bool {
    const ORDER_U256: u256 = stark_curve::ORDER.into();
    let r: u256 = signature_r.into();
    let s: u256 = signature_s.into();
    if !is_valid_auth_public_key(public_key)
        || signature_r == 0
        || signature_s == 0
        || r >= ORDER_U256
        || s >= ORDER_U256
        || s > ORDER_U256
        / 2 {
        return false;
    }
    check_ecdsa_signature(
        payout_authorization_hash(circle_id, round, member_ref, amount, nonce),
        public_key,
        signature_r,
        signature_s,
    )
}

fn verify_settlement_hash(
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
        || s > ORDER_U256
        / 2 {
        return false;
    }
    check_ecdsa_signature(message_hash, public_key, signature_r, signature_s)
}

pub fn contribution_settlement_authorization_hash(
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            CONTRIBUTION_SETTLEMENT_DOMAIN_TAG, circle_id.into(), round.into(), member_ref,
            helper.into(), pool.into(), token.into(), amount.into(), nonce,
        ]
            .span(),
    )
}

pub fn verify_contribution_settlement_authorization(
    public_key: felt252,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    nonce: felt252,
    signature_r: felt252,
    signature_s: felt252,
) -> bool {
    verify_settlement_hash(
        public_key,
        contribution_settlement_authorization_hash(
            circle_id, round, member_ref, helper, pool, token, amount, nonce,
        ),
        signature_r,
        signature_s,
    )
}

pub fn cure_settlement_authorization_hash(
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            CURE_SETTLEMENT_DOMAIN_TAG, circle_id.into(), round.into(), member_ref, helper.into(),
            pool.into(), token.into(), amount.into(), nonce,
        ]
            .span(),
    )
}

pub fn verify_cure_settlement_authorization(
    public_key: felt252,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    nonce: felt252,
    signature_r: felt252,
    signature_s: felt252,
) -> bool {
    verify_settlement_hash(
        public_key,
        cure_settlement_authorization_hash(
            circle_id, round, member_ref, helper, pool, token, amount, nonce,
        ),
        signature_r,
        signature_s,
    )
}

pub fn payout_settlement_authorization_hash(
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    open_note_id: felt252,
    nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            PAYOUT_SETTLEMENT_DOMAIN_TAG, circle_id.into(), round.into(), member_ref, helper.into(),
            pool.into(), token.into(), amount.into(), open_note_id, nonce,
        ]
            .span(),
    )
}

pub fn verify_payout_settlement_authorization(
    public_key: felt252,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    open_note_id: felt252,
    nonce: felt252,
    signature_r: felt252,
    signature_s: felt252,
) -> bool {
    verify_settlement_hash(
        public_key,
        payout_settlement_authorization_hash(
            circle_id, round, member_ref, helper, pool, token, amount, open_note_id, nonce,
        ),
        signature_r,
        signature_s,
    )
}

pub fn recovery_settlement_authorization_hash(
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    open_note_id: felt252,
    nonce: felt252,
) -> felt252 {
    poseidon_hash_span(
        array![
            RECOVERY_SETTLEMENT_DOMAIN_TAG, circle_id.into(), round.into(), member_ref,
            helper.into(), pool.into(), token.into(), amount.into(), open_note_id, nonce,
        ]
            .span(),
    )
}

pub fn verify_recovery_settlement_authorization(
    public_key: felt252,
    circle_id: u32,
    round: u32,
    member_ref: felt252,
    helper: ContractAddress,
    pool: ContractAddress,
    token: ContractAddress,
    amount: u128,
    open_note_id: felt252,
    nonce: felt252,
    signature_r: felt252,
    signature_s: felt252,
) -> bool {
    verify_settlement_hash(
        public_key,
        recovery_settlement_authorization_hash(
            circle_id, round, member_ref, helper, pool, token, amount, open_note_id, nonce,
        ),
        signature_r,
        signature_s,
    )
}

/// Reliability classification of a contribution obligation (INV-018).
/// No default variant: uninitialized storage must not become a valid status.
#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum ContributionStatus {
    Pending,
    OnTime,
    LateWithinGrace,
    MissedDefault,
}

/// Circle lifecycle (ARCHITECTURE.md). Rounds are tracked as `current_round`,
/// not extra status variants.
#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum CircleStatus {
    Created,
    OpenForMembers,
    Active,
    PausedForNewActions,
    /// Terminal accounting requirements are fixed, but real value movement
    /// remains outstanding. Only Task 8 may reach financial completion.
    SettlementPending,
    Completed,
}

/// First-release allowlist (INV-008). Unknown assets are rejected at the
/// contract boundary in Task 6.
#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum SupportedAsset {
    Usdc,
    Strk,
}

/// Deterministic payout scheduling. DeferredLocked is the deficit path;
/// Recovered is the final-settlement recovery/refund path (INV-009, INV-020).
#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum PayoutStatus {
    /// Accounting-ready for later authenticated token settlement. No funds
    /// have moved merely because this state exists.
    Scheduled,
    /// Preserved for the scheduled member while their deficit is unresolved.
    DeferredLocked,
    /// The scheduled member authorized exact settlement accounting. Tokens
    /// have not moved.
    SettlementAuthorized,
    /// Final deterministic recovery accounting exists for the same rightful
    /// member and amount. Tokens have not moved.
    RecoveryPending,
    /// The round has no funded value available for recovery. The original
    /// recipient and nominal payout remain recorded, but no token movement or
    /// settlement authorization exists to consume.
    NoFundedRecovery,
    Paid,
    Recovered,
}

/// How a MISSED_DEFAULT obligation may be cured (locked August 28, 2026).
/// Not caller-configurable; persisted on each circle so Task 6F does not
/// change the domain model. Cure *execution* is not implemented in 6A.
#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum CureEligibility {
    /// Only an unresolved contribution deficit for one circle + round +
    /// obligation that is already MISSED_DEFAULT.
    MissedDefaultObligation,
}

#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum CureWindow {
    /// Open until that member's deferred payout reaches final
    /// settlement/recovery. No admin extension.
    UntilFinalSettlement,
}

#[allow(starknet::store_no_default_variant)]
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub enum CureAmount {
    /// Exact unresolved contribution deficit. No partial cure in MVP.
    ExactDeficit,
}

#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct CureConfig {
    pub eligibility: CureEligibility,
    pub window: CureWindow,
    pub amount: CureAmount,
    /// Always false: a cure must not rewrite MISSED_DEFAULT (INV-004).
    pub rewrite_history: bool,
    /// Always false: admin cannot waive, resize, extend, erase, or release.
    pub admin_discretion: bool,
}

pub fn locked_cure_config() -> CureConfig {
    CureConfig {
        eligibility: CureEligibility::MissedDefaultObligation,
        window: CureWindow::UntilFinalSettlement,
        amount: CureAmount::ExactDeficit,
        rewrite_history: false,
        admin_discretion: false,
    }
}

/// Circle configuration agreed at creation. Payout order is stored separately
/// as a locked sequence of member refs (Task 6).
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct CircleConfig {
    pub asset: SupportedAsset,
    pub contribution_amount: u128,
    pub cadence_seconds: u64,
    pub grace_period_seconds: u64,
    pub member_limit: u8,
}

/// A member is an opaque commitment plus a slot. Not a wallet address.
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct Member {
    pub circle_id: u32,
    pub member_ref: felt252,
    pub slot: u8,
}

/// One required contribution per member per round.
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct ContributionObligation {
    pub circle_id: u32,
    pub round: u32,
    pub member_ref: felt252,
    /// Locked accounting terms. These do not assert that tokens moved.
    pub asset: SupportedAsset,
    pub required_amount: u128,
    pub due_at: u64,
    pub grace_ends_at: u64,
    pub status: ContributionStatus,
}

/// Financial-deficit state is separate from immutable contribution history.
/// Only the pinned helper may set `deficit_settled`; Task 8 must make that
/// helper call atomic with the corresponding STRK20 value movement.
#[derive(Copy, Drop, Serde, PartialEq)]
pub struct CureState {
    pub circle_id: u32,
    pub round: u32,
    pub member_ref: felt252,
    pub deficit_amount: u128,
    pub deficit_settled: bool,
    /// Task 6F only observes this deterministic boundary. A later payout /
    /// final-settlement slice may close it; no admin setter exists.
    pub window_open: bool,
}

/// Deterministic payout state for a round.
#[derive(Copy, Drop, Serde, PartialEq, starknet::Store)]
pub struct PayoutState {
    pub circle_id: u32,
    pub round: u32,
    pub scheduled_member_ref: felt252,
    /// Locked rotating-pot amount. This is accounting, not a transfer claim.
    pub amount: u128,
    pub status: PayoutStatus,
}

#[derive(Copy, Drop, Serde, PartialEq)]
pub struct SettlementConfig {
    pub settlement_helper: ContractAddress,
    pub privacy_pool: ContractAddress,
    /// Non-zero only during deployment wiring. Cleared permanently when the
    /// helper is initialized successfully.
    pub setup_authority: ContractAddress,
    pub helper_initialized: bool,
}

/// Helper-confirmed value conservation for exactly one circle round and its
/// locked token. No field may be credited by a public accounting-only call.
#[derive(Copy, Drop, Serde, PartialEq)]
pub struct RoundLiability {
    pub circle_id: u32,
    pub round: u32,
    pub token: ContractAddress,
    pub settled_inflows: u256,
    pub settled_outflows: u256,
    pub outstanding: u256,
}

/// Scoped Portable Trust Credential claim. Not a numerical credit score.
#[derive(Copy, Drop, Serde, PartialEq)]
pub enum CredentialClaim {
    CompletedCycles: u32,
    NoDefaults,
    OnTimeRate: u32,
}
