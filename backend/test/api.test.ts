// API behaviour, driven over a real HTTP stack against the in-memory store.
// Covers the happy path (organizer draft -> invite -> acceptance -> created)
// and the negative cases that matter: stale and tampered invitations, replay,
// impersonation, and any attempt to send key material.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { randomBytes } from "node:crypto";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { isInviteToken, SN_MAIN } from "../src/validation.js";
import { ChallengeStore, type SignatureVerifier } from "../src/auth.js";
import type { CircleVerifier, DiscoveryOutcome, VerifyOutcome } from "../src/chainVerify.js";
import { AUTH_HEADERS } from "../src/app.js";

/**
 * The same invitation token with its last character changed.
 *
 * Spelled out rather than done inline, because the obvious inline version was
 * wrong. Appending a fixed character to `slice(0, -1)` leaves the token
 * completely unchanged whenever it already ended in that character, and invite
 * tokens are base64url, whose sixty-four character alphabet contains whatever
 * fixed character gets picked. So roughly one run in sixty-four handed the
 * server a perfectly valid invitation, the server correctly accepted it, and a
 * test asserting a refusal failed for a reason nobody could reproduce on
 * demand. It was one half of a long-standing intermittent failure.
 *
 * The replacement is chosen against what is actually there, and stays inside
 * the base64url alphabet so the result is still a syntactically valid token.
 * That matters: the property under test is that an UNKNOWN invitation is
 * refused, and a malformed one would be refused earlier, by validation, which
 * would quietly test something weaker.
 */
function withLastCharacterChanged(token: string): string {
  return token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
}

/**
 * Stands in for the account contract. Accepts a signature only when it is the
 * literal marker for the address that is meant to have signed, so a signature
 * from one wallet can never authenticate another.
 */
class StubVerifier implements SignatureVerifier {
  async verify(address: string, _hash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `signed-by:${address}`;
  }
}

// Creation evidence is covered in creation.test.ts; here it simply passes so
// the coordination routes can be exercised on their own.
class AlwaysVerifies implements CircleVerifier {
  async verifyCreated(): Promise<VerifyOutcome> {
    return { status: "verified" };
  }
  async findCircleForDraft(): Promise<DiscoveryOutcome> {
    return { status: "absent" };
  }
}

function signatureFor(address: string): string {
  return JSON.stringify([`signed-by:${address}`]);
}

/** Obtains a challenge and returns the headers a signed request carries. */
async function authHeaders(app: Express, address: string) {
  const res = await request(app).post("/api/auth/challenge").send({ address }).expect(200);
  return {
    "x-iwa-address": address,
    "x-iwa-nonce": res.body.nonce as string,
    "x-iwa-chain": SN_MAIN,
    "x-iwa-signature": signatureFor(address),
  };
}

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

let app: Express;
let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  app = createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    rateLimit: { windowMs: 60_000, max: 500 },
    verifier: new StubVerifier(),
    circleVerifier: new AlwaysVerifies(),
  });
});

async function newDraft() {
  const res = await request(app)
    .post("/api/drafts")
    .set(await authHeaders(app, ORGANIZER))
    .send(DRAFT)
    .expect(201);
  return res.body as {
    id: string;
    slots: { slotIndex: number; inviteToken: string; accepted: boolean }[];
    status: string;
  };
}

describe("health", () => {
  it("reports database state and declares no custody", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", database: "up", custody: "none" });
  });
});

