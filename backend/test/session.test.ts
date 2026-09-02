// Read-only sessions.
//
// The property under test, stated once: a session is a cheaper way to prove
// the same thing a wallet signature proves, for reads only. It must never be
// a cheaper way to prove more.
//
// So these tests are arranged around two questions. What can a session do that
// a signature could — read this wallet's own coordination data, and nothing
// belonging to anybody else. And what can a session never do, however valid it
// is — create, reorder, record a creation, reconcile, or authorize anything
// that moves money or fixes a payout order.
//
// The second set matters more than the first. A session that fails to read is
// an inconvenience; a session that authorizes a reorder is the whole of Phase
// 6C undone.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";
import { AUTH_ACTIONS, authorizationHash, hashBody, hashResource } from "../src/authBinding.js";
import { ChallengeStore, type SignatureVerifier } from "../src/auth.js";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SessionStore,
} from "../src/session.js";

const ALICE = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const BOB = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";
const SEPOLIA = "0x534e5f5345504f4c4941";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";

/** Accepts only a signature that names the account that made it. */
class StubVerifier implements SignatureVerifier {
  async verify(address: string, _hash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `signed-by:${address}`;
  }
}

const sig = (address: string) => JSON.stringify([`signed-by:${address}`]);

let app: Express;
let sessions: SessionStore;
let challenges: ChallengeStore;
let store: MemoryStore;
let clock: number;

beforeEach(() => {
  clock = Date.parse("2026-01-01T00:00:00.000Z");
  store = new MemoryStore();
  challenges = new ChallengeStore(() => clock);
  sessions = new SessionStore(() => clock);
  app = createApp({
    store,
    corsOrigins: ["https://www.useiwa.xyz"],
    rateLimit: { windowMs: 60_000, max: 500 },
    verifier: new StubVerifier(),
    challenges,
    sessions,
    now: () => clock,
  });
});

async function nonceFor(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/challenge").send({ address }).expect(200);
  return res.body.nonce as string;
}

/** Signs in the way the real client does, and returns the opaque token. */
async function signIn(address: string, chainId: string = SN_MAIN): Promise<string> {
  const nonce = await nonceFor(address);
  const res = await request(app)
    .post("/api/auth/session")
    .set({
      "x-iwa-address": address,
      "x-iwa-nonce": nonce,
      "x-iwa-chain": chainId,
      "x-iwa-signature": sig(address),
    })
    .send({})
    .expect(200);
  return res.body.token as string;
}

/** A Phase 6C signed request, for the comparisons that need one. */
async function signedHeaders(address: string) {
  const nonce = await nonceFor(address);
  return {
    "x-iwa-address": address,
    "x-iwa-nonce": nonce,
    "x-iwa-chain": SN_MAIN,
    "x-iwa-signature": sig(address),
  };
}

async function draftOwnedBy(organizerAddress: string) {
  return store.createDraft({
    chainId: SN_MAIN,
    organizerAddress,
    token: USDC,
    contributionAmount: "1000000",
    cadenceSeconds: 604800,
    graceSeconds: 86400,
    memberCount: 2,
  });
}

// ---------------------------------------------------------------- creation

