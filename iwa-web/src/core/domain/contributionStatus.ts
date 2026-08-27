// core/domain/contributionStatus.ts — chain-neutral contribution timing
// classification. Mirrors the locked grace rule (INV-018) for UI and tests.
// Contracts remain the authoritative classifier; this helper must not drift.
//
// Settled:
//   settledAt <= due_at                  -> ON_TIME
//   due_at < settledAt <= grace_ends_at  -> LATE_WITHIN_GRACE
//   settledAt > grace_ends_at            -> MISSED_DEFAULT (invalid settlement)
// Unsettled:
//   now <= grace_ends_at                 -> PENDING
//   now > grace_ends_at                  -> MISSED_DEFAULT

import type { ContributionStatus } from "./types";

/**
 * Classify a contribution obligation from one timestamp source.
 *
 * Pass `settledAt` when a settlement exists: the status the settlement
 * receives (a settlement after `graceEndsAt` is invalid — reported as
 * MISSED_DEFAULT so the caller can reject it). Without `settledAt`, the
 * obligation is still payable (PENDING) while `now <= graceEndsAt` and
 * becomes MISSED_DEFAULT once the grace window expires.
 */
export function classifyContribution(
  now: number,
  dueAt: number,
  graceEndsAt: number,
  settledAt?: number,
): ContributionStatus {
  if (settledAt !== undefined) {
    if (settledAt <= dueAt) return "ON_TIME";
    if (settledAt <= graceEndsAt) return "LATE_WITHIN_GRACE";
    return "MISSED_DEFAULT";
  }
  if (now <= graceEndsAt) return "PENDING";
  return "MISSED_DEFAULT";
}