describe("draft creation", () => {
  it("creates one invite per reserved place and returns them to the organizer", async () => {
    const draft = await newDraft();
    expect(draft.slots).toHaveLength(2);
    expect(new Set(draft.slots.map((s) => s.inviteToken)).size).toBe(2);
    expect(draft.status).toBe("draft");
  });

  it("refuses a one-member circle, which the contract would reject anyway", async () => {
    await request(app)
      .post("/api/drafts")
      .set(await authHeaders(app, ORGANIZER))
      .send({ ...DRAFT, memberCount: 1 })
      .expect(400);
  });

  it("refuses any chain other than SN_MAIN", async () => {
    await request(app)
      .post("/api/drafts")
      .set(await authHeaders(app, ORGANIZER))
      .send({ ...DRAFT, chainId: "0x534e5f5345504f4c4941" })
      .expect(400);
  });

  it("refuses a contribution amount that is not a positive u128", async () => {
    for (const contributionAmount of ["0", "-1", "1.5", "abc"]) {
      await request(app)
        .post("/api/drafts")
        .set(await authHeaders(app, ORGANIZER))
        .send({ ...DRAFT, contributionAmount })
        .expect(400);
    }
  });

  it("refuses an address that is not a felt below the field prime", async () => {
    await request(app)
      .post("/api/drafts")
      .set(await authHeaders(app, ORGANIZER))
      .send({ ...DRAFT, organizerAddress: `0x${"f".repeat(64)}` })
      .expect(400);
  });
});

describe("invitations", () => {
  it("shows an invited member the circle terms without leaking other tokens", async () => {
    const draft = await newDraft();
    const res = await request(app).get(`/api/invites/${draft.slots[0].inviteToken}`).expect(200);
    expect(res.body.contributionAmount).toBe("1000000");
    expect(res.body.slotIndex).toBe(0);
    expect(res.body.alreadyAccepted).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(draft.slots[1].inviteToken);
  });

  it("accepts public commitment data only, and marks the draft ready when full", async () => {
    const draft = await newDraft();

    const first = await request(app)
      .post("/api/invites/accept")
      .send({
        inviteToken: draft.slots[0].inviteToken,
        memberRef: MEMBER_A,
        authPublicKey: KEY_A,
        address: ORGANIZER,
      })
      .expect(200);
    expect(first.body.slotIndex).toBe(0);
    expect(first.body.draft.status).toBe("draft");
    // Acceptance responses never carry invite tokens.
    expect(JSON.stringify(first.body)).not.toContain(draft.slots[0].inviteToken);

    const second = await request(app)
      .post("/api/invites/accept")
      .send({
        inviteToken: draft.slots[1].inviteToken,
        memberRef: MEMBER_B,
        authPublicKey: KEY_B,
        address: "0x123",
      })
      .expect(200);
    expect(second.body.draft.status).toBe("ready");
    expect(second.body.draft.acceptedCount).toBe(2);
  });

  it("rejects an unknown or tampered invitation token", async () => {
    const draft = await newDraft();
    const real = draft.slots[0].inviteToken;
    const tampered = withLastCharacterChanged(real);
    // The tamper has to be a real tamper. Asserted rather than assumed, because
    // the version of this that assumed it was wrong about one time in sixty-four
    // and nobody could reproduce it on demand.
    expect(tampered).not.toBe(real);
    expect(isInviteToken(tampered)).toBe(true);

    for (const inviteToken of ["not-a-real-token-000000", tampered]) {
      const res = await request(app)
        .post("/api/invites/accept")
        .send({ inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER })
        .expect(409);
      expect(res.body.error).toBe("unknown_invite");
    }
  });

  // The guard for the test above. A tamper that silently fails to tamper turns
  // a negative test into a positive one, and does it rarely enough to look like
  // an environment problem. Every real token shape is exercised here, so the
  // collision that used to happen by chance would now fail every run.
  it("always changes the token it is asked to tamper with", () => {
    for (let i = 0; i < 2000; i += 1) {
      // Exactly how src/store.ts mints one.
      const token = randomBytes(24).toString("base64url");
      const tampered = withLastCharacterChanged(token);
      expect(tampered).not.toBe(token);
      expect(tampered).toHaveLength(token.length);
      // Still a well-formed token, so the route refuses it for being unknown
      // rather than for being malformed.
      expect(isInviteToken(tampered)).toBe(true);
    }
  });

  // Both branches of the replacement, named rather than left to chance.
  it("changes the last character whatever it happens to be", () => {
    expect(withLastCharacterChanged("aaaaaaaaaaaaaaaaX")).toBe("aaaaaaaaaaaaaaaaA");
    expect(withLastCharacterChanged("aaaaaaaaaaaaaaaaA")).toBe("aaaaaaaaaaaaaaaaB");
    expect(withLastCharacterChanged("aaaaaaaaaaaaaaaaB")).toBe("aaaaaaaaaaaaaaaaA");
    expect(withLastCharacterChanged("aaaaaaaaaaaaaaaa_")).toBe("aaaaaaaaaaaaaaaaA");
  });

  it("rejects replaying an invitation that was already used", async () => {
    const draft = await newDraft();
    const body = {
      inviteToken: draft.slots[0].inviteToken,
      memberRef: MEMBER_A,
      authPublicKey: KEY_A,
      address: ORGANIZER,
    };
    await request(app).post("/api/invites/accept").send(body).expect(200);
    const res = await request(app).post("/api/invites/accept").send(body).expect(409);
    expect(res.body.error).toBe("already_accepted");
  });

  it("refuses the same member taking two places in one circle", async () => {
    const draft = await newDraft();
    await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER })
      .expect(200);
    const res = await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: draft.slots[1].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER })
      .expect(409);
    expect(res.body.error).toBe("duplicate_member");
  });

  it("refuses acceptance once the circle exists on chain (a stale link)", async () => {
    const draft = await newDraft();
    await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER })
      .expect(200);
    await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: draft.slots[1].inviteToken, memberRef: MEMBER_B, authPublicKey: KEY_B, address: "0x123" })
      .expect(200);
    await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set(await authHeaders(app, ORGANIZER))
      .send({ organizerAddress: ORGANIZER, circleId: 2, txHash: "0xabc" })
      .expect(200);

    // A member who opens an old link afterwards is told plainly.
    const stale = await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER })
      .expect(409);
    expect(stale.body.error).toBe("draft_closed");
  });

  it("refuses a zero commitment", async () => {
    const draft = await newDraft();
    await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: draft.slots[0].inviteToken, memberRef: "0x0", authPublicKey: KEY_A, address: ORGANIZER })
      .expect(400);
  });
});

