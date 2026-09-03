// lib/organizerView.ts — what the person running a circle needs to know.
//
// An organizer has a job the savers do not: they set the circle up, they are
// the one people ask when something has stalled, and they are the only person
// who can tell whether a circle is stuck on somebody or simply waiting. That
// job needs facts, and it is the only thing this module produces.
//
// It produces no power. Organizing an Iwa circle is operational, never
// custodial: nothing here can move money, take a turn, waive a default, choose
// a recipient or act for a member, and no state it reports is one an organizer
// resolves by pressing something. The contracts hold no such capability to
// expose, and this module does not invent a softer one in the interface.
//
// WHAT IT MAY SEE
//
// Only the two things the organizer is entitled to. The chain, which is public
// and where every count here comes from: the payout order, who has joined,
// each place's obligation for the round, and the round's payout accounting.
// And the coordination service's own record of their draft, which is how many
// places were accepted. Nothing about a member as a person: no wallet address,
// no member reference, no invite token, no savings elsewhere, no credential.
// Places are positions, and a position is all an organizer needs to chase a
// missing contribution.
//
// Pure and synchronous, so the exact operational picture somebody saw can be
// replayed in a test from the same numbers.

import { sameAddress } from "../chains/starknetProduction";
import { obligationState, recipientSlotFor, type ObligationFacts } from "./roundState";
import type { CircleStatus } from "./types";

/**
 * Whether this wallet organizes this circle.
 *
 * The contract's own record of who created the circle, compared against the
 * connected wallet, and nothing else. Not a role from the coordination
 * service, not a flag in a draft, and certainly not something the browser
 * decided: those can all be wrong or claimed, and the chain cannot.
 *
 * It is also fail closed. No wallet is not an organizer, an unreadable address
 * is not an organizer, and the zero address is not an organizer, so the
 * operational view stays hidden unless the chain positively says otherwise.
 */
export function isOrganizer(circleOrganizer: string | null, address: string | null): boolean {
  if (circleOrganizer === null || address === null) return false;
  try {
    if (BigInt(circleOrganizer) === 0n) return false;
  } catch {
    return false;
  }
  return sameAddress(circleOrganizer, address);
}

/** PayoutStatus, exactly the contract's declaration order. */
export type PayoutStatusName =
  | "Scheduled"
  | "DeferredLocked"
  | "SettlementAuthorized"
  | "RecoveryPending"
  | "NoFundedRecovery"
  | "Paid"
  | "Recovered";

/**
 * A round's payout accounting, as far as it can be established.
 *
 * `notPrepared` is a fact, not a failure: the contract holds no payout record
 * for a round until every obligation in it is final, and it says so with a
 * distinct error. `unavailable` is the honest third answer for a read that did
 * not come back, and it is deliberately not folded into `notPrepared`, because
 * a network failure is not evidence about a circle.
 */
export type PayoutAccounting =
  | { kind: "prepared"; status: PayoutStatusName }
  | { kind: "notPrepared" }
  | { kind: "unavailable" };

/** One place in the locked payout order, as the chain reports it. */
export interface PlaceFacts {
  /** Zero based position in the payout order. */
  slot: number;
  /** The contract counts this place's member as joined. */
  joined: boolean;
  /** This place's obligation for the round being shown, when one exists. */
  obligation: ObligationFacts | null;
}

export interface OrganizerFacts {
  /** member_limit. Also the number of rounds and the number of places. */
  memberLimit: number;
  /** joined_count, the contract's own counter. */
  joinedCount: number;
  /**
   * Places accepted, from the organizer's own draft. Null when the service has
   * not said, which is not the same as nobody having accepted.
   */
  acceptedCount: number | null;
  round: number;
  circleStatus: CircleStatus;
  places: readonly PlaceFacts[];
  /** Payout accounting for the round in progress. */
  payout: PayoutAccounting;
  /** The round before this one, when there is one and it was read. */
  priorPayout: PayoutAccounting | null;
  /** Unix seconds. */
  now: number;
}

export interface OrganizerCounts {
  places: number;
  /** Null when the coordination service has not been asked. */
  accepted: number | null;
  joined: number;
  paid: number;
  due: number;
  grace: number;
  /** The grace window closed and the contract has not recorded a default yet. */
  overdue: number;
  missed: number;
}

