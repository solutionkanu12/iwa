// PgStore integration suite.
//
// Runs against a REAL Postgres, exercising the SQL, the transactions, and the
// constraints that the in-memory store cannot prove. It is skipped unless a
// database is provided, so CI without Postgres stays green while the checks
// still exist and are one command away:
//
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/iwa_test \
//     npm test
//
// The suite creates and drops its own data; point it at a scratch database.

import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PgStore } from "../src/pgStore.js";
import { SN_MAIN } from "../src/validation.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const HERE = dirname(fileURLToPath(import.meta.url));

const ORGANIZER = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const MEMBER_A = "0x45325587024dc0326f740bc5268c766620a4a51dbdec04894256480aecbae0f";
const MEMBER_B = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";
const KEY_A = "0x6a77859939dd3948dd673b07b0d0929af6942731fa4815d152190bdeddb658d";
const KEY_B = "0x94edb9a04dbe7a9160830e8d755af5ee6becf8a82ad12ad5eb64509fbe9f41";

const DRAFT = {
  chainId: SN_MAIN,
  organizerAddress: ORGANIZER,
  token: USDC,
  contributionAmount: "1000000",
  cadenceSeconds: 604800,
  graceSeconds: 86400,
  memberCount: 2,
};

const suite = DATABASE_URL ? describe : describe.skip;

