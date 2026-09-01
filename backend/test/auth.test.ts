// Security gate for organizer authentication.
//
// The property under test: knowing a public address must never be enough. Only
// a fresh, single-use, correctly-signed challenge from that exact account on
// that exact chain authorizes an organizer action.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";
import { AUTH_ACTIONS, authorizationHash, hashBody, hashResource } from "../src/authBinding.js";
import {
  CHALLENGE_TTL_MS,
  ChallengeStore,
  verifyCredentials,
  type SignatureVerifier,
} from "../src/auth.js";

const ORGANIZER = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const ATTACKER = "0xdead";
const SEPOLIA = "0x534e5f5345504f4c4941";

class StubVerifier implements SignatureVerifier {
  async verify(address: string, _hash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `signed-by:${address}`;
  }
}

const sig = (address: string) => JSON.stringify([`signed-by:${address}`]);

const DRAFT = {
  chainId: SN_MAIN,
  organizerAddress: ORGANIZER,
  token: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
  contributionAmount: "1000000",
  cadenceSeconds: 604800,
  graceSeconds: 86400,
  memberCount: 2,
};

let app: Express;

beforeEach(() => {
  app = createApp({
    store: new MemoryStore(),
    corsOrigins: [],
    rateLimit: { windowMs: 60_000, max: 500 },
    verifier: new StubVerifier(),
  });
});

async function challenge(address: string): Promise<string> {
  const res = await request(app).post("/api/auth/challenge").send({ address }).expect(200);
  return res.body.nonce as string;
}

describe("challenge issuance", () => {
  it("returns a felt nonce, an expiry, and the exact payload to sign", async () => {
    const res = await request(app).post("/api/auth/challenge").send({ address: ORGANIZER }).expect(200);
    expect(res.body.nonce).toMatch(/^0x[0-9a-f]{32}$/);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // No payload comes back. What the signature will authorize is decided when
    // the client signs, from the call it is about to make, and is recomputed by
    // the server from the request it actually receives.
    expect(res.body).not.toHaveProperty("typedData");
  });

  it("issues a different nonce every time", async () => {
    const a = await challenge(ORGANIZER);
    const b = await challenge(ORGANIZER);
    expect(a).not.toBe(b);
  });

  it("refuses a malformed address", async () => {
    await request(app).post("/api/auth/challenge").send({ address: "nope" }).expect(400);
  });
});

describe("organizer routes reject everything but a valid signed challenge", () => {
  it("rejects a request with no signature at all", async () => {
    const res = await request(app).post("/api/drafts").send(DRAFT).expect(401);
    expect(res.body.error).toBe("missing_auth");
  });

  it("rejects a stolen organizer address with no signature", async () => {
    // The whole point: the address is public, so it cannot be the credential.
    const res = await request(app)
      .post("/api/drafts")
      .set({ "x-iwa-address": ORGANIZER, "x-iwa-nonce": "0x1", "x-iwa-chain": SN_MAIN })
      .send(DRAFT)
      .expect(401);
    expect(res.body.error).toBe("missing_auth");
  });

  it("rejects a made-up nonce", async () => {
    const res = await request(app)
      .post("/api/drafts")
      .set({
        "x-iwa-address": ORGANIZER,
        "x-iwa-nonce": "0xdeadbeef",
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(ORGANIZER),
      })
      .send(DRAFT)
      .expect(401);
    expect(res.body.error).toBe("unknown_nonce");
  });

  it("rejects a replayed signature", async () => {
    const nonce = await challenge(ORGANIZER);
    const headers = {
      "x-iwa-address": ORGANIZER,
      "x-iwa-nonce": nonce,
      "x-iwa-chain": SN_MAIN,
      "x-iwa-signature": sig(ORGANIZER),
    };
    await request(app).post("/api/drafts").set(headers).send(DRAFT).expect(201);
    // Same nonce, same signature, second time.
    const replay = await request(app).post("/api/drafts").set(headers).send(DRAFT).expect(401);
    expect(replay.body.error).toBe("unknown_nonce");
  });

  it("rejects a nonce issued for a different wallet", async () => {
    const nonce = await challenge(ATTACKER);
    const res = await request(app)
      .post("/api/drafts")
      .set({
        "x-iwa-address": ORGANIZER,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(ORGANIZER),
      })
      .send(DRAFT)
      .expect(401);
    expect(res.body.error).toBe("wrong_address");
  });

  it("rejects a signature made by the wrong signer", async () => {
    const nonce = await challenge(ORGANIZER);
    const res = await request(app)
      .post("/api/drafts")
      .set({
        "x-iwa-address": ORGANIZER,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        // A real signature, but from another account.
        "x-iwa-signature": sig(ATTACKER),
      })
      .send(DRAFT)
      .expect(401);
    expect(res.body.error).toBe("bad_signature");
  });

  it("rejects a confirmation presented for the wrong chain", async () => {
    const nonce = await challenge(ORGANIZER);
    const res = await request(app)
      .post("/api/drafts")
      .set({
        "x-iwa-address": ORGANIZER,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SEPOLIA,
        "x-iwa-signature": sig(ORGANIZER),
      })
      .send(DRAFT)
      .expect(401);
    expect(res.body.error).toBe("wrong_chain");
  });

  it("rejects a malformed signature header", async () => {
    const nonce = await challenge(ORGANIZER);
    const res = await request(app)
      .post("/api/drafts")
      .set({
        "x-iwa-address": ORGANIZER,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": "not-json",
      })
      .send(DRAFT)
      .expect(401);
    expect(res.body.error).toBe("bad_signature");
  });

  it("refuses to create a draft whose organizer is not the signer", async () => {
    const nonce = await challenge(ATTACKER);
    const res = await request(app)
      .post("/api/drafts")
      .set({
        "x-iwa-address": ATTACKER,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": sig(ATTACKER),
      })
      .send(DRAFT)
      .expect(403);
    expect(res.body.error).toBe("not_organizer");
  });
});

