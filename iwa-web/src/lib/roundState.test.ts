// What the circle screen is allowed to tell somebody about their round.
//
// The rule these enforce: every statement is either something the chain said,
// or something that follows from it with no guessing in between. A savings app
// that is confidently wrong about whether you owe money this week is worse than
// one that says it does not know.

import { describe, expect, it } from "vitest";

import {
  circleTimeline,
  recipientSlotFor,
  relativeDay,
  roundSummary,
  type ObligationFacts,
  type RoundFacts,
} from "./roundState";

const DAY = 86_400;
const NOW = Date.parse("2026-09-03T00:00:00.000Z") / 1000;

const obligation = (over: Partial<ObligationFacts> = {}): ObligationFacts => ({
  status: "Pending",
  requiredAmount: 1_000_000n,
  dueAt: NOW + 4 * DAY,
  graceEndsAt: NOW + 5 * DAY,
  ...over,
});

const facts = (over: Partial<RoundFacts> = {}): RoundFacts => ({
  round: 1,
  memberLimit: 2,
  contributionAmount: 1_000_000n,
  circleStatus: "active",
  youJoined: true,
  reserved: true,
  yourSlot: 0,
  obligation: obligation(),
  now: NOW,
  ...over,
});

describe("where the member stands this round", () => {
  it("says a contribution is due before the deadline", () => {
    const s = roundSummary(facts());
    expect(s.payment).toBe("due");
    expect(s.paymentLabel).toBe("Contribution due");
    expect(s.nextAction).toBe("Contribute before in 4 days.");
  });

  it("says paid once the contract recorded it on time", () => {
    const s = roundSummary(facts({ obligation: obligation({ status: "OnTime" }) }));
    expect(s.payment).toBe("paid");
    expect(s.paymentLabel).toBe("Paid");
    expect(s.paidLate).toBe(false);
    expect(s.nextAction).toBeNull();
  });

  // Paid is paid. The lateness is recorded, and is not turned into a warning
  // on a screen the person can no longer do anything about.
  it("says paid, and remembers it was late, when it was inside the grace window", () => {
    const s = roundSummary(facts({ obligation: obligation({ status: "LateWithinGrace" }) }));
    expect(s.payment).toBe("paid");
    expect(s.paidLate).toBe(true);
  });

  it("shows the grace period once the deadline has passed", () => {
    const s = roundSummary(facts({ now: NOW + 4.5 * DAY }));
    expect(s.payment).toBe("grace");
    expect(s.paymentLabel).toBe("Grace period");
    expect(s.nextAction).toContain("grace period ends");
  });

  // The window can close before anybody calls the contract to record a default.
  // Until it is recorded, saying "missed" would assert something the chain has
  // not written.
  it("says overdue, not missed, when grace has ended but the chain still says pending", () => {
    const s = roundSummary(facts({ now: NOW + 6 * DAY }));
    expect(s.payment).toBe("overdue");
    expect(s.paymentLabel).toBe("Payment overdue");
  });

  it("says missed only when the contract recorded a default", () => {
    const s = roundSummary(facts({ obligation: obligation({ status: "MissedDefault" }) }));
    expect(s.payment).toBe("missed");
    expect(s.paymentLabel).toBe("Missed");
  });

  it("asks a reserved member who has not joined to take their place", () => {
    const s = roundSummary(facts({ youJoined: false, reserved: true, obligation: null }));
    expect(s.payment).toBe("notJoined");
    expect(s.nextAction).toBe("Take your place in this circle.");
  });

  it("offers nothing to somebody with no place in the circle", () => {
    const s = roundSummary(facts({ youJoined: false, reserved: false, obligation: null }));
    expect(s.payment).toBe("notJoined");
    expect(s.nextAction).toBeNull();
  });

  // A round that has not begun has no obligation. That is not a debt.
  it("says nothing is due when the round has no obligation yet", () => {
    const s = roundSummary(facts({ obligation: null }));
    expect(s.payment).toBe("none");
    expect(s.paymentLabel).toBe("Nothing due yet");
    expect(s.nextAction).toBeNull();
  });
});

describe("whose turn it is", () => {
  // recipient_slot = round - 1, exactly as the contract computes it.
  it("matches the contract's own recipient slot", () => {
    expect(recipientSlotFor(1)).toBe(0);
    expect(recipientSlotFor(2)).toBe(1);
    expect(recipientSlotFor(5)).toBe(4);
  });

  it("tells the collecting member it is their turn", () => {
    const s = roundSummary(facts({ round: 2, yourSlot: 1, memberLimit: 2 }));
    expect(s.yourTurn).toBe(true);
    expect(s.turnLabel).toBe("Your turn to collect");
  });

  it("names the turn without naming anybody when it is not yours", () => {
    const s = roundSummary(facts({ round: 1, yourSlot: 1, memberLimit: 3 }));
    expect(s.yourTurn).toBe(false);
    expect(s.turnLabel).toBe("Turn 1 of 3");
  });

  it("claims no turn for somebody with no place", () => {
    const s = roundSummary(facts({ yourSlot: null }));
    expect(s.yourTurn).toBe(false);
  });

  it("computes the pot from the circle's own terms", () => {
    const s = roundSummary(facts({ contributionAmount: 5_000_000n, memberLimit: 4 }));
    expect(s.potAmount).toBe(20_000_000n);
  });
});

