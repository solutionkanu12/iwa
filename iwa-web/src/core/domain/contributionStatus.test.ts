// Unit tests for the chain-neutral contribution timing classification.
//
// Implements the locked grace rule (docs/domain/IWA_INVARIANTS.md INV-018,
// ARCHITECTURE.md "Grace periods", August 27, 2026):
//   now <= due_at                  -> ON_TIME
//   due_at < now <= grace_ends_at  -> LATE_WITHIN_GRACE
//   now > grace_ends_at (no valid settlement) -> MISSED_DEFAULT
// Settlements after grace_ends_at are invalid and must be rejected by the
// caller; the classifier reports them as MISSED_DEFAULT.

import { describe, expect, it } from "vitest";
import { classifyContribution } from "./contributionStatus";

const DUE_AT = 1_000;
const GRACE_ENDS_AT = 2_000;

describe("classifyContribution — settled obligations", () => {
  it("classifies a settlement exactly at dueAt as ON_TIME", () => {
    expect(classifyContribution(DUE_AT, DUE_AT, GRACE_ENDS_AT, DUE_AT)).toBe(
      "ON_TIME",
    );
  });

  it("classifies a settlement before dueAt as ON_TIME", () => {
    expect(classifyContribution(900, DUE_AT, GRACE_ENDS_AT, 900)).toBe(
      "ON_TIME",
    );
  });

  it("classifies a settlement one second after dueAt as LATE_WITHIN_GRACE", () => {
    expect(
      classifyContribution(DUE_AT + 1, DUE_AT, GRACE_ENDS_AT, DUE_AT + 1),
    ).toBe("LATE_WITHIN_GRACE");
  });

  it("classifies a settlement exactly at graceEndsAt as LATE_WITHIN_GRACE", () => {
    expect(
      classifyContribution(GRACE_ENDS_AT, DUE_AT, GRACE_ENDS_AT, GRACE_ENDS_AT),
    ).toBe("LATE_WITHIN_GRACE");
  });

  it("classifies a settlement after graceEndsAt as MISSED_DEFAULT (invalid)", () => {
    expect(
      classifyContribution(
        GRACE_ENDS_AT + 1,
        DUE_AT,
        GRACE_ENDS_AT,
        GRACE_ENDS_AT + 1,
      ),
    ).toBe("MISSED_DEFAULT");
  });
});

describe("classifyContribution — unsettled obligations", () => {
  it("classifies an unsettled obligation before dueAt as PENDING", () => {
    expect(classifyContribution(900, DUE_AT, GRACE_ENDS_AT)).toBe("PENDING");
  });

  it("classifies an unsettled obligation exactly at dueAt as PENDING", () => {
    expect(classifyContribution(DUE_AT, DUE_AT, GRACE_ENDS_AT)).toBe("PENDING");
  });

  it("classifies an unsettled obligation inside grace as PENDING", () => {
    expect(classifyContribution(1_500, DUE_AT, GRACE_ENDS_AT)).toBe("PENDING");
  });

  it("classifies an unsettled obligation exactly at graceEndsAt as PENDING", () => {
    expect(classifyContribution(GRACE_ENDS_AT, DUE_AT, GRACE_ENDS_AT)).toBe(
      "PENDING",
    );
  });

  it("classifies an unsettled obligation one second past graceEndsAt as MISSED_DEFAULT", () => {
    expect(
      classifyContribution(GRACE_ENDS_AT + 1, DUE_AT, GRACE_ENDS_AT),
    ).toBe("MISSED_DEFAULT");
  });
});