/**
 * Where the circle's operational work has got to.
 *
 * One state, chosen by what is actually blocking, so a screen can say the one
 * true thing rather than list every state it is not in.
 */
export type OperationalState =
  | "waitingToJoin"
  | "waitingForContributions"
  | "gracePeriod"
  | "pastGrace"
  | "accountingReady"
  | "waitingForRecipient"
  | "settling"
  | "payoutHeld"
  | "roundPaid"
  | "finalSettlement"
  | "complete"
  | "unavailable";

export interface OrganizerRow {
  key: string;
  label: string;
  value: string;
}

export interface OrganizerPlaceRow {
  key: string;
  /** A position, never a person. */
  label: string;
  joinLabel: string;
  /** Null when the place has not joined, since it can owe nothing yet. */
  paymentLabel: string | null;
  /** Whether this place needs the organizer to chase something. */
  needsAttention: boolean;
  /** This round pays out to this place. */
  payoutTurn: boolean;
}

export interface OrganizerSummary {
  counts: OrganizerCounts;
  rows: OrganizerRow[];
  places: OrganizerPlaceRow[];
  state: OperationalState;
  /** Plain words for `state`. */
  stateLabel: string;
  /** Everything blocking, in plain words. Empty when nothing is. */
  attention: string[];
  /** One based place collecting this round, or null when there is none. */
  payoutTurnPlace: number | null;
}

/**
 * The words.
 *
 * Kept together so they can be read as a set, and so a test can check the whole
 * vocabulary at once. Nothing here mentions finalizing, settlement accounting,
 * state transitions or authorization: those are the contract's words for its
 * own bookkeeping, and an organizer is a person with a savings group, not an
 * operator of a protocol.
 */
export const ORGANIZER_COPY = {
  heading: "Running this circle",
  lede: "What is happening across the places, and what it is waiting on.",
  placesHeading: "Progress by place",
  waitingToJoin: "Waiting for people to join",
  waitingForContributions: "Waiting for contributions",
  gracePeriod: "Grace period is active",
  pastGrace: "A contribution is past its grace period",
  accountingReady: "Round accounting is ready",
  waitingForRecipient: "Waiting for the current recipient",
  settling: "The payout is authorized and settling",
  payoutHeld: "The payout is held while a shortfall is unresolved",
  roundPaid: "This round has paid out",
  finalSettlement: "This round is in final settlement",
  complete: "This circle has finished",
  unavailable: "This round could not be read just now",
  /** Said only when the organizer is not also a member of their own circle. */
  noMemberPowers:
    "You can see progress here. Contributions and payouts stay with the people they belong to.",
} as const;

const STATE_LABEL: Record<OperationalState, string> = {
  waitingToJoin: ORGANIZER_COPY.waitingToJoin,
  waitingForContributions: ORGANIZER_COPY.waitingForContributions,
  gracePeriod: ORGANIZER_COPY.gracePeriod,
  pastGrace: ORGANIZER_COPY.pastGrace,
  accountingReady: ORGANIZER_COPY.accountingReady,
  waitingForRecipient: ORGANIZER_COPY.waitingForRecipient,
  settling: ORGANIZER_COPY.settling,
  payoutHeld: ORGANIZER_COPY.payoutHeld,
  roundPaid: ORGANIZER_COPY.roundPaid,
  finalSettlement: ORGANIZER_COPY.finalSettlement,
  complete: ORGANIZER_COPY.complete,
  unavailable: ORGANIZER_COPY.unavailable,
};

