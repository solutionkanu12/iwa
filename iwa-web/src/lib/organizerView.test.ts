import { describe, expect, it } from "vitest";

import {
  inviteProgress,
  isOrganizer,
  organizerSummary,
  ORGANIZER_COPY,
  type OrganizerFacts,
  type PlaceFacts,
} from "./organizerView";
import type { ObligationFacts } from "./roundState";

const NOW = 1_788_459_380;
const DAY = 86_400;

function obligation(over: Partial<ObligationFacts> = {}): ObligationFacts {
  return {
    status: "Pending",
    requiredAmount: 1_000_000n,
    dueAt: NOW + 3 * DAY,
    graceEndsAt: NOW + 4 * DAY,
    ...over,
  };
}

function place(slot: number, over: Partial<PlaceFacts> = {}): PlaceFacts {
  return { slot, joined: true, obligation: obligation(), ...over };
}

function facts(over: Partial<OrganizerFacts> = {}): OrganizerFacts {
  const places = over.places ?? [place(0), place(1), place(2)];
  return {
    memberLimit: 3,
    joinedCount: places.filter((p) => p.joined).length,
    acceptedCount: 3,
    round: 1,
    circleStatus: "active",
    payout: { kind: "notPrepared" },
    priorPayout: null,
    now: NOW,
    ...over,
    places,
  };
}

const valueOf = (rows: readonly { key: string; value: string }[], key: string) =>
  rows.find((r) => r.key === key)?.value ?? null;

describe("organizer summary counts", () => {
  it("counts places, accepted and joined separately", () => {
    const s = organizerSummary(
      facts({
        acceptedCount: 3,
        places: [place(0), place(1), place(2, { joined: false, obligation: null })],
      }),
    );
    expect(s.counts.places).toBe(3);
    expect(s.counts.accepted).toBe(3);
    expect(s.counts.joined).toBe(2);
  });

  it("never claims an accepted count the service has not given", () => {
    const s = organizerSummary(facts({ acceptedCount: null }));
    expect(s.counts.accepted).toBeNull();
    expect(valueOf(s.rows, "accepted")).toBeNull();
  });

  it("counts paid, due, grace, overdue and missed from real obligation state", () => {
    const s = organizerSummary(
      facts({
        memberLimit: 5,
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "LateWithinGrace" }) }),
          place(2, { obligation: obligation() }),
          place(3, {
            obligation: obligation({ dueAt: NOW - DAY, graceEndsAt: NOW + DAY }),
          }),
          place(4, { obligation: obligation({ status: "MissedDefault" }) }),
        ],
      }),
    );
    expect(s.counts.paid).toBe(2);
    expect(s.counts.due).toBe(1);
    expect(s.counts.grace).toBe(1);
    expect(s.counts.overdue).toBe(0);
    expect(s.counts.missed).toBe(1);
  });

  it("separates a closed grace window from a recorded default", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ dueAt: NOW - 3 * DAY, graceEndsAt: NOW - DAY }) }),
          place(1, { obligation: obligation({ status: "OnTime" }) }),
          place(2, { obligation: obligation({ status: "OnTime" }) }),
        ],
      }),
    );
    expect(s.counts.overdue).toBe(1);
    expect(s.counts.missed).toBe(0);
  });

  it("names the place whose turn it is to collect", () => {
    expect(organizerSummary(facts({ round: 1 })).payoutTurnPlace).toBe(1);
    expect(organizerSummary(facts({ round: 3 })).payoutTurnPlace).toBe(3);
  });

  it("gives no payout turn when the round is outside the payout order", () => {
    expect(organizerSummary(facts({ round: 9 })).payoutTurnPlace).toBeNull();
  });
});

describe("member progress rows", () => {
  it("labels places by position and never by identity", () => {
    const s = organizerSummary(facts());
    expect(s.places.map((p) => p.label)).toEqual(["Place 1", "Place 2", "Place 3"]);
    for (const p of s.places) {
      expect(JSON.stringify(p)).not.toMatch(/0x[0-9a-f]{6}/i);
    }
  });

  it("distinguishes accepted from joined on a place", () => {
    const s = organizerSummary(
      facts({ places: [place(0), place(1, { joined: false, obligation: null }), place(2)] }),
    );
    expect(s.places[1].joinLabel).toBe("Has not joined yet");
    expect(s.places[0].joinLabel).toBe("Joined");
  });

  it("says nothing about payment for a place that has not joined", () => {
    const s = organizerSummary(
      facts({ places: [place(0, { joined: false, obligation: null }), place(1), place(2)] }),
    );
    expect(s.places[0].paymentLabel).toBeNull();
  });

  it("marks the place collecting this round", () => {
    const s = organizerSummary(facts({ round: 2 }));
    expect(s.places.map((p) => p.payoutTurn)).toEqual([false, true, false]);
  });

  it("reads payment from the obligation windows", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "LateWithinGrace" }) }),
          place(2, { obligation: obligation({ dueAt: NOW - DAY, graceEndsAt: NOW + DAY }) }),
        ],
      }),
    );
    expect(s.places[0].paymentLabel).toBe("Paid");
    expect(s.places[1].paymentLabel).toBe("Paid late");
    expect(s.places[2].paymentLabel).toBe("In the grace period");
  });
});

