// Chain-neutral IWA domain types for the Cairo implementation.
// Identities are felt252 commitments (INV-013), never ContractAddress.
// Token addresses stay in chain config; the domain allowlist is this enum.

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
