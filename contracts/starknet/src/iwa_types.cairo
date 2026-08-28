// Chain-neutral IWA domain types for the Cairo implementation.
// Identities are felt252 commitments (INV-013), never ContractAddress.
// Token addresses stay in chain config; the domain allowlist is this enum.

use core::poseidon::poseidon_hash_span;

/// Domain-separated invite commitment. Off-chain invite secrets never appear
/// in storage or events. Join proves possession of the preimage.
pub const INVITE_DOMAIN_TAG: felt252 = 'IWA_INVITE_V1';

pub fn invite_commitment(secret: felt252) -> felt252 {
    poseidon_hash_span(array![INVITE_DOMAIN_TAG, secret].span())
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
    pub due_at: u64,
    pub grace_ends_at: u64,
    pub status: ContributionStatus,
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
