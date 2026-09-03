// lib/roundState.ts — what is happening in this circle right now.
//
// A saver opening a circle wants four answers: which round is this, do I owe
// anything, when, and whose turn is it to collect. The contract holds all four,
// but it holds them as an obligation status, two unix timestamps and a payout
// order, which is not what anybody wants to read.
//
// Everything here is derived from values the chain actually returns. Nothing is
// estimated and no date is invented. Where the chain does not yet hold a fact,
// this says so in words rather than filling the gap with a plausible number:
// the obligations for a future round genuinely do not exist yet, so no future
// round is given a date.
//
// Pure and synchronous, so the exact state a person saw can be replayed in a
// test from the same numbers.

/** Obligation status names, exactly the contract's ContributionStatus. */
export type ObligationStatus = "Pending" | "OnTime" | "LateWithinGrace" | "MissedDefault";

/** One member's obligation for one round, as the contract holds it. */
export interface ObligationFacts {
  status: ObligationStatus;
  requiredAmount: bigint;
  /** Unix seconds. `due_at` on chain. */
  dueAt: number;
  /** Unix seconds. `grace_ends_at` on chain, always dueAt + grace. */
  graceEndsAt: number;
}

export interface RoundFacts {
  round: number;
  /** member_limit. Also the number of rounds, since every member collects once. */
  memberLimit: number;
  contributionAmount: bigint;
  circleStatus: "created" | "open" | "active" | "complete" | string;
  /** This wallet has joined on chain. */
  youJoined: boolean;
  /** A place in the payout order holds this wallet's commitment. */
  reserved: boolean;
  /** Zero based position of this wallet in the payout order, or null. */
  yourSlot: number | null;
  /** This round's obligation for this wallet, when it exists. */
  obligation: ObligationFacts | null;
  /** Unix seconds. */
  now: number;
}

/**
 * Where this member stands on this round's contribution.
 *
 * `overdue` is deliberately distinct from `missed`. The grace window can close
 * before anybody calls the contract to record the default, so for a while the
 * chain still says Pending while the deadline has passed. Calling that a
 * default would be asserting something the contract has not recorded; calling
 * it merely late would be softer than the truth.
 */
export type PaymentState =
  | "notJoined"
  | "paid"
  | "due"
  | "grace"
  | "overdue"
  | "missed"
  | "none";

export interface RoundSummary {
  round: number;
  totalRounds: number;
  contributionAmount: bigint;
  /** contribution * members. What the person whose turn it is collects. */
  potAmount: bigint;
  payment: PaymentState;
  /** Plain words for `payment`. */
  paymentLabel: string;
  /** Paid, but after the deadline and inside the grace window. */
  paidLate: boolean;
  /** This round pays out to this wallet. */
  yourTurn: boolean;
  /** Whose turn it is, without naming anybody. */
  turnLabel: string;
  /** The one thing to do next, or null when there is nothing. */
  nextAction: string | null;
  dueAt: number | null;
  graceEndsAt: number | null;
}

const DAY = 86_400;

/**
 * A deadline in words a person can act on.
 *
 * Days only. An hour count implies a precision that a chain timestamp and a
 * user's clock do not really share, and "in 3 days" is what somebody deciding
 * whether to pay today actually needs.
 */
export function relativeDay(target: number, now: number): string {
  const diff = target - now;
  const days = Math.round(diff / DAY);
  if (diff >= 0) {
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    return `in ${days} days`;
  }
  const ago = Math.abs(days);
  if (ago === 0) return "today";
  if (ago === 1) return "yesterday";
  return `${ago} days ago`;
}

/**
 * Which round pays out to which place.
 *
 * `recipient_slot = round - 1`, read straight from the contract, where the
 * payout order is both the member set and the recipient schedule. Derived here
 * rather than read, because the payout record for a round is only written once
 * that round's contributions are all final, so asking the chain for it says
 * nothing at all for the round currently in progress.
 */
export function recipientSlotFor(round: number): number {
  return round - 1;
}

function paymentOf(facts: RoundFacts): { state: PaymentState; late: boolean } {
  if (!facts.youJoined) return { state: "notJoined", late: false };

  const o = facts.obligation;
  if (o === null) return { state: "none", late: false };

  if (o.status === "OnTime") return { state: "paid", late: false };
  if (o.status === "LateWithinGrace") return { state: "paid", late: true };
  if (o.status === "MissedDefault") return { state: "missed", late: false };

  // Pending. Which of the three windows are we in.
  if (facts.now < o.dueAt) return { state: "due", late: false };
  if (facts.now < o.graceEndsAt) return { state: "grace", late: false };
  return { state: "overdue", late: false };
}

