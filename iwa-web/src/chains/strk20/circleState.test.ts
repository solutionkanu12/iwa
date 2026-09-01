import { describe, expect, it } from "vitest";

import { canJoin, memberSlots, potFor, type JoinInput } from "./circleState";
import { formatAmount } from "../../lib/amount";
import { USDC_DECIMALS } from "../../lib/starknetConfig";

// Base units in, base units out, formatted exactly once at the edge. The bug
// this guards against was a second division: the chain read converted base
// units to a human number and the screen then divided by 10^6 again, so 1.00
// USDC rendered as 0.000001.
describe("amounts are base units all the way to the formatter", () => {
  it("renders whole amounts without a second conversion", () => {
    expect(formatAmount(1_000_000n, USDC_DECIMALS)).toBe("1");
    expect(formatAmount(10_000_000n, USDC_DECIMALS)).toBe("10");
    expect(formatAmount(12_500_000n, USDC_DECIMALS)).toBe("12.5");
  });

  it("renders the smallest representable amount", () => {
    expect(formatAmount(1n, USDC_DECIMALS)).toBe("0.000001");
  });

  it("never renders 10 USDC as 0.00001", () => {
    expect(formatAmount(10_000_000n, USDC_DECIMALS)).not.toBe("0.00001");
  });

  it("computes the pot for two members", () => {
    const pot = potFor(1_000_000n, 2);
    expect(pot).toBe(2_000_000n);
    expect(formatAmount(pot, USDC_DECIMALS)).toBe("2");
  });

  it("computes the pot for four members", () => {
    const pot = potFor(10_000_000n, 4);
    expect(pot).toBe(40_000_000n);
    expect(formatAmount(pot, USDC_DECIMALS)).toBe("40");
  });

  it("keeps exact precision at amounts a float would round", () => {
    // 9007199254740993 base units exceeds Number.MAX_SAFE_INTEGER, so a number
    // path would silently lose the last digit.
    const odd = 9_007_199_254_740_993n;
    expect(potFor(odd, 1)).toBe(odd);
  });

  it("rejects a member count that cannot be a circle", () => {
    expect(() => potFor(1_000_000n, 0)).toThrow();
    expect(() => potFor(1_000_000n, -2)).toThrow();
  });
});

const MINE = "0x45325587024dc0326f740bc5268c766620a4a51dbdec04894256480aecbae0f";
const OTHER = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";

describe("memberSlots", () => {
  it("marks a reserved place as reserved, and yours as yours", () => {
    const slots = memberSlots([MINE, OTHER], BigInt(MINE));
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ slot: 0, filled: true, isYou: true });
    expect(slots[1]).toMatchObject({ slot: 1, filled: true, isYou: false });
  });

  it("treats a zero commitment as an unreserved place", () => {
    const slots = memberSlots([MINE, "0x0"], BigInt(MINE));
    expect(slots[1].filled).toBe(false);
    expect(slots[1].isYou).toBe(false);
  });

  it("marks nothing as yours when no wallet identity is known", () => {
    expect(memberSlots([MINE, OTHER], null).every((s) => !s.isYou)).toBe(true);
  });
});

// A place in the payout order is a reservation, not a membership. The payout
// order is written in full at creation, so every place reads as reserved
// immediately; the only signal that someone actually joined is joined_count.
describe("canJoin", () => {
  const base: JoinInput = {
    reservedForYou: true,
    youJoined: false,
    joinedCount: 0,
    memberLimit: 2,
    status: "forming",
  };

  it("allows an invited member while the payout order is fully reserved", () => {
    expect(canJoin({ ...base, joinedCount: 0 })).toBe(true);
    expect(canJoin({ ...base, joinedCount: 1 })).toBe(true);
  });

  it("refuses a wallet with no place reserved for it", () => {
    expect(canJoin({ ...base, reservedForYou: false })).toBe(false);
  });

  it("refuses a member who has already joined", () => {
    expect(canJoin({ ...base, youJoined: true })).toBe(false);
  });

  it("refuses once every member has joined", () => {
    expect(canJoin({ ...base, joinedCount: 2, memberLimit: 2 })).toBe(false);
  });

  it("refuses once the circle is no longer forming", () => {
    expect(canJoin({ ...base, status: "active" })).toBe(false);
    expect(canJoin({ ...base, status: "complete" })).toBe(false);
  });
});
