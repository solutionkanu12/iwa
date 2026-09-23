// Postgres implementation of the persistence boundary.
//
// Every statement is parameterised — no string-built SQL anywhere — and the
// multi-row invariants (accepting a slot, reordering an order) run inside
// transactions so two concurrent clients cannot both take the same place.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import type { CoordinationCounts } from "./admin.js";
import {
  MAX_ACCOUNT_SESSIONS_PER_USER,
  normalizeEmail,
  type AccountSessionRecord,
  type IwaUser,
  type IwaUserStatus,
  type OnboardingStep,
  type OnboardingStatus,
  type VerifiedIdentity,
} from "./iwaAccount.js";
import {
  associationFor,
  deriveStatus,
  newInviteToken,
  type AcceptInput,
  type AcceptResult,
  type CircleAssociation,
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
  id: string;
  slot_index: number;
  invite_token: string;
  member_ref: string | null;
  auth_public_key: string | null;
  accepted_by_address: string | null;
  accepted_at: Date | null;
}

function toSlot(r: SlotRow): DraftSlot {
  return {
    slotId: r.id,
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
   * Every circle this wallet organizes or holds a place in.
   *
   * Two ways to be connected to a draft, unioned: the organizer address on the
   * draft, and the accepting address on any of its slots. Both columns already
   * exist, so this needs no schema change. The projection is shared with the
   * in-memory store so the two cannot drift.
   */
  async listAssociationsForAddress(address: string): Promise<CircleAssociation[]> {
    const r = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT d.id, d.created_at
           FROM circle_drafts d
           LEFT JOIN draft_slots s ON s.draft_id = d.id
          WHERE d.organizer_address = $1 OR s.accepted_by_address = $1
          ORDER BY d.created_at DESC
          LIMIT 50`,
      [address],
    );
    const out: CircleAssociation[] = [];
    for (const row of r.rows) {
      const draft = await this.loadDraft(this.pool, row.id);
      if (draft !== null) out.push(associationFor(draft, address));
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

  async reorderSlots(id: string, order: string[]): Promise<CircleDraft | null> {
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
      const bySlotId = new Map(current.rows.map((r) => [r.id, r]));
      const isPermutation =
        new Set(order).size === order.length &&
        order.length === current.rowCount &&
        order.every((slotId) => bySlotId.has(slotId));
      if (!isPermutation) {
        await client.query("ROLLBACK");
        return null;
      }
      // Two passes via a temporary offset: slot_index is unique per draft, so
      // writing the new order directly would collide mid-update. The slot id
      // addresses the row, so the invite token and any accepted member travel
      // with the place rather than with its old position.
      const OFFSET = 100;
      for (const [target, slotId] of order.entries()) {
        await client.query(
          "UPDATE draft_slots SET slot_index = $1 WHERE draft_id = $2 AND id = $3",
          [target + OFFSET, id, slotId],
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

  async markCreated(id: string, circleId: number, txHash: string | null): Promise<CircleDraft | null> {
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

  /**
   * Aggregate coordination counts for the operator dashboard.
   *
   * Two aggregate queries over columns that already exist. No migration was
   * needed and none was made: everything here is a COUNT, a SUM or a MIN, and
   * no row, address, token or member reference is selected, so there is nothing
   * in the result that could identify anybody even by accident.
   */
  async coordinationCounts(chainId: string): Promise<CoordinationCounts> {
    const drafts = await this.pool.query<{
      drafts_total: string;
      drafts_collecting: string;
      drafts_ready: string;
      drafts_created: string;
      drafts_abandoned: string;
      places_total: string | null;
      created_without_circle_id: string;
      oldest_collecting_at: Date | null;
      oldest_ready_at: Date | null;
    }>(
      `SELECT
         count(*)                                                        AS drafts_total,
         count(*) FILTER (WHERE status = 'draft')                        AS drafts_collecting,
         count(*) FILTER (WHERE status = 'ready')                        AS drafts_ready,
         count(*) FILTER (WHERE status = 'created')                      AS drafts_created,
         count(*) FILTER (WHERE status = 'abandoned')                    AS drafts_abandoned,
         coalesce(sum(member_count) FILTER (WHERE status <> 'abandoned'), 0)
                                                                         AS places_total,
         count(*) FILTER (WHERE status = 'created' AND circle_id IS NULL)
                                                                         AS created_without_circle_id,
         min(created_at) FILTER (WHERE status = 'draft')                 AS oldest_collecting_at,
         min(created_at) FILTER (WHERE status = 'ready')                 AS oldest_ready_at
       FROM circle_drafts`,
    );

    const slots = await this.pool.query<{ places_accepted: string }>(
      `SELECT count(*) AS places_accepted
         FROM draft_slots s
         JOIN circle_drafts d ON d.id = s.draft_id
        WHERE s.member_ref IS NOT NULL AND d.status <> 'abandoned'`,
    );

    const circles = await this.pool.query<{ indexed: string; unrecorded: string }>(
      `SELECT
         count(*) AS indexed,
         count(*) FILTER (
           WHERE c.circle_id NOT IN (
             SELECT circle_id FROM circle_drafts WHERE circle_id IS NOT NULL
           )
         ) AS unrecorded
       FROM indexed_circles c
      WHERE c.chain_id = $1`,
      [chainId],
    );

    const d = drafts.rows[0];
    const n = (value: string | null | undefined): number => Number(value ?? 0);

    return {
      draftsTotal: n(d?.drafts_total),
      draftsCollecting: n(d?.drafts_collecting),
      draftsReady: n(d?.drafts_ready),
      draftsCreated: n(d?.drafts_created),
      draftsAbandoned: n(d?.drafts_abandoned),
      placesTotal: n(d?.places_total),
      placesAccepted: n(slots.rows[0]?.places_accepted),
      createdWithoutCircleId: n(d?.created_without_circle_id),
      indexedCircles: n(circles.rows[0]?.indexed),
      unrecordedChainCircles: n(circles.rows[0]?.unrecorded),
      oldestCollectingAt: d?.oldest_collecting_at?.toISOString() ?? null,
      oldestReadyAt: d?.oldest_ready_at?.toISOString() ?? null,
    };
  }

  async healthy(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async upsertUserFromIdentity(identity: VerifiedIdentity): Promise<IwaUser> {
    const email = normalizeEmail(identity.email);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        user_id: string;
        id: string;
        email: string;
        status: IwaUserStatus;
        onboarding_status: OnboardingStatus;
        onboarding_step: OnboardingStep;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT u.id AS user_id, u.id, u.email, u.status, u.onboarding_status, u.onboarding_step, u.created_at, u.updated_at
           FROM auth_identities i
           JOIN users u ON u.id = i.user_id
          WHERE i.provider = $1 AND i.provider_subject = $2
          FOR UPDATE`,
        [identity.provider, identity.subject],
      );
      if ((existing.rowCount ?? 0) > 0) {
        const row = existing.rows[0];
        if (row.email !== email) {
          await client.query(
            `UPDATE users SET email = $1, updated_at = now() WHERE id = $2`,
            [email, row.id],
          );
          row.email = email;
          row.updated_at = new Date();
        }
        await client.query(
          `UPDATE auth_identities SET verified_email = $1 WHERE provider = $2 AND provider_subject = $3`,
          [email, identity.provider, identity.subject],
        );
        await client.query("COMMIT");
        return toIwaUser(row);
      }

      const byEmail = await client.query<{
        id: string;
        email: string;
        status: IwaUserStatus;
        onboarding_status: OnboardingStatus;
        onboarding_step: OnboardingStep;
        created_at: Date;
        updated_at: Date;
      }>(`SELECT id, email, status, onboarding_status, onboarding_step, created_at, updated_at FROM users WHERE email = $1 FOR UPDATE`, [
        email,
      ]);

      let userId: string;
      let userRow: {
        id: string;
        email: string;
        status: IwaUserStatus;
        onboarding_status: OnboardingStatus;
        onboarding_step: OnboardingStep;
        created_at: Date;
        updated_at: Date;
      };
      if ((byEmail.rowCount ?? 0) > 0) {
        userRow = byEmail.rows[0];
        userId = userRow.id;
        await client.query(`UPDATE users SET updated_at = now() WHERE id = $1`, [userId]);
      } else {
        userId = randomUUID();
        const inserted = await client.query<{
          id: string;
          email: string;
          status: IwaUserStatus;
          onboarding_status: OnboardingStatus;
          onboarding_step: OnboardingStep;
          created_at: Date;
          updated_at: Date;
        }>(
          `INSERT INTO users (id, email, status, onboarding_status) VALUES ($1, $2, 'active', 'new')
           RETURNING id, email, status, onboarding_status, onboarding_step, created_at, updated_at`,
          [userId, email],
        );
        userRow = inserted.rows[0];
      }

      await client.query(
        `INSERT INTO auth_identities (id, user_id, provider, provider_subject, verified_email)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, identity.provider, identity.subject, email],
      );
      await client.query("COMMIT");
      return toIwaUser(userRow);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getIwaUser(id: string): Promise<IwaUser | null> {
    const r = await this.pool.query<{
      id: string;
      email: string;
      status: IwaUserStatus;
      onboarding_status: OnboardingStatus;
      onboarding_step: OnboardingStep;
      created_at: Date;
      updated_at: Date;
    }>(`SELECT id, email, status, onboarding_status, onboarding_step, created_at, updated_at FROM users WHERE id = $1`, [id]);
    if (r.rowCount === 0) return null;
    return toIwaUser(r.rows[0]);
  }

  async setIwaUserStatus(id: string, status: IwaUserStatus): Promise<IwaUser | null> {
    const r = await this.pool.query<{
      id: string;
      email: string;
      status: IwaUserStatus;
      onboarding_status: OnboardingStatus;
      onboarding_step: OnboardingStep;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE users SET status = $2, updated_at = now() WHERE id = $1
       RETURNING id, email, status, onboarding_status, onboarding_step, created_at, updated_at`,
      [id, status],
    );
    if (r.rowCount === 0) return null;
    return toIwaUser(r.rows[0]);
  }

  async setIwaUserOnboardingStatus(id: string, status: OnboardingStatus): Promise<IwaUser | null> {
    const r = await this.pool.query<{
      id: string;
      email: string;
      status: IwaUserStatus;
      onboarding_status: OnboardingStatus;
      onboarding_step: OnboardingStep;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE users
          SET onboarding_status = $2,
              onboarding_step = CASE WHEN $2 = 'completed' THEN 'finish' ELSE 'profile' END,
              updated_at = now()
        WHERE id = $1
       RETURNING id, email, status, onboarding_status, onboarding_step, created_at, updated_at`,
      [id, status],
    );
    if (r.rowCount === 0) return null;
    return toIwaUser(r.rows[0]);
  }

  async setIwaUserOnboardingState(
    id: string,
    state: { status: OnboardingStatus; step: OnboardingStep },
  ): Promise<IwaUser | null> {
    const r = await this.pool.query<{
      id: string;
      email: string;
      status: IwaUserStatus;
      onboarding_status: OnboardingStatus;
      onboarding_step: OnboardingStep;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE users
          SET onboarding_status = $2, onboarding_step = $3, updated_at = now()
        WHERE id = $1
       RETURNING id, email, status, onboarding_status, onboarding_step, created_at, updated_at`,
      [id, state.status, state.step],
    );
    if (r.rowCount === 0) return null;
    return toIwaUser(r.rows[0]);
  }

  async createAccountSession(
    userId: string,
    tokenHash: string,
    meta: { createdAt: number; expiresAt: number; userAgent: string | null; deviceLabel: string | null },
  ): Promise<AccountSessionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const live = await client.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at ASC
          FOR UPDATE`,
        [userId],
      );
      const excess = live.rows.length - (MAX_ACCOUNT_SESSIONS_PER_USER - 1);
      for (let i = 0; i < excess; i += 1) {
        const oldest = live.rows[i];
        if (oldest !== undefined) {
          await client.query(`UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [
            oldest.id,
            new Date(meta.createdAt),
          ]);
        }
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO sessions
           (id, user_id, token_hash, created_at, last_used_at, expires_at, user_agent, device_label)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
        [
          id,
          userId,
          tokenHash,
          new Date(meta.createdAt),
          new Date(meta.expiresAt),
          meta.userAgent,
          meta.deviceLabel,
        ],
      );
      await client.query("COMMIT");
      return {
        id,
        userId,
        tokenHash,
        createdAt: meta.createdAt,
        lastUsedAt: meta.createdAt,
        expiresAt: meta.expiresAt,
        revokedAt: null,
        userAgent: meta.userAgent,
        deviceLabel: meta.deviceLabel,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async getAccountSessionByTokenHash(tokenHash: string): Promise<AccountSessionRecord | null> {
    const r = await this.pool.query<{
      id: string;
      user_id: string;
      token_hash: string;
      created_at: Date;
      last_used_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      user_agent: string | null;
      device_label: string | null;
    }>(`SELECT * FROM sessions WHERE token_hash = $1`, [tokenHash]);
    if (r.rowCount === 0) return null;
    return toAccountSession(r.rows[0]);
  }

  async touchAccountSession(id: string, lastUsedAt: number, expiresAt: number): Promise<void> {
    await this.pool.query(`UPDATE sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1`, [
      id,
      new Date(lastUsedAt),
      new Date(expiresAt),
    ]);
  }

  async revokeAccountSession(id: string, revokedAt: number): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [id, new Date(revokedAt)],
    );
  }

  async revokeAllAccountSessions(userId: string, revokedAt: number): Promise<number> {
    const r = await this.pool.query(
      `UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, new Date(revokedAt)],
    );
    return r.rowCount ?? 0;
  }

  async listAccountSessions(userId: string): Promise<AccountSessionRecord[]> {
    const r = await this.pool.query<{
      id: string;
      user_id: string;
      token_hash: string;
      created_at: Date;
      last_used_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
      user_agent: string | null;
      device_label: string | null;
    }>(`SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at ASC`, [userId]);
    return r.rows.map(toAccountSession);
  }
}

function toIwaUser(row: {
  id: string;
  email: string;
  status: IwaUserStatus;
  onboarding_status?: OnboardingStatus;
  onboarding_step?: OnboardingStep;
  created_at: Date;
  updated_at: Date;
}): IwaUser {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    onboardingStatus: row.onboarding_status ?? "new",
    onboardingStep: row.onboarding_step ?? (row.onboarding_status === "completed" ? "finish" : "profile"),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toAccountSession(row: {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  user_agent: string | null;
  device_label: string | null;
}): AccountSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at.getTime(),
    lastUsedAt: row.last_used_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    revokedAt: row.revoked_at ? row.revoked_at.getTime() : null,
    userAgent: row.user_agent,
    deviceLabel: row.device_label,
  };
}
