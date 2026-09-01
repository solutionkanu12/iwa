import { describe, expect, it } from "vitest";

import { mergeTokens, moveInOrder, orderOf } from "./draftOrder";
import type { DraftSlotView, DraftView } from "./backend";

function slot(slotId: string, slotIndex: number, extra: Partial<DraftSlotView> = {}): DraftSlotView {
  return {
    slotId,
    slotIndex,
    accepted: false,
    memberRef: null,
    authPublicKey: null,
    acceptedAt: null,
    ...extra,
  };
}

function draft(slots: DraftSlotView[]): DraftView {
  return {
    id: "d1",
    chainId: "0x534e5f4d41494e",
    organizerAddress: "0xorg",
    token: "0xusdc",
    contributionAmount: "10000000",
    cadenceSeconds: 604800,
    graceSeconds: 86400,
    memberCount: slots.length,
    status: "draft",
    circleId: null,
    createdTx: null,
    createdAt: "2026-09-01T00:00:00Z",
    acceptedCount: slots.filter((s) => s.accepted).length,
    slots,
  };
}

// An invite link is sent to one person. If it ever moves to another place it
// has effectively been sent to the wrong person, so the link travels with the
// slot id and never with the position.
describe("mergeTokens", () => {
  it("keeps every link with its own place after the order changes", () => {
    const held = draft([
      slot("a", 0, { inviteToken: "token-a" }),
      slot("b", 1, { inviteToken: "token-b" }),
    ]);
    // The service answers with the places swapped and no links.
    const fresh = draft([slot("b", 0), slot("a", 1)]);

    const merged = mergeTokens(fresh, held);

    expect(merged.slots[0]).toMatchObject({ slotId: "b", inviteToken: "token-b" });
    expect(merged.slots[1]).toMatchObject({ slotId: "a", inviteToken: "token-a" });
  });

  it("never lets a place inherit another place's link", () => {
    const held = draft([
      slot("a", 0, { inviteToken: "token-a", accepted: true, memberRef: "0x1" }),
      slot("b", 1, { inviteToken: "token-b" }),
    ]);
    const fresh = draft([slot("b", 0), slot("a", 1, { accepted: true, memberRef: "0x1" })]);

    const merged = mergeTokens(fresh, held);
    const pending = merged.slots.find((s) => s.slotId === "b");
    expect(pending?.inviteToken).toBe("token-b");
    expect(pending?.inviteToken).not.toBe("token-a");
  });

  it("prefers a link the service supplied over the one held locally", () => {
    const held = draft([slot("a", 0, { inviteToken: "stale" }), slot("b", 1)]);
    const fresh = draft([slot("a", 0, { inviteToken: "canonical" }), slot("b", 1)]);
    expect(mergeTokens(fresh, held).slots[0].inviteToken).toBe("canonical");
  });

  it("takes the service response whole when nothing is held yet", () => {
    const fresh = draft([slot("a", 0, { inviteToken: "t" }), slot("b", 1)]);
    expect(mergeTokens(fresh, null)).toEqual(fresh);
  });

  it("drops a place the service no longer reports", () => {
    const held = draft([slot("a", 0, { inviteToken: "t" }), slot("b", 1)]);
    const fresh = draft([slot("a", 0)]);
    expect(mergeTokens(fresh, held).slots.map((s) => s.slotId)).toEqual(["a"]);
  });
});

// Arranging is local. Several moves produce one order, which is saved once,
// rather than a wallet signature for every arrow press.
describe("moveInOrder", () => {
  it("swaps two neighbours", () => {
    expect(moveInOrder(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
  });

  it("accumulates several moves into one final order", () => {
    let order = ["a", "b", "c", "d"];
    order = moveInOrder(order, 3, 2);
    order = moveInOrder(order, 2, 1);
    order = moveInOrder(order, 1, 0);
    expect(order).toEqual(["d", "a", "b", "c"]);
    expect(new Set(order).size).toBe(4);
  });

  it("refuses to move outside the circle, leaving the order untouched", () => {
    const order = ["a", "b"];
    expect(moveInOrder(order, 0, -1)).toBe(order);
    expect(moveInOrder(order, 1, 2)).toBe(order);
    expect(moveInOrder(order, -1, 0)).toBe(order);
  });

  it("never adds, drops or repeats a place", () => {
    const order = ["a", "b", "c"];
    const moved = moveInOrder(order, 0, 2);
    expect([...moved].sort()).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the order it was given", () => {
    const order = ["a", "b"];
    moveInOrder(order, 0, 1);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("orderOf", () => {
  it("reads the saved order as slot ids", () => {
    expect(orderOf(draft([slot("a", 0), slot("b", 1)]))).toEqual(["a", "b"]);
  });

  it("is empty when there is no draft", () => {
    expect(orderOf(null)).toEqual([]);
  });
});
