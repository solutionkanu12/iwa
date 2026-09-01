// Input handling and rate limiting.
//
// Everything here is reachable without authenticating, which is what makes it
// worth pinning. A stranger can reach these paths, so the answers they get have
// to be deliberate: a refusal, never a server error, and never a way to hand
// yourself a fresh budget by relabelling who you are.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp, createRateLimiter } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";
import { ChallengeStore, type SignatureVerifier } from "../src/auth.js";
import type { CircleVerifier, DiscoveryOutcome, VerifyOutcome } from "../src/chainVerify.js";

class StubVerifier implements SignatureVerifier {
  async verify(address: string, _hash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `signed-by:${address}`;
  }
}
class AlwaysVerifies implements CircleVerifier {
  async verifyCreated(): Promise<VerifyOutcome> {
    return { status: "verified" };
  }
  async findCircleForDraft(): Promise<DiscoveryOutcome> {
    return { status: "absent" };
  }
}

const ORGANIZER = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const DRAFT = {
  chainId: SN_MAIN,
  organizerAddress: ORGANIZER,
  token: USDC,
  contributionAmount: "10000000",
  cadenceSeconds: 604800,
  graceSeconds: 86400,
  memberCount: 2,
};

let app: Express;
let clock: number;

function makeApp(rateLimit = { windowMs: 60_000, max: 500 }) {
  return createApp({
    store: new MemoryStore(),
    corsOrigins: ["https://useiwa.xyz"],
    rateLimit,
    verifier: new StubVerifier(),
    circleVerifier: new AlwaysVerifies(),
    challenges: new ChallengeStore(),
    now: () => clock,
  });
}

beforeEach(() => {
  clock = Date.now();
  app = makeApp();
});

async function authHeaders(target: Express, address: string) {
  const r = await request(target).post("/api/auth/challenge").send({ address }).expect(200);
  return {
    "x-iwa-address": address,
    "x-iwa-nonce": r.body.nonce as string,
    "x-iwa-chain": SN_MAIN,
    "x-iwa-signature": JSON.stringify([`signed-by:${address}`]),
  };
}

async function newDraft() {
  const r = await request(app).post("/api/drafts").set(await authHeaders(app, ORGANIZER)).send(DRAFT);
  expect(r.status).toBe(201);
  return r.body;
}