describe("operational state", () => {
  it("waits for people to join before anything else", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0),
          place(1, { joined: false, obligation: null }),
          place(2, { joined: false, obligation: null }),
        ],
      }),
    );
    expect(s.state).toBe("waitingToJoin");
    expect(s.stateLabel).toBe(ORGANIZER_COPY.waitingToJoin);
  });

  it("waits for contributions while any is still pending and not yet due", () => {
    expect(organizerSummary(facts()).state).toBe("waitingForContributions");
  });

  it("reports an active grace period", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "OnTime" }) }),
          place(2, { obligation: obligation({ dueAt: NOW - DAY, graceEndsAt: NOW + DAY }) }),
        ],
      }),
    );
    expect(s.state).toBe("gracePeriod");
  });

  it("reports round accounting as ready once every obligation is final", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "OnTime" }) }),
          place(2, { obligation: obligation({ status: "MissedDefault" }) }),
        ],
        payout: { kind: "notPrepared" },
      }),
    );
    expect(s.state).toBe("accountingReady");
    expect(s.stateLabel).toBe(ORGANIZER_COPY.accountingReady);
  });

  it("waits for the recipient once the accounting is prepared", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "OnTime" }) }),
          place(2, { obligation: obligation({ status: "OnTime" }) }),
        ],
        payout: { kind: "prepared", status: "Scheduled" },
      }),
    );
    expect(s.state).toBe("waitingForRecipient");
  });

  it("says a payout is held rather than lost when a shortfall is unresolved", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "OnTime" }) }),
          place(2, { obligation: obligation({ status: "MissedDefault" }) }),
        ],
        payout: { kind: "prepared", status: "DeferredLocked" },
      }),
    );
    expect(s.state).toBe("payoutHeld");
  });

  it("says the round state is unavailable rather than guessing it", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "OnTime" }) }),
          place(2, { obligation: obligation({ status: "OnTime" }) }),
        ],
        payout: { kind: "unavailable" },
      }),
    );
    expect(s.state).toBe("unavailable");
    expect(s.stateLabel).toBe(ORGANIZER_COPY.unavailable);
  });

  it("reports a finished circle as finished", () => {
    expect(organizerSummary(facts({ circleStatus: "complete" })).state).toBe("complete");
  });

  it("is unavailable when no place could be read", () => {
    expect(organizerSummary(facts({ places: [], joinedCount: 3 })).state).toBe("unavailable");
  });
});

describe("what needs attention", () => {
  it("says how many people accepted but have not joined", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0),
          place(1, { joined: false, obligation: null }),
          place(2, { joined: false, obligation: null }),
        ],
      }),
    );
    expect(s.attention).toContain("2 people accepted but have not joined yet");
  });

  it("uses the singular for one place", () => {
    const s = organizerSummary(
      facts({ places: [place(0), place(1), place(2, { joined: false, obligation: null })] }),
    );
    expect(s.attention).toContain("1 person accepted but has not joined yet");
  });

  it("counts contributions still due", () => {
    const s = organizerSummary(
      facts({
        places: [place(0, { obligation: obligation({ status: "OnTime" }) }), place(1), place(2)],
      }),
    );
    expect(s.attention).toContain("2 contributions are still due");
  });

  it("reports a grace period and a missed round separately", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ dueAt: NOW - DAY, graceEndsAt: NOW + DAY }) }),
          place(1, { obligation: obligation({ status: "MissedDefault" }) }),
          place(2, { obligation: obligation({ status: "OnTime" }) }),
        ],
      }),
    );
    expect(s.attention).toContain("1 contribution is in its grace period");
    expect(s.attention).toContain("1 contribution was missed");
  });

  it("mentions a prior round still waiting for its recipient", () => {
    const s = organizerSummary(
      facts({ round: 2, priorPayout: { kind: "prepared", status: "Scheduled" } }),
    );
    expect(s.attention).toContain("The pot for round 1 is waiting for the person collecting it");
  });

  it("says nothing about a prior round that has been paid", () => {
    const s = organizerSummary(
      facts({ round: 2, priorPayout: { kind: "prepared", status: "Paid" } }),
    );
    expect(s.attention.join(" ")).not.toContain("round 1");
  });

  it("says nothing about a prior round it could not read", () => {
    const s = organizerSummary(facts({ round: 2, priorPayout: { kind: "unavailable" } }));
    expect(s.attention.join(" ")).not.toContain("round 1");
  });

  it("has nothing to say when nothing is blocked", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: obligation({ status: "OnTime" }) }),
          place(1, { obligation: obligation({ status: "OnTime" }) }),
          place(2, { obligation: obligation({ status: "OnTime" }) }),
        ],
        payout: { kind: "prepared", status: "Paid" },
      }),
    );
    expect(s.attention).toEqual([]);
  });
});

