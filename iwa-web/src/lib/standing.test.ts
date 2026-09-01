import { describe, expect, it } from "vitest";

import { standingFrom, standingSummary, type ObligationOutcome } from "./standing";

const outcomes = (...list: ObligationOutcome[]): ObligationOutcome[] => list;

// The record has to be read off the obligations the contract actually holds.
// Anything it cannot say, this must not say either.
describe("standingFrom", () => {
  it("counts nothing when there is nothing to count", () => {
    const s = standingFrom([]);
    expect(s).toMatchObject({ completedCycles: 0, onTimeCount: 0, lateCount: 0, defaultCount: 0 });
  });

  // The bug this replaces reported 100 per cent on time for a member who had
  // never contributed, which is a claim about a record that does not exist.
  it("has no on-time rate at all before the first round is settled", () => {
    expect(standingFrom([]).onTimeRate).toBeNull();
  });

  it("counts each outcome the contract reports", () => {
    const s = standingFrom(outcomes("OnTime", "OnTime", "LateWithinGrace", "MissedDefault"));
    expect(s).toMatchObject({
      completedCycles: 4,
      onTimeCount: 2,
      lateCount: 1,
      defaultCount: 1,
      onTimeRate: 50,
    });
  });

  it("ignores a round with nothing settled yet", () => {
    const s = standingFrom(outcomes("OnTime", "Pending"));
    expect(s.completedCycles).toBe(1);
    expect(s.onTimeRate).toBe(100);
  });

  it("reports a full record only when every round was on time", () => {
    expect(standingFrom(outcomes("OnTime", "OnTime")).onTimeRate).toBe(100);
    expect(standingFrom(outcomes("OnTime", "LateWithinGrace")).onTimeRate).toBe(50);
  });
});

// The words shown to a person. Each one has to be earned by the counts.
describe("standingSummary", () => {
  it("says plainly that there is no record yet", () => {
    expect(standingSummary(standingFrom([]))).toBe("No rounds completed yet");
  });

  it("says a member paid on time only when every round was on time", () => {
    expect(standingSummary(standingFrom(outcomes("OnTime", "OnTime")))).toContain("always on time");
  });

  // The phrase that was previously hardcoded. It must never appear over a
  // record that includes a late payment or a default.
  it("never claims always on time over a late round", () => {
    const late = standingSummary(standingFrom(outcomes("OnTime", "LateWithinGrace")));
    expect(late).not.toContain("always on time");
    expect(late).toContain("1 paid late");
  });

  it("never claims always on time over a default", () => {
    const missed = standingSummary(standingFrom(outcomes("OnTime", "MissedDefault")));
    expect(missed).not.toContain("always on time");
    expect(missed).toContain("1 default");
  });

  it("never claims always on time over an empty record", () => {
    expect(standingSummary(standingFrom([]))).not.toContain("always on time");
  });

  it("counts defaults in plain words", () => {
    expect(standingSummary(standingFrom(outcomes("MissedDefault")))).toContain("1 default");
    expect(standingSummary(standingFrom(outcomes("MissedDefault", "MissedDefault")))).toContain(
      "2 defaults",
    );
  });

  it("says no defaults only when there are none, and there is a record", () => {
    expect(standingSummary(standingFrom(outcomes("OnTime")))).toContain("no defaults");
    expect(standingSummary(standingFrom(outcomes("MissedDefault")))).not.toContain("no defaults");
  });

  it("invents no score, band or rating", () => {
    for (const list of [[], outcomes("OnTime"), outcomes("MissedDefault", "OnTime")]) {
      const text = standingSummary(standingFrom(list)).toLowerCase();
      for (const banned of ["score", "rating", "excellent", "healthy", "good standing", "grade"]) {
        expect(text).not.toContain(banned);
      }
      expect(text).not.toMatch(/[—–!]/);
    }
  });
});
