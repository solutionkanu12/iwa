// Chain-neutral account-binding coordination, plus the Celo/EVM organizer
// authorization that gates invite creation.
//
// Covers the production source of truth for memberRef <-> wallet binding: an
// on-chain-verified organizer mints a single-use, per-member invite; the
// member's own client accepts it with their connected account; the binding
// is then durable and never silently replaced. Organizer authority is read
// fresh from IwaCircleCelo.organizer() via an injected CeloOrganizerReader
// stub — never from a backend-side record — matching this repo's existing
// convention of injecting chain reads for testability (see chainVerify.ts's
// CircleVerifier, used the same way in api.test.ts).

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
import type { CeloOrganizerReader, CeloOrganizerReadResult } from "../src/celoChainVerify.js";

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

/** A configurable stand-in for reading organizer() from a real Celo node. */
class StubCeloOrganizerReader implements CeloOrganizerReader {
  private readonly byContract = new Map<string, CeloOrganizerReadResult>();

  set(circleContract: string, result: CeloOrganizerReadResult): void {
    this.byContract.set(circleContract.toLowerCase(), result);
  }

  async readOrganizer(circleContract: string): Promise<CeloOrganizerReadResult> {
    return this.byContract.get(circleContract.toLowerCase()) ?? { ok: false, reason: "no_code" };
  }
}

const CIRCLE = "0x00000000000000000000000000000000000123";
const CIRCLE_CONTRACT = "0x00000000000000000000000000000000000000ab";
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000cd";
const CHAIN = "celo:42220";
const MEMBER_1 = "m1";
const MEMBER_2 = "m2";
const ACCOUNT_A = `celo:0x00000000000000000000000000000000000000aa`;
const ACCOUNT_B = `celo:0x00000000000000000000000000000000000000bb`;

const ORGANIZER = Wallet.createRandom();
const OTHER_WALLET = Wallet.createRandom();

/** A reader where CIRCLE_CONTRACT's real, on-chain organizer is ORGANIZER. */
function legitimateReader(): StubCeloOrganizerReader {
  const reader = new StubCeloOrganizerReader();
  reader.set(CIRCLE_CONTRACT, { ok: true, organizer: ORGANIZER.address });
  return reader;
}

function buildApp(
  store: Store,
  opts: { now?: () => number; celoNonces?: CeloAuthNonceStore; celoOrganizerReader?: CeloOrganizerReader } = {},
): Express {
  return createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    verifier: new StubVerifier(),
    circleVerifier: new AlwaysAbsent(),
    now: opts.now,
    celoNonces: opts.celoNonces,
    celoOrganizerReader: opts.celoOrganizerReader ?? legitimateReader(),
  });
}

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
    circleContract: CIRCLE_CONTRACT,
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
  overrides: { circleId?: string; circleContract?: string; memberRef?: string; wallet?: Wallet } = {},
): Promise<request.Response> {
  const wallet = overrides.wallet ?? ORGANIZER;
  const circleId = overrides.circleId ?? CIRCLE;
  const circleContract = overrides.circleContract ?? CIRCLE_CONTRACT;
  const memberRef = overrides.memberRef ?? MEMBER_1;
  const authorization = await signOrganizerAuth(wallet, { circleId, circleContract, memberRef });
  return request(app)
    .post("/api/account-bindings/invites")
    .send({ circleId, circleContract, memberRef, chain: CHAIN, authorization });
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
      .send({
        circleId: CIRCLE,
        circleContract: CIRCLE_CONTRACT,
        memberRef: MEMBER_1,
        chain: CHAIN,
        authorization,
        seedPhrase: "x",
      })
      .expect(400)
      .expect((res) => expect(res.body.error).toBe("forbidden_field"));
  });
});