describe("organizer actions", () => {
  it("reorders the payout order before creation", async () => {
    const draft = await newDraft();
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, ORGANIZER))
      .send({
        organizerAddress: ORGANIZER,
        order: [draft.slots[1].slotId, draft.slots[0].slotId],
      })
      .expect(200);
    expect(res.body.slots.map((s: { slotIndex: number }) => s.slotIndex)).toEqual([0, 1]);
    expect(res.body.slots.map((s: { slotId: string }) => s.slotId)).toEqual([
      draft.slots[1].slotId,
      draft.slots[0].slotId,
    ]);
  });

  it("refuses reordering by anyone but the organizer", async () => {
    const draft = await newDraft();
    await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, "0xdead"))
      .send({
        organizerAddress: "0xdead",
        order: [draft.slots[1].slotId, draft.slots[0].slotId],
      })
      .expect(403);
  });

  it("refuses an order that drops or repeats a place", async () => {
    const draft = await newDraft();
    await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, ORGANIZER))
      .send({
        organizerAddress: ORGANIZER,
        order: [draft.slots[0].slotId, draft.slots[0].slotId],
      })
      .expect(400);
  });

  it("refuses marking created by anyone but the organizer", async () => {
    const draft = await newDraft();
    await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set(await authHeaders(app, "0xdead"))
      .send({ organizerAddress: "0xdead", circleId: 2, txHash: "0xabc" })
      .expect(403);
  });

  it("hides invite tokens from a non-organizer reading the draft", async () => {
    const draft = await newDraft();
    const anon = await request(app).get(`/api/drafts/${draft.id}`).expect(200);
    expect(JSON.stringify(anon.body)).not.toContain(draft.slots[0].inviteToken);

    const owner = await request(app)
      .post(`/api/drafts/${draft.id}/organizer-view`)
      .set(await authHeaders(app, ORGANIZER))
      .send({})
      .expect(200);
    expect(JSON.stringify(owner.body)).toContain(draft.slots[0].inviteToken);
  });

  it("refuses the organizer view to a stranger who merely knows the address", async () => {
    const draft = await newDraft();
    await request(app).post(`/api/drafts/${draft.id}/organizer-view`).send({}).expect(401);
    await request(app)
      .post(`/api/drafts/${draft.id}/organizer-view`)
      .set(await authHeaders(app, "0xdead"))
      .send({})
      .expect(403);
  });
});

