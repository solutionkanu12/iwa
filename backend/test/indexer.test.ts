// The public event indexer.
//
// Two jobs, and until now only one of them was done. It records the events
// IwaCircle publishes, and it is supposed to keep a cached view of the circles
// themselves so the service can answer "which circles exist" without a read
// storm. The second half was never wired up: `upsertIndexedCircle` existed, was
// implemented in both stores, and was called by nothing, so `indexed_circles`
// stayed empty in production and every figure derived from it read zero.
//
// These cover both halves, and specifically that the circle sync is idempotent
// and runs even when there are no new blocks — because a service that has
// caught up is exactly the state production was in.

import { describe, expect, it, beforeEach } from "vitest";

import { CircleIndexer, decodeCircleView, decodeEvent } from "../src/indexer/events.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";

const CIRCLE = "0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const STRK = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const TOKENS = { usdc: USDC, strk: STRK };

/** One circle as `get_circle` returns it: twelve felts, in contract order. */
function circleFelts(over: Partial<Record<string, string>> = {}): string[] {
  const base = [
    "0x1", // id
    "0x0", // asset: Usdc
    "0xf4240", // contribution_amount = 1_000_000
    "0x93a80", // cadence
    "0x15180", // grace
    "0x2", // member_limit
    "0x1", // current_round
    "0x2", // status: Active
    "0x6a9c0000", // created_at
    "0xabc", // organizer
    "0x1", // payout_order_locked
    "0x2", // joined_count
  ];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v as string;
  return base;
}

/** A provider that answers from fixtures and counts what it was asked. */
function fakeProvider(opts: {
  head?: number;
  events?: { keys: string[]; data: string[]; transaction_hash: string; block_number: number }[];
  circleCount?: number;
}) {
  const calls: { entrypoint: string; calldata: string[] }[] = [];
  return {
    calls,
    async getBlockNumber() {
      return opts.head ?? 100;
    },
    async getEvents() {
      return { events: opts.events ?? [], continuation_token: undefined };
    },
    async callContract(req: { entrypoint: string; calldata: string[] }) {
      calls.push(req);
      if (req.entrypoint !== "get_circle") throw new Error("unexpected entrypoint");
      const id = Number(BigInt(req.calldata[0] as string));
      if (id < 1 || id > (opts.circleCount ?? 1)) throw new Error("IWA: circle not found");
      return circleFelts({ 0: `0x${id.toString(16)}` });
    },
  };
}

function indexer(provider: ReturnType<typeof fakeProvider>, store: MemoryStore, over = {}) {
  return new CircleIndexer({
    provider: provider as never,
    store,
    chainId: SN_MAIN,
    circleAddress: CIRCLE,
    startBlock: 1,
    tokens: TOKENS,
    ...over,
  });
}

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

describe("decoding one circle view", () => {
  it("reads the fields the cached row needs and nothing more", () => {
    const c = decodeCircleView(circleFelts(), 7, SN_MAIN, TOKENS);
    expect(c).toEqual({
      chainId: SN_MAIN,
      circleId: 7,
      contributionAmount: "1000000",
      token: USDC,
      memberLimit: 2,
      joinedCount: 2,
      currentRound: 1,
      status: "Active",
    });
  });

  it("resolves the asset to the token the circle is denominated in", () => {
    expect(decodeCircleView(circleFelts({ 1: "0x1" }), 1, SN_MAIN, TOKENS)?.token).toBe(STRK);
  });

  it("carries no organizer, member reference or payout order", () => {
    const c = decodeCircleView(circleFelts(), 1, SN_MAIN, TOKENS) as Record<string, unknown>;
    expect(Object.keys(c)).not.toContain("organizer");
    expect(JSON.stringify(c)).not.toContain("0xabc");
  });

  it("refuses a reply that is not a circle view rather than inventing one", () => {
    expect(decodeCircleView(["0x1", "0x0"], 1, SN_MAIN, TOKENS)).toBeNull();
    expect(decodeCircleView([], 1, SN_MAIN, TOKENS)).toBeNull();
  });

  it("refuses an unknown status discriminant", () => {
    expect(decodeCircleView(circleFelts({ 7: "0x9" }), 1, SN_MAIN, TOKENS)).toBeNull();
  });
});

