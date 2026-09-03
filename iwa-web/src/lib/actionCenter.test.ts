// What the front door is allowed to ask of somebody.
//
// Two failure modes are being designed against, and they pull in opposite
// directions. A list that invents tasks trains people to ignore it. A list that
// stays quiet about a deadline costs somebody their standing in a circle.
//
// So these check both directions: every real obligation surfaces, and nothing
// that is not a real obligation ever does.

import { describe, expect, it } from "vitest";

import { actionCenter, NOTHING_TO_DO, type CircleInput } from "./actionCenter";
import { roundSummary, type RoundFacts } from "./roundState";

const DAY = 86_400;
const NOW = Date.parse("2026-09-03T00:00:00.000Z") / 1000;

function round(over: Partial<RoundFacts> = {}) {
  const facts: RoundFacts = {
    round: 1,
    memberLimit: 3,
    contributionAmount: 1_000_000n,
    circleStatus: "active",
    youJoined: true,
    reserved: true,
    yourSlot: 1,
    obligation: {
      status: "Pending",
      requiredAmount: 1_000_000n,
      dueAt: NOW + 4 * DAY,
      graceEndsAt: NOW + 5 * DAY,
    },
    now: NOW,
    ...over,
  };
  return roundSummary(facts);
}

function circle(over: Partial<CircleInput> = {}): CircleInput {
  return {
    draftId: "d1",
    circleId: 1,
    role: "member",
    accepted: true,
    status: "created",
    memberCount: 3,
    acceptedCount: 3,
    readyToJoin: false,
    round: round(),
    ...over,
  };
}

describe("what reaches a saver", () => {
  it("asks somebody with a reserved place to take it", () => {
    const [task] = actionCenter([circle({ readyToJoin: true })]);
    expect(task.title).toBe("Take your place");
    expect(task.priority).toBe("urgent");
    expect(task.audience).toBe("member");
  });

  it("raises a contribution that is due", () => {
    const [task] = actionCenter([circle()]);
    expect(task.title).toBe("Contribution due");
    expect(task.priority).toBe("soon");
  });

  it("raises the grace period as urgent", () => {
    const [task] = actionCenter([circle({ round: round({ now: NOW + 4.5 * DAY }) })]);
    expect(task.title).toBe("Grace period");
    expect(task.priority).toBe("urgent");
  });

  it("raises an overdue payment as urgent", () => {
    const [task] = actionCenter([circle({ round: round({ now: NOW + 6 * DAY }) })]);
    expect(task.title).toBe("Payment overdue");
    expect(task.priority).toBe("urgent");
  });

  it("raises a missed round, because it can still be put right", () => {
    const r = round({ obligation: { status: "MissedDefault", requiredAmount: 1_000_000n, dueAt: NOW, graceEndsAt: NOW } });
    const [task] = actionCenter([circle({ round: r })]);
    expect(task.title).toBe("Missed round");
  });

  it("tells somebody when the pot is theirs, quietly", () => {
    const r = round({
      round: 2,
      yourSlot: 1,
      obligation: { status: "OnTime", requiredAmount: 1_000_000n, dueAt: NOW, graceEndsAt: NOW },
    });
    const [task] = actionCenter([circle({ round: r })]);
    expect(task.title).toBe("Your turn to collect");
    expect(task.priority).toBe("info");
  });
});

describe("what never reaches anybody", () => {
  it("says nothing when the contribution is paid and the turn is not theirs", () => {
    const r = round({
      obligation: { status: "OnTime", requiredAmount: 1_000_000n, dueAt: NOW, graceEndsAt: NOW },
    });
    expect(actionCenter([circle({ round: r })])).toEqual([]);
  });

  it("says nothing when the chain has not been read yet", () => {
    expect(actionCenter([circle({ round: null })])).toEqual([]);
  });

  it("says nothing about a round with no obligation yet", () => {
    expect(actionCenter([circle({ round: round({ obligation: null }) })])).toEqual([]);
  });

  it("says nothing about a circle somebody never accepted", () => {
    expect(actionCenter([circle({ accepted: false, role: "member" })])).toEqual([]);
  });

  it("says nothing about an abandoned circle", () => {
    expect(
      actionCenter([circle({ role: "organizer", accepted: false, status: "abandoned" })]),
    ).toEqual([]);
  });

  it("has a calm empty state and does not celebrate", () => {
    expect(actionCenter([])).toEqual([]);
    expect(NOTHING_TO_DO).toBe("You are up to date.");
    expect(NOTHING_TO_DO).not.toMatch(/[!—–]/);
  });
});