/** One operation, used wherever these tests only care about the lifecycle. */
const OPERATION = {
  action: AUTH_ACTIONS.draftsList,
  method: "POST",
  resourceHash: hashResource("/api/drafts/mine"),
  bodyHash: hashBody({}),
};

/** The hash the account is asked to have signed, for that operation. */
const hashFor = (nonce: string, chainId: string, address: string) =>
  authorizationHash({ ...OPERATION, nonce, chainId }, address);

describe("challenge expiry", () => {
  it("rejects a nonce past its lifetime, and burns it", async () => {
    let clock = 1_000_000;
    const store = new ChallengeStore(() => clock);
    const issued = store.issue(ORGANIZER, SN_MAIN);

    clock += CHALLENGE_TTL_MS + 1;
    const expired = await verifyCredentials(
      { address: ORGANIZER, nonce: issued.nonce, chainId: SN_MAIN, signature: [`signed-by:${ORGANIZER}`] },
      OPERATION,
      store,
      new StubVerifier(),
    );
    expect(expired).toEqual({ ok: false, reason: "expired_nonce" });

    // Even if the clock were wound back, the nonce is gone.
    clock = 1_000_001;
    const retry = await verifyCredentials(
      { address: ORGANIZER, nonce: issued.nonce, chainId: SN_MAIN, signature: [`signed-by:${ORGANIZER}`] },
      OPERATION,
      store,
      new StubVerifier(),
    );
    expect(retry).toEqual({ ok: false, reason: "unknown_nonce" });
  });

  it("burns the nonce even when the signature is wrong, so it cannot be brute-forced", async () => {
    const store = new ChallengeStore();
    const issued = store.issue(ORGANIZER, SN_MAIN);
    const verifier = new StubVerifier();

    const first = await verifyCredentials(
      { address: ORGANIZER, nonce: issued.nonce, chainId: SN_MAIN, signature: ["wrong"] },
      OPERATION,
      store,
      verifier,
    );
    expect(first).toEqual({ ok: false, reason: "bad_signature" });

    const second = await verifyCredentials(
      { address: ORGANIZER, nonce: issued.nonce, chainId: SN_MAIN, signature: [`signed-by:${ORGANIZER}`] },
      OPERATION,
      store,
      verifier,
    );
    expect(second).toEqual({ ok: false, reason: "unknown_nonce" });
  });

  it("sweeps expired challenges rather than growing without bound", () => {
    let clock = 0;
    const store = new ChallengeStore(() => clock);
    store.issue(ORGANIZER, SN_MAIN);
    store.issue(ORGANIZER, SN_MAIN);
    expect(store.size).toBe(2);
    clock += CHALLENGE_TTL_MS + 1;
    store.issue(ORGANIZER, SN_MAIN);
    expect(store.size).toBe(1);
  });
});

describe("challenge hash", () => {
  it("binds the nonce, the chain and the account together", () => {
    const a = hashFor("0x1", SN_MAIN, ORGANIZER);
    expect(hashFor("0x2", SN_MAIN, ORGANIZER)).not.toBe(a);
    expect(hashFor("0x1", SEPOLIA, ORGANIZER)).not.toBe(a);
    expect(hashFor("0x1", SN_MAIN, ATTACKER)).not.toBe(a);

    // And now the operation itself, which is what this wave added.
    expect(
      authorizationHash(
        { ...OPERATION, action: AUTH_ACTIONS.draftReorder, nonce: "0x1", chainId: SN_MAIN },
        ORGANIZER,
      ),
    ).not.toBe(a);
    expect(
      authorizationHash({ ...OPERATION, method: "GET", nonce: "0x1", chainId: SN_MAIN }, ORGANIZER),
    ).not.toBe(a);
    expect(
      authorizationHash(
        { ...OPERATION, resourceHash: hashResource("/api/me/circles"), nonce: "0x1", chainId: SN_MAIN },
        ORGANIZER,
      ),
    ).not.toBe(a);
    expect(
      authorizationHash(
        { ...OPERATION, bodyHash: hashBody({ a: 1 }), nonce: "0x1", chainId: SN_MAIN },
        ORGANIZER,
      ),
    ).not.toBe(a);
  });
});
