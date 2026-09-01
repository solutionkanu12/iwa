// chains/strk20/circleState.ts — turning what the circle contract reports into
// what a screen needs to decide.
//
// Two rules live here, and both exist because the contract's own vocabulary is
// easy to misread from the UI side.
//
// AMOUNTS ARE BASE UNITS. The contract stores an integer number of the token's
// smallest unit, and that integer travels unchanged through this layer as a
// bigint. It is converted to a human amount exactly once, by formatAmount at
// the point of display. Nothing here divides, and nothing here uses a float:
// a contribution is money, and a float is not an exact representation of it.
//
// A RESERVED PLACE IS NOT A MEMBER. create_circle writes the whole payout order
// at once, so from the moment a circle exists every place already holds a
// commitment. Membership is a separate step: each invited person still calls
// join_circle, and joined_count is the only signal that they have. Reading the
// payout order as though it answered "who has joined" makes a full circle out
// of one where nobody has joined yet.

import type { CircleStatus, MemberSlot } from "../../lib/types";

/** The pot one member collects on their turn, in base units. */
export function potFor(contributionAmount: bigint, memberLimit: number): bigint {
  if (!Number.isInteger(memberLimit) || memberLimit < 1) {
    throw new Error(`memberLimit must be a positive integer, got ${memberLimit}`);
  }
  return contributionAmount * BigInt(memberLimit);
}

/**
 * The circle's seats, in payout order. `filled` means the place is reserved for
 * a specific invited commitment, which is what the seat row draws; it does not
 * mean that person has joined.
 */
export function memberSlots(payoutOrder: readonly string[], mine: bigint | null): MemberSlot[] {
  return payoutOrder.map((ref, slot) => {
    let commitment: bigint | null;
    try {
      commitment = BigInt(ref);
    } catch {
      commitment = null;
    }
    const reserved = commitment !== null && commitment !== 0n;
    return {
      slot,
      filled: reserved,
      isYou: reserved && mine !== null && commitment === mine,
    };
  });
}

export interface JoinInput {
  /** A place in the payout order holds this wallet's commitment. */
  reservedForYou: boolean;
  /** The contract already counts this wallet as joined. */
  youJoined: boolean;
  joinedCount: number;
  memberLimit: number;
  status: CircleStatus;
}

/**
 * Whether this wallet can join now.
 *
 * Deliberately conservative, and deliberately not permissionless: without a
 * reserved place the contract rejects the join anyway, since join_circle
 * derives the member reference from the invite secret and requires it to
 * already sit in the payout order. Offering the action to anyone else would
 * only produce a reverted transaction.
 */
export function canJoin(input: JoinInput): boolean {
  if (!input.reservedForYou) return false;
  if (input.youJoined) return false;
  if (input.status !== "forming") return false;
  return input.joinedCount < input.memberLimit;
}