describe("no custody, no secrets", () => {
  it("rejects any request carrying key material, by field name", async () => {
    const forbidden = [
      { privateKey: "0x1" },
      { seedPhrase: "word word word" },
      { viewingKey: "0x2" },
      { inviteSecret: "0x3" },
      { authPrivateKey: "0x4" },
      { nested: { deeper: { mnemonic: "x" } } },
    ];
    for (const extra of forbidden) {
      const res = await request(app)
        .post("/api/drafts")
        .set(await authHeaders(app, ORGANIZER))
        .send({ ...DRAFT, ...extra })
        .expect(400);
      expect(res.body.error).toBe("forbidden_field");
    }
  });

  it("never returns a field that looks like key material", async () => {
    const draft = await newDraft();
    await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: draft.slots[0].inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER })
      .expect(200);
    const body = JSON.stringify(
      (
        await request(app)
          .post(`/api/drafts/${draft.id}/organizer-view`)
          .set(await authHeaders(app, ORGANIZER))
          .send({})
          .expect(200)
      ).body,
    ).toLowerCase();
    for (const word of ["privatekey", "seed", "mnemonic", "viewingkey", "invitesecret"]) {
      expect(body).not.toContain(word);
    }
  });
});

describe("rate limiting", () => {
  it("limits mutations and leaves reads alone", async () => {
    const limited = createApp({
      store: new MemoryStore(),
      corsOrigins: [],
      rateLimit: { windowMs: 60_000, max: 2 },
      verifier: new StubVerifier(),
    });
    await request(limited).post("/api/auth/challenge").send({ address: ORGANIZER }).expect(200);
    await request(limited).post("/api/auth/challenge").send({ address: ORGANIZER }).expect(200);
    const blocked = await request(limited).post("/api/drafts").send(DRAFT).expect(429);
    expect(blocked.body.error).toBe("rate_limited");
    await request(limited).get("/health").expect(200);
  });
});