const PAYMENT_LABEL: Record<PaymentState, string> = {
  notJoined: "Not joined yet",
  paid: "Paid",
  due: "Contribution due",
  grace: "Grace period",
  overdue: "Payment overdue",
  missed: "Missed",
  none: "Nothing due yet",
};

export function roundSummary(facts: RoundFacts): RoundSummary {
  const { state, late } = paymentOf(facts);
  const potAmount = facts.contributionAmount * BigInt(facts.memberLimit);
  const yourTurn =
    facts.yourSlot !== null && facts.yourSlot === recipientSlotFor(facts.round);

  const turnLabel = yourTurn
    ? "Your turn to collect"
    : `Turn ${facts.round} of ${facts.memberLimit}`;

  return {
    round: facts.round,
    totalRounds: facts.memberLimit,
    contributionAmount: facts.contributionAmount,
    potAmount,
    payment: state,
    paymentLabel: PAYMENT_LABEL[state],
    paidLate: late,
    yourTurn,
    turnLabel,
    nextAction: nextActionFor(state, facts),
    dueAt: facts.obligation?.dueAt ?? null,
    graceEndsAt: facts.obligation?.graceEndsAt ?? null,
  };
}

/**
 * The single next thing, or nothing.
 *
 * One sentence, never a list. A screen that offers three things at once is a
 * screen nobody acts on, and the point of this whole module is that a person
 * should be able to look once and know.
 */
function nextActionFor(state: PaymentState, facts: RoundFacts): string | null {
  const o = facts.obligation;

  switch (state) {
    case "notJoined":
      return facts.reserved ? "Take your place in this circle." : null;
    case "due":
      return o === null
        ? "Contribute this round."
        : `Contribute before ${relativeDay(o.dueAt, facts.now)}.`;
    case "grace":
      return o === null
        ? "Contribute now."
        : `Contribute now. The grace period ends ${relativeDay(o.graceEndsAt, facts.now)}.`;
    case "overdue":
      return "Contribute now. This round is past its grace period.";
    case "missed":
      return "This round was missed. Paying the shortfall keeps the circle whole.";
    case "paid":
      // Nothing to do, including when it is this member's turn to collect.
      // That is already said once by `turnLabel`, and saying it twice in two
      // different places is how a screen stops being read.
      return null;
    case "none":
      return null;
  }
}

// ------------------------------------------------------------------ timeline

export type TimelineTone = "done" | "current" | "upcoming";

export interface TimelineEntry {
  key: string;
  label: string;
  /** A real date in words, or an honest relative note. Never an invented date. */
  detail: string | null;
  tone: TimelineTone;
}

export interface TimelineFacts {
  currentRound: number;
  memberLimit: number;
  /** Unix seconds. `created_at` on chain. */
  createdAt: number | null;
  /** This round's obligation, the only round whose dates exist on chain. */
  obligation: ObligationFacts | null;
  circleComplete: boolean;
  now: number;
}

/**
 * The circle from start to finish, one entry per round.
 *
 * Only the round in progress carries dates, because only its obligation exists.
 * The contract writes each round's `due_at` when that round begins, so a future
 * round has no deadline yet, and printing one worked out from the cadence would
 * be presenting a guess in the same typeface as a fact. Those rounds say when
 * they begin in relative terms instead, which is true and is all anybody needs.
 */
export function circleTimeline(facts: TimelineFacts): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  entries.push({
    key: "start",
    label: "Circle started",
    detail: facts.createdAt === null ? null : relativeDay(facts.createdAt, facts.now),
    tone: "done",
  });

  for (let round = 1; round <= facts.memberLimit; round += 1) {
    const isCurrent = round === facts.currentRound && !facts.circleComplete;
    const isPast = round < facts.currentRound || facts.circleComplete;

    let detail: string | null = null;
    if (isCurrent && facts.obligation !== null) {
      detail = `Due ${relativeDay(facts.obligation.dueAt, facts.now)}`;
    } else if (isPast) {
      detail = "Completed";
    } else if (round === facts.currentRound + 1) {
      detail = "Begins when this round completes";
    }

    entries.push({
      key: `round-${round}`,
      label: `Round ${round}`,
      detail,
      tone: isCurrent ? "current" : isPast ? "done" : "upcoming",
    });
  }

  entries.push({
    key: "end",
    label: "Everyone has collected",
    detail: facts.circleComplete ? "Completed" : null,
    tone: facts.circleComplete ? "done" : "upcoming",
  });

  return entries;
}
