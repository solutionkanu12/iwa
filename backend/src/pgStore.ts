// Postgres implementation of the persistence boundary.
//
// Every statement is parameterised — no string-built SQL anywhere — and the
// multi-row invariants (accepting a slot, reordering an order) run inside
// transactions so two concurrent clients cannot both take the same place.

import { Pool, type PoolClient } from "pg";

import {
  deriveStatus,
  newInviteToken,
  type AcceptInput,
  type AcceptResult,
  type CircleDraft,
  type CircleEvent,
  type CreateDraftInput,
  type DraftSlot,
  type IndexedCircle,
  type Store,
} from "./store.js";

interface DraftRow {
  id: string;
  chain_id: string;
  organizer_address: string;
  token: string;
  contribution_amount: string;
  cadence_seconds: number;
  grace_seconds: number;
  member_count: number;
  status: CircleDraft["status"];
  circle_id: number | null;
  created_tx: string | null;
  created_at: Date;
}

interface SlotRow {
  slot_index: number;
  invite_token: string;
  member_ref: string | null;
  auth_public_key: string | null;
  accepted_by_address: string | null;
  accepted_at: Date | null;
}

function toSlot(r: SlotRow): DraftSlot {
  return {
    slotIndex: r.slot_index,
    inviteToken: r.invite_token,
    memberRef: r.member_ref,
    authPublicKey: r.auth_public_key,
    acceptedByAddress: r.accepted_by_address,
    acceptedAt: r.accepted_at ? r.accepted_at.toISOString() : null,
  };
}

function toDraft(d: DraftRow, slots: SlotRow[]): CircleDraft {
  return {
    id: d.id,
    chainId: d.chain_id,
    organizerAddress: d.organizer_address,
    token: d.token,
    contributionAmount: d.contribution_amount,
    cadenceSeconds: d.cadence_seconds,
    graceSeconds: d.grace_seconds,
    memberCount: d.member_count,
    status: d.status,
    circleId: d.circle_id,
    createdTx: d.created_tx,
    createdAt: d.created_at.toISOString(),
    slots: slots.map(toSlot).sort((a, b) => a.slotIndex - b.slotIndex),
  };
}

export class PgStore implements Store {
  private pool: Pool;

