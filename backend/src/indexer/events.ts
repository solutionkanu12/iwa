// Public event indexer.
//
// Reads only what IwaCircle already publishes on chain — circle creation,
// membership, and contribution state transitions. There is nothing private
// here to leak: private contribution amounts live inside the STRK20 pool and
// are never visible to this service in the first place.
//
// The cursor advances only after a range is persisted, so a crash re-reads a
// range rather than skipping it. Writes are idempotent on (tx_hash, event_index).

import { RpcProvider, hash } from "starknet";

import type { CircleEvent, IndexedCircle, Store } from "../store.js";

/** CircleStatus, in the contract's declaration order. */
const CIRCLE_STATUS = [
  "Created",
  "OpenForMembers",
  "Active",
  "PausedForNewActions",
  "SettlementPending",
  "Completed",
] as const;

/** The tokens a circle can be denominated in. Public addresses, no secrets. */
export interface IndexerTokens {
  usdc: string;
  strk: string;
}

/**
 * One `get_circle` reply as the cached row.
 *
 * Twelve felts, in the order `CircleView` declares them. Three of them are
 * deliberately dropped rather than stored: the organizer's address, the payout
 * order lock and the creation timestamp. None is needed to answer "which
 * circles exist and how far along are they", and a column nobody needs is a
 * column that eventually leaks something.
 *
 * Returns null rather than guessing whenever the reply is not a circle view, so
 * a short answer or an unknown status cannot become a confident cached row.
 */
export function decodeCircleView(
  felts: readonly string[],
  circleId: number,
  chainId: string,
  tokens: IndexerTokens,
): Omit<IndexedCircle, "updatedAt"> | null {
  if (felts.length < 12) return null;

  const int = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    try {
      return Number(BigInt(v));
    } catch {
      return null;
    }
  };

  const asset = int(felts[1]);
  const memberLimit = int(felts[5]);
  const currentRound = int(felts[6]);
  const statusIndex = int(felts[7]);
  const joinedCount = int(felts[11]);
  if (memberLimit === null || currentRound === null || joinedCount === null) return null;
  if (statusIndex === null || statusIndex < 0 || statusIndex >= CIRCLE_STATUS.length) return null;
  if (asset !== 0 && asset !== 1) return null;

  let contributionAmount: string;
  try {
    contributionAmount = BigInt(felts[2] as string).toString();
  } catch {
    return null;
  }

  return {
    chainId,
    circleId,
    contributionAmount,
    token: asset === 1 ? tokens.strk : tokens.usdc,
    memberLimit,
    joinedCount,
    currentRound,
    status: CIRCLE_STATUS[statusIndex],
  };
}

/** Event names IwaCircle emits that are worth indexing. */
export const INDEXED_EVENTS = [
  "CircleCreated",
  "MemberJoined",
  "CircleActivated",
  "ContributionStateUpdated",
  "PayoutAccountingPrepared",
  "PayoutSettlementAuthorized",
] as const;

const CONTRIBUTION_STATUS = ["Pending", "OnTime", "LateWithinGrace", "MissedDefault"];

export interface IndexerOptions {
  provider: RpcProvider;
  store: Store;
  chainId: string;
  circleAddress: string;
  startBlock: number;
  /** The assets a circle can be denominated in, so a cached row names its token. */
  tokens: IndexerTokens;
  /** Blocks per pass. Kept modest so one pass cannot stall the service. */
  batchSize?: number;
  cursorName?: string;
  /**
   * How far the circle sweep will count before giving up.
   *
   * `IwaCircle` has no list call and assigns ids in sequence from 1, so the only
   * way to discover circles is to count upward until one does not exist. The cap
   * stops a malformed reply turning that into an unbounded scan.
   */
  maxCircleScan?: number;
}