// A path parameter is attacker-controlled. Reaching a UUID column with one is
// how a stranger turns a mistyped link into a database error and a 500.
describe("malformed resource ids", () => {
  const BAD = [
    "not-a-uuid",
    "1 OR 1=1",
    "%27",
    "'; DROP TABLE circle_drafts; --",
    "../../etc/passwd",
    "0",
    "null",
    "undefined",
    "a".repeat(5000),
    "0000-0000",
    "00000000000000000000000000000000",
  ];

  it("answers every malformed draft id without a server error", async () => {
    for (const bad of BAD) {
      const res = await request(app).get(`/api/drafts/${encodeURIComponent(bad)}`);
      expect(res.status, `GET /api/drafts/${bad}`).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    }
  });

  // The same class on every route that takes a draft id, not just the one that
  // was noticed. These authenticate first, so a stranger sees only the refusal.
  it("answers a malformed id on every authenticated draft route", async () => {
    for (const route of ["organizer-view", "order", "created", "reconcile"]) {
      for (const bad of ["not-a-uuid", "1 OR 1=1", "a".repeat(5000)]) {
        const res = await request(app)
          .post(`/api/drafts/${encodeURIComponent(bad)}/${route}`)
          .set(await authHeaders(app, ORGANIZER))
          .send({ organizerAddress: ORGANIZER, circleId: 1, txHash: "0xabc", order: [] });
        expect([400, 404], `${route} with ${bad.slice(0, 12)}`).toContain(res.status);
        expect(res.status).not.toBe(500);
      }
    }
  });

  it("answers a malformed invite token without a server error", async () => {
    for (const bad of ["not a token", "%27", "a".repeat(5000), "../secret"]) {
      const res = await request(app).get(`/api/invites/${encodeURIComponent(bad)}`);
      expect(res.status).not.toBe(500);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("answers a malformed circle id without a server error", async () => {
    for (const bad of ["abc", "-1", "0", "1.5", "a".repeat(500)]) {
      const res = await request(app).get(`/api/circles/${encodeURIComponent(bad)}/events`);
      expect(res.status).not.toBe(500);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("still serves a real draft id", async () => {
    const draft = await newDraft();
    const res = await request(app).get(`/api/drafts/${draft.id}`).expect(200);
    expect(res.body.id).toBe(draft.id);
  });

  it("never mentions the database in a refusal", async () => {
    const res = await request(app).get("/api/drafts/not-a-uuid");
    const body = JSON.stringify(res.body).toLowerCase();
    for (const leak of ["uuid", "postgres", "syntax", "invalid input", "select", "column"]) {
      expect(body).not.toContain(leak);
    }
  });
});

describe("request bodies", () => {
  it("refuses a body past the limit as too large, not as a fault", async () => {
    const huge = { ...DRAFT, token: `0x${"a".repeat(200_000)}` };
    const res = await request(app)
      .post("/api/drafts")
      .set(await authHeaders(app, ORGANIZER))
      .send(huge);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("refuses malformed json as a bad request", async () => {
    const res = await request(app)
      .post("/api/drafts")
      .set("content-type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it("leaks no parser internals in either refusal", async () => {
    for (const body of [`{"a":"${"x".repeat(200_000)}"}`, "{not json"]) {
      const res = await request(app)
        .post("/api/drafts")
        .set("content-type", "application/json")
        .send(body);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/at Object|node_modules|entity\.too\.large|JSON at position/);
    }
  });

  it("leaves an ordinary body working", async () => {
    const draft = await newDraft();
    expect(draft.slots).toHaveLength(2);
  });
});

// Railway puts one proxy in front of the service, and it appends the real
// client to X-Forwarded-For. Anything to the LEFT of that is whatever the
// client chose to send, so trusting it hands every client an unlimited supply
// of fresh identities.
describe("rate limiting behind one proxy", () => {
  /** Simulates the edge: the client's own header, with the real peer appended. */
  const forwarded = (clientSupplied: string | null, realClient: string) =>
    clientSupplied === null ? realClient : `${clientSupplied}, ${realClient}`;

  async function spend(target: Express, xff: string) {
    return request(target).post("/api/drafts").set("X-Forwarded-For", xff).send(DRAFT);
  }

  it("PROOF: rotating the client-supplied part does not reset the bucket", async () => {
    const limited = makeApp({ windowMs: 60_000, max: 3 });
    const real = "198.51.100.7";

    for (let i = 0; i < 3; i += 1) {
      await spend(limited, forwarded(null, real));
    }
    expect((await spend(limited, forwarded(null, real))).status).toBe(429);
    // Sanity: the limiter is what refused, not authentication.

    // The same client, now claiming to be somebody else. Still the same budget.
    for (const spoof of ["203.0.113.1", "203.0.113.2", "10.0.0.1", "::1"]) {
      const res = await spend(limited, forwarded(spoof, real));
      expect(res.status, `spoof ${spoof}`).toBe(429);
    }
  });

  it("still tells two genuinely different clients apart", async () => {
    const limited = makeApp({ windowMs: 60_000, max: 2 });
    for (let i = 0; i < 2; i += 1) await spend(limited, forwarded(null, "198.51.100.7"));
    expect((await spend(limited, forwarded(null, "198.51.100.7"))).status).toBe(429);

    // A different real client, appended by the same proxy, has its own budget.
    expect((await spend(limited, forwarded(null, "198.51.100.8"))).status).not.toBe(429);
  });

  it("does not fall over when no forwarding header is present", async () => {
    const limited = makeApp({ windowMs: 60_000, max: 2 });
    const res = await request(limited).post("/api/drafts").send(DRAFT);
    expect(res.status).not.toBe(500);
  });
});

// A limiter that remembers every client it has ever seen is a slow leak, and
// with a rotating identity it is a fast one.
describe("rate limiter memory", () => {
  it("forgets a client once its window has passed", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter(1_000, 1, () => t);

    for (let i = 0; i < 500; i += 1) limiter(`client-${i}`);
    expect(limiter.size()).toBe(500);

    // Every window has closed. The next call is the one that tidies up.
    t += 60_000;
    limiter("someone-new");
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });

  it("cannot be grown without bound by rotating identities", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter(1_000, 1, () => t);
    let peak = 0;
    for (let i = 0; i < 5_000; i += 1) {
      t += 10; // time moves on as the requests arrive
      limiter(`rotating-${i}`);
      peak = Math.max(peak, limiter.size());
    }
    // Bounded by what fits in one window, not by everything ever seen.
    expect(peak).toBeLessThan(1_000);
  });

  it("counts correctly inside a live window and rolls over after it", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter(60_000, 2, () => t);

    expect(limiter("a").allowed).toBe(true);
    expect(limiter("a").allowed).toBe(true);
    const blocked = limiter("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    t += 61_000;
    expect(limiter("a").allowed).toBe(true);
  });

  it("keeps separate budgets for separate clients", () => {
    let t = 1_000_000;
    const limiter = createRateLimiter(60_000, 1, () => t);
    expect(limiter("a").allowed).toBe(true);
    expect(limiter("a").allowed).toBe(false);
    expect(limiter("b").allowed).toBe(true);
  });
});

// A refusal the browser cannot read is a refusal the app cannot act on. The
// origin header has to survive the body parser rejecting a request.
describe("refusals reach the browser", () => {
  it("carries the origin header on a too-large body", async () => {
    const res = await request(app)
      .post("/api/drafts")
      .set("Origin", "https://useiwa.xyz")
      .set("content-type", "application/json")
      .send(`{"a":"${"x".repeat(200_000)}"}`);
    expect(res.status).toBe(413);
    expect(res.headers["access-control-allow-origin"]).toBe("https://useiwa.xyz");
  });

  it("carries the origin header on malformed json", async () => {
    const res = await request(app)
      .post("/api/drafts")
      .set("Origin", "https://useiwa.xyz")
      .set("content-type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.headers["access-control-allow-origin"]).toBe("https://useiwa.xyz");
  });

  it("still refuses an origin that is not allowed", async () => {
    const res = await request(app)
      .post("/api/drafts")
      .set("Origin", "https://evil.example")
      .set("content-type", "application/json")
      .send("{not json");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
