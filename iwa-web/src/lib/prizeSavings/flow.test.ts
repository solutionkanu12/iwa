// features/prizeSavings/flow.test.ts — the pure flow model of the Prize
// Savings screen.

import { describe, expect, it } from "vitest";

import {
  claimOffer,
  depositOffer,
  formatUnits6,
  ownerOffer,
  parseUnits6,
  stageOf,
  type PoolFacts,
} from "./flow";

const openFacts: PoolFacts = {
  roundState: "Open",
  participantCount: 3,
  maxParticipants: 16,
  isParticipant: true,
  hasClaimed: false,
  isOwner: false,
  operatorGranted: true,
};

describe("stageOf", () => {
  it("maps a missing wallet to walletMissing before anything else", () => {
    expect(stageOf({ wallet: "missing", onSepolia: false, facts: null, loadFailed: false })).toBe(
      "walletMissing",
    );
  });

  it("asks to connect when disconnected", () => {
    expect(stageOf({ wallet: "disconnected", onSepolia: false, facts: null, loadFailed: false })).toBe(
      "connect",
    );
  });

  it("asks for the network when connected elsewhere or not on Sepolia", () => {
    expect(
      stageOf({ wallet: "wrongNetwork", onSepolia: false, facts: null, loadFailed: false }),
    ).toBe("wrongNetwork");
    expect(stageOf({ wallet: "connected", onSepolia: false, facts: null, loadFailed: false })).toBe(
      "wrongNetwork",
    );
  });

  it("shows a load state until the pool facts arrive", () => {
    expect(stageOf({ wallet: "connected", onSepolia: true, facts: null, loadFailed: false })).toBe(
      "load",
    );
  });

  it("reports a failed load instead of guessing", () => {
    expect(stageOf({ wallet: "connected", onSepolia: true, facts: null, loadFailed: true })).toBe(
      "loadFailed",
    );
  });

  it("follows the on-chain round state once facts exist", () => {
    for (const state of ["Open", "Locked", "Drawn", "Claimable"] as const) {
      expect(
        stageOf({
          wallet: "connected",
          onSepolia: true,
          facts: { ...openFacts, roundState: state },
          loadFailed: false,
        }),
      ).toBe(state.toLowerCase());
    }
  });
});

describe("depositOffer", () => {
  it("allows deposit and withdrawal while open", () => {
    const offer = depositOffer("open");
    expect(offer.canDeposit).toBe(true);
    expect(offer.canWithdraw).toBe(true);
    expect(offer.reason).toBeNull();
  });

  it("stops deposits after the round closes but keeps withdrawals open", () => {
    for (const stage of ["locked", "drawn", "claimable"] as const) {
      const offer = depositOffer(stage);
      expect(offer.canDeposit, stage).toBe(false);
      expect(offer.canWithdraw, stage).toBe(true);
      expect(offer.reason).not.toBeNull();
    }
  });
});

describe("claimOffer", () => {
  it("offers claim to an unclaimed participant after the draw", () => {
    const offer = claimOffer({ ...openFacts, roundState: "Drawn" });
    expect(offer.canClaim).toBe(true);
  });

  it("refuses a second claim", () => {
    const offer = claimOffer({ ...openFacts, roundState: "Claimable", hasClaimed: true });
    expect(offer.canClaim).toBe(false);
    expect(offer.claimLabel).toBe("Claimed");
  });

  it("refuses non-participants", () => {
    const offer = claimOffer({ ...openFacts, roundState: "Drawn", isParticipant: false });
    expect(offer.canClaim).toBe(false);
  });

  it("says claims open after the draw while the round is still open", () => {
    const offer = claimOffer({ ...openFacts, roundState: "Open" });
    expect(offer.canClaim).toBe(false);
  });
});

describe("ownerOffer", () => {
  it("lets the owner fund and lock while open", () => {
    const offer = ownerOffer({ ...openFacts, isOwner: true, roundState: "Open" });
    expect(offer.canFund).toBe(true);
    expect(offer.canLock).toBe(true);
    expect(offer.canDraw).toBe(false);
  });

  it("lets the owner draw only once locked", () => {
    const offer = ownerOffer({ ...openFacts, isOwner: true, roundState: "Locked" });
    expect(offer.canFund).toBe(false);
    expect(offer.canDraw).toBe(true);
  });

  it("hides everything from non-owners", () => {
    const offer = ownerOffer({ ...openFacts, isOwner: false });
    expect(offer.isOwner).toBe(false);
    expect(offer.canFund).toBe(false);
    expect(offer.canLock).toBe(false);
    expect(offer.canDraw).toBe(false);
  });
});

describe("amount formatting (6 decimals, like the wrapped token)", () => {
  it("formats whole units without trailing zeros", () => {
    expect(formatUnits6(1000000000n)).toBe("1000");
    expect(formatUnits6(0n)).toBe("0");
  });

  it("formats fractions without padding noise", () => {
    expect(formatUnits6(40000000n)).toBe("40");
    expect(formatUnits6(123456n)).toBe("0.123456");
    expect(formatUnits6(100000n)).toBe("0.1");
  });

  it("parses valid inputs", () => {
    expect(parseUnits6("40")).toBe(40000000n);
    expect(parseUnits6("0.5")).toBe(500000n);
    expect(parseUnits6("1.123456")).toBe(1123456n);
  });

  it("rejects malformed inputs", () => {
    expect(parseUnits6("")).toBeNull();
    expect(parseUnits6("abc")).toBeNull();
    expect(parseUnits6("1.1234567")).toBeNull();
    expect(parseUnits6("-5")).toBeNull();
  });
});