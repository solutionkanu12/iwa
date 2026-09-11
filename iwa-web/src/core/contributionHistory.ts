// core/contributionHistory.ts — settled contribution records for standing
// and later Portable Trust Credentials. Failed payments must never be
// written here.

import { classifyContribution } from "./domain/contributionStatus";
import type { ContributionObligation, ContributionStatus } from "./domain/types";

export interface SettledContribution {
  obligation: ContributionObligation;
  txHash: string;
  settledAt: number;
}

export type StandingOutcome = "OnTime" | "LateWithinGrace" | "MissedDefault";

export class ContributionHistory {
  private readonly records: SettledContribution[] = [];

  list(): readonly SettledContribution[] {
    return this.records;
  }

  get(circleId: string, round: number, memberRef: string): SettledContribution | null {
    return (
      this.records.find(
        (r) =>
          r.obligation.circleId === circleId &&
          r.obligation.round === round &&
          r.obligation.memberRef === memberRef,
      ) ?? null
    );
  }

  /**
   * Record a confirmed settlement. Rejects duplicates and settlements
   * after the grace window (those are MISSED_DEFAULT, not a valid pay).
   */
  recordConfirmed(input: {
    circleId: string;
    round: number;
    memberRef: string;
    dueAt: number;
    graceEndsAt: number;
    settledAt: number;
    txHash: string;
  }): ContributionObligation {
    if (this.get(input.circleId, input.round, input.memberRef) !== null) {
      throw new Error("Contribution already recorded for this member and round");
    }
    if (!input.txHash) {
      throw new Error("Cannot record a contribution without a transaction");
    }
    const status: ContributionStatus = classifyContribution(
      input.settledAt,
      input.dueAt,
      input.graceEndsAt,
      input.settledAt,
    );
    if (status === "MISSED_DEFAULT") {
      throw new Error("Settlement after the grace window cannot mark a contribution complete");
    }
    const obligation: ContributionObligation = {
      circleId: input.circleId,
      round: input.round,
      memberRef: input.memberRef,
      dueAt: input.dueAt,
      graceEndsAt: input.graceEndsAt,
      status,
    };
    this.records.push({ obligation, txHash: input.txHash, settledAt: input.settledAt });
    return obligation;
  }

  standingOutcomes(): StandingOutcome[] {
    const out: StandingOutcome[] = [];
    for (const r of this.records) {
      if (r.obligation.status === "ON_TIME") out.push("OnTime");
      else if (r.obligation.status === "LATE_WITHIN_GRACE") out.push("LateWithinGrace");
    }
    return out;
  }
}