describe("creating a session", () => {
  it("returns an opaque token for a correctly signed session:create", async () => {
    const nonce = await nonceFor(ALICE);
    const res = await request(app)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": ALICE,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(ALICE),
      })
      .send({})
      .expect(200);

    expect(typeof res.body.token).toBe("string");
    expect((res.body.token as string).length).toBeGreaterThanOrEqual(32);
    expect(res.body.scope).toBe("read");
    expect(new Date(res.body.expiresAt).getTime()).toBe(clock + SESSION_ABSOLUTE_MS);
  });

  // The token is the credential. Anything derived from the address would be
  // guessable by anybody who knows the address, which is everybody.
  it("issues a different token every time", async () => {
    const a = await signIn(ALICE);
    const b = await signIn(ALICE);
    expect(a).not.toBe(b);
  });

  it("never returns anything derived from the wallet's own material", async () => {
    const nonce = await nonceFor(ALICE);
    const res = await request(app)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": ALICE,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(ALICE),
      })
      .send({})
      .expect(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("signed-by");
    expect(serialized).not.toContain(nonce);
  });

  it("refuses a request with no signature", async () => {
    const res = await request(app).post("/api/auth/session").send({}).expect(401);
    expect(res.body.error).toBe("missing_auth");
  });

  it("refuses a made-up nonce", async () => {
    const res = await request(app)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": ALICE,
        "x-iwa-nonce": "0xdeadbeef",
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(ALICE),
      })
      .send({})
      .expect(401);
    expect(res.body.error).toBe("unknown_nonce");
  });

  it("refuses a spent nonce", async () => {
    const nonce = await nonceFor(ALICE);
    const headers = {
      "x-iwa-address": ALICE,
      "x-iwa-nonce": nonce,
      "x-iwa-chain": SN_MAIN,
      "x-iwa-signature": sig(ALICE),
    };
    await request(app).post("/api/auth/session").set(headers).send({}).expect(200);
    const res = await request(app).post("/api/auth/session").set(headers).send({}).expect(401);
    expect(res.body.error).toBe("unknown_nonce");
  });

  it("refuses an expired nonce", async () => {
    const nonce = await nonceFor(ALICE);
    clock += 10 * 60 * 1000;
    const res = await request(app)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": ALICE,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(ALICE),
      })
      .send({})
      .expect(401);
    expect(res.body.error).toBe("expired_nonce");
  });

  it("refuses a signature made by a different wallet", async () => {
    const nonce = await nonceFor(ALICE);
    const res = await request(app)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": ALICE,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(BOB),
      })
      .send({})
      .expect(401);
    expect(res.body.error).toBe("bad_signature");
  });

  it("refuses a nonce issued to a different wallet", async () => {
    const nonce = await nonceFor(ALICE);
    const res = await request(app)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": BOB,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(BOB),
      })
      .send({})
      .expect(401);
    expect(res.body.error).toBe("wrong_address");
  });

  it("refuses a wallet on another chain", async () => {
    const nonce = await nonceFor(ALICE);
    const res = await request(app)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": ALICE,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SEPOLIA,
        "x-iwa-signature": sig(ALICE),
      })
      .send({})
      .expect(401);
    expect(res.body.error).toBe("wrong_chain");
  });

  // The signature must name session:create specifically. A signature obtained
  // for anything else — including the reads the session will go on to do — is
  // a different message and must not mint one.
  it("binds to the session:create action and to this exact route", async () => {
    const bound = authorizationHash(
      {
        action: AUTH_ACTIONS.sessionCreate,
        method: "POST",
        resourceHash: hashResource("/api/auth/session"),
        bodyHash: hashBody({}),
        nonce: "0x1",
        chainId: SN_MAIN,
      },
      ALICE,
    );
    const asRead = authorizationHash(
      {
        action: AUTH_ACTIONS.associationsList,
        method: "POST",
        resourceHash: hashResource("/api/auth/session"),
        bodyHash: hashBody({}),
        nonce: "0x1",
        chainId: SN_MAIN,
      },
      ALICE,
    );
    const elsewhere = authorizationHash(
      {
        action: AUTH_ACTIONS.sessionCreate,
        method: "POST",
        resourceHash: hashResource("/api/me/circles"),
        bodyHash: hashBody({}),
        nonce: "0x1",
        chainId: SN_MAIN,
      },
      ALICE,
    );
    expect(bound).not.toBe(asRead);
    expect(bound).not.toBe(elsewhere);
  });

  // Version one of the authorization payload was unbound. Nothing signed under
  // it may mint a session, or the bump was decorative.
  it("does not accept a version one authorization", async () => {
    const v1 = {
      domain: { name: "Iwa", version: "1", chainId: SN_MAIN },
      types: {
        StarkNetDomain: [
          { name: "name", type: "felt" },
          { name: "version", type: "felt" },
          { name: "chainId", type: "felt" },
        ],
        Authorization: [
          { name: "action", type: "felt" },
          { name: "nonce", type: "felt" },
        ],
      },
      primaryType: "Authorization",
      message: { action: "Iwa organizer action", nonce: "0x1" },
    };
    // A verifier that only accepts the old, unbound hash. Under the current
    // binding the server asks about a different hash entirely, so this fails.
    const legacyOnly: SignatureVerifier = {
      async verify(address, messageHash) {
        const { typedData } = await import("starknet");
        return messageHash === typedData.getMessageHash(v1, address);
      },
    };
    const legacyApp = createApp({
      store: new MemoryStore(),
      corsOrigins: [],
      rateLimit: { windowMs: 60_000, max: 500 },
      verifier: legacyOnly,
      now: () => clock,
    });
    const nonce = (
      await request(legacyApp).post("/api/auth/challenge").send({ address: ALICE }).expect(200)
    ).body.nonce as string;
    const res = await request(legacyApp)
      .post("/api/auth/session")
      .set({
        "x-iwa-address": ALICE,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": JSON.stringify(["0x1"]),
      })
      .send({})
      .expect(401);
    expect(res.body.error).toBe("bad_signature");
  });
});

// ------------------------------------------------------------------- reads