const PLACE_PAYMENT_LABEL: Record<string, string> = {
  paid: "Paid",
  due: "Due",
  grace: "In the grace period",
  overdue: "Past the grace period",
  missed: "Missed",
  none: "Nothing due yet",
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function countsOf(facts: OrganizerFacts): OrganizerCounts {
  const counts: OrganizerCounts = {
    places: facts.memberLimit,
    accepted: facts.acceptedCount === null ? null : Math.min(facts.acceptedCount, facts.memberLimit),
    joined: facts.joinedCount,
    paid: 0,
    due: 0,
    grace: 0,
    overdue: 0,
    missed: 0,
  };

  for (const place of facts.places) {
    if (!place.joined) continue;
    const { state } = obligationState(place.obligation, facts.now);
    if (state === "paid") counts.paid += 1;
    else if (state === "due") counts.due += 1;
    else if (state === "grace") counts.grace += 1;
    else if (state === "overdue") counts.overdue += 1;
    else if (state === "missed") counts.missed += 1;
  }

  return counts;
}

/**
 * The place collecting this round.
 *
 * `recipient_slot = round - 1`, the contract's own rule, and null once the
 * round is past the last place, which is a circle that has run its course
 * rather than a place nobody can name.
 */
function payoutTurnPlaceOf(facts: OrganizerFacts): number | null {
  const slot = recipientSlotFor(facts.round);
  if (slot < 0 || slot >= facts.memberLimit) return null;
  return slot + 1;
}

function placeRows(facts: OrganizerFacts, turnPlace: number | null): OrganizerPlaceRow[] {
  return facts.places.map((place) => {
    const position = place.slot + 1;
    const { state, late } = obligationState(place.obligation, facts.now);
    const paymentLabel = !place.joined
      ? null
      : state === "paid" && late
        ? "Paid late"
        : PLACE_PAYMENT_LABEL[state];

    return {
      key: `place-${position}`,
      label: `Place ${position}`,
      joinLabel: place.joined ? "Joined" : "Has not joined yet",
      paymentLabel,
      needsAttention:
        !place.joined || state === "due" || state === "grace" || state === "overdue" || state === "missed",
      payoutTurn: turnPlace !== null && position === turnPlace,
    };
  });
}

/** The payout state for a prepared round, in operational terms. */
function stateForPayout(status: PayoutStatusName): OperationalState {
  switch (status) {
    case "Scheduled":
      return "waitingForRecipient";
    case "DeferredLocked":
      return "payoutHeld";
    case "SettlementAuthorized":
      return "settling";
    case "Paid":
      return "roundPaid";
    case "RecoveryPending":
    case "NoFundedRecovery":
    case "Recovered":
      return "finalSettlement";
  }
}

/**
 * The one thing this circle is waiting on.
 *
 * Ordered by what actually blocks progress. People who have not joined come
 * first because nothing else can happen until they do; a pending contribution
 * comes next; and only once every obligation is final does the round's own
 * accounting become the answer.
 */
function stateOf(facts: OrganizerFacts, counts: OrganizerCounts): OperationalState {
  if (facts.circleStatus === "complete") return "complete";
  if (facts.places.length === 0) return "unavailable";
  if (counts.joined < counts.places) return "waitingToJoin";

  if (counts.overdue > 0) return "pastGrace";
  if (counts.grace > 0) return "gracePeriod";
  if (counts.due > 0) return "waitingForContributions";

  // Nothing is pending. Either every obligation is final, or the round has no
  // obligations at all, and those are different situations.
  const settled = counts.paid + counts.missed;
  if (settled < counts.places) return "unavailable";

  if (facts.payout.kind === "unavailable") return "unavailable";
  if (facts.payout.kind === "notPrepared") return "accountingReady";
  return stateForPayout(facts.payout.status);
}

/**
 * What is blocking, in the words somebody would use to chase it.
 *
 * Each sentence names a real count from a real read. Nothing is here to fill
 * the space: a circle where everybody has joined and everybody has paid has an
 * empty list, and that is the answer.
 */
function attentionOf(
  facts: OrganizerFacts,
  counts: OrganizerCounts,
  state: OperationalState,
): string[] {
  const lines: string[] = [];

  const notJoined = counts.places - counts.joined;
  if (notJoined > 0) {
    lines.push(
      plural(
        notJoined,
        "1 person accepted but has not joined yet",
        `${notJoined} people accepted but have not joined yet`,
      ),
    );
  }

  if (counts.due > 0) {
    lines.push(
      plural(
        counts.due,
        "1 contribution is still due",
        `${counts.due} contributions are still due`,
      ),
    );
  }

  if (counts.grace > 0) {
    lines.push(
      plural(
        counts.grace,
        "1 contribution is in its grace period",
        `${counts.grace} contributions are in their grace period`,
      ),
    );
  }

  if (counts.overdue > 0) {
    lines.push(
      plural(
        counts.overdue,
        "1 contribution is past its grace period",
        `${counts.overdue} contributions are past their grace period`,
      ),
    );
  }

  if (counts.missed > 0) {
    lines.push(
      plural(counts.missed, "1 contribution was missed", `${counts.missed} contributions were missed`),
    );
  }

  if (state === "accountingReady") lines.push("Round accounting is ready");
  if (state === "waitingForRecipient") {
    lines.push("This round is waiting for the person collecting it");
  }

  // The round before this one, when it was read and has not paid out. Once a
  // round's accounting is prepared the circle moves on, so a pot still sitting
  // there is the kind of thing only the organizer would otherwise notice.
  const prior = facts.priorPayout;
  if (prior !== null && prior.kind === "prepared" && facts.round > 1) {
    const priorRound = facts.round - 1;
    if (prior.status === "Scheduled" || prior.status === "DeferredLocked") {
      lines.push(
        prior.status === "Scheduled"
          ? `The pot for round ${priorRound} is waiting for the person collecting it`
          : `The pot for round ${priorRound} is held while a shortfall is unresolved`,
      );
    }
  }

  return lines;
}

function rowsOf(
  facts: OrganizerFacts,
  counts: OrganizerCounts,
  state: OperationalState,
  turnPlace: number | null,
): OrganizerRow[] {
  const rows: OrganizerRow[] = [
    { key: "places", label: "Places", value: String(counts.places) },
  ];

  if (counts.accepted !== null) {
    rows.push({
      key: "accepted",
      label: "Accepted",
      value: `${counts.accepted} of ${counts.places}`,
    });
  }

  rows.push({
    key: "joined",
    label: "Joined",
    value: `${counts.joined} of ${counts.places}`,
  });

  // Payment counts only mean something once the round has obligations to
  // count. Before that they would all read zero and look like a problem.
  const hasObligations = facts.places.some((p) => p.obligation !== null);
  if (hasObligations) {
    rows.push({
      key: "paid",
      label: "Paid this round",
      value: `${counts.paid} of ${counts.places}`,
    });
    rows.push({ key: "due", label: "Still due", value: String(counts.due) });
    if (counts.grace > 0) {
      rows.push({ key: "grace", label: "In grace", value: String(counts.grace) });
    }
    if (counts.overdue > 0) {
      rows.push({ key: "overdue", label: "Past grace", value: String(counts.overdue) });
    }
    if (counts.missed > 0) {
      rows.push({ key: "missed", label: "Missed", value: String(counts.missed) });
    }
  }

  if (turnPlace !== null) {
    rows.push({ key: "turn", label: "Collecting now", value: `Place ${turnPlace}` });
  }

  rows.push({ key: "state", label: "Right now", value: STATE_LABEL[state] });

  return rows;
}

/** Everything an organizer needs from one circle, and nothing else. */
export function organizerSummary(facts: OrganizerFacts): OrganizerSummary {
  const counts = countsOf(facts);
  const state = stateOf(facts, counts);
  const turnPlace = payoutTurnPlaceOf(facts);

  return {
    counts,
    rows: rowsOf(facts, counts, state, turnPlace),
    places: placeRows(facts, turnPlace),
    state,
    stateLabel: STATE_LABEL[state],
    attention: state === "unavailable" && facts.places.length === 0 ? [] : attentionOf(facts, counts, state),
    payoutTurnPlace: turnPlace,
  };
}

// ------------------------------------------------------------ invite progress

export interface InviteProgress {
  places: number;
  accepted: number;
  waiting: number;
  ready: boolean;
  label: string;
}

/**
 * How far the invitations have got, before there is a circle to read.
 *
 * The only thing an organizer can act on at this stage is a place nobody has
 * taken, and the only action is to share that place's link again, which the
 * setup screen already offers. This adds the count and nothing else: no token
 * is read here, and no invitation is described beyond whether it is taken.
 */
export function inviteProgress(input: { memberCount: number; acceptedCount: number }): InviteProgress {
  const places = Math.max(input.memberCount, 0);
  const accepted = Math.min(Math.max(input.acceptedCount, 0), places);
  const waiting = places - accepted;

  return {
    places,
    accepted,
    waiting,
    ready: waiting === 0 && places > 0,
    label:
      waiting === 0
        ? "Everyone has accepted"
        : plural(
            waiting,
            "1 place still needs to accept",
            `${waiting} places still need to accept`,
          ),
  };
}
