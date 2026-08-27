// core/domain/types.ts — chain-neutral IWA domain model.
//
// No chain-specific types live here: identities are opaque strings, amounts
// are exact decimal strings in base units, and time is seconds. A chain
// adapter (src/chains) maps these to and from chain representations.

// Reliability classification of a contribution obligation. PENDING is the
// unsettled, still-payable state; the three settled states follow the locked
// grace rule (see contributionStatus.ts).
export type ContributionStatus =
  | "PENDING"
  | "ON_TIME"
  | "LATE_WITHIN_GRACE"
  | "MISSED_DEFAULT";

// Circle lifecycle (ARCHITECTURE.md "Circle lifecycle").
export type CircleStatus =
  | "CREATED"
  | "OPEN_FOR_MEMBERS"
  | "ACTIVE"
  | "PAUSED_FOR_NEW_ACTIONS"
  | "COMPLETED";

// Initial release supports exactly USDC and STRK (allowlisted).
export type SupportedAsset = "USDC" | "STRK";

// A round payout is scheduled deterministically; an unresolved deficit of the
// scheduled member locks it (DEFERRED_LOCKED) instead of redirecting it.
// RECOVERED is the deterministic final-settlement recovery/refund path
// (INV-009 / INV-020) — never an admin-chosen redirect.
export type PayoutStatus =
  | "SCHEDULED"
  | "DEFERRED_LOCKED"
  | "PAID"
  | "RECOVERED";

// Conceptual Circle (ARCHITECTURE.md data model). payoutOrder is agreed at
// creation and immutable once contributions begin.
export interface Circle {
  id: string; // opaque chain-neutral circle identifier
  asset: SupportedAsset;
  contributionAmount: string; // base units as decimal string (exact math)
  cadenceSeconds: number; // round length in seconds
  gracePeriodSeconds: number; // grace window after due_at
  memberLimit: number;
  currentRound: number; // starting at 1
  status: CircleStatus;
  payoutOrder: string[]; // member refs in fixed payout order
}

// A member is an opaque reference (a commitment), never an identity.
export interface Member {
  circleId: string;
  memberRef: string; // opaque commitment/reference
  slot: number; // 0-indexed position in the circle
}

// One required contribution per member per round, with deterministic timing.
export interface ContributionObligation {
  circleId: string;
  round: number;
  memberRef: string;
  dueAt: number; // seconds
  graceEndsAt: number; // seconds
  status: ContributionStatus;
}

// Deterministic payout scheduling for a round (locked rotation + deficit rule).
export interface PayoutState {
  circleId: string;
  round: number;
  scheduledMemberRef: string;
  status: PayoutStatus;
}

// A scoped reliability claim (Portable Trust Credential). The verifier sees
// only the requested claim, never raw history. No universal credit score.
export type CredentialClaim =
  | { type: "completed_cycles"; threshold: number }
  | { type: "no_defaults" }
  | { type: "on_time_rate"; threshold: number };