describe("on-chain Celo organizer authorization on POST /api/account-bindings/invites", () => {
  it("mints an invite when the real/mock RPC organizer read matches the signer", async () => {
    const app = buildApp(new MemoryStore());
    const res = await mintInvite(app);
    expect(res.status).toBe(200);
  });

  it("rejects a missing authorization", async () => {
    const app = buildApp(new MemoryStore());
    await request(app)
      .post("/api/account-bindings/invites")
      .send({ circleId: CIRCLE, circleContract: CIRCLE_CONTRACT, memberRef: MEMBER_1, chain: CHAIN })
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
        circleContract: CIRCLE_CONTRACT,
        memberRef: MEMBER_1,
        chain: CHAIN,
        authorization: { ...good, signature: `0x${"00".repeat(65)}` },
      })
      .expect(401)
      .expect((res) => expect(res.body.error).toBe("bad_signature"));
  });

  it("rejects a client-supplied organizer mismatch: signer differs from the claimed organizer field", async () => {
    const app = buildApp(new MemoryStore());
    // Sign as OTHER_WALLET but claim to be ORGANIZER in the message.
    const wrongSigner = await signOrganizerAuth(OTHER_WALLET, { organizer: ORGANIZER.address });
    const res = await mintInviteRaw(app, wrongSigner);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("wrong_signer");
  });

  it("rejects a wrong signer against the real on-chain organizer, even with a fully self-consistent signature", async () => {
    const app = buildApp(new MemoryStore());
    // OTHER_WALLET signs a perfectly valid, internally consistent
    // authorization for itself — recovery succeeds and matches the claimed
    // organizer field. It is simply not who CIRCLE_CONTRACT.organizer()
    // actually is.
    const authorization = await signOrganizerAuth(OTHER_WALLET);
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("wrong_signer");
  });

  it("rejects a contract mismatch: a signature signed for a different circleContract", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, { circleContract: OTHER_CONTRACT });
    // Submitted against CIRCLE_CONTRACT, not the contract the signature
    // actually names — recovery against CIRCLE_CONTRACT's hash yields an
    // unrelated address, not a validated-but-wrong claim.
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(["bad_signature", "wrong_signer"]).toContain(res.body.error);
  });

  it("rejects a circle mismatch: a signature signed for a different circleId", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, { circleId: "0xsome-other-circle" });
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(["bad_signature", "wrong_signer"]).toContain(res.body.error);
  });

  it("rejects a wrong memberRef: a signature signed for a different member", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, { memberRef: MEMBER_2 });
    const res = await mintInviteRaw(app, authorization, { memberRef: MEMBER_1 });
    expect(res.status).toBe(401);
    expect(["bad_signature", "wrong_signer"]).toContain(res.body.error);
  });

  it("rejects a wrong EIP-712 domain chain id", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, {}, { chainId: 1 });
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(["bad_signature", "wrong_signer"]).toContain(res.body.error);
  });

  it("rejects a no-code contract (nothing deployed at circleContract)", async () => {
    const reader = new StubCeloOrganizerReader();
    reader.set(CIRCLE_CONTRACT, { ok: false, reason: "no_code" });
    const app = buildApp(new MemoryStore(), { celoOrganizerReader: reader });
    const authorization = await signOrganizerAuth(ORGANIZER);
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("no_contract_code");
  });

  it("rejects when the organizer() call itself fails/reverts", async () => {
    const reader = new StubCeloOrganizerReader();
    reader.set(CIRCLE_CONTRACT, { ok: false, reason: "organizer_call_failed" });
    const app = buildApp(new MemoryStore(), { celoOrganizerReader: reader });
    const authorization = await signOrganizerAuth(ORGANIZER);
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("organizer_call_failed");
  });

  it("rejects a malformed organizer() response", async () => {
    const reader = new StubCeloOrganizerReader();
    reader.set(CIRCLE_CONTRACT, { ok: false, reason: "malformed_organizer_response" });
    const app = buildApp(new MemoryStore(), { celoOrganizerReader: reader });
    const authorization = await signOrganizerAuth(ORGANIZER);
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("malformed_organizer_response");
  });

  it("fails closed on RPC failure (does not fall back to trusting the client)", async () => {
    const reader = new StubCeloOrganizerReader();
    reader.set(CIRCLE_CONTRACT, { ok: false, reason: "rpc_unavailable" });
    const app = buildApp(new MemoryStore(), { celoOrganizerReader: reader });
    const authorization = await signOrganizerAuth(ORGANIZER);
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("rpc_unavailable");
  });

  it("fails closed when the RPC reports the wrong chain", async () => {
    const reader = new StubCeloOrganizerReader();
    reader.set(CIRCLE_CONTRACT, { ok: false, reason: "wrong_chain" });
    const app = buildApp(new MemoryStore(), { celoOrganizerReader: reader });
    const authorization = await signOrganizerAuth(ORGANIZER);
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("wrong_chain");
  });

  it("rejects an expired signature", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, {
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    });
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("expired_authorization");
  });

  it("rejects an authorization whose validity window is unreasonably long", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, {
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    });
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authorization_window_too_long");
  });

  it("rejects a replayed nonce: the same signed authorization cannot be spent twice", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER, { memberRef: MEMBER_1 });
    const first = await mintInviteRaw(app, authorization);
    expect(first.status).toBe(200);
    // The exact same request again. The signature still recovers correctly
    // and the on-chain organizer read would still succeed — but the nonce it
    // carries was already spent, so this must fail on that basis
    // specifically, not on "already_invited" (the now-unreachable store call).
    const second = await mintInviteRaw(app, authorization);
    expect(second.status).toBe(401);
    expect(second.body.error).toBe("reused_nonce");
  });

  it("concurrent requests do not bypass nonce protection: firing the same signed authorization twice at once only lets one through", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(ORGANIZER);
    const [a, b] = await Promise.all([mintInviteRaw(app, authorization), mintInviteRaw(app, authorization)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("unauthorized organizer cannot mint an invite for a circle another wallet actually organizes", async () => {
    const app = buildApp(new MemoryStore()); // legitimateReader(): CIRCLE_CONTRACT's organizer is ORGANIZER
    const legit = await mintInvite(app, { memberRef: MEMBER_1 });
    expect(legit.status).toBe(200);

    // OTHER_WALLET signs a perfectly valid authorization for itself, for the
    // same circle contract, a different member. The signature is genuine —
    // this is not a signature-shape failure — but OTHER_WALLET is not what
    // CIRCLE_CONTRACT.organizer() returns.
    const authorization = await signOrganizerAuth(OTHER_WALLET, { memberRef: MEMBER_2 });
    const res = await mintInviteRaw(app, authorization, { memberRef: MEMBER_2 });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("wrong_signer");
  });

  it("does not leak the on-chain organizer's address in a wrong_signer failure", async () => {
    const app = buildApp(new MemoryStore());
    const authorization = await signOrganizerAuth(OTHER_WALLET);
    const res = await mintInviteRaw(app, authorization);
    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ORGANIZER.address.toLowerCase());
    expect(body).not.toContain(ORGANIZER.address);
  });
});

