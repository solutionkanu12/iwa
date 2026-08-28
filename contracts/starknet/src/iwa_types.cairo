// Chain-neutral IWA domain types for the Cairo implementation.
// Identities are felt252 commitments (INV-013), never ContractAddress.
// Token addresses stay in chain config; the domain allowlist is this enum.

use core::ec::{EcPointTrait, stark_curve};
use core::ecdsa::check_ecdsa_signature;
use core::poseidon::poseidon_hash_span;

/// Domain-separated invite commitment. Off-chain invite secrets never appear
/// in storage or events. Join proves possession of the preimage.
pub const INVITE_DOMAIN_TAG: felt252 = 'IWA_INVITE_V1';
pub const CONTRIBUTION_AUTH_DOMAIN_TAG: felt252 = 'IWA_CONTRIBUTION_V1';
pub const CURE_AUTH_DOMAIN_TAG: felt252 = 'IWA_CURE_V1';

pub fn invite_commitment(secret: felt252) -> felt252 {
    poseidon_hash_span(array![INVITE_DOMAIN_TAG, secret].span())
}

/// A member authentication key is an x-coordinate on the Stark curve. It is
/// independent of any Starknet account and is registered once during join.
pub fn is_valid_auth_public_key(public_key: felt252) -> bool {
    public_key != 0 && EcPointTrait::new_nz_from_x(public_key).is_some()
}

/// Domain-separated authorization for one exact contribution obligation.
/// The nonce is consumed by the contribution/helper state transition in 6D;
/// this task only defines and verifies the signed message.
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

/// Domain-separated authorization for settling the exact stored deficit of
/// one historical MISSED_DEFAULT obligation. This does not attest token
/// movement; Task 8 must bind it to verified STRK20 settlement.
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
    Scheduled,
    DeferredLocked,
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

/// Financial-deficit accounting is separate from immutable contribution
/// history. `deficit_settled` does not assert that tokens moved.
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
    pub status: PayoutStatus,
}

/// Scoped Portable Trust Credential claim. Not a numerical credit score.
#[derive(Copy, Drop, Serde, PartialEq)]
pub enum CredentialClaim {
    CompletedCycles: u32,
    NoDefaults,
    OnTimeRate: u32,
}
