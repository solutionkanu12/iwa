import { describe, expect, it } from "vitest";

import {
  celoCircleId,
  celoDomainCircle,
  celoMemberRef,
  celoMyObligation,
  loadCeloCircleContext,
} from "./circleModel";
import type { CeloCircleReader } from "./circleReader";

const CIRCLE_CONTRACT = "0x" + "0".repeat(37) + "abc";
const CIRCLE_ID = celoCircleId(CIRCLE_CONTRACT);
const ORGANIZER = "0x" + "0".repeat(39) + "1";
const MEMBER_0 = "0x" + "0".repeat(39) + "2";
const MEMBER_1 = "0x" + "0".repeat(39) + "3";

function fakeReader(overrides: Partial<CeloCircleReader> = {}): CeloCircleReader {
  return {
    readSnapshot: async () => ({
      status: "ACTIVE",
      currentRound: 1,
      memberCount: 2,
      organizer: ORGANIZER,
      contributionAmount: 5_000_000n,
      dueAt: 1_700_000_000,
      graceEndsAt: 1_700_000_500,
      scheduledMember: MEMBER_0,
      payoutStatus: "SCHEDULED",
    }),
    readMemberAt: async (i: number) => [MEMBER_0, MEMBER_1][i],
    readCadenceSeconds: async () => 604_800,
    readGracePeriodSeconds: async () => 86_400,
    readContributionStatus: async () => "PENDING",
    readPayoutStatus: async () => "SCHEDULED",
    readRecovered: async () => false,
    ...overrides,
  } as CeloCircleReader;
}

describe("celoCircleId / celoMemberRef", () => {
  it("normalizes the circle contract into a lowercase chain-neutral id", () => {
    expect(celoCircleId(CIRCLE_CONTRACT)).toBe(`celo:${CIRCLE_CONTRACT.toLowerCase()}`);
  });

  it("derives a stable, opaque memberRef per slot", () => {
    expect(celoMemberRef(CIRCLE_CONTRACT, 0)).toBe(`${CIRCLE_ID}:0`);
    expect(celoMemberRef(CIRCLE_CONTRACT, 1)).toBe(`${CIRCLE_ID}:1`);
  });
});

describe("loadCeloCircleContext", () => {
  it("assembles the full execution context for a connected member wallet", async () => {
    const ctx = await loadCeloCircleContext(fakeReader(), CIRCLE_CONTRACT, MEMBER_1);
    expect(ctx.circleId).toBe(CIRCLE_ID);
    expect(ctx.chainId).toBe(42220);
    expect(ctx.asset).toBe("cNGN");
    expect(ctx.organizer).toBe(ORGANIZER.toLowerCase());
    expect(ctx.members).toEqual([MEMBER_0.toLowerCase(), MEMBER_1.toLowerCase()]);
    expect(ctx.mySlot).toBe(1);
    expect(ctx.myMemberRef).toBe(celoMemberRef(CIRCLE_CONTRACT, 1));
    expect(ctx.isOrganizer).toBe(false);
    expect(ctx.isScheduledRecipient).toBe(false);
  });

  it("flags the organizer and the scheduled recipient correctly", async () => {
    const ctxOrganizer = await loadCeloCircleContext(fakeReader(), CIRCLE_CONTRACT, ORGANIZER);
    expect(ctxOrganizer.isOrganizer).toBe(true);
    expect(ctxOrganizer.mySlot).toBeNull();

    const ctxScheduled = await loadCeloCircleContext(fakeReader(), CIRCLE_CONTRACT, MEMBER_0);
    expect(ctxScheduled.isScheduledRecipient).toBe(true);
  });

  it("leaves mySlot/myMemberRef null with no connected wallet", async () => {
    const ctx = await loadCeloCircleContext(fakeReader(), CIRCLE_CONTRACT, null);
    expect(ctx.mySlot).toBeNull();
    expect(ctx.myMemberRef).toBeNull();
    expect(ctx.myContributionStatus).toBeNull();
    expect(ctx.isOrganizer).toBe(false);
    expect(ctx.isScheduledRecipient).toBe(false);
  });

  it("reads the connected member's own contribution status for the current round", async () => {
    let queriedRound: number | null = null;
    let queriedMember: string | null = null;
    const reader = fakeReader({
      readContributionStatus: async (round: number, member: string) => {
        queriedRound = round;
        queriedMember = member;
        return "LATE_WITHIN_GRACE";
      },
    });
    const ctx = await loadCeloCircleContext(reader, CIRCLE_CONTRACT, MEMBER_1);
    expect(ctx.myContributionStatus).toBe("LATE_WITHIN_GRACE");
    expect(queriedRound).toBe(1);
    expect(queriedMember).toBe(MEMBER_1);
  });
});

describe("celoDomainCircle / celoMyObligation", () => {
  it("builds a chain-neutral Circle from the context", async () => {
    const ctx = await loadCeloCircleContext(fakeReader(), CIRCLE_CONTRACT, MEMBER_1);
    const circle = celoDomainCircle(ctx);
    expect(circle.id).toBe(CIRCLE_ID);
    expect(circle.asset).toBe("cNGN");
    expect(circle.contributionAmount).toBe("5000000");
    expect(circle.cadenceSeconds).toBe(604_800);
    expect(circle.gracePeriodSeconds).toBe(86_400);
    expect(circle.currentRound).toBe(1);
    expect(circle.status).toBe("ACTIVE");
    expect(circle.payoutOrder).toEqual([
      celoMemberRef(CIRCLE_CONTRACT, 0),
      celoMemberRef(CIRCLE_CONTRACT, 1),
    ]);
  });

  it("builds the connected member's own obligation, or null when not a member", async () => {
    const ctx = await loadCeloCircleContext(fakeReader(), CIRCLE_CONTRACT, MEMBER_1);
    const obligation = celoMyObligation(ctx);
    expect(obligation).not.toBeNull();
    expect(obligation?.memberRef).toBe(celoMemberRef(CIRCLE_CONTRACT, 1));
    expect(obligation?.round).toBe(1);
    expect(obligation?.status).toBe("PENDING");

    const outsider = await loadCeloCircleContext(
      fakeReader(),
      CIRCLE_CONTRACT,
      "0x" + "0".repeat(39) + "9",
    );
    expect(celoMyObligation(outsider)).toBeNull();
  });
});

