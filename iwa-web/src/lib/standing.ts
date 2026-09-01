// lib/standing.ts — a member's record, counted from what the contract holds.
//
// Every figure here is one the chain can settle. The contract keeps one
// obligation per member per round, each of which ends On time, Late within the
// grace window, or Missed. Counting those is the whole of a member's record,
// and nothing is added to it.
//
// THE RATE IS NULLABLE ON PURPOSE. The version this replaces reported one
// hundred per cent on time for a member who had never contributed, because a
// division by zero was defaulted rather than refused. That is a claim about a
// record which does not exist. With no completed rounds the rate is null, and
// the screen says there is no record yet.
//
// There is no score, no band and no grade. A rate and three counts describe
// what happened; a score would be a judgement about it, and Iwa does not make
// one. It is a Portable Trust Credential, never a credit score.

/** How one round ended for one member, as the contract reports it. */
export type ObligationOutcome = "Pending" | "OnTime" | "LateWithinGrace" | "MissedDefault";

export interface Standing {
  /** Rounds that reached an outcome. A pending round is not one of them. */
  completedCycles: number;
  onTimeCount: number;
  lateCount: number;
  defaultCount: number;
  /** Percentage on time, or null when nothing has been settled yet. */
  onTimeRate: number | null;
}

/** Counts a member's outcomes. Nothing is inferred beyond what is in them. */
export function standingFrom(outcomes: readonly ObligationOutcome[]): Standing {
  let onTimeCount = 0;
  let lateCount = 0;
  let defaultCount = 0;

  for (const outcome of outcomes) {
    if (outcome === "OnTime") onTimeCount += 1;
    else if (outcome === "LateWithinGrace") lateCount += 1;
    else if (outcome === "MissedDefault") defaultCount += 1;
  }

  const completedCycles = onTimeCount + lateCount + defaultCount;
  return {
    completedCycles,
    onTimeCount,
    lateCount,
    defaultCount,
    onTimeRate:
      completedCycles === 0 ? null : Math.round((onTimeCount / completedCycles) * 100),
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The record in a sentence.
 *
 * "always on time" has to be earned: every completed round on time, and at
 * least one of them. It was previously printed unconditionally, over records
 * that included late rounds and defaults alike.
 */
export function standingSummary(s: Standing): string {
  if (s.completedCycles === 0) return "No rounds completed yet";

  const parts = [plural(s.completedCycles, "round completed", "rounds completed")];

  if (s.defaultCount === 0 && s.lateCount === 0) {
    parts.push("always on time");
  } else {
    if (s.lateCount > 0) parts.push(plural(s.lateCount, "paid late", "paid late"));
    if (s.defaultCount > 0) parts.push(plural(s.defaultCount, "default", "defaults"));
  }

  if (s.defaultCount === 0) parts.push("no defaults");

  return parts.join(", ");
}
