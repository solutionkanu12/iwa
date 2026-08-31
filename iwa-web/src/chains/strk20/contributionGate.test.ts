// Regression cover for the live bug: after member A settled, the console
// blocked member B with "member A obligation is OnTime". A round progresses one
// contribution at a time, so a settled peer must never gate the next member.

import { describe, expect, it } from "vitest";

import { contributionBlockers, hasContributed, type ContributionGateInput } from "./contributionGate";

/** The live on-chain state at the time of the bug, with everything else green. */
const LIVE: ContributionGateInput = {
  memberLabel: "B",
  walletConnected: true,
  registered: true,
  shieldedUsdc: 2_017_800n,
  shieldedUsdcRequired: 2_000_000n,
  shieldCompleted: true,
  circleStatus: "Active",
  obligations: { A: { status: "OnTime" }, B: { status: "Pending" } },
  helperSurplus: 0n,
  strkAllowance: 18n * 10n ** 18n,
  strkAllowanceRequired: 12n * 10n ** 18n,
  maturityRemaining: 0,
};

describe("per-member gating", () => {
  it("allows contribution B when A is OnTime and B is Pending", () => {
    // The exact reported failure.
    expect(contributionBlockers(LIVE)).toEqual([]);
  });

  it("never mentions another member in B's blockers", () => {
    const blockers = contributionBlockers({
      ...LIVE,
      obligations: { A: { status: "MissedDefault" }, B: { status: "Pending" } },
    });
    expect(blockers.join(" ")).not.toContain("member A");
  });

  it("blocks B when B has already contributed, even though A is Pending", () => {
    const blockers = contributionBlockers({
      ...LIVE,
      obligations: { A: { status: "Pending" }, B: { status: "OnTime" } },
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/member B has already contributed \(OnTime\)/);
  });

  it("allows contribution A when both are still Pending", () => {
    expect(
      contributionBlockers({
        ...LIVE,
        memberLabel: "A",
        obligations: { A: { status: "Pending" }, B: { status: "Pending" } },
      }),
    ).toEqual([]);
  });

  it("blocks A once A has settled", () => {
    const blockers = contributionBlockers({ ...LIVE, memberLabel: "A" });
    expect(blockers[0]).toMatch(/member A has already contributed/);
  });

  it("blocks a member with no obligation in the round", () => {
    const blockers = contributionBlockers({ ...LIVE, memberLabel: "C" });
    expect(blockers[0]).toMatch(/member C has no obligation/);
  });

  it("treats a defaulted obligation as not Pending", () => {
    const blockers = contributionBlockers({
      ...LIVE,
      obligations: { A: { status: "OnTime" }, B: { status: "MissedDefault" } },
    });
    expect(blockers[0]).toMatch(/member B obligation is MissedDefault, not Pending/);
  });
});

describe("shared preconditions still apply", () => {
  it("blocks when the account is not registered", () => {
    expect(contributionBlockers({ ...LIVE, registered: false })).toContain(
      "account not registered with the STRK20 pool",
    );
  });

  it("blocks when the shielded balance has not been read", () => {
    expect(contributionBlockers({ ...LIVE, shieldedUsdc: null }).join(" ")).toMatch(/not read/);
  });

  it("blocks when the shielded balance is short", () => {
    expect(contributionBlockers({ ...LIVE, shieldedUsdc: 1_000_000n }).join(" ")).toMatch(
      /below the 2/,
    );
  });

  it("blocks when no shield is recorded", () => {
    expect(contributionBlockers({ ...LIVE, shieldCompleted: false })).toContain(
      "no verified shield recorded",
    );
  });

  it("blocks when the circle is not Active", () => {
    expect(contributionBlockers({ ...LIVE, circleStatus: "OpenForMembers" })).toContain(
      "circle is OpenForMembers",
    );
  });

  it("blocks on unaccounted helper surplus", () => {
    expect(contributionBlockers({ ...LIVE, helperSurplus: 1n }).join(" ")).toMatch(
      /normalize_surplus/,
    );
  });

  it("blocks on an insufficient STRK allowance for the remaining fees", () => {
    expect(
      contributionBlockers({ ...LIVE, strkAllowance: 6n * 10n ** 18n }).join(" "),
    ).toMatch(/below the 12/);
  });

  it("blocks while the shielded note is immature", () => {
    expect(contributionBlockers({ ...LIVE, maturityRemaining: 4 }).join(" ")).toMatch(
      /4 blocks until/,
    );
  });

  it("blocks when the shield block is unknown", () => {
    expect(contributionBlockers({ ...LIVE, maturityRemaining: null }).join(" ")).toMatch(
      /shield block unknown/,
    );
  });
});

describe("hasContributed", () => {
  it("recognises settled and unsettled states", () => {
    const obligations = {
      A: { status: "OnTime" },
      B: { status: "Pending" },
      C: { status: "LateWithinGrace" },
      D: { status: "MissedDefault" },
    };
    expect(hasContributed(obligations, "A")).toBe(true);
    expect(hasContributed(obligations, "B")).toBe(false);
    expect(hasContributed(obligations, "C")).toBe(true);
    expect(hasContributed(obligations, "D")).toBe(false);
    expect(hasContributed(null, "A")).toBe(false);
  });
});
