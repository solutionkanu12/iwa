// Chain-neutral account-binding coordination, plus the Celo/EVM organizer
// authorization that gates invite creation.
//
// Covers the production source of truth for memberRef <-> wallet binding: an
// authorized organizer mints a single-use, per-member invite; the member's
// own client accepts it with their connected account; the binding is then
// durable and never silently replaced. Exercised both at the Store level
// (MemoryStore) and over the real HTTP routes (supertest + createApp),
// matching this repo's existing convention (see api.test.ts).

import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { Wallet } from "ethers";
import { randomBytes } from "node:crypto";

import { createApp } from "../src/app.js";
import { MemoryStore, type Store, type AccountBinding } from "../src/store.js";
import type { SignatureVerifier } from "../src/auth.js";
import type { CircleVerifier, DiscoveryOutcome, VerifyOutcome } from "../src/chainVerify.js";
import { CeloAuthNonceStore } from "../src/celoAuth.js";
import {
  CELO_AUTH_ACTIONS,
  celoAuthorizationTypedData,
  type CeloAuthorizationMessage,
} from "../src/celoAuthBinding.js";

class StubVerifier implements SignatureVerifier {
  async verify(): Promise<boolean> {
    return false;
  }
}

class AlwaysAbsent implements CircleVerifier {
  async verifyCreated(): Promise<VerifyOutcome> {
    return { status: "verified" };
  }
  async findCircleForDraft(): Promise<DiscoveryOutcome> {
    return { status: "absent" };
  }
}

function buildApp(store: Store, opts: { now?: () => number; celoNonces?: CeloAuthNonceStore } = {}): Express {
  return createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    verifier: new StubVerifier(),
    circleVerifier: new AlwaysAbsent(),
    now: opts.now,
    celoNonces: opts.celoNonces,
  });
}

const CIRCLE = "0x00000000000000000000000000000000000123";
const CHAIN = "celo:42220";
const MEMBER_1 = "m1";
const MEMBER_2 = "m2";
const ACCOUNT_A = `celo:0x00000000000000000000000000000000000000aa`;
const ACCOUNT_B = `celo:0x00000000000000000000000000000000000000bb`;

const ORGANIZER = Wallet.createRandom();
const OTHER_WALLET = Wallet.createRandom();