  constructor(connectionString: string, ssl: boolean) {
    this.pool = new Pool({
      connectionString,
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 10,
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async loadDraft(client: PoolClient | Pool, id: string): Promise<CircleDraft | null> {
    const d = await client.query<DraftRow>("SELECT * FROM circle_drafts WHERE id = $1", [id]);
    if (d.rowCount === 0) return null;
    const s = await client.query<SlotRow>(
      "SELECT * FROM draft_slots WHERE draft_id = $1 ORDER BY slot_index",
      [id],
    );
    return toDraft(d.rows[0], s.rows);
  }

  async createDraft(input: CreateDraftInput): Promise<CircleDraft> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const d = await client.query<DraftRow>(
        `INSERT INTO circle_drafts
           (id, chain_id, organizer_address, token, contribution_amount,
            cadence_seconds, grace_seconds, member_count)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          input.chainId,
          input.organizerAddress,
          input.token,
          input.contributionAmount,
          input.cadenceSeconds,
          input.graceSeconds,
          input.memberCount,
        ],
      );
      const draft = d.rows[0];
      for (let i = 0; i < input.memberCount; i += 1) {
        await client.query(
          `INSERT INTO draft_slots (id, draft_id, slot_index, invite_token)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [draft.id, i, newInviteToken()],
        );
      }
      await client.query("COMMIT");
      const loaded = await this.loadDraft(this.pool, draft.id);
      if (loaded === null) throw new Error("draft vanished immediately after creation");
      return loaded;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getDraft(id: string): Promise<CircleDraft | null> {
    return this.loadDraft(this.pool, id);
  }

  async getDraftByInviteToken(token: string): Promise<CircleDraft | null> {
    const r = await this.pool.query<{ draft_id: string }>(
      "SELECT draft_id FROM draft_slots WHERE invite_token = $1",
      [token],
    );
    if (r.rowCount === 0) return null;
    return this.loadDraft(this.pool, r.rows[0].draft_id);
  }

  async listDraftsByOrganizer(address: string): Promise<CircleDraft[]> {
    const r = await this.pool.query<{ id: string }>(
      "SELECT id FROM circle_drafts WHERE organizer_address = $1 ORDER BY created_at DESC LIMIT 50",
      [address],
    );
    const out: CircleDraft[] = [];
    for (const row of r.rows) {
      const d = await this.loadDraft(this.pool, row.id);
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * Claims a slot atomically. The row is locked first so two people opening the
   * same link cannot both be told they took the place.
   */
  async acceptInvite(input: AcceptInput): Promise<AcceptResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const slot = await client.query<SlotRow & { draft_id: string }>(
        "SELECT * FROM draft_slots WHERE invite_token = $1 FOR UPDATE",
        [input.inviteToken],
      );
      if (slot.rowCount === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "unknown_invite" };
      }
      const row = slot.rows[0];

      const draftRow = await client.query<DraftRow>(
        "SELECT * FROM circle_drafts WHERE id = $1 FOR UPDATE",
        [row.draft_id],
      );
      const draft = draftRow.rows[0];
      if (draft.status === "created" || draft.status === "abandoned") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "draft_closed" };
      }
      if (row.member_ref !== null) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "already_accepted" };
      }

      const dup = await client.query(
        "SELECT 1 FROM draft_slots WHERE draft_id = $1 AND member_ref = $2",
        [row.draft_id, input.memberRef],
      );
      if ((dup.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "duplicate_member" };
      }

      await client.query(
        `UPDATE draft_slots
            SET member_ref = $1, auth_public_key = $2,
                accepted_by_address = $3, accepted_at = now()
          WHERE invite_token = $4`,
        [input.memberRef, input.authPublicKey, input.address, input.inviteToken],
      );

      const slots = await client.query<SlotRow>(
        "SELECT * FROM draft_slots WHERE draft_id = $1 ORDER BY slot_index",
        [row.draft_id],
      );
      const updated = toDraft(draft, slots.rows);
      const status = deriveStatus(updated);
      await client.query(
        "UPDATE circle_drafts SET status = $1, updated_at = now() WHERE id = $2",
        [status, row.draft_id],
      );
      await client.query("COMMIT");
      return { ok: true, draft: { ...updated, status }, slotIndex: row.slot_index };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async reorderSlots(id: string, order: number[]): Promise<CircleDraft | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<SlotRow>(
        "SELECT * FROM draft_slots WHERE draft_id = $1 FOR UPDATE",
        [id],
      );
      if (current.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const byIndex = new Map(current.rows.map((r) => [r.slot_index, r]));
      const isPermutation =
        new Set(order).size === order.length &&
        order.length === current.rowCount &&
        order.every((i) => byIndex.has(i));
      if (!isPermutation) {
        await client.query("ROLLBACK");
        return null;
      }
      // Two passes via a temporary offset: slot_index is unique per draft, so
      // writing the new order directly would collide mid-update.
      const OFFSET = 100;
      for (const [target, source] of order.entries()) {
        await client.query(
          "UPDATE draft_slots SET slot_index = $1 WHERE draft_id = $2 AND slot_index = $3",
          [target + OFFSET, id, source],
        );
      }
      await client.query(
        "UPDATE draft_slots SET slot_index = slot_index - $1 WHERE draft_id = $2 AND slot_index >= $1",
        [OFFSET, id],
      );
      await client.query("COMMIT");
      return this.loadDraft(this.pool, id);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async markCreated(id: string, circleId: number, txHash: string): Promise<CircleDraft | null> {
    const r = await this.pool.query(
      `UPDATE circle_drafts
          SET circle_id = $1, created_tx = $2, status = 'created', updated_at = now()
        WHERE id = $3`,
      [circleId, txHash, id],
    );
    if (r.rowCount === 0) return null;
    return this.loadDraft(this.pool, id);
  }

  async abandonDraft(id: string): Promise<CircleDraft | null> {
    const r = await this.pool.query(
      "UPDATE circle_drafts SET status = 'abandoned', updated_at = now() WHERE id = $1",
      [id],
    );
    if (r.rowCount === 0) return null;
    return this.loadDraft(this.pool, id);
  }

  async upsertIndexedCircle(c: Omit<IndexedCircle, "updatedAt">): Promise<void> {
    await this.pool.query(
      `INSERT INTO indexed_circles
         (chain_id, circle_id, contribution_amount, token, member_limit,
          joined_count, current_round, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (chain_id, circle_id) DO UPDATE SET
         contribution_amount = EXCLUDED.contribution_amount,
         token = EXCLUDED.token,
         member_limit = EXCLUDED.member_limit,
         joined_count = EXCLUDED.joined_count,
         current_round = EXCLUDED.current_round,
         status = EXCLUDED.status,
         updated_at = now()`,
      [
        c.chainId,
        c.circleId,
        c.contributionAmount,
        c.token,
        c.memberLimit,
        c.joinedCount,
        c.currentRound,
        c.status,
      ],
    );
  }

  async listIndexedCircles(chainId: string): Promise<IndexedCircle[]> {
    const r = await this.pool.query(
      "SELECT * FROM indexed_circles WHERE chain_id = $1 ORDER BY circle_id",
      [chainId],
    );
    return r.rows.map((x) => ({
      chainId: x.chain_id,
      circleId: x.circle_id,
      contributionAmount: x.contribution_amount,
      token: x.token,
      memberLimit: x.member_limit,
      joinedCount: x.joined_count,
      currentRound: x.current_round,
      status: x.status,
      updatedAt: x.updated_at.toISOString(),
    }));
  }

  async recordEvents(events: CircleEvent[]): Promise<number> {
    let inserted = 0;
    for (const e of events) {
      const r = await this.pool.query(
        `INSERT INTO circle_events
           (chain_id, block_number, tx_hash, event_index, event_name,
            circle_id, round, member_ref, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (chain_id, tx_hash, event_index) DO NOTHING`,
        [
          e.chainId,
          e.blockNumber,
          e.txHash,
          e.eventIndex,
          e.eventName,
          e.circleId,
          e.round,
          e.memberRef,
          e.status,
        ],
      );
      inserted += r.rowCount ?? 0;
    }
    return inserted;
  }

  async listEventsForCircle(chainId: string, circleId: number): Promise<CircleEvent[]> {
    const r = await this.pool.query(
      `SELECT * FROM circle_events
        WHERE chain_id = $1 AND circle_id = $2
        ORDER BY block_number, event_index`,
      [chainId, circleId],
    );
    return r.rows.map((x) => ({
      chainId: x.chain_id,
      blockNumber: Number(x.block_number),
      txHash: x.tx_hash,
      eventIndex: x.event_index,
      eventName: x.event_name,
      circleId: x.circle_id,
      round: x.round,
      memberRef: x.member_ref,
      status: x.status,
    }));
  }

  async getCursor(name: string): Promise<number | null> {
    const r = await this.pool.query("SELECT last_block FROM sync_cursor WHERE name = $1", [name]);
    return r.rowCount === 0 ? null : Number(r.rows[0].last_block);
  }

  async setCursor(name: string, chainId: string, block: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO sync_cursor (name, chain_id, last_block, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (name) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
      [name, chainId, block],
    );
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
