import { describe, expect, it } from "vitest";

import { lifecycleOf, type AssociationLike, type ChainSnapshot } from "./lifecycle";

function association(over: Partial<AssociationLike> = {}): AssociationLike {
  return {
    role: "member",
    accepted: true,
    status: "draft",
    circleId: null,
    memberCount: 4,
    acceptedCount: 2,
    ...over,
  };
}

const chain = (over: Partial<ChainSnapshot> = {}): ChainSnapshot => ({
  status: "forming",
  joinedCount: 0,
  memberLimit: 4,
  reserved: true,
  youJoined: false,
  ...over,
});

// Before the organizer creates the circle there is nothing on chain to join,
// and nothing that should look joinable.
describe("waiting for the organizer", () => {
  it("waits while the draft is still collecting acceptances", () => {
    const life = lifecycleOf(association({ status: "draft" }), null);
    expect(life.state).toBe("waiting");
    expect(life.canOpen).toBe(false);
  });

  it("waits while every place is taken but the circle is not created", () => {
    const life = lifecycleOf(association({ status: "ready" }), null);
    expect(life.state).toBe("waiting");
    expect(life.canOpen).toBe(false);
  });

  it("tells an organizer their circle is theirs to start", () => {
    const life = lifecycleOf(association({ role: "organizer", accepted: false, status: "ready" }), null);
    expect(life.state).toBe("waiting");
    expect(life.organizerAction).toBe(true);
  });

  it("does not offer an organizer action to a member", () => {
    expect(lifecycleOf(association({ status: "ready" }), null).organizerAction).toBe(false);
  });

  it("never claims a circle id it does not have", () => {
    expect(lifecycleOf(association(), null).circleId).toBeNull();
  });
});

// Created, but the chain has not been read yet. Nothing is asserted about
// membership until it has been.
describe("created, chain not read yet", () => {
  it("reports that it is still reading rather than guessing", () => {
    const life = lifecycleOf(association({ status: "created", circleId: 5 }), null);
    expect(life.state).toBe("reading");
    expect(life.circleId).toBe(5);
    expect(life.canOpen).toBe(true);
  });
});

describe("created, with the chain read", () => {
  const created = association({ status: "created", circleId: 5 });

  it("is ready to join when a place is reserved and nobody has taken it", () => {
    const life = lifecycleOf(created, chain({ reserved: true, youJoined: false, joinedCount: 1 }));
    expect(life.state).toBe("readyToJoin");
    expect(life.canOpen).toBe(true);
  });

  it("is joined once the contract counts you as a member", () => {
    const life = lifecycleOf(created, chain({ youJoined: true, joinedCount: 2 }));
    expect(life.state).toBe("joined");
    expect(life.canOpen).toBe(true);
  });

  // Phase 1's predicate is the only one. A full circle is not joinable even
  // with a place reserved, and this must agree with the circle screen.
  it("is not ready to join once every member has joined", () => {
    const life = lifecycleOf(
      created,
      chain({ reserved: true, youJoined: false, joinedCount: 4, memberLimit: 4 }),
    );
    expect(life.state).not.toBe("readyToJoin");
  });

  it("is not ready to join once the circle is running", () => {
    const life = lifecycleOf(created, chain({ status: "active", reserved: true, youJoined: false }));
    expect(life.state).not.toBe("readyToJoin");
  });

  it("is not ready to join without a place reserved for this wallet", () => {
    const life = lifecycleOf(created, chain({ reserved: false }));
    expect(life.state).not.toBe("readyToJoin");
  });

  it("shows an organizer their created circle as running", () => {
    const life = lifecycleOf(
      association({ role: "organizer", accepted: false, status: "created", circleId: 5 }),
      chain({ status: "active", reserved: false, youJoined: false }),
    );
    expect(life.state).toBe("running");
    expect(life.canOpen).toBe(true);
  });

  it("reports a finished circle as complete", () => {
    const life = lifecycleOf(created, chain({ status: "complete", youJoined: true }));
    expect(life.state).toBe("complete");
  });

  // The list never joins anything. It opens the circle, and the circle screen
  // is where a join is confirmed.
  it("never carries an action that would join on its own", () => {
    const life = lifecycleOf(created, chain({ reserved: true, youJoined: false }));
    expect(Object.keys(life)).not.toContain("join");
    expect(life.canOpen).toBe(true);
  });
});

describe("the words shown to a person", () => {
  const cases: [AssociationLike, ChainSnapshot | null, string][] = [
    [association({ status: "draft" }), null, "Waiting for the organizer"],
    [association({ status: "created", circleId: 1 }), chain({ reserved: true }), "Ready to join"],
    [association({ status: "created", circleId: 1 }), chain({ youJoined: true }), "Joined"],
    [
      association({ status: "created", circleId: 1 }),
      chain({ status: "complete", youJoined: true }),
      "Completed",
    ],
  ];

  it("says something plain and true in each state", () => {
    for (const [a, c, expected] of cases) {
      expect(lifecycleOf(a, c).label).toBe(expected);
    }
  });

  it("uses no jargon, no dashes and no exclamation", () => {
    for (const [a, c] of cases) {
      const { label } = lifecycleOf(a, c);
      expect(label).not.toMatch(/[—–!]/);
      expect(label.toLowerCase()).not.toMatch(/nonce|felt|commitment|memberref|payout order/);
    }
  });
});
