// Shared seam types. The UI imports these and the two seam modules only.
// Return shapes here match PRD sections 11 and 13 so the real Soroban + ZK
// backend drops in behind lib/iwaContract.ts and lib/zk.ts with no UI changes.

export interface CircleConfig {
  amount: number; // contribution per round, USDC
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
  id: string;
  amount: number;
  frequency: number;
  size: number;
  current_round: number;
  status: CircleStatus;
  pot: number; // amount * size, derived
  members: MemberSlot[];
  yourStreak: number; // on-time streak for the connected member
}

// A reputation claim the member chooses to prove. Demo threshold is small
// (N = 2): completed at least N cycles with zero defaults (PRD section 12.3).
export interface Claim {
  threshold: number;
  statement: string;
}

export interface ProofResult {
  proof: string;
  publicSignals: string[];
  claim: Claim;
}

// The saver's own reputation record (PRD section 12.2). on_time / zero defaults
// are the good-standing signals. Private to the saver; never shared until they
// choose to prove it.
export interface Reputation {
  completedCycles: number;
  onTimeRate: number; // percent, 0 to 100
  defaultCount: number;
}
