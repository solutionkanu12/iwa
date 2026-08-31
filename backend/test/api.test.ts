// API behaviour, driven over a real HTTP stack against the in-memory store.
// Covers the happy path (organizer draft -> invite -> acceptance -> created)
// and the negative cases that matter: stale and tampered invitations, replay,
// impersonation, and any attempt to send key material.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";
import { ChallengeStore, type SignatureVerifier } from "../src/auth.js";

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
    const tampered = `${draft.slots[0].inviteToken.slice(0, -1)}X`;
    for (const inviteToken of ["not-a-real-token-000000", tampered]) {
      const res = await request(app)
        .post("/api/invites/accept")
        .send({ inviteToken, memberRef: MEMBER_A, authPublicKey: KEY_A, address: ORGANIZER })
        .expect(409);
      expect(res.body.error).toBe("unknown_invite");
    }
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
      .send({ organizerAddress: ORGANIZER, order: [1, 0] })
      .expect(200);
    expect(res.body.slots.map((s: { slotIndex: number }) => s.slotIndex)).toEqual([0, 1]);
  });

  it("refuses reordering by anyone but the organizer", async () => {
    const draft = await newDraft();
    await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, "0xdead"))
      .send({ organizerAddress: "0xdead", order: [1, 0] })
      .expect(403);
  });

  it("refuses an order that drops or repeats a place", async () => {
    const draft = await newDraft();
    await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(await authHeaders(app, ORGANIZER))
      .send({ organizerAddress: ORGANIZER, order: [0, 0] })
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