describe("organizer work stays separate from saving", () => {
  const organizing = (over: Partial<CircleInput> = {}) =>
    circle({ role: "organizer", accepted: false, status: "ready", circleId: null, ...over });

  it("tells an organizer when everyone has accepted", () => {
    const [task] = actionCenter([organizing({ acceptedCount: 3, memberCount: 3 })]);
    expect(task.title).toBe("Ready to start");
    expect(task.audience).toBe("organizer");
    expect(task.priority).toBe("urgent");
  });

  it("counts who has not accepted, without naming anybody", () => {
    const [task] = actionCenter([organizing({ acceptedCount: 1, memberCount: 3 })]);
    expect(task.detail).toBe("2 people have not accepted their invitations yet.");
    expect(task.priority).toBe("info");
  });

  it("uses singular wording for one person", () => {
    const [task] = actionCenter([organizing({ acceptedCount: 2, memberCount: 3 })]);
    expect(task.detail).toBe("One person has not accepted their invitation yet.");
  });

  it("stops asking once the circle exists", () => {
    expect(actionCenter([organizing({ status: "created" })])).toEqual([]);
  });

  // Somebody can organize a circle and hold a place in it. The deadline wins.
  it("prefers the member deadline over the organizer task for one circle", () => {
    const tasks = actionCenter([
      circle({ role: "organizer", accepted: true, status: "ready", acceptedCount: 1 }),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].audience).toBe("member");
  });

  it("marks every task with an audience so no screen has to guess", () => {
    const tasks = actionCenter([circle(), organizing({ acceptedCount: 1 })]);
    for (const t of tasks) expect(["member", "organizer"]).toContain(t.audience);
  });
});

describe("ordering and shape", () => {
  it("puts urgent first, then due soon, then information", () => {
    const tasks = actionCenter([
      circle({ draftId: "a", round: round() }),
      circle({ draftId: "b", round: round({ now: NOW + 6 * DAY }) }),
      circle({
        draftId: "c",
        round: round({
          round: 2,
          yourSlot: 1,
          obligation: { status: "OnTime", requiredAmount: 1n, dueAt: NOW, graceEndsAt: NOW },
        }),
      }),
    ]);
    expect(tasks.map((t) => t.priority)).toEqual(["urgent", "soon", "info"]);
  });

  it("raises at most one task per circle", () => {
    const tasks = actionCenter([circle({ readyToJoin: true, round: round({ now: NOW + 6 * DAY }) })]);
    expect(tasks).toHaveLength(1);
  });

  it("gives every task a stable distinct key", () => {
    const tasks = actionCenter([circle({ draftId: "a" }), circle({ draftId: "b" })]);
    expect(new Set(tasks.map((t) => t.key)).size).toBe(tasks.length);
  });

  it("speaks plainly, with no jargon and no dashes", () => {
    const tasks = actionCenter([
      circle({ readyToJoin: true }),
      circle({ draftId: "b", round: round({ now: NOW + 6 * DAY }) }),
      circle({ draftId: "c", role: "organizer", accepted: false, status: "ready", acceptedCount: 1 }),
    ]);
    for (const t of tasks) {
      const text = `${t.title} ${t.detail}`;
      expect(text).not.toMatch(/[—–!]/);
      for (const jargon of ["on-chain", "wallet action", "settlement", "obligation", "nonce", "execute"]) {
        expect(text.toLowerCase()).not.toContain(jargon);
      }
    }
  });
});