describe("deadlines in words", () => {
  it("counts forward in days", () => {
    expect(relativeDay(NOW, NOW)).toBe("today");
    expect(relativeDay(NOW + DAY, NOW)).toBe("tomorrow");
    expect(relativeDay(NOW + 4 * DAY, NOW)).toBe("in 4 days");
  });

  it("counts backward once the moment has passed", () => {
    expect(relativeDay(NOW - DAY, NOW)).toBe("yesterday");
    expect(relativeDay(NOW - 3 * DAY, NOW)).toBe("3 days ago");
  });

  it("uses no dashes anywhere in its words", () => {
    for (const offset of [-5, -1, 0, 1, 5]) {
      expect(relativeDay(NOW + offset * DAY, NOW)).not.toMatch(/[—–]/);
    }
  });
});

describe("the timeline", () => {
  const timeline = (over = {}) =>
    circleTimeline({
      currentRound: 1,
      memberLimit: 3,
      createdAt: NOW - 3 * DAY,
      obligation: obligation(),
      circleComplete: false,
      now: NOW,
      ...over,
    });

  it("has a start, one entry per round, and an end", () => {
    const t = timeline();
    expect(t).toHaveLength(5);
    expect(t[0].label).toBe("Circle started");
    expect(t[4].label).toBe("Everyone has collected");
  });

  it("dates the round in progress from the chain's own deadline", () => {
    const t = timeline();
    const current = t.find((e) => e.tone === "current");
    expect(current?.label).toBe("Round 1");
    expect(current?.detail).toBe("Due in 4 days");
  });

  // The whole point. A future round's obligation does not exist yet, so its
  // deadline does not exist yet, and inventing one from the cadence would put a
  // guess in the same typeface as a fact.
  it("gives no future round a date", () => {
    const t = timeline({ currentRound: 1, memberLimit: 4 });
    for (const entry of t.filter((e) => e.tone === "upcoming")) {
      // null is the honest answer for a round with no deadline yet, so the
      // check is on whatever text there is, if any.
      const detail = entry.detail ?? "";
      expect(detail).not.toMatch(/\d{4}/);
      expect(detail).not.toMatch(/in \d+ days/);
    }
  });

  it("says only that the next round follows this one", () => {
    const t = timeline({ currentRound: 1, memberLimit: 3 });
    expect(t.find((e) => e.key === "round-2")?.detail).toBe(
      "Begins when this round completes",
    );
    expect(t.find((e) => e.key === "round-3")?.detail).toBeNull();
  });

  it("marks earlier rounds complete", () => {
    const t = timeline({ currentRound: 3, memberLimit: 3 });
    expect(t.find((e) => e.key === "round-1")?.tone).toBe("done");
    expect(t.find((e) => e.key === "round-2")?.detail).toBe("Completed");
  });

  it("marks everything done when the circle has finished", () => {
    const t = timeline({ circleComplete: true, currentRound: 3, memberLimit: 3 });
    expect(t.every((e) => e.tone === "done")).toBe(true);
    expect(t[t.length - 1].detail).toBe("Completed");
  });

  it("omits the start date rather than inventing one", () => {
    const t = timeline({ createdAt: null });
    expect(t[0].detail).toBeNull();
  });
});

describe("the words it uses", () => {
  const everything = (): string[] => {
    const out: string[] = [];
    for (const status of ["Pending", "OnTime", "LateWithinGrace", "MissedDefault"] as const) {
      for (const now of [NOW, NOW + 4.5 * DAY, NOW + 6 * DAY]) {
        const s = roundSummary(facts({ obligation: obligation({ status }), now }));
        out.push(s.paymentLabel, s.turnLabel, s.nextAction ?? "");
      }
    }
    for (const e of circleTimeline({
      currentRound: 1,
      memberLimit: 3,
      createdAt: NOW,
      obligation: obligation(),
      circleComplete: false,
      now: NOW,
    })) {
      out.push(e.label, e.detail ?? "");
    }
    return out.filter((s) => s.length > 0);
  };

  it("uses no dashes and no exclamation marks", () => {
    for (const text of everything()) expect(text).not.toMatch(/[—–!]/);
  });

  it("uses no protocol jargon", () => {
    for (const text of everything()) {
      const lower = text.toLowerCase();
      for (const jargon of [
        "obligation",
        "settlement",
        "on-chain",
        "onchain",
        "wallet action",
        "calldata",
        "nonce",
        "commitment",
        "member_ref",
        "execute",
      ]) {
        expect(lower).not.toContain(jargon);
      }
    }
  });

  it("never says default before the contract has recorded one", () => {
    const s = roundSummary(facts({ now: NOW + 30 * DAY }));
    expect(s.paymentLabel.toLowerCase()).not.toContain("default");
  });
});
