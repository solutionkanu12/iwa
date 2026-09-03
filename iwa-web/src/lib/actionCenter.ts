// lib/actionCenter.ts — the few things actually waiting on this person.
//
// Not a feed and not a dashboard. It answers one question, which is whether
// anything needs doing right now, and its most common correct answer is that
// nothing does. A list that always has something in it teaches people to stop
// reading it, so a task appears here only when there is a real thing to do and
// a real place to do it.
//
// Everything is derived from state that already exists: what the coordination
// service knows about a person's circles, and what the chain says about the
// round in progress. Nothing new is stored, and no task is a reminder record
// with a life of its own. That matters, because a stored reminder can be wrong
// after the fact and a derived one cannot.
//
// WHAT THIS DELIBERATELY CANNOT SEE
//
// An invitation nobody has accepted yet. An invite is a link holding a token,
// and the service only records a wallet against a place at the moment it is
// accepted, so an unopened invitation has no owner to notify. Showing an
// "invitation waiting" task would mean inventing one. It is left out.

import type { RoundSummary } from "./roundState";

/** How much this interrupts. Ordered, and the order is the sort. */
export type TaskPriority = "urgent" | "soon" | "info";

/**
 * Who a task belongs to.
 *
 * Kept apart so running a circle never turns up inside a saver's list of
 * things to do. Organizing is work; saving is not, and mixing them makes the
 * product feel like an admin console for everybody.
 */
export type TaskAudience = "member" | "organizer";

export interface CircleTask {
  key: string;
  title: string;
  detail: string;
  priority: TaskPriority;
  audience: TaskAudience;
  /** Where to go. Null when the circle does not exist on chain yet. */
  circleId: number | null;
  draftId: string;
}

export interface CircleInput {
  draftId: string;
  circleId: number | null;
  role: "organizer" | "member";
  accepted: boolean;
  status: "draft" | "ready" | "created" | "abandoned";
  memberCount: number;
  acceptedCount: number;
  /** The chain reserved a place for this wallet and it has not been taken yet. */
  readyToJoin: boolean;
  /** Null until the chain has been read for this circle. */
  round: RoundSummary | null;
  /**
   * What the chain says about the circle as a whole, once it has been read.
   *
   * Public, so reading it costs no signature, and undefined rather than zero
   * when it has not been read: a circle nobody has looked at must never turn
   * into a circle nobody has joined.
   */
  chain?: { joinedCount: number; memberLimit: number } | null;
}

const ORDER: Record<TaskPriority, number> = { urgent: 0, soon: 1, info: 2 };

/**
 * Everything waiting on this person, most pressing first.
 *
 * A circle contributes at most one task. Somebody who has not joined and also
 * owes a contribution has one problem, not two, and listing both would make the
 * smaller one look like progress.
 */
export function actionCenter(circles: readonly CircleInput[]): CircleTask[] {
  const tasks: CircleTask[] = [];

  for (const circle of circles) {
    const task =
      circle.role === "organizer" ? organizerTask(circle) : null;
    const memberTask = circle.accepted ? contributorTask(circle) : null;

    // A person can organize a circle and also hold a place in it. The thing
    // they owe as a member comes first, because it has a deadline.
    if (memberTask !== null) tasks.push(memberTask);
    else if (task !== null) tasks.push(task);
  }

  return tasks.sort((a, b) => ORDER[a.priority] - ORDER[b.priority]);
}

/** What this person owes, or is owed, as a member of one circle. */
function contributorTask(circle: CircleInput): CircleTask | null {
  const base = { circleId: circle.circleId, draftId: circle.draftId, audience: "member" as const };

  if (circle.readyToJoin) {
    return {
      ...base,
      key: `join-${circle.draftId}`,
      title: "Take your place",
      detail: "A place is reserved for you. The circle starts once everyone has joined.",
      priority: "urgent",
    };
  }

  const round = circle.round;
  if (round === null) return null;

  switch (round.payment) {
    case "overdue":
      return {
        ...base,
        key: `overdue-${circle.draftId}`,
        title: "Payment overdue",
        detail: `Round ${round.round}. The grace period has ended.`,
        priority: "urgent",
      };
    case "grace":
      return {
        ...base,
        key: `grace-${circle.draftId}`,
        title: "Grace period",
        detail: `Round ${round.round}. Your contribution is late but still counts.`,
        priority: "urgent",
      };
    case "due":
      return {
        ...base,
        key: `due-${circle.draftId}`,
        title: "Contribution due",
        detail: round.nextAction ?? `Round ${round.round}.`,
        priority: "soon",
      };
    case "missed":
      return {
        ...base,
        key: `missed-${circle.draftId}`,
        title: "Missed round",
        detail: `Round ${round.round}. Paying the shortfall keeps the circle whole.`,
        priority: "soon",
      };
    case "paid":
      // Nothing is owed. Worth one calm line only when the pot is theirs.
      return round.yourTurn
        ? {
            ...base,
            key: `turn-${circle.draftId}`,
            title: "Your turn to collect",
            detail: `Round ${round.round} pays out to you.`,
            priority: "info",
          }
        : null;
    case "notJoined":
    case "none":
      return null;
  }
}

/** What this person has to do to get a circle of theirs running. */
function organizerTask(circle: CircleInput): CircleTask | null {
  if (circle.status === "abandoned") return null;

  const base = {
    circleId: circle.circleId,
    draftId: circle.draftId,
    audience: "organizer" as const,
  };

  // The circle exists. The one thing that can still be stuck on a person, and
  // that only the organizer will notice, is a place somebody accepted and never
  // took. Nothing here is an action on their behalf: it opens the circle, where
  // the operational detail is, and joining stays with the person joining.
  if (circle.status === "created") {
    const chain = circle.chain;
    if (chain === undefined || chain === null) return null;
    const waiting = chain.memberLimit - chain.joinedCount;
    if (waiting <= 0) return null;
    return {
      ...base,
      key: `joining-${circle.draftId}`,
      title: "Waiting for people to join",
      detail:
        waiting === 1
          ? "1 person accepted but has not joined yet."
          : `${waiting} people accepted but have not joined yet.`,
      priority: "soon",
    };
  }
  const everyoneAccepted = circle.acceptedCount >= circle.memberCount;

  if (everyoneAccepted) {
    return {
      ...base,
      key: `create-${circle.draftId}`,
      title: "Ready to start",
      detail: "Everyone has accepted their invitation. You can start the circle.",
      priority: "urgent",
    };
  }

  const waiting = circle.memberCount - circle.acceptedCount;
  return {
    ...base,
    key: `invites-${circle.draftId}`,
    title: "Invitations outstanding",
    detail:
      waiting === 1
        ? "One person has not accepted their invitation yet."
        : `${waiting} people have not accepted their invitations yet.`,
    priority: "info",
  };
}

/** What to say when there is nothing to do. Calm, and not a celebration. */
export const NOTHING_TO_DO = "You are up to date.";