describe("what a session may read", () => {
  it("reads the wallet's own circles", async () => {
    const token = await signIn(ALICE);
    const res = await request(app)
      .post("/api/me/circles")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("reads the wallet's own invitations", async () => {
    const token = await signIn(ALICE);
    await request(app)
      .post("/api/me/invitations")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(200);
  });

  it("lists the drafts this wallet organizes", async () => {
    await draftOwnedBy(ALICE);
    const token = await signIn(ALICE);
    const res = await request(app)
      .post("/api/drafts/mine")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(res.body).toHaveLength(1);
  });

  it("opens the organizer view of the wallet's own draft", async () => {
    const draft = await draftOwnedBy(ALICE);
    const token = await signIn(ALICE);
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/organizer-view`)
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(200);
    // The organizer projection, which is the point of the route.
    expect(res.body.slots[0]).toHaveProperty("inviteToken");
  });

  // The scoping property. The session is the identity; the body is not.
  it("scopes reads to the session's wallet and ignores any address sent", async () => {
    await draftOwnedBy(BOB);
    const token = await signIn(ALICE);
    const res = await request(app)
      .post("/api/drafts/mine")
      .set("authorization", `Bearer ${token}`)
      .send({ address: BOB, organizerAddress: BOB })
      .expect(200);
    expect(res.body).toHaveLength(0);
  });

  it("refuses to open another wallet's draft", async () => {
    const draft = await draftOwnedBy(BOB);
    const token = await signIn(ALICE);
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/organizer-view`)
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(403);
    expect(res.body.error).toBe("not_organizer");
  });

  it("does not let a header claim override the session's wallet", async () => {
    await draftOwnedBy(BOB);
    const token = await signIn(ALICE);
    const res = await request(app)
      .post("/api/drafts/mine")
      .set("authorization", `Bearer ${token}`)
      .set("x-iwa-address", BOB)
      .send({})
      .expect(200);
    expect(res.body).toHaveLength(0);
  });

  it("refuses a token that was never issued", async () => {
    const res = await request(app)
      .post("/api/me/circles")
      .set("authorization", "Bearer not-a-real-token")
      .send({})
      .expect(401);
    expect(res.body.error).toBe("session_invalid");
  });

  it("refuses a token past its idle timeout", async () => {
    const token = await signIn(ALICE);
    clock += SESSION_IDLE_MS + 1;
    await request(app)
      .post("/api/me/circles")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(401);
  });

  it("keeps a session alive while it is being used", async () => {
    const token = await signIn(ALICE);
    for (let i = 0; i < 5; i += 1) {
      clock += SESSION_IDLE_MS - 1000;
      await request(app)
        .post("/api/me/circles")
        .set("authorization", `Bearer ${token}`)
        .send({})
        .expect(200);
    }
  });

  it("refuses a token past its absolute lifetime however active it was", async () => {
    const token = await signIn(ALICE);
    // Used constantly, so the idle timer never fires. The absolute one still does.
    for (let i = 0; i < 20; i += 1) {
      clock += 25 * 60 * 1000;
      await request(app)
        .post("/api/me/circles")
        .set("authorization", `Bearer ${token}`)
        .send({});
    }
    await request(app)
      .post("/api/me/circles")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(401);
  });

  it("refuses a revoked token", async () => {
    const token = await signIn(ALICE);
    await request(app)
      .post("/api/auth/session/revoke")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(204);
    await request(app)
      .post("/api/me/circles")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(401);
  });

  it("refuses a session issued for another chain", async () => {
    // Constructed in the store, because the HTTP route will not mint one.
    const created = sessions.create(ALICE, SEPOLIA);
    expect(created).not.toBeNull();
    const res = await request(app)
      .post("/api/me/circles")
      .set("authorization", `Bearer ${created!.token}`)
      .send({})
      .expect(401);
    expect(res.body.error).toBe("session_invalid");
  });

  it("ignores an Authorization header that is not a bearer token", async () => {
    const res = await request(app)
      .post("/api/me/circles")
      .set("authorization", "Basic YWxpY2U6cHc=")
      .send({})
      .expect(401);
    expect(res.body.error).toBe("missing_auth");
  });

  // A read route still accepts the stronger credential, so a client that has
  // no session — or a frontend deployed before this — is not locked out.
  it("still accepts a full Phase 6C signature on a read route", async () => {
    await request(app)
      .post("/api/me/circles")
      .set(await signedHeaders(ALICE))
      .send({})
      .expect(200);
  });
});

// --------------------------------------------------------------- mutations

describe("what a session may never do", () => {
  const DRAFT = {
    chainId: SN_MAIN,
    organizerAddress: ALICE,
    token: USDC,
    contributionAmount: "1000000",
    cadenceSeconds: 604800,
    graceSeconds: 86400,
    memberCount: 2,
  };

  it("cannot create a draft", async () => {
    const token = await signIn(ALICE);
    const res = await request(app)
      .post("/api/drafts")
      .set("authorization", `Bearer ${token}`)
      .send(DRAFT)
      .expect(401);
    expect(res.body.error).toBe("missing_auth");
  });

  it("cannot reorder a payout order", async () => {
    const draft = await draftOwnedBy(ALICE);
    const token = await signIn(ALICE);
    const order = draft.slots.map((s) => s.slotId).reverse();
    await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set("authorization", `Bearer ${token}`)
      .send({ organizerAddress: ALICE, order })
      .expect(401);
    // And the order really is unchanged.
    const after = await store.getDraft(draft.id);
    expect(after!.slots.map((s) => s.slotId)).toEqual(draft.slots.map((s) => s.slotId));
  });

  it("cannot record a circle as created", async () => {
    const draft = await draftOwnedBy(ALICE);
    const token = await signIn(ALICE);
    await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set("authorization", `Bearer ${token}`)
      .send({ organizerAddress: ALICE, circleId: 7, txHash: "0x1" })
      .expect(401);
    const after = await store.getDraft(draft.id);
    expect(after!.circleId).toBeNull();
  });

  it("cannot reconcile", async () => {
    const draft = await draftOwnedBy(ALICE);
    const token = await signIn(ALICE);
    await request(app)
      .post(`/api/drafts/${draft.id}/reconcile`)
      .set("authorization", `Bearer ${token}`)
      .send({ organizerAddress: ALICE })
      .expect(401);
    const after = await store.getDraft(draft.id);
    expect(after!.circleId).toBeNull();
  });

  // Belt and braces: a session presented alongside a broken signature must not
  // be quietly promoted to the credential.
  it("does not rescue a mutation whose signature is bad", async () => {
    const draft = await draftOwnedBy(ALICE);
    const token = await signIn(ALICE);
    const nonce = await nonceFor(ALICE);
    await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set({
        authorization: `Bearer ${token}`,
        "x-iwa-address": ALICE,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(BOB),
      })
      .send({ organizerAddress: ALICE, order: draft.slots.map((s) => s.slotId) })
      .expect(401);
  });
});

// ------------------------------------------------------------------- store

describe("the session store itself", () => {
  it("stores no raw token", () => {
    const created = sessions.create(ALICE, SN_MAIN)!;
    const dumped = JSON.stringify(sessions.records());
    expect(dumped).not.toContain(created.token);
  });

  it("records only what authorization needs", () => {
    sessions.create(ALICE, SN_MAIN);
    const [record] = sessions.records();
    expect(Object.keys(record).sort()).toEqual(
      ["address", "chainId", "createdAt", "expiresAt", "lastUsedAt", "scope", "tokenHash"].sort(),
    );
    expect(record.scope).toBe("read");
  });

  it("forgets expired sessions rather than growing without bound", () => {
    for (let i = 0; i < 4; i += 1) sessions.create(`0x${i + 1}`, SN_MAIN);
    expect(sessions.size).toBe(4);
    clock += SESSION_ABSOLUTE_MS + 1;
    sessions.create(ALICE, SN_MAIN);
    expect(sessions.size).toBe(1);
  });

  it("caps how many live sessions one wallet may hold", () => {
    const tokens = [];
    for (let i = 0; i < 8; i += 1) tokens.push(sessions.create(ALICE, SN_MAIN)!.token);
    expect(sessions.size).toBeLessThanOrEqual(5);
    // The newest survive; the oldest are dropped.
    expect(sessions.validate(tokens[7], SN_MAIN).ok).toBe(true);
    expect(sessions.validate(tokens[0], SN_MAIN).ok).toBe(false);
  });

  it("revoking is idempotent and never reports on a token it does not hold", () => {
    const created = sessions.create(ALICE, SN_MAIN)!;
    expect(sessions.revoke(created.token)).toBe(true);
    expect(sessions.revoke(created.token)).toBe(false);
    expect(sessions.revoke("nonsense")).toBe(false);
  });

  it("reports the reason a session failed, for the log rather than the client", () => {
    expect(sessions.validate("nope", SN_MAIN)).toEqual({ ok: false, reason: "unknown" });
    const created = sessions.create(ALICE, SEPOLIA)!;
    expect(sessions.validate(created.token, SN_MAIN)).toEqual({ ok: false, reason: "wrong_chain" });
  });
});

// -------------------------------------------------------------- observable

describe("the deployment constraint is visible", () => {
  it("reports that sessions live in this process", async () => {
    const res = await request(app).get("/health");
    expect(res.body.sessions).toBe("in-process");
  });

  it("advertises the session header to the browser", async () => {
    const res = await request(app)
      .options("/api/me/circles")
      .set("origin", "https://www.useiwa.xyz")
      .expect(204);
    expect(res.headers["access-control-allow-headers"]).toContain("authorization");
  });
});
