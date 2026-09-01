// lib/draftOrder.ts — arranging a payout order, and keeping invite links with
// the places they belong to.
//
// Two rules, both about identity.
//
// A PLACE IS NOT A POSITION. slotIndex is renumbered by every reorder, so it
// says where a place currently sits and nothing more. slotId is assigned once
// and never changes. Anything that has to stay attached to a place, above all
// the invite link sent to a specific person, is matched by slotId. Matching by
// position is how an invitation ends up in the wrong hands.
//
// ARRANGING IS NOT SAVING. The organizer moves places around locally and saves
// once. Persisting each arrow press would ask the wallet to sign again every
// time, which is a confirmation prompt for a decision nobody has made yet.
//
// Pure and synchronous, so the exact sequence can be replayed in a test.

import type { DraftView } from "./backend";

/** The saved payout order of a draft, as slot ids. */
export function orderOf(draft: DraftView | null): string[] {
  return draft?.slots.map((s) => s.slotId) ?? [];
}

/**
 * Carries invite links from the draft in hand onto a fresh response.
 *
 * The public draft view has no links in it, so a poll would otherwise blank
 * them. A link the service did supply always wins: it is the authority, and
 * the local copy is only a cache of what it last said.
 */
export function mergeTokens(fresh: DraftView, current: DraftView | null): DraftView {
  if (current === null) return fresh;
  const tokenBySlot = new Map(current.slots.map((s) => [s.slotId, s.inviteToken]));
  return {
    ...fresh,
    slots: fresh.slots.map((s) => ({
      ...s,
      inviteToken: s.inviteToken ?? tokenBySlot.get(s.slotId),
    })),
  };
}

/**
 * Moves one place within an order.
 *
 * Returns the same array unchanged when the move is out of bounds, so a
 * mis-click cannot shorten a payout order or drop somebody out of it.
 */
export function moveInOrder(order: string[], from: number, to: number): string[] {
  if (from < 0 || from >= order.length) return order;
  if (to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
