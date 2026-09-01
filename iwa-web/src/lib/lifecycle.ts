// lib/lifecycle.ts — where one circle has got to, for the person looking at it.
//
// Two sources, each answering only what it owns. The coordination service knows
// whether the organizer has created the circle yet and whether this wallet took
// a place; the chain knows whether that place has actually been joined, how far
// the circle has got, and whether joining is still possible. Neither is asked a
// question belonging to the other.
//
// The join test is Phase 1's `canJoin` and nothing else. A second predicate
// here would eventually disagree with the circle screen, and a list offering a
// join the circle then refuses is worse than a list that stays quiet.
//
// Nothing in here joins, and nothing returns an action that could. A list opens
// a circle; joining is confirmed on the circle itself.

import { canJoin } from "../chains/strk20/circleState";
import type { CircleStatus } from "./types";

/** What the coordination service knows. */
export interface AssociationLike {
  role: "organizer" | "member";
  accepted: boolean;
  status: "draft" | "ready" | "created" | "abandoned";
  circleId: number | null;
  memberCount: number;
  acceptedCount: number;
}

/** What the chain says, once it has been read. */
export interface ChainSnapshot {
  status: CircleStatus;
  joinedCount: number;
  memberLimit: number;
  /** A place in the payout order holds this wallet's commitment. */
  reserved: boolean;
  /** The contract counts this wallet as a joined member. */
  youJoined: boolean;
}

export type LifecycleState =
  /** No circle on chain yet. */
  | "waiting"
  /** Created, and the chain has not answered yet. */
  | "reading"
  /** A place is reserved and this wallet can still take it. */
  | "readyToJoin"
  | "joined"
  /** Running, and this wallet is not a member of it. */
  | "running"
  | "complete"
  /** The draft was abandoned. */
  | "closed";

export interface Lifecycle {
  state: LifecycleState;
  /** Plain words for the state. No jargon, and never more certain than the facts. */
  label: string;
  /** The circle to open, once one exists. */
  circleId: number | null;
  /** Whether there is a circle to open at all. */
  canOpen: boolean;
  /** The organizer still has to create this circle. */
  organizerAction: boolean;
}

export function lifecycleOf(a: AssociationLike, chain: ChainSnapshot | null): Lifecycle {
  if (a.status === "abandoned") {
    return {
      state: "closed",
      label: "No longer active",
      circleId: null,
      canOpen: false,
      organizerAction: false,
    };
  }

  // Nothing exists on chain, so nothing here may look joinable.
  if (a.status !== "created" || a.circleId === null) {
    return {
      state: "waiting",
      label:
        a.role === "organizer" ? "Not started yet" : "Waiting for the organizer",
      circleId: null,
      canOpen: false,
      organizerAction: a.role === "organizer",
    };
  }

  const circleId = a.circleId;

  if (chain === null) {
    return {
      state: "reading",
      label: "Opening",
      circleId,
      canOpen: true,
      organizerAction: false,
    };
  }

  if (chain.youJoined) {
    return {
      state: chain.status === "complete" ? "complete" : "joined",
      label: chain.status === "complete" ? "Completed" : "Joined",
      circleId,
      canOpen: true,
      organizerAction: false,
    };
  }

  const joinable = canJoin({
    reservedForYou: chain.reserved,
    youJoined: chain.youJoined,
    joinedCount: chain.joinedCount,
    memberLimit: chain.memberLimit,
    status: chain.status,
  });

  if (joinable) {
    return {
      state: "readyToJoin",
      label: "Ready to join",
      circleId,
      canOpen: true,
      organizerAction: false,
    };
  }

  return {
    state: chain.status === "complete" ? "complete" : "running",
    label: chain.status === "complete" ? "Completed" : "Running",
    circleId,
    canOpen: true,
    organizerAction: false,
  };
}
