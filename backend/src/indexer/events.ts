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

import type { CircleEvent, Store } from "../store.js";

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
  /** Blocks per pass. Kept modest so one pass cannot stall the service. */
  batchSize?: number;
  cursorName?: string;
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
      ...options,
    };
    this.selectorToName = new Map(
      INDEXED_EVENTS.map((n) => [normalize(hash.getSelectorFromName(n)), n]),
    );
  }

  /** Runs one pass. Returns how far it got and how many rows it wrote. */
  async runOnce(): Promise<{ from: number; to: number; inserted: number }> {
    const cursor = await this.opts.store.getCursor(this.opts.cursorName);
    const from = cursor === null ? this.opts.startBlock : cursor + 1;
    const head = await this.opts.provider.getBlockNumber();
    const to = Math.min(head, from + this.opts.batchSize - 1);

    if (from > head) return { from, to: head, inserted: 0 };

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
    return { from, to, inserted };
  }
}