describe("circles discovered on chain reach the cache", () => {
  it("upserts every circle it finds", async () => {
    const p = fakeProvider({ circleCount: 3 });
    const result = await indexer(p, store).runOnce();
    expect(result.circles).toBe(3);

    const cached = await store.listIndexedCircles(SN_MAIN);
    expect(cached.map((c) => c.circleId).sort()).toEqual([1, 2, 3]);
    expect(cached[0].status).toBe("Active");
  });

  it("stops at the first id that does not exist", async () => {
    const p = fakeProvider({ circleCount: 2 });
    await indexer(p, store).runOnce();
    // Ids 1, 2, then 3 to discover the end. Never beyond.
    expect(p.calls.map((c) => Number(BigInt(c.calldata[0] as string)))).toEqual([1, 2, 3]);
  });

  it("writes no row when the chain has no circles yet", async () => {
    const p = fakeProvider({ circleCount: 0 });
    const result = await indexer(p, store).runOnce();
    expect(result.circles).toBe(0);
    expect(await store.listIndexedCircles(SN_MAIN)).toEqual([]);
  });

  it("is idempotent: a second pass writes the same rows, not duplicates", async () => {
    const p = fakeProvider({ circleCount: 2 });
    const first = await indexer(p, store).runOnce();
    const second = await indexer(p, store).runOnce();
    expect(first.circles).toBe(2);
    expect(second.circles).toBe(2);
    expect((await store.listIndexedCircles(SN_MAIN)).length).toBe(2);
  });

  it("refreshes a circle whose state moved on", async () => {
    const p = fakeProvider({ circleCount: 1 });
    await indexer(p, store).runOnce();
    expect((await store.listIndexedCircles(SN_MAIN))[0].currentRound).toBe(1);

    // The same circle, now in round 2.
    const moved = {
      ...p,
      async callContract(req: { entrypoint: string; calldata: string[] }) {
        const id = Number(BigInt(req.calldata[0] as string));
        if (id !== 1) throw new Error("IWA: circle not found");
        return circleFelts({ 6: "0x2" });
      },
    };
    await indexer(moved as never, store).runOnce();
    const cached = await store.listIndexedCircles(SN_MAIN);
    expect(cached.length).toBe(1);
    expect(cached[0].currentRound).toBe(2);
  });

  it("runs even when there are no new blocks, which is the caught up case", async () => {
    // The bug in production: the pass returned early once the cursor reached
    // the head, so the circle sync would never have happened.
    await store.setCursor("iwa_circle_events", SN_MAIN, 100);
    const p = fakeProvider({ head: 100, circleCount: 1 });
    const result = await indexer(p, store).runOnce();
    expect(result.inserted).toBe(0);
    expect(result.circles).toBe(1);
    expect((await store.listIndexedCircles(SN_MAIN)).length).toBe(1);
  });

  it("keeps the cache to one chain", async () => {
    const p = fakeProvider({ circleCount: 1 });
    await indexer(p, store).runOnce();
    expect(await store.listIndexedCircles("0x534e5f5345504f4c4941")).toEqual([]);
  });

  it("never scans past its cap", async () => {
    const p = fakeProvider({ circleCount: 500 });
    await indexer(p, store, { maxCircleScan: 5 }).runOnce();
    expect(p.calls.length).toBe(5);
    expect((await store.listIndexedCircles(SN_MAIN)).length).toBe(5);
  });
});

describe("the event pass is unchanged", () => {
  const selector = (name: string): string => {
    // The indexer maps selectors itself; this mirrors it for the fixture.
    const { hash } = require("starknet") as typeof import("starknet");
    return `0x${BigInt(hash.getSelectorFromName(name)).toString(16)}`;
  };

  it("still records events and advances the cursor", async () => {
    const p = fakeProvider({
      head: 50,
      circleCount: 1,
      events: [
        {
          keys: [selector("MemberJoined"), "0x1"],
          data: ["0xaaa", "0x0"],
          transaction_hash: "0xtx1",
          block_number: 10,
        },
      ],
    });
    const result = await indexer(p, store).runOnce();
    expect(result.inserted).toBe(1);
    expect(result.to).toBe(50);
    expect(await store.getCursor("iwa_circle_events")).toBe(50);
    const events = await store.listEventsForCircle(SN_MAIN, 1);
    expect(events.length).toBe(1);
    expect(events[0].eventName).toBe("MemberJoined");
  });

  it("advances the cursor only once the rows are durable", async () => {
    const p = fakeProvider({ head: 50, circleCount: 1 });
    const broken = new MemoryStore();
    broken.recordEvents = async () => {
      throw new Error("write failed");
    };
    await expect(indexer(p, broken).runOnce()).rejects.toThrow("write failed");
    expect(await broken.getCursor("iwa_circle_events")).toBeNull();
  });

  it("decodes a contribution transition exactly as before", () => {
    const map = new Map([["0xabc", "ContributionStateUpdated"]]);
    const decoded = decodeEvent(
      { keys: ["0xabc", "0x1"], data: ["0x2", "0xdef", "0x1"], transaction_hash: "0xt", block_number: 5 },
      0,
      SN_MAIN,
      map,
    );
    expect(decoded).toEqual({
      chainId: SN_MAIN,
      blockNumber: 5,
      txHash: "0xt",
      eventIndex: 0,
      eventName: "ContributionStateUpdated",
      circleId: 1,
      round: 2,
      memberRef: "0xdef",
      status: "OnTime",
    });
  });
});

describe("a failed circle read does not lose the event pass", () => {
  it("still records events and advances the cursor when the sync cannot read", async () => {
    const p = {
      async getBlockNumber() {
        return 50;
      },
      async getEvents() {
        return { events: [], continuation_token: undefined };
      },
      async callContract() {
        throw new Error("RPC unavailable");
      },
    };
    const result = await indexer(p as never, store).runOnce();
    // No circle could be read, so none is claimed.
    expect(result.circles).toBe(0);
    expect(await store.listIndexedCircles(SN_MAIN)).toEqual([]);
    // The event half still completed.
    expect(await store.getCursor("iwa_circle_events")).toBe(50);
  });
});