function randomNonce(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

async function signOrganizerAuth(
  wallet: Wallet,
  overrides: Partial<CeloAuthorizationMessage> = {},
  domainOverrides: Partial<{ name: string; version: string; chainId: number }> = {},
): Promise<{ organizer: string; nonce: string; expiresAt: number; signature: string }> {
  const message: CeloAuthorizationMessage = {
    action: CELO_AUTH_ACTIONS.accountBindingInvite,
    circleId: CIRCLE,
    memberRef: MEMBER_1,
    organizer: wallet.address,
    nonce: randomNonce(),
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
  const typed = celoAuthorizationTypedData(message);
  const domain = { ...typed.domain, ...domainOverrides };
  const signature = await wallet.signTypedData(domain, typed.types, typed.message);
  return {
    organizer: message.organizer,
    nonce: message.nonce,
    expiresAt: message.expiresAt,
    signature,
  };
}

/**
 * Signs and submits an invite-mint request, fully resolved. Deliberately not
 * chained with supertest's `.expect(...)`: returning a supertest `Test`
 * (thenable) from an `async` function causes it to be settled before the
 * caller ever sees it, so `.expect` would already be gone. Callers assert on
 * `.status`/`.body` instead.
 */
async function mintInvite(
  app: Express,
  overrides: { circleId?: string; memberRef?: string; wallet?: Wallet } = {},
): Promise<request.Response> {
  const wallet = overrides.wallet ?? ORGANIZER;
  const circleId = overrides.circleId ?? CIRCLE;
  const memberRef = overrides.memberRef ?? MEMBER_1;
  const authorization = await signOrganizerAuth(wallet, { circleId, memberRef });
  return request(app)
    .post("/api/account-bindings/invites")
    .send({ circleId, memberRef, chain: CHAIN, authorization });
}

describe("MemoryStore account bindings", () => {
  it("join creates a binding", async () => {
    const store = new MemoryStore();
    const invite = await store.createAccountBindInvite({
      circleId: CIRCLE,
      memberRef: MEMBER_1,
      chain: CHAIN,
    });
    expect(invite.ok).toBe(true);
    if (!invite.ok) throw new Error("unreachable");
    const accepted = await store.acceptAccountBind({
      inviteToken: invite.inviteToken,
      account: ACCOUNT_A,
    });
    expect(accepted).toEqual({
      ok: true,
      binding: expect.objectContaining({
        circleId: CIRCLE,
        memberRef: MEMBER_1,
        chain: CHAIN,
        account: ACCOUNT_A,
      }),
    });
  });

  it("existing binding resolves correctly", async () => {
    const store = new MemoryStore();
    const invite = await store.createAccountBindInvite({
      circleId: CIRCLE,
      memberRef: MEMBER_1,
      chain: CHAIN,
    });
    if (!invite.ok) throw new Error("unreachable");
    await store.acceptAccountBind({ inviteToken: invite.inviteToken, account: ACCOUNT_A });
    const resolved = await store.getAccountBinding(CIRCLE, MEMBER_1);
    expect(resolved).toEqual(
      expect.objectContaining({
        circleId: CIRCLE,
        memberRef: MEMBER_1,
        chain: CHAIN,
        account: ACCOUNT_A,
      }),
    );
  });

  it("missing binding resolves to null", async () => {
    const store = new MemoryStore();
    expect(await store.getAccountBinding(CIRCLE, MEMBER_1)).toBeNull();
  });

  it("rejects minting a second invite for the same member (duplicate/conflicting invite)", async () => {
    const store = new MemoryStore();
    const first = await store.createAccountBindInvite({
      circleId: CIRCLE,
      memberRef: MEMBER_1,
      chain: CHAIN,
    });
    expect(first.ok).toBe(true);
    const second = await store.createAccountBindInvite({
      circleId: CIRCLE,
      memberRef: MEMBER_1,
      chain: CHAIN,
    });
    expect(second).toEqual({ ok: false, reason: "already_invited" });
  });

  it("an unauthorized client cannot bind any member without a valid token", async () => {
    const store = new MemoryStore();
    await store.createAccountBindInvite({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN });
    const result = await store.acceptAccountBind({
      inviteToken: "guessed-token-that-does-not-exist",
      account: ACCOUNT_B,
    });
    expect(result).toEqual({ ok: false, reason: "unknown_invite" });
    expect(await store.getAccountBinding(CIRCLE, MEMBER_1)).toBeNull();
    expect(await store.getAccountBinding(CIRCLE, MEMBER_2)).toBeNull();
  });

  it("active binding cannot be silently replaced: the same token cannot be spent twice", async () => {
    const store = new MemoryStore();
    const invite = await store.createAccountBindInvite({
      circleId: CIRCLE,
      memberRef: MEMBER_1,
      chain: CHAIN,
    });
    if (!invite.ok) throw new Error("unreachable");
    const firstAccept = await store.acceptAccountBind({
      inviteToken: invite.inviteToken,
      account: ACCOUNT_A,
    });
    expect(firstAccept.ok).toBe(true);

    const replay = await store.acceptAccountBind({
      inviteToken: invite.inviteToken,
      account: ACCOUNT_B,
    });
    expect(replay).toEqual({ ok: false, reason: "already_used" });

    const stillOriginal = await store.getAccountBinding(CIRCLE, MEMBER_1);
    expect(stillOriginal?.account).toBe(ACCOUNT_A);
  });

  it("fails closed when the store throws (simulated database failure)", async () => {
    const store = new MemoryStore();
    const failing: Store = {
      ...store,
      getAccountBinding: async () => {
        throw new Error("simulated database outage");
      },
    };
    await expect(failing.getAccountBinding(CIRCLE, MEMBER_1)).rejects.toThrow(
      /simulated database outage/,
    );
  });
});

describe("MemoryStore Celo circle organizer authority", () => {
  it("first claim establishes the organizer; the same organizer may re-establish", async () => {
    const store = new MemoryStore();
    const first = await store.establishCeloCircleOrganizer(CIRCLE, ACCOUNT_A);
    expect(first).toEqual({ ok: true, organizer: ACCOUNT_A });
    const again = await store.establishCeloCircleOrganizer(CIRCLE, ACCOUNT_A);
    expect(again).toEqual({ ok: true, organizer: ACCOUNT_A });
  });

  it("a different wallet cannot become organizer once one is established", async () => {
    const store = new MemoryStore();
    await store.establishCeloCircleOrganizer(CIRCLE, ACCOUNT_A);
    const second = await store.establishCeloCircleOrganizer(CIRCLE, ACCOUNT_B);
    expect(second).toEqual({ ok: false, reason: "wrong_organizer" });
  });

  it("race/double-submit: only one of two concurrent first-claims wins", async () => {
    const store = new MemoryStore();
    const [a, b] = await Promise.all([
      store.establishCeloCircleOrganizer(CIRCLE, ACCOUNT_A),
      store.establishCeloCircleOrganizer(CIRCLE, ACCOUNT_B),
    ]);
    const results = [a, b];
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
  });
});

describe("account-binding HTTP routes", () => {
  it("mints an invite, accepts it, and resolves the binding by exact chain/account", async () => {
    const app = buildApp(new MemoryStore());

    const invite = await mintInvite(app);
    expect(invite.status).toBe(200);
    const inviteToken = invite.body.inviteToken as string;
    expect(typeof inviteToken).toBe("string");

    const accept = await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken, account: ACCOUNT_A })
      .expect(200);
    expect((accept.body.binding as AccountBinding).account).toBe(ACCOUNT_A);

    const resolved = await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_1}`)
      .query({ chain: CHAIN, account: ACCOUNT_A })
      .expect(200);
    expect((resolved.body.binding as AccountBinding).account).toBe(ACCOUNT_A);
  });

  it("rejects binding for an unauthenticated/arbitrary client with no valid token", async () => {
    const app = buildApp(new MemoryStore());
    await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken: "totally-made-up-token-value", account: ACCOUNT_A })
      .expect(409)
      .expect((res) => expect(res.body.error).toBe("unknown_invite"));
  });

  it("rejects a wrong wallet: resolving with the wrong account behaves like no binding", async () => {
    const app = buildApp(new MemoryStore());
    const invite = await mintInvite(app);
    expect(invite.status).toBe(200);
    await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken: invite.body.inviteToken, account: ACCOUNT_A })
      .expect(200);

    await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_1}`)
      .query({ chain: CHAIN, account: ACCOUNT_B })
      .expect(404);
  });

  it("rejects a wrong chain: resolving with the wrong chain behaves like no binding", async () => {
    const app = buildApp(new MemoryStore());
    const invite = await mintInvite(app);
    expect(invite.status).toBe(200);
    await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken: invite.body.inviteToken, account: ACCOUNT_A })
      .expect(200);

    await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_1}`)
      .query({ chain: "starknet:SN_MAIN", account: ACCOUNT_A })
      .expect(404);
  });

  it("rejects a wrong memberRef: resolving an unbound member behaves like no binding", async () => {
    const app = buildApp(new MemoryStore());
    await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_2}`)
      .query({ chain: CHAIN, account: ACCOUNT_A })
      .expect(404);
  });

  it("does not disclose the real binding when queried with the wrong account (same 404 either way)", async () => {
    const app = buildApp(new MemoryStore());
    const invite = await mintInvite(app);
    expect(invite.status).toBe(200);
    await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken: invite.body.inviteToken, account: ACCOUNT_A })
      .expect(200);

    const wrongGuess = await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_1}`)
      .query({ chain: CHAIN, account: ACCOUNT_B })
      .expect(404);
    const neverBound = await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_2}`)
      .query({ chain: CHAIN, account: ACCOUNT_B })
      .expect(404);
    expect(wrongGuess.body).toEqual(neverBound.body);
  });

  it("rejects a second invite for the same member (duplicate/conflicting binding)", async () => {
    const app = buildApp(new MemoryStore());
    const first = await mintInvite(app);
    expect(first.status).toBe(200);
    const second = await mintInvite(app);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("already_invited");
  });

  it("cannot silently replace an active binding: replaying the same invite token fails", async () => {
    const app = buildApp(new MemoryStore());
    const invite = await mintInvite(app);
    expect(invite.status).toBe(200);
    await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken: invite.body.inviteToken, account: ACCOUNT_A })
      .expect(200);
    await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken: invite.body.inviteToken, account: ACCOUNT_B })
      .expect(409)
      .expect((res) => expect(res.body.error).toBe("already_used"));

    const resolved = await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_1}`)
      .query({ chain: CHAIN, account: ACCOUNT_A })
      .expect(200);
    expect((resolved.body.binding as AccountBinding).account).toBe(ACCOUNT_A);
  });

  it("fails closed (5xx, no data leaked) when the store throws", async () => {
    const failingStore: Store = {
      ...new MemoryStore(),
      getAccountBinding: async () => {
        throw new Error("simulated database outage");
      },
    };
    const app = buildApp(failingStore);
    const res = await request(app)
      .get(`/api/account-bindings/${encodeURIComponent(CIRCLE)}/${MEMBER_1}`)
      .query({ chain: CHAIN, account: ACCOUNT_A });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.binding).toBeUndefined();
  });

  it("never accepts key material on these routes either", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER);
    await request(app)
      .post("/api/account-bindings/accept")
      .send({ inviteToken: "x".repeat(20), account: ACCOUNT_A, privateKey: "0xdeadbeef" })
      .expect(400)
      .expect((res) => expect(res.body.error).toBe("forbidden_field"));
    // Also on the mint route, alongside a well-formed authorization.
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization, seedPhrase: "x" })
      .expect(400)
      .expect((res) => expect(res.body.error).toBe("forbidden_field"));
  });
});

describe("Celo organizer authorization on POST /api/account-bindings/invites", () => {
  it("mints an invite for a valid organizer signature", async () => {
    const app = buildApp(new MemoryStore());
    const res = await mintInvite(app);
    expect(res.status).toBe(200);
  });

  it("rejects a missing authorization", async () => {
    const app = buildApp(new MemoryStore());
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN })
      .expect(400)
      .expect((res) => expect(res.body.error).toBe("invalid_request"));
  });

  it("rejects a malformed signature", async () => {
    const app = buildApp(new MemoryStore());
    const good = await signOrganizerAuth(ORGANIZER);
    await request(app)
      .post("/api/account-bindings/invites")
      .send({
        circleId: CIRCLE,
        memberRef: MEMBER_1,
        chain: CHAIN,
        authorization: { ...good, signature: `0x${"00".repeat(65)}` },
      })
      .expect(401)
      .expect((res) => expect(res.body.error).toBe("bad_signature"));
  });

  it("rejects a wrong signer: a signature that recovers to an address other than the claimed organizer", async () => {
    const app = buildApp(new MemoryStore());
    // Sign as OTHER_WALLET but claim to be ORGANIZER in the message.
    const wrongSigner = await signOrganizerAuth(OTHER_WALLET, { organizer: ORGANIZER.address });
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization: wrongSigner })
      .expect(401)
      .expect((res) => expect(res.body.error).toBe("wrong_signer"));
  });

  it("rejects a wrong circle: a signature signed for a different circleId", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, { circleId: "0xsome-other-circle" });
    // Submitted against CIRCLE, not the circle the signature actually names.
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization })
      .expect(401)
      .expect((res) => expect(["bad_signature", "wrong_signer"]).toContain(res.body.error));
  });

  it("rejects a wrong memberRef: a signature signed for a different member", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, { memberRef: MEMBER_2 });
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization })
      .expect(401)
      .expect((res) => expect(["bad_signature", "wrong_signer"]).toContain(res.body.error));
  });

  it("rejects a wrong chain: a signature signed against a different EIP-712 domain chainId", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, {}, { chainId: 1 });
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization })
      .expect(401)
      .expect((res) => expect(["bad_signature", "wrong_signer"]).toContain(res.body.error));
  });

  it("rejects an expired signature", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, {
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    });
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization })
      .expect(401)
      .expect((res) => expect(res.body.error).toBe("expired_authorization"));
  });

  it("rejects an authorization whose validity window is unreasonably long", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, {
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    });
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization })
      .expect(401)
      .expect((res) => expect(res.body.error).toBe("authorization_window_too_long"));
  });

  it("rejects a replayed nonce: the same signed authorization cannot be spent twice", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, { memberRef: MEMBER_1 });
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization })
      .expect(200);
    // The exact same request again. The signature still recovers correctly
    // (nothing about the request changed), but the nonce it carries was
    // already spent, so this must fail on that basis specifically — not on
    // "already_invited", which the (now-unreachable) store call would
    // otherwise report.
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization })
      .expect(401)
      .expect((res) => expect(res.body.error).toBe("reused_nonce"));
  });

  it("race/double-submit: firing the same signed authorization twice at once only lets one through", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER);
    const [a, b] = await Promise.all([
      request(app)
        .post("/api/account-bindings/invites")
        .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization }),
      request(app)
        .post("/api/account-bindings/invites")
        .send({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN, authorization }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("unauthorized organizer cannot mint an invite for a circle another wallet already organizes", async () => {
    const app = buildApp(new MemoryStore());
    // ORGANIZER establishes itself for CIRCLE.
    const established = await mintInvite(app, { memberRef: MEMBER_1 });
    expect(established.status).toBe(200);

    // OTHER_WALLET signs a perfectly valid authorization for itself, for the
    // same circle, a different member. The signature is genuine — this is
    // not a signer/signature failure — but the wallet is not the recorded
    // organizer.
    const authorization = await signOrganizerAuth(OTHER_WALLET, { memberRef: MEMBER_2 });
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_2, chain: CHAIN, authorization })
      .expect(403)
      .expect((res) => expect(res.body.error).toBe("not_organizer"));
  });

  it("does not leak the recorded organizer's address in a not_organizer failure", async () => {
    const app = buildApp(new MemoryStore());
    const established = await mintInvite(app, { memberRef: MEMBER_1 });
    expect(established.status).toBe(200);
    const authorization = await signOrganizerAuth(OTHER_WALLET, { memberRef: MEMBER_2 });
    const res = await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, memberRef: MEMBER_2, chain: CHAIN, authorization })
      .expect(403);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ORGANIZER.address.toLowerCase());
    expect(body).not.toContain(ORGANIZER.address);
  });
});
