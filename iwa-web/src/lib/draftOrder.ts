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
 * Carries the organizer-only fields from the draft in hand onto a fresh
 * response.
 *
 * The public draft view answers with the terms and the progress and nothing
 * else: no invite link, and no member commitment. That is deliberate, because
 * the id travels in a link and a stranger holding it should not be handed the
 * set of people in the circle. It does mean a poll returns less than the
 * organizer already has, and blanking those fields would leave them unable to
 * create the circle they just filled.
 *
 * So the poll keeps them, matched by slot id. Never by position: a position is
 * renumbered by every reorder, and matching on it is exactly how a link ends up
 * attached to the wrong person.
 *
 * Anything the service did supply wins. It is the authority, and what is held
 * here is only a cache of what it last said.
 */
export function mergePrivate(fresh: DraftView, current: DraftView | null): DraftView {
  if (current === null) return fresh;
  const held = new Map(current.slots.map((s) => [s.slotId, s]));
  return {
    ...fresh,
    slots: fresh.slots.map((s) => {
      const mine = held.get(s.slotId);
      return {
        ...s,
        inviteToken: s.inviteToken ?? mine?.inviteToken,
        memberRef: s.memberRef ?? mine?.memberRef ?? null,
        authPublicKey: s.authPublicKey ?? mine?.authPublicKey ?? null,
        acceptedAt: s.acceptedAt ?? mine?.acceptedAt ?? null,
      };
    }),
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