describe("recoverableRounds", () => {
  it("finds a past DeferredLocked round the connected member paid and has not recovered", async () => {
    const reader = fakeReader({
      readSnapshot: async () => ({
        status: "ACTIVE",
        currentRound: 3,
        memberCount: 2,
        organizer: ORGANIZER,
        contributionAmount: 5_000_000n,
        dueAt: 1_700_000_000,
        graceEndsAt: 1_700_000_500,
        scheduledMember: MEMBER_0,
        payoutStatus: "SCHEDULED",
      }),
      readPayoutStatus: async (round: number) => (round === 2 ? "DEFERRED_LOCKED" : "PAID"),
      readContributionStatus: async () => "ON_TIME",
      readRecovered: async () => false,
    });
    const ctx = await loadCeloCircleContext(reader, CIRCLE_CONTRACT, MEMBER_1);
    expect(ctx.recoverableRounds).toEqual([2]);
  });

  it("excludes a locked round the member did not pay (defaulted)", async () => {
    const reader = fakeReader({
      readSnapshot: async () => ({
        status: "ACTIVE",
        currentRound: 3,
        memberCount: 2,
        organizer: ORGANIZER,
        contributionAmount: 5_000_000n,
        dueAt: 1_700_000_000,
        graceEndsAt: 1_700_000_500,
        scheduledMember: MEMBER_0,
        payoutStatus: "SCHEDULED",
      }),
      readPayoutStatus: async (round: number) => (round === 2 ? "DEFERRED_LOCKED" : "PAID"),
      readContributionStatus: async () => "MISSED_DEFAULT",
      readRecovered: async () => false,
    });
    const ctx = await loadCeloCircleContext(reader, CIRCLE_CONTRACT, MEMBER_1);
    expect(ctx.recoverableRounds).toEqual([]);
  });

  it("excludes a round already recovered", async () => {
    const reader = fakeReader({
      readSnapshot: async () => ({
        status: "ACTIVE",
        currentRound: 3,
        memberCount: 2,
        organizer: ORGANIZER,
        contributionAmount: 5_000_000n,
        dueAt: 1_700_000_000,
        graceEndsAt: 1_700_000_500,
        scheduledMember: MEMBER_0,
        payoutStatus: "SCHEDULED",
      }),
      readPayoutStatus: async (round: number) => (round === 2 ? "DEFERRED_LOCKED" : "PAID"),
      readContributionStatus: async () => "ON_TIME",
      readRecovered: async () => true,
    });
    const ctx = await loadCeloCircleContext(reader, CIRCLE_CONTRACT, MEMBER_1);
    expect(ctx.recoverableRounds).toEqual([]);
  });

  it("is empty with no connected wallet, and does not scan past rounds at all", async () => {
    let scanned = false;
    const reader = fakeReader({
      readSnapshot: async () => ({
        status: "ACTIVE",
        currentRound: 3,
        memberCount: 2,
        organizer: ORGANIZER,
        contributionAmount: 5_000_000n,
        dueAt: 1_700_000_000,
        graceEndsAt: 1_700_000_500,
        scheduledMember: MEMBER_0,
        payoutStatus: "SCHEDULED",
      }),
      readPayoutStatus: async () => {
        scanned = true;
        return "DEFERRED_LOCKED";
      },
    });
    const ctx = await loadCeloCircleContext(reader, CIRCLE_CONTRACT, null);
    expect(ctx.recoverableRounds).toEqual([]);
    expect(scanned).toBe(false);
  });

  it("is empty on round 1, with no past rounds to scan", async () => {
    const ctx = await loadCeloCircleContext(fakeReader(), CIRCLE_CONTRACT, MEMBER_1);
    expect(ctx.recoverableRounds).toEqual([]);
  });

  it("never attributes another member's recoverable round to the wrong connected wallet", async () => {
    // MEMBER_0 paid the locked round; MEMBER_1 did not. Connecting as
    // MEMBER_1 must never see MEMBER_0's entitlement.
    const reader = fakeReader({
      readSnapshot: async () => ({
        status: "ACTIVE",
        currentRound: 3,
        memberCount: 2,
        organizer: ORGANIZER,
        contributionAmount: 5_000_000n,
        dueAt: 1_700_000_000,
        graceEndsAt: 1_700_000_500,
        scheduledMember: MEMBER_0,
        payoutStatus: "SCHEDULED",
      }),
      readPayoutStatus: async (round: number) => (round === 2 ? "DEFERRED_LOCKED" : "PAID"),
      readContributionStatus: async (_round: number, member: string) =>
        member.toLowerCase() === MEMBER_0.toLowerCase() ? "ON_TIME" : "MISSED_DEFAULT",
      readRecovered: async () => false,
    });
    const asMember0 = await loadCeloCircleContext(reader, CIRCLE_CONTRACT, MEMBER_0);
    const asMember1 = await loadCeloCircleContext(reader, CIRCLE_CONTRACT, MEMBER_1);
    expect(asMember0.recoverableRounds).toEqual([2]);
    expect(asMember1.recoverableRounds).toEqual([]);
  });
});