describe("cors", () => {
  it("echoes only an allowed origin", async () => {
    const ok = await request(app).get("/health").set("Origin", "http://localhost:5173");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    const bad = await request(app).get("/health").set("Origin", "https://evil.example");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("cors preflight", () => {
  // The organizer routes authenticate with custom headers. A preflight that
  // does not advertise them makes every organizer action fail in a browser
  // while passing every server-side test, so the header list is asserted here
  // against the same constant the auth middleware reads.
  it("advertises every header an authenticated request carries", async () => {
    const res = await request(app)
      .options("/api/drafts")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);

    const advertised = String(res.headers["access-control-allow-headers"] ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase());

    for (const header of ["content-type", ...AUTH_HEADERS]) {
      expect(advertised).toContain(header);
    }
  });

  it("advertises nothing to a disallowed origin", async () => {
    const res = await request(app)
      .options("/api/drafts")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

// --- Phase 2: organizer reliability -------------------------------------

describe("slot identity survives reordering", () => {
  // slot_index is a position and gets renumbered on every reorder, so it can
  // never identify a place. draft_slots.id can: it is assigned once and never
  // changes, which is what keeps an invite link attached to the person it was
  // sent to.
  it("gives every slot a stable id that reordering does not change", async () => {
    const draft = await newDraft();
    const before = draft.slots.map((s: { slotId: string }) => s.slotId);
    expect(new Set(before).size).toBe(before.length);
    expect(before.every((id: string) => typeof id === "string" && id.length > 0)).toBe(true);

    const res = await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, ORGANIZER))
      .send({ organizerAddress: ORGANIZER, order: [before[1], before[0]] })
      .expect(200);

    expect(res.body.slots.map((s: { slotId: string }) => s.slotId)).toEqual([before[1], before[0]]);
    expect(res.body.slots.map((s: { slotIndex: number }) => s.slotIndex)).toEqual([0, 1]);
  });

  it("keeps each invite token with its own slot across a reorder", async () => {
    const draft = await newDraft();
    const tokenOf = new Map<string, string>(
      draft.slots.map((s: { slotId: string; inviteToken: string }) => [s.slotId, s.inviteToken]),
    );
    const ids = draft.slots.map((s: { slotId: string }) => s.slotId);

    const res = await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, ORGANIZER))
      .send({ organizerAddress: ORGANIZER, order: [ids[1], ids[0]] })
      .expect(200);

    for (const slot of res.body.slots as { slotId: string; inviteToken: string }[]) {
      expect(slot.inviteToken).toBe(tokenOf.get(slot.slotId));
    }
  });

  it("keeps an accepted member with their own place when a pending place moves", async () => {
    const draft = await newDraft();
    const ids = draft.slots.map((s: { slotId: string }) => s.slotId);
    await request(app)
      .post("/api/invites/accept")
      .send({
        inviteToken: draft.slots[0].inviteToken,
        memberRef: MEMBER_A,
        authPublicKey: KEY_A,
        address: MEMBER_A,
      })
      .expect(200);

    const res = await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, ORGANIZER))
      .send({ organizerAddress: ORGANIZER, order: [ids[1], ids[0]] })
      .expect(200);

    const moved = (res.body.slots as { slotId: string; memberRef: string | null }[]).find(
      (s) => s.slotId === ids[0],
    );
    const pending = (res.body.slots as { slotId: string; memberRef: string | null }[]).find(
      (s) => s.slotId === ids[1],
    );
    expect(moved?.memberRef).toBe(MEMBER_A);
    expect(pending?.memberRef).toBeNull();
  });

  it("survives repeated reorders without losing identity", async () => {
    const draft = await newDraft();
    const ids = draft.slots.map((s: { slotId: string }) => s.slotId);
    let current = ids;
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app)
        .post(`/api/drafts/${draft.id}/order`)
        .set(await authHeaders(app, ORGANIZER))
        .send({ organizerAddress: ORGANIZER, order: [current[1], current[0]] })
        .expect(200);
      current = res.body.slots.map((s: { slotId: string }) => s.slotId);
      expect(new Set(current)).toEqual(new Set(ids));
    }
  });

  it("refuses an order naming a slot that is not in this draft", async () => {
    const draft = await newDraft();
    const other = await newDraft();
    const ids = draft.slots.map((s: { slotId: string }) => s.slotId);
    await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, ORGANIZER))
      .send({ organizerAddress: ORGANIZER, order: [ids[0], other.slots[0].slotId] })
      .expect(400);
  });
});

describe("organizer draft recovery", () => {
  it("lists this organizer's drafts and no one else's", async () => {
    const mine = await newDraft();
    await request(app)
      .post("/api/drafts")
      .set(await authHeaders(app, MEMBER_B))
      .send({ ...DRAFT, organizerAddress: MEMBER_B })
      .expect(201);

    const res = await request(app)
      .post("/api/drafts/mine")
      .set(await authHeaders(app, ORGANIZER))
      .send({})
      .expect(200);

    expect(res.body.map((d: { id: string }) => d.id)).toEqual([mine.id]);
  });

  it("restores the invite links through the organizer view after a reload", async () => {
    const draft = await newDraft();
    const listed = await request(app)
      .post("/api/drafts/mine")
      .set(await authHeaders(app, ORGANIZER))
      .send({})
      .expect(200);

    const recovered = await request(app)
      .post(`/api/drafts/${listed.body[0].id}/organizer-view`)
      .set(await authHeaders(app, ORGANIZER))
      .send({})
      .expect(200);

    expect(recovered.body.slots.map((s: { inviteToken: string }) => s.inviteToken)).toEqual(
      draft.slots.map((s: { inviteToken: string }) => s.inviteToken),
    );
  });
});