describe("invite progress", () => {
  it("counts accepted and waiting places", () => {
    const p = inviteProgress({ memberCount: 5, acceptedCount: 3 });
    expect(p.accepted).toBe(3);
    expect(p.waiting).toBe(2);
    expect(p.ready).toBe(false);
    expect(p.label).toBe("2 places still need to accept");
  });

  it("uses the singular for the last place", () => {
    expect(inviteProgress({ memberCount: 5, acceptedCount: 4 }).label).toBe(
      "1 place still needs to accept",
    );
  });

  it("is ready once everyone has accepted", () => {
    const p = inviteProgress({ memberCount: 5, acceptedCount: 5 });
    expect(p.ready).toBe(true);
    expect(p.waiting).toBe(0);
    expect(p.label).toBe("Everyone has accepted");
  });

  it("never reports more accepted than there are places", () => {
    const p = inviteProgress({ memberCount: 3, acceptedCount: 9 });
    expect(p.accepted).toBe(3);
    expect(p.waiting).toBe(0);
  });
});

describe("what the organizer view refuses to carry", () => {
  it("offers no control that could move money or override a member", () => {
    const s = organizerSummary(facts());
    const text = JSON.stringify(s).toLowerCase();
    for (const banned of [
      "collect for",
      "release",
      "override",
      "force",
      "skip member",
      "seize",
      "pause",
      "change recipient",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("invents no date for a round the chain has not dated", () => {
    const s = organizerSummary(
      facts({
        places: [
          place(0, { obligation: null }),
          place(1, { obligation: null }),
          place(2, { obligation: null }),
        ],
      }),
    );
    for (const p of s.places) expect(p.paymentLabel).toBe("Nothing due yet");
    expect(JSON.stringify(s)).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("keeps every label short enough for a narrow screen", () => {
    const s = organizerSummary(facts());
    for (const row of s.rows) expect(row.label.length).toBeLessThanOrEqual(20);
    for (const p of s.places) expect(p.label.length).toBeLessThanOrEqual(12);
  });

  it("uses no dash characters that the design forbids", () => {
    const s = organizerSummary(
      facts({
        acceptedCount: 2,
        priorPayout: { kind: "prepared", status: "Scheduled" },
        round: 2,
      }),
    );
    const text = JSON.stringify(s) + JSON.stringify(ORGANIZER_COPY);
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("who the operational view is for", () => {
  const ORGANIZER = "0x043d08F5B0D621eF22f91B954e719d7C0a5a8c6ed89308bA05f36FAe42F2d804";

  it("recognizes the wallet the contract recorded as organizer", () => {
    expect(isOrganizer(ORGANIZER, ORGANIZER)).toBe(true);
  });

  it("ignores case and leading zeroes, which are the same address", () => {
    expect(isOrganizer(ORGANIZER, ORGANIZER.toLowerCase())).toBe(true);
    expect(isOrganizer("0x0000042", "0x42")).toBe(true);
  });

  it("hides the view from an ordinary member of the same circle", () => {
    expect(isOrganizer(ORGANIZER, "0x1234")).toBe(false);
  });

  it("hides the view when no wallet is connected", () => {
    expect(isOrganizer(ORGANIZER, null)).toBe(false);
  });

  it("hides the view when the circle names no organizer", () => {
    expect(isOrganizer(null, ORGANIZER)).toBe(false);
    expect(isOrganizer("0x0", ORGANIZER)).toBe(false);
  });

  it("fails closed on anything it cannot read as an address", () => {
    expect(isOrganizer("not an address", ORGANIZER)).toBe(false);
    expect(isOrganizer(ORGANIZER, "not an address")).toBe(false);
  });
});
