// chains/strk20/contributionGate.ts — preconditions for ONE member's contribution.
//
// The gate is per member, and that distinction is the whole point of this
// module. A round progresses one contribution at a time: once member A settles,
// A's obligation becomes OnTime and stays that way. Requiring every obligation
// in the round to be Pending would therefore make the second contribution
// permanently unreachable the moment the first one succeeded.
//
// Only the contributing member's own obligation is examined. The others are
// none of this transaction's business — the helper reads the obligation it is
// settling and asserts Pending on that one alone.
//
// Pure and synchronous so the exact live state can be replayed in a test.

import { USDC_DECIMALS, STRK_DECIMALS, formatUnits } from "./funding";

/** Contribution status names, as decoded from the circle. */
export type ObligationStatusName = "Pending" | "OnTime" | "LateWithinGrace" | "MissedDefault";

export interface ObligationSnapshot {
  status: ObligationStatusName | string;
}

export interface ContributionGateInput {
  /** Which member is contributing. Only this member's obligation is checked. */
  memberLabel: string;
  walletConnected: boolean;
  registered: boolean | null;
  /** null means "not read yet" — never treated as sufficient. */
  shieldedUsdc: bigint | null;
  shieldedUsdcRequired: bigint;
  shieldCompleted: boolean;
  circleStatus: string | null;
  /** Per-member obligations, keyed by member label. */
  obligations: Record<string, ObligationSnapshot> | null;
  helperSurplus: bigint | null;
  strkAllowance: bigint;
  strkAllowanceRequired: bigint;
  /** Blocks until the shielded note matures; null when unknown. */
  maturityRemaining: number | null;
}

/**
 * Everything blocking this member's contribution. Empty means it may proceed.
 * Each entry is operator-facing text, so a disabled button always says why.
 */
export function contributionBlockers(input: ContributionGateInput): string[] {
  const blockers: string[] = [];

  if (!input.walletConnected) blockers.push("wallet not connected");
  if (input.registered !== true) blockers.push("account not registered with the STRK20 pool");

  if (input.shieldedUsdc === null) {
    blockers.push("shielded USDC not read yet (needs your consent)");
  } else if (input.shieldedUsdc < input.shieldedUsdcRequired) {
    blockers.push(
      `shielded USDC ${formatUnits(input.shieldedUsdc, USDC_DECIMALS)} is below the ` +
        `${formatUnits(input.shieldedUsdcRequired, USDC_DECIMALS)} this round needs`,
    );
  }

  if (!input.shieldCompleted) blockers.push("no verified shield recorded");

  if (input.circleStatus === null) blockers.push("circle not loaded");
  else if (input.circleStatus !== "Active") blockers.push(`circle is ${input.circleStatus}`);

  // Per member. A settled peer never blocks this contribution.
  if (input.obligations === null) {
    blockers.push("obligations not read");
  } else {
    const own = input.obligations[input.memberLabel];
    if (own === undefined) {
      blockers.push(`member ${input.memberLabel} has no obligation in this round`);
    } else if (own.status !== "Pending") {
      blockers.push(
        own.status === "OnTime" || own.status === "LateWithinGrace"
          ? `member ${input.memberLabel} has already contributed (${own.status})`
          : `member ${input.memberLabel} obligation is ${own.status}, not Pending`,
      );
    }
  }

  if (input.helperSurplus === null) blockers.push("helper surplus not read");
  else if (input.helperSurplus !== 0n) {
    blockers.push(
      `helper holds ${formatUnits(input.helperSurplus, USDC_DECIMALS)} USDC of unaccounted ` +
        "surplus — call normalize_surplus(USDC) first",
    );
  }

  if (input.strkAllowance < input.strkAllowanceRequired) {
    blockers.push(
      `STRK allowance ${formatUnits(input.strkAllowance, STRK_DECIMALS)} is below the ` +
        `${formatUnits(input.strkAllowanceRequired, STRK_DECIMALS)} of remaining pool fees`,
    );
  }

  if (input.maturityRemaining === null) {
    blockers.push("shield block unknown — re-import the shield transaction");
  } else if (input.maturityRemaining > 0) {
    blockers.push(`${input.maturityRemaining} blocks until the shielded note matures`);
  }

  return blockers;
}

/** True when this member's contribution has already settled. */
export function hasContributed(
  obligations: Record<string, ObligationSnapshot> | null,
  memberLabel: string,
): boolean {
  const own = obligations?.[memberLabel];
  return own?.status === "OnTime" || own?.status === "LateWithinGrace";
}
