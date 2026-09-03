// Shared seam types. The UI imports these and the two seam modules only.
// Return shapes here match PRD sections 11 and 13 so the real Soroban + ZK
// backend drops in behind lib/iwaStarknet.ts and lib/zk.ts with no UI changes.

import type { SnarkProof } from "./convert";

export interface CircleConfig {
  amount: number; // contribution per round, in the circle's token
  frequency: number; // seconds per round
  size: number; // number of members
}

export type CircleStatus = "forming" | "active" | "complete";

export interface MemberSlot {
  slot: number; // 0-indexed position in the circle
  filled: boolean; // taken by an anonymous member
  isYou: boolean; // this slot is the connected member
}

// PRD section 13 Circle (id, amount, frequency, size, current_round, status)
// plus the derived fields the circle screen renders (pot, anonymous slots,
// your streak). All identity stays as opaque slots, never names.
export interface Circle {
  id: number; // circle id (u32 on chain)
  token: string; // the circle's token; resolves to a symbol
  trust_required: boolean; // join requires a verified reputation proof
  /** Contribution per round in the token's BASE UNITS. Formatted once, at display. */
  amount: bigint;
  frequency: number;
  size: number; // places in the circle (member_limit on chain)
  current_round: number;
  status: CircleStatus;
  /** amount * size, in base units. */
  pot: bigint;
  members: MemberSlot[]; // payout order; `filled` means reserved, not joined
  /** How many of the reserved places have actually called join_circle. */
  joinedCount: number;
  /**
   * The address that created the circle, as the contract recorded it. Public
   * on chain, and the only thing that establishes who organizes a circle: a
   * claim from the coordination service could not, and a claim from the
   * browser certainly could not.
   */
  organizer: string;
  /** A place in the payout order holds the connected wallet's commitment. */
  reserved: boolean;
  /** The contract counts the connected wallet as a joined member. */
  youJoined: boolean;
  yourStreak: number; // on-time streak for the connected member
}

// A reputation claim the member chooses to prove. Demo threshold is small
// (N = 2): completed at least N cycles with zero defaults (PRD section 12.3).
export interface Claim {
  threshold: number;
  statement: string;
}

// A generated Groth16 proof. proof carries the curve points (decimal strings)
// the on-chain verifier needs; publicSignals are [nullifier, threshold, root]
// as decimal strings, in the order snarkjs emits them.
export interface ProofResult {
  proof: SnarkProof;
  publicSignals: string[];
  claim: Claim;
}

// The saver's own reputation record (PRD section 12.2). on_time / zero defaults
// are the good-standing signals. Private to the saver; never shared until they
// choose to prove it.
// Superseded by `Standing` in lib/standing.ts, which counts late rounds
// separately and leaves the rate null when there is nothing to rate. Kept as an
// alias so the older Soroban seam still compiles against the same shape.
export type Reputation = import("./standing").Standing;