describe("MemoryStore hasAccountBindInvite", () => {
  it("is false before an invite is minted, true after, regardless of acceptance", async () => {
    const store = new MemoryStore();
    expect(await store.hasAccountBindInvite(CIRCLE, MEMBER_1)).toBe(false);

    const invite = await store.createAccountBindInvite({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN });
    if (!invite.ok) throw new Error("unreachable");
    expect(await store.hasAccountBindInvite(CIRCLE, MEMBER_1)).toBe(true);

    await store.acceptAccountBind({ inviteToken: invite.inviteToken, account: ACCOUNT_A });
    expect(await store.hasAccountBindInvite(CIRCLE, MEMBER_1)).toBe(true);
  });

  it("does not leak across members or circles", async () => {
    const store = new MemoryStore();
    await store.createAccountBindInvite({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN });
    expect(await store.hasAccountBindInvite(CIRCLE, MEMBER_2)).toBe(false);
    expect(await store.hasAccountBindInvite("0xanother-circle", MEMBER_1)).toBe(false);
  });
});

describe("POST /api/account-bindings/status (organizer binding-status read)", () => {
  async function signStatusAuth(wallet: Wallet, overrides: Partial<CeloAuthorizationMessage> = {}) {
    return signOrganizerAuth(wallet, { action: CELO_AUTH_ACTIONS.accountBindingStatus, ...overrides });
  }

  async function statusRequest(
    app: Express,
    authorization: { organizer: string; nonce: string; expiresAt: number; signature: string },
    overrides: { circleId?: string; circleContract?: string; memberRef?: string } = {},
  ): Promise<request.Response> {
    return request(app)
      .post("/api/account-bindings/status")
      .send({
        circleId: overrides.circleId ?? CIRCLE,
        circleContract: overrides.circleContract ?? CIRCLE_CONTRACT,
        memberRef: overrides.memberRef ?? MEMBER_1,
        authorization,
      });
  }

  it("reports none for a member with no invite and no binding", async () => {
    const app = buildApp(new MemoryStore());
    const auth = await signStatusAuth(ORGANIZER);
    const res = await statusRequest(app, auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("none");
  });

  it("reports invited once the organizer has minted an invite but it is unaccepted", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    await store.createAccountBindInvite({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN });

    const auth = await signStatusAuth(ORGANIZER);
    const res = await statusRequest(app, auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("invited");
  });

  it("reports bound once the member has accepted, and never discloses the account", async () => {
    const store = new MemoryStore();
    const app = buildApp(store);
    const invite = await store.createAccountBindInvite({ circleId: CIRCLE, memberRef: MEMBER_1, chain: CHAIN });
    if (!invite.ok) throw new Error("unreachable");
    await store.acceptAccountBind({ inviteToken: invite.inviteToken, account: ACCOUNT_A });

    const auth = await signStatusAuth(ORGANIZER);
    const res = await statusRequest(app, auth);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("bound");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ACCOUNT_A);
    expect(body.toLowerCase()).not.toContain("0x00000000000000000000000000000000000000aa");
  });

  it("rejects a non-organizer wallet", async () => {
    const app = buildApp(new MemoryStore()); // legitimateReader(): organizer is ORGANIZER
    const auth = await signStatusAuth(OTHER_WALLET);
    const res = await statusRequest(app, auth);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("wrong_signer");
  });

  it("a signature minted for the invite action cannot be spent as a status read", async () => {
    const app = buildApp(new MemoryStore());
    const inviteAuth = await signOrganizerAuth(ORGANIZER); // default action: accountBindingInvite
    const res = await statusRequest(app, inviteAuth);
    expect(res.status).toBe(401);
    expect(["bad_signature", "wrong_signer"]).toContain(res.body.error);
  });

  it("rejects a missing authorization", async () => {
    const app = buildApp(new MemoryStore());
    const res = await request(app)
      .post("/api/account-bindings/status")
      .send({ circleId: CIRCLE, circleContract: CIRCLE_CONTRACT, memberRef: MEMBER_1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("fails closed on RPC/organizer-read failure rather than reporting a status", async () => {
    const reader = new StubCeloOrganizerReader();
    reader.set(CIRCLE_CONTRACT, { ok: false, reason: "rpc_unavailable" });
    const app = buildApp(new MemoryStore(), { celoOrganizerReader: reader });
    const auth = await signStatusAuth(ORGANIZER);
    const res = await statusRequest(app, auth);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("rpc_unavailable");
  });
});

/** Submits an invite-mint request with an already-built authorization object, fully resolved (see mintInvite's note on why this isn't chained with `.expect`). */
async function mintInviteRaw(
  app: Express,
  authorization: { organizer: string; nonce: string; expiresAt: number; signature: string },
  overrides: { circleId?: string; circleContract?: string; memberRef?: string } = {},
): Promise<request.Response> {
  return request(app)
    .post("/api/account-bindings/invites")
    .send({
      circleId: overrides.circleId ?? CIRCLE,
      circleContract: overrides.circleContract ?? CIRCLE_CONTRACT,
      memberRef: overrides.memberRef ?? MEMBER_1,
      chain: CHAIN,
      authorization,
    });
}
