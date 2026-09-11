import { describe, expect, it } from "vitest";
import { id as keccakId } from "ethers";

import { CeloCircleReader } from "./circleReader";
import type { CeloProviderLike } from "./transactions";

const CIRCLE_CONTRACT = "0x00000000000000000000000000000000000000ab";
const MEMBER = "0x00000000000000000000000000000000000000cd";

function selector(sig: string): string {
  return keccakId(sig).slice(0, 10);
}

function uintWord(value: bigint | number): string {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

function addressWord(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

/** Maps a selector prefix to a canned response, ignoring any trailing args. */
function mockProvider(
  responses: Record<string, string>,
  logs: unknown[] = [],
): CeloProviderLike {
  return {
    async request(args) {
      if (args.method === "eth_call") {
        const tx = (args.params as { data: string }[])[0];
        const sel = tx.data.slice(0, 10);
        const response = responses[sel];
        if (response === undefined) throw new Error(`no mock response for selector ${sel}`);
        return response;
      }
      if (args.method === "eth_getLogs") {
        return logs;
      }
      throw new Error(`unexpected ${args.method}`);
    },
  };
}

describe("CeloCircleReader", () => {
  it("reads status as ACTIVE/COMPLETED from the enum index", async () => {
    const provider = mockProvider({ [selector("status()")]: uintWord(0) });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readStatus()).toBe("ACTIVE");

    const providerCompleted = mockProvider({ [selector("status()")]: uintWord(1) });
    const readerCompleted = new CeloCircleReader(CIRCLE_CONTRACT, providerCompleted);
    expect(await readerCompleted.readStatus()).toBe("COMPLETED");
  });

  it("reads currentRound, memberCount, and contributionAmount as numbers/bigint", async () => {
    const provider = mockProvider({
      [selector("currentRound()")]: uintWord(2),
      [selector("memberCount()")]: uintWord(5),
      [selector("contributionAmount()")]: uintWord(5_000_000),
    });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readCurrentRound()).toBe(2);
    expect(await reader.readMemberCount()).toBe(5);
    expect(await reader.readContributionAmount()).toBe(5_000_000n);
  });

  it("reads organizer and scheduledMember as normalized addresses", async () => {
    const provider = mockProvider({
      [selector("organizer()")]: addressWord(MEMBER),
      [selector("scheduledMember(uint32)")]: addressWord(MEMBER),
    });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readOrganizer()).toBe(MEMBER.toLowerCase());
    expect(await reader.readScheduledMember(1)).toBe(MEMBER.toLowerCase());
  });

  it("reads contributionStatus and payoutStatus enums correctly", async () => {
    const provider = mockProvider({
      [selector("contributionStatus(uint32,address)")]: uintWord(2), // LATE_WITHIN_GRACE
      [selector("payoutStatus(uint32)")]: uintWord(2), // DEFERRED_LOCKED
    });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readContributionStatus(1, MEMBER)).toBe("LATE_WITHIN_GRACE");
    expect(await reader.readPayoutStatus(1)).toBe("DEFERRED_LOCKED");
  });

  it("reads dueAt and graceEndsAt as unix-second numbers", async () => {
    const provider = mockProvider({
      [selector("dueAt()")]: uintWord(1_700_000_000),
      [selector("graceEndsAt()")]: uintWord(1_700_000_500),
    });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readDueAt()).toBe(1_700_000_000);
    expect(await reader.readGraceEndsAt()).toBe(1_700_000_500);
  });

  it("throws rather than guessing on an out-of-range enum index (a malformed/unexpected response)", async () => {
    const provider = mockProvider({ [selector("status()")]: uintWord(99) });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    await expect(reader.readStatus()).rejects.toThrow(/out of range/);
  });

  it("readSnapshot assembles every field from a single pass of reads", async () => {
    const provider = mockProvider({
      [selector("status()")]: uintWord(0),
      [selector("currentRound()")]: uintWord(1),
      [selector("memberCount()")]: uintWord(3),
      [selector("organizer()")]: addressWord(MEMBER),
      [selector("contributionAmount()")]: uintWord(5_000_000),
      [selector("dueAt()")]: uintWord(1_700_000_000),
      [selector("graceEndsAt()")]: uintWord(1_700_000_500),
      [selector("scheduledMember(uint32)")]: addressWord(MEMBER),
      [selector("payoutStatus(uint32)")]: uintWord(0),
    });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    const snapshot = await reader.readSnapshot();
    expect(snapshot).toEqual({
      status: "ACTIVE",
      currentRound: 1,
      memberCount: 3,
      organizer: MEMBER.toLowerCase(),
      contributionAmount: 5_000_000n,
      dueAt: 1_700_000_000,
      graceEndsAt: 1_700_000_500,
      scheduledMember: MEMBER.toLowerCase(),
      payoutStatus: "SCHEDULED",
    });
  });

  it("reads memberAt, isMember, cadenceSeconds, and gracePeriodSeconds", async () => {
    const provider = mockProvider({
      [selector("memberAt(uint256)")]: addressWord(MEMBER),
      [selector("isMember(address)")]: uintWord(1),
      [selector("cadenceSeconds()")]: uintWord(604_800),
      [selector("gracePeriodSeconds()")]: uintWord(86_400),
    });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readMemberAt(0)).toBe(MEMBER.toLowerCase());
    expect(await reader.readIsMember(MEMBER)).toBe(true);
    expect(await reader.readCadenceSeconds()).toBe(604_800);
    expect(await reader.readGracePeriodSeconds()).toBe(86_400);
  });

  it("reads isMember as false from a zero response", async () => {
    const provider = mockProvider({ [selector("isMember(address)")]: uintWord(0) });
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readIsMember(MEMBER)).toBe(false);
  });

  it("reads whether a member has already recovered a round from the Recovered event log", async () => {
    let seenFilter: { address?: string; topics?: string[] } | undefined;
    const provider: CeloProviderLike = {
      async request(args) {
        if (args.method === "eth_getLogs") {
          seenFilter = (args.params as { address?: string; topics?: string[] }[])[0];
          return [{ transactionHash: "0xabc" }];
        }
        throw new Error(`unexpected ${args.method}`);
      },
    };
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readRecovered(3, MEMBER)).toBe(true);
    expect(seenFilter?.address?.toLowerCase()).toBe(CIRCLE_CONTRACT.toLowerCase());
    expect(seenFilter?.topics?.[0]).toBe(keccakId("Recovered(address,uint32,uint256)"));
    expect(seenFilter?.topics?.[1]?.toLowerCase()).toBe(addressWord(MEMBER).toLowerCase());
    expect(seenFilter?.topics?.[2]).toBe(uintWord(3));
  });

  it("reads no prior recovery when the log query returns nothing", async () => {
    const provider = mockProvider({}, []);
    const reader = new CeloCircleReader(CIRCLE_CONTRACT, provider);
    expect(await reader.readRecovered(3, MEMBER)).toBe(false);
  });

  it("rejects construction with a malformed circle contract address", () => {
    expect(() => new CeloCircleReader("not-an-address", mockProvider({}))).toThrow();
  });
});