/** Decodes one raw event into the public row shape. Unknown shapes are skipped. */
export function decodeEvent(
  raw: { keys: string[]; data: string[]; transaction_hash: string; block_number?: number },
  eventIndex: number,
  chainId: string,
  selectorToName: Map<string, string>,
): CircleEvent | null {
  const name = selectorToName.get(normalize(raw.keys[0] ?? ""));
  if (name === undefined || raw.block_number === undefined) return null;

  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    try {
      return Number(BigInt(v));
    } catch {
      return null;
    }
  };

  const base: CircleEvent = {
    chainId,
    blockNumber: raw.block_number,
    txHash: raw.transaction_hash,
    eventIndex,
    eventName: name,
    // keys[1] is the indexed circle_id on every event that carries one.
    circleId: num(raw.keys[1]),
    round: null,
    memberRef: null,
    status: null,
  };

  if (name === "ContributionStateUpdated") {
    // data = [round, member_ref, status]
    base.round = num(raw.data[0]);
    base.memberRef = raw.data[1] ? normalize(raw.data[1]) : null;
    const s = num(raw.data[2]);
    base.status = s === null ? null : (CONTRIBUTION_STATUS[s] ?? String(s));
  } else if (name === "MemberJoined") {
    // data = [member_ref, slot]
    base.memberRef = raw.data[0] ? normalize(raw.data[0]) : null;
  }

  return base;
}

function normalize(felt: string): string {
  try {
    return `0x${BigInt(felt).toString(16)}`;
  } catch {
    return felt;
  }
}

export class CircleIndexer {
  private readonly opts: Required<IndexerOptions>;
  private readonly selectorToName: Map<string, string>;

  constructor(options: IndexerOptions) {
    this.opts = {
      batchSize: 2000,
      cursorName: "iwa_circle_events",
      maxCircleScan: 64,
      ...options,
    };
    this.selectorToName = new Map(
      INDEXED_EVENTS.map((n) => [normalize(hash.getSelectorFromName(n)), n]),
    );
  }

  /**
   * Refreshes the cached view of every circle that exists on chain.
   *
   * `IwaCircle` assigns ids in sequence from 1 and has no list call, so this
   * counts upward until an id does not answer. That makes it self-healing: it
   * does not depend on where the event cursor happens to be, so a service that
   * has already indexed past a circle's creation still ends up with its row.
   *
   * Idempotent by construction. Every write is `upsertIndexedCircle`, which is
   * an upsert keyed on (chain, circle), so running this a hundred times leaves
   * the same rows with fresher figures and never a duplicate.
   *
   * A read that fails ends the sweep and is not an error: an unreachable node
   * means this pass learned nothing, not that the circles stopped existing.
   * Nothing is written for a circle that could not be read.
   */
  private async syncCircles(): Promise<number> {
    let synced = 0;
    for (let circleId = 1; circleId <= this.opts.maxCircleScan; circleId += 1) {
      let felts: string[];
      try {
        felts = await this.opts.provider.callContract(
          {
            contractAddress: this.opts.circleAddress,
            entrypoint: "get_circle",
            calldata: [String(circleId)],
          },
          "latest",
        );
      } catch {
        // Past the last circle, or the node is unavailable. Either way there is
        // nothing further to learn this pass.
        break;
      }

      const circle = decodeCircleView(felts, circleId, this.opts.chainId, this.opts.tokens);
      if (circle === null) break;
      await this.opts.store.upsertIndexedCircle(circle);
      synced += 1;
    }
    return synced;
  }

  /** Runs one pass. Returns how far it got and how many rows it wrote. */
  async runOnce(): Promise<{ from: number; to: number; inserted: number; circles: number }> {
    // Before the event pass, and outside its early return: a caught-up service
    // has no new blocks to read but its circle cache still has to be right.
    // That early return is exactly why this half never ran in production.
    const circles = await this.syncCircles();

    const cursor = await this.opts.store.getCursor(this.opts.cursorName);
    const from = cursor === null ? this.opts.startBlock : cursor + 1;
    const head = await this.opts.provider.getBlockNumber();
    const to = Math.min(head, from + this.opts.batchSize - 1);

    if (from > head) return { from, to: head, inserted: 0, circles };

    const events: CircleEvent[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.opts.provider.getEvents({
        address: this.opts.circleAddress,
        from_block: { block_number: from },
        to_block: { block_number: to },
        chunk_size: 100,
        ...(continuationToken ? { continuation_token: continuationToken } : {}),
      });
      page.events.forEach((e, i) => {
        const decoded = decodeEvent(
          e as unknown as Parameters<typeof decodeEvent>[0],
          i,
          this.opts.chainId,
          this.selectorToName,
        );
        if (decoded !== null) events.push(decoded);
      });
      continuationToken = page.continuation_token;
    } while (continuationToken);

    const inserted = await this.opts.store.recordEvents(events);
    // Only after the rows are durable.
    await this.opts.store.setCursor(this.opts.cursorName, this.opts.chainId, to);
    return { from, to, inserted, circles };
  }
}