suite("PgStore against a real Postgres", () => {
  // A hosted database is reached over the internet through a connection
  // pooler, and each test makes several round trips inside a transaction. The
  // default 5s budget is a local-Postgres assumption, not a real one here.
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  let store: PgStore;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Fresh schema every run so a failed run cannot poison the next.
    await pool.query(`
      DROP TABLE IF EXISTS circle_events, draft_slots, circle_drafts,
        indexed_circles, sync_cursor, schema_migrations CASCADE
    `);
    const sql = readFileSync(resolve(HERE, "../migrations/001_init.sql"), "utf8");
    await pool.query(sql);
    // Mirror production: RLS on, no policies. The backend connects as the
    // table owner and bypasses it; anon and authenticated get nothing.
    await pool.query(`
      ALTER TABLE public.circle_drafts    ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.draft_slots      ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.indexed_circles  ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.circle_events    ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.sync_cursor      ENABLE ROW LEVEL SECURITY;
    `);
    store = new PgStore(DATABASE_URL as string, false);
  });

  // Each test starts from an empty database.
  //
  // The schema is built once, but the rows are not: every test creates its own
  // draft with the same organizer, so without this the associations of earlier
  // tests are still there when a later one counts them. The schema is left in
  // place, so this is a truncate rather than another migration per test.
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE circle_events, draft_slots, circle_drafts, indexed_circles,
         sync_cursor RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  it("applies the migration and creates every table", async () => {
    const r = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = r.rows.map((x) => x.table_name);
    for (const t of ["circle_drafts", "draft_slots", "indexed_circles", "circle_events", "sync_cursor"]) {
      expect(tables).toContain(t);
    }
  });

  it("creates a draft with one invite per place", async () => {
    const draft = await store.createDraft(DRAFT);
    expect(draft.slots).toHaveLength(2);
    expect(new Set(draft.slots.map((s) => s.inviteToken)).size).toBe(2);
    expect(draft.status).toBe("draft");

    const reloaded = await store.getDraft(draft.id);
    expect(reloaded?.contributionAmount).toBe("1000000");
  });

  it("accepts invitations and flips the draft to ready when full", async () => {
    const draft = await store.createDraft(DRAFT);

    const first = await store.acceptInvite({
      inviteToken: draft.slots[0].inviteToken,
      memberRef: MEMBER_A,
      authPublicKey: KEY_A,
      address: ORGANIZER,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.draft.status).toBe("draft");

    const second = await store.acceptInvite({
      inviteToken: draft.slots[1].inviteToken,
      memberRef: MEMBER_B,
      authPublicKey: KEY_B,
      address: "0x123",
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.draft.status).toBe("ready");
  });

  it("rejects a replayed invitation, a duplicate member, and an unknown token", async () => {
    const draft = await store.createDraft(DRAFT);
    const token = draft.slots[0].inviteToken;

    await store.acceptInvite({ inviteToken: token, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER });

    const replay = await store.acceptInvite({
      inviteToken: token,
      memberRef: MEMBER_A,
      authPublicKey: KEY_A,
      address: ORGANIZER,
    });
    expect(replay).toEqual({ ok: false, reason: "already_accepted" });

    const duplicate = await store.acceptInvite({
      inviteToken: draft.slots[1].inviteToken,
      memberRef: MEMBER_A,
      authPublicKey: KEY_A,
      address: ORGANIZER,
    });
    expect(duplicate).toEqual({ ok: false, reason: "duplicate_member" });

    const unknown = await store.acceptInvite({
      inviteToken: "no-such-token",
      memberRef: MEMBER_B,
      authPublicKey: KEY_B,
      address: ORGANIZER,
    });
    expect(unknown).toEqual({ ok: false, reason: "unknown_invite" });
  });

  it("reorders the payout order and keeps every member", async () => {
    const draft = await store.createDraft(DRAFT);
    await store.acceptInvite({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER });
    await store.acceptInvite({ inviteToken: draft.slots[1].inviteToken, memberRef: MEMBER_B, authPublicKey: KEY_B, address: "0x123" });

    const ids = draft.slots.map((s) => s.slotId);
    const reordered = await store.reorderSlots(draft.id, [ids[1], ids[0]]);
    expect(reordered?.slots.map((s) => s.slotIndex)).toEqual([0, 1]);
    expect(reordered?.slots.map((s) => s.slotId)).toEqual([ids[1], ids[0]]);
    expect(reordered?.slots[0].memberRef).toBe(MEMBER_B);
    expect(reordered?.slots[1].memberRef).toBe(MEMBER_A);
    // The invite token belongs to the place, not to its position.
    expect(reordered?.slots[0].inviteToken).toBe(draft.slots[1].inviteToken);
  });

  it("refuses an order that repeats or drops a place", async () => {
    const draft = await store.createDraft(DRAFT);
    const ids = draft.slots.map((s) => s.slotId);
    expect(await store.reorderSlots(draft.id, [ids[0], ids[0]])).toBeNull();
    expect(await store.reorderSlots(draft.id, [ids[0]])).toBeNull();
    expect(await store.reorderSlots(draft.id, [ids[0], randomUUID()])).toBeNull();
  });

it("answers which circles belong to a wallet", async () => {
    const draft = await store.createDraft(DRAFT);
    await store.acceptInvite({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: MEMBER_A });

    const organizer = await store.listAssociationsForAddress(ORGANIZER);
    expect(organizer).toHaveLength(1);
    expect(organizer[0]).toMatchObject({ draftId: draft.id, role: "organizer", accepted: false });

    const member = await store.listAssociationsForAddress(MEMBER_A);
    expect(member).toHaveLength(1);
    expect(member[0]).toMatchObject({ draftId: draft.id, role: "member", accepted: true });

    // A wallet with no connection to any draft gets an empty answer.
    expect(await store.listAssociationsForAddress(MEMBER_B)).toEqual([]);

    // The projection is a summary. No invite token travels with it.
    const body = JSON.stringify([...organizer, ...member]);
    for (const slot of draft.slots) expect(body).not.toContain(slot.inviteToken);
  });

  it("marks a draft created and then refuses further acceptances", async () => {
    const draft = await store.createDraft(DRAFT);
    await store.acceptInvite({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER });

    const created = await store.markCreated(draft.id, 7, "0xabc");
    expect(created?.status).toBe("created");
    expect(created?.circleId).toBe(7);

    const stale = await store.acceptInvite({
      inviteToken: draft.slots[1].inviteToken,
      memberRef: MEMBER_B,
      authPublicKey: KEY_B,
      address: "0x123",
    });
    expect(stale).toEqual({ ok: false, reason: "draft_closed" });
  });

  it("persists the sync cursor and indexed events idempotently", async () => {
    await store.setCursor("test_cursor", SN_MAIN, 14160000);
    expect(await store.getCursor("test_cursor")).toBe(14160000);
    await store.setCursor("test_cursor", SN_MAIN, 14160100);
    expect(await store.getCursor("test_cursor")).toBe(14160100);

    const event = {
      chainId: SN_MAIN,
      blockNumber: 14160773,
      txHash: "0x46bd320ecdc20de3c97fc99a17eb1741a3425f5e414ce029c5d259e712817f5",
      eventIndex: 0,
      eventName: "ContributionStateUpdated",
      circleId: 1,
      round: 1,
      memberRef: MEMBER_A,
      status: "OnTime",
    };
    expect(await store.recordEvents([event])).toBe(1);
    // Re-reading a range must not duplicate rows.
    expect(await store.recordEvents([event])).toBe(0);

    const events = await store.listEventsForCircle(SN_MAIN, 1);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("OnTime");
  });

  it("survives a restart: a new connection sees the same data", async () => {
    const draft = await store.createDraft(DRAFT);
    await store.acceptInvite({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER });
    // Written here rather than inherited from an earlier test: what survives a
    // restart is what this test put there.
    await store.setCursor("test_cursor", SN_MAIN, 14160100);

    const reopened = new PgStore(DATABASE_URL as string, false);
    try {
      const seen = await reopened.getDraft(draft.id);
      expect(seen?.slots[0].memberRef).toBe(MEMBER_A);
      expect(await reopened.getCursor("test_cursor")).toBe(14160100);
      expect(await reopened.healthy()).toBe(true);
    } finally {
      await reopened.close();
    }
  });

  it("keeps RLS on, and the backend still reads and writes through it", async () => {
    const rls = await pool.query<{ relname: string; relrowsecurity: boolean; policies: string }>(
      `SELECT c.relname, c.relrowsecurity,
              (SELECT count(*) FROM pg_policies p
                WHERE p.schemaname='public' AND p.tablename=c.relname) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relname IN ('circle_drafts','draft_slots','indexed_circles','circle_events','sync_cursor')`,
    );
    expect(rls.rowCount).toBe(5);
    for (const row of rls.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(Number(row.policies)).toBe(0);
    }

    // The backend path must be unaffected by RLS being on.
    const draft = await store.createDraft(DRAFT);
    const accepted = await store.acceptInvite({
      inviteToken: draft.slots[0].inviteToken,
      memberRef: MEMBER_A,
      authPublicKey: KEY_A,
      address: ORGANIZER,
    });
    expect(accepted.ok).toBe(true);
    expect((await store.getDraft(draft.id))?.slots[0].memberRef).toBe(MEMBER_A);
  });

  it("upserts indexed circles rather than duplicating them", async () => {
    const circle = {
      chainId: SN_MAIN,
      circleId: 1,
      contributionAmount: "1000000",
      token: USDC,
      memberLimit: 2,
      joinedCount: 2,
      currentRound: 1,
      status: "Active",
    };
    await store.upsertIndexedCircle(circle);
    await store.upsertIndexedCircle({ ...circle, currentRound: 2 });
    const list = await store.listIndexedCircles(SN_MAIN);
    expect(list.filter((c) => c.circleId === 1)).toHaveLength(1);
    expect(list.find((c) => c.circleId === 1)?.currentRound).toBe(2);
  });
});
