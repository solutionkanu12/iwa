// features/prizeSavings/flow.test.ts — the pure flow model of the Prize
// Savings screen.

import { describe, expect, it } from "vitest";

import {
  claimOffer,
  depositOffer,
  formatUnits6,
  joinOffer,
  ownerOffer,
  parseUnits6,
  PRIZE_SAVINGS_COPY,
  stageOf,
  type LastRoundFacts,
  type PoolFacts,
} from "./flow";

const openFacts: PoolFacts = {
  currentRoundId: 3,
  roundState: "Open",
  participantCount: 3,
  maxParticipants: 16,
  hasSavings: true,
  isParticipantInCurrentRound: true,
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

  it("never gets permanently stuck: Open remains reachable after any state", () => {
    // The multi-round redesign's whole point: there is no terminal stage.
    for (const state of ["Open", "Locked", "Drawn", "Claimable"] as const) {
      const stage = stageOf({
        wallet: "connected",
        onSepolia: true,
        facts: { ...openFacts, roundState: state },
        loadFailed: false,
      });
      expect(["open", "locked", "drawn", "claimable"]).toContain(stage);
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

  it("stops new savings while the round finishes but keeps withdrawals open", () => {
    for (const stage of ["locked", "drawn", "claimable"] as const) {
      const offer = depositOffer(stage);
      expect(offer.canDeposit, stage).toBe(false);
      expect(offer.canWithdraw, stage).toBe(true);
      expect(offer.reason).not.toBeNull();
    }
  });
});

describe("joinOffer", () => {
  it("lets an eligible saver join while the round is open", () => {
    const offer = joinOffer("open", { ...openFacts, isParticipantInCurrentRound: false });
    expect(offer.canJoin).toBe(true);
    expect(offer.alreadyJoined).toBe(false);
  });

  it("reports already-joined once the wallet is in the current round", () => {
    const offer = joinOffer("open", { ...openFacts, isParticipantInCurrentRound: true });
    expect(offer.canJoin).toBe(false);
    expect(offer.alreadyJoined).toBe(true);
  });

  it("requires savings before joining - no automatic opt-in from a bare deposit-less wallet", () => {
    const offer = joinOffer("open", {
      ...openFacts,
      isParticipantInCurrentRound: false,
      hasSavings: false,
    });
    expect(offer.canJoin).toBe(false);
    expect(offer.reason).toMatch(/savings/i);
  });

  it("closes joining once the round is no longer open", () => {
    for (const stage of ["locked", "drawn", "claimable"] as const) {
      const offer = joinOffer(stage, { ...openFacts, isParticipantInCurrentRound: false });
      expect(offer.canJoin, stage).toBe(false);
      expect(offer.reason).not.toBeNull();
    }
  });

  it("closes joining once the round is full", () => {
    const offer = joinOffer("open", {
      ...openFacts,
      isParticipantInCurrentRound: false,
      participantCount: 16,
      maxParticipants: 16,
    });
    expect(offer.canJoin).toBe(false);
    expect(offer.reason).toMatch(/full/i);
  });

  it("returns nothing actionable before facts load", () => {
    const offer = joinOffer("load", null);
    expect(offer.canJoin).toBe(false);
    expect(offer.alreadyJoined).toBe(false);
  });
});

describe("claimOffer", () => {
  const drawnRound: LastRoundFacts = {
    roundId: 1,
    state: "Drawn",
    participated: true,
    claimed: false,
  };

  it("offers claim to an unclaimed participant of the last finished round", () => {
    const offer = claimOffer(drawnRound);
    expect(offer.visible).toBe(true);
    expect(offer.canClaim).toBe(true);
  });

  it("refuses a second claim and labels it Claimed", () => {
    const offer = claimOffer({ ...drawnRound, claimed: true });
    expect(offer.canClaim).toBe(false);
    expect(offer.claimLabel).toBe("Claimed");
  });

  it("hides the claim area for a non-participant", () => {
    const offer = claimOffer({ ...drawnRound, participated: false });
    expect(offer.visible).toBe(false);
    expect(offer.canClaim).toBe(false);
  });

  it("hides the claim area when there is no finished round yet", () => {
    const offer = claimOffer(null);
    expect(offer.visible).toBe(false);
    expect(offer.canClaim).toBe(false);
  });

  it("names the round in the message, so an old claim stays legible after later rounds open", () => {
    const offer = claimOffer({ ...drawnRound, roundId: 7 });
    expect(offer.message).toContain("7");
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

describe("product copy", () => {
  it("never uses an em dash or en dash", () => {
    for (const [key, value] of Object.entries(PRIZE_SAVINGS_COPY)) {
      expect(value, key).not.toMatch(/[–—]/);
    }
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
