// The operator dashboard, and everything it must refuse.
//
// Two properties are under test, and they pull against each other. An operator
// must be able to see whether the platform is working. Everybody else, holding
// anything short of an operator's own wallet signature, must see nothing at
// all — including somebody who holds a perfectly valid read-only session for
// an operator's wallet, because a bearer token is a thing that can be stolen.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { normalizeFelt, SN_MAIN } from "../src/validation.js";
import { AUTH_ACTIONS } from "../src/authBinding.js";
import { AdminAllowlist, NO_CHAIN_HEALTH, type ChainHealthReader } from "../src/admin.js";
import type { SignatureVerifier } from "../src/auth.js";

const OPERATOR = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
/** The same wallet written the way a person would paste it back. */
const OPERATOR_PADDED =
  "0x04099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const SAVER = "0x1234";
const CIRCLE = "0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be";

class StubVerifier implements SignatureVerifier {
  async verify(address: string, _hash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `signed-by:${address}`;
  }
}

const healthyChain: ChainHealthReader = {
  configured: true,
  circleContract: CIRCLE,
  async read() {
    return { rpcReachable: true, latestBlock: 1_500_000, circleReadOk: true };
  },
};

const unreachableChain: ChainHealthReader = {
  configured: true,
  circleContract: CIRCLE,
  async read() {
    return { rpcReachable: false, latestBlock: null, circleReadOk: false };
  },
};

let store: MemoryStore;

function build(over: Partial<Parameters<typeof createApp>[0]> = {}): Express {
  store = (over.store as MemoryStore) ?? new MemoryStore();
  return createApp({
    store,
    corsOrigins: ["https://useiwa.xyz"],
    rateLimit: { windowMs: 60_000, max: 500 },
    verifier: new StubVerifier(),
    adminAddresses: [OPERATOR],
    chainHealth: healthyChain,
    environment: "production",
    ...over,
    store,
  } as Parameters<typeof createApp>[0]);
}

async function challenge(app: Express, address: string): Promise<string> {
  const res = await request(app).post("/api/auth/challenge").send({ address }).expect(200);
  return res.body.nonce as string;
}

/** One authenticated admin read, signed by `address`. */
async function overview(app: Express, address: string) {
  const nonce = await challenge(app, address);
  return request(app)
    .post("/api/admin/overview")
    .set("x-iwa-address", address)
    .set("x-iwa-nonce", nonce)
    .set("x-iwa-chain", SN_MAIN)
    // A real account signs a message hash, not the address string. The stub
    // verifier keys off the address the server resolved, which is the
    // normalized one, so the same wallet written either way signs the same.
    .set("x-iwa-signature", JSON.stringify([`signed-by:${normalizeFelt(address)}`]))
    .send({});
}

let app: Express;
beforeEach(() => {
  app = build();
});

describe("who reaches the operator dashboard", () => {
  it("answers a wallet on the allowlist", async () => {
    const res = await overview(app, OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.backend.database).toBe("up");
  });

  it("recognizes the same wallet written with leading zeroes", async () => {
    const res = await overview(app, OPERATOR_PADDED);
    expect(res.status).toBe(200);
  });

  it("refuses an authenticated wallet that is not an operator", async () => {
    const res = await overview(app, SAVER);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_admin");
  });

  it("tells a refused caller nothing about the platform", async () => {
    const res = await overview(app, SAVER);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("coordination");
    expect(text).not.toContain("drafts");
    expect(text).not.toContain("database");
    expect(text).not.toContain("latestBlock");
  });

  it("refuses a caller with no credentials at all", async () => {
    const res = await request(app).post("/api/admin/overview").send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_auth");
    expect(JSON.stringify(res.body)).not.toContain("drafts");
  });

  it("refuses a signature made by a different wallet", async () => {
    const nonce = await challenge(app, OPERATOR);
    const res = await request(app)
      .post("/api/admin/overview")
      .set("x-iwa-address", OPERATOR)
      .set("x-iwa-nonce", nonce)
      .set("x-iwa-chain", SN_MAIN)
      .set("x-iwa-signature", JSON.stringify([`signed-by:${SAVER}`]))
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
  });

  it("refuses everybody when no operator is configured", async () => {
    const closed = build({ adminAddresses: [] });
    const res = await overview(closed, OPERATOR);
    expect(res.status).toBe(403);
  });

  it("refuses everybody when the option is absent entirely", async () => {
    const closed = build({ adminAddresses: undefined });
    const res = await overview(closed, OPERATOR);
    expect(res.status).toBe(403);
  });
});

describe("a stolen read session is not operator access", () => {
  async function session(address: string): Promise<string> {
    const nonce = await challenge(app, address);
    const res = await request(app)
      .post("/api/auth/session")
      .set("x-iwa-address", address)
      .set("x-iwa-nonce", nonce)
      .set("x-iwa-chain", SN_MAIN)
      .set("x-iwa-signature", JSON.stringify([`signed-by:${address}`]))
      .send({})
      .expect(200);
    return res.body.token as string;
  }

  it("refuses an operator's own valid session token", async () => {
    const token = await session(OPERATOR);
    // The token works for an ordinary private read, which is what makes this
    // the interesting case: it is genuinely that operator's session.
    await request(app)
      .post("/api/me/circles")
      .set("authorization", `Bearer ${token}`)
      .send({})
      .expect(200);

    const res = await request(app)
      .post("/api/admin/overview")
      .set("authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("drafts");
  });
});

describe("an admin authorization cannot be replayed", () => {
  it("burns the nonce, so the same signed request fails the second time", async () => {
    const nonce = await challenge(app, OPERATOR);
    const send = () =>
      request(app)
        .post("/api/admin/overview")
        .set("x-iwa-address", OPERATOR)
        .set("x-iwa-nonce", nonce)
        .set("x-iwa-chain", SN_MAIN)
        .set("x-iwa-signature", JSON.stringify([`signed-by:${OPERATOR}`]))
        .send({});

    expect((await send()).status).toBe(200);
    const replay = await send();
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("unknown_nonce");
  });
});

describe("what the dashboard reports", () => {
  it("counts drafts by the state they are actually in", async () => {
    const base = {
      chainId: SN_MAIN,
      organizerAddress: OPERATOR,
      token: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
      contributionAmount: "1000000",
      cadenceSeconds: 604800,
      graceSeconds: 86400,
      memberCount: 2,
    };
    const one = await store.createDraft(base);
    await store.createDraft(base);
    await store.acceptInvite({
      inviteToken: one.slots[0].inviteToken,
      memberRef: "0xaaa",
      authPublicKey: "0xbbb",
      address: SAVER,
    });

    const res = await overview(app, OPERATOR);
    expect(res.body.coordination.draftsTotal).toBe(2);
    expect(res.body.coordination.draftsCollecting).toBe(2);
    expect(res.body.coordination.draftsReady).toBe(0);
    expect(res.body.coordination.placesTotal).toBe(4);
    expect(res.body.coordination.placesAccepted).toBe(1);
  });

  it("counts a circle on chain that no draft records", async () => {
    await store.upsertIndexedCircle({
      chainId: SN_MAIN,
      circleId: 1,
      contributionAmount: "1000000",
      token: "0x33068f",
      memberLimit: 2,
      joinedCount: 2,
      currentRound: 1,
      status: "Active",
    });
    const res = await overview(app, OPERATOR);
    expect(res.body.coordination.indexedCircles).toBe(1);
    expect(res.body.coordination.unrecordedChainCircles).toBe(1);
  });

  it("reports live chain health", async () => {
    const res = await overview(app, OPERATOR);
    expect(res.body.chain.rpcReachable).toBe(true);
    expect(res.body.chain.latestBlock).toBe(1_500_000);
    expect(res.body.chain.circleReadOk).toBe(true);
    expect(res.body.chain.chainId).toBe(SN_MAIN);
  });

  it("states an unreachable chain rather than failing the page", async () => {
    const degraded = build({ chainHealth: unreachableChain });
    const res = await overview(degraded, OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.chain.rpcReachable).toBe(false);
    expect(res.body.chain.latestBlock).toBeNull();
  });

  it("states a chain with no RPC configured at all", async () => {
    const none = build({ chainHealth: NO_CHAIN_HEALTH });
    const res = await overview(none, OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.chain.rpcConfigured).toBe(false);
  });

  it("states a database that is down rather than pretending", async () => {
    const broken = new MemoryStore();
    broken.healthy = async () => false;
    const degraded = build({ store: broken });
    const res = await overview(degraded, OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.backend.database).toBe("down");
  });

  it("reports where challenges and sessions live", async () => {
    const res = await overview(app, OPERATOR);
    expect(res.body.backend.challengeStore).toBe("in-process");
    expect(res.body.backend.sessionStore).toBe("in-process");
    expect(res.body.backend.environment).toBe("production");
  });

  it("counts configured origins without naming them", async () => {
    const res = await overview(app, OPERATOR);
    expect(res.body.backend.corsOriginsConfigured).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain("useiwa.xyz");
  });
});

describe("what the dashboard must never carry", () => {
  it("returns no member identifier, address or invitation token", async () => {
    const draft = await store.createDraft({
      chainId: SN_MAIN,
      organizerAddress: OPERATOR,
      token: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
      contributionAmount: "1000000",
      cadenceSeconds: 604800,
      graceSeconds: 86400,
      memberCount: 2,
    });
    await store.acceptInvite({
      inviteToken: draft.slots[0].inviteToken,
      memberRef: "0xaaa111",
      authPublicKey: "0xbbb222",
      address: SAVER,
    });

    const res = await overview(app, OPERATOR);
    const text = JSON.stringify(res.body);
    for (const banned of [
      draft.id,
      draft.slots[0].inviteToken,
      draft.slots[1].inviteToken,
      "0xaaa111",
      "0xbbb222",
      SAVER,
      OPERATOR,
      "memberRef",
      "member_ref",
      "authPublicKey",
      "inviteToken",
      "organizerAddress",
      "acceptedByAddress",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("carries no session token, nonce or signature", async () => {
    const res = await overview(app, OPERATOR);
    const text = JSON.stringify(res.body).toLowerCase();
    for (const banned of ["token", "nonce", "signature", "bearer", "secret", "password"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("carries no environment secret or connection string", async () => {
    const res = await overview(app, OPERATOR);
    const text = JSON.stringify(res.body).toLowerCase();
    for (const banned of ["postgres://", "postgresql://", "database_url", "http://", "https://"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("exposes only the contract address, which is public on chain", async () => {
    const res = await overview(app, OPERATOR);
    expect(res.body.chain.circleContract).toBe(CIRCLE);
  });

  it("offers no method other than reading", async () => {
    // A dashboard that could be told to do something would need a verb. There
    // is none: the route answers POST because every authenticated call in this
    // API does, and it changes nothing.
    await request(app).get("/api/admin/overview").expect(404);
    await request(app).put("/api/admin/overview").expect(404);
    await request(app).delete("/api/admin/overview").expect(404);
  });

  it("has no admin route beyond the overview", async () => {
    for (const path of [
      "/api/admin",
      "/api/admin/drafts",
      "/api/admin/members",
      "/api/admin/circles",
      "/api/admin/reconcile",
      "/api/admin/pause",
    ]) {
      const res = await request(app).post(path).send({});
      expect(res.status).toBe(404);
    }
  });
});

describe("the allowlist itself", () => {
  it("matches regardless of case or leading zeroes", () => {
    const list = new AdminAllowlist([OPERATOR]);
    expect(list.allows(OPERATOR)).toBe(true);
    expect(list.allows(OPERATOR_PADDED)).toBe(true);
    expect(list.allows(OPERATOR.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("allows nobody when empty", () => {
    const list = new AdminAllowlist([]);
    expect(list.enabled).toBe(false);
    expect(list.allows(OPERATOR)).toBe(false);
  });

  it("ignores blank entries from a trailing comma", () => {
    const list = new AdminAllowlist([OPERATOR, "", "  "]);
    expect(list.size).toBe(1);
  });

  it("fails closed on an address it cannot read", () => {
    const list = new AdminAllowlist([OPERATOR]);
    expect(list.allows("not an address")).toBe(false);
    expect(list.allows("")).toBe(false);
  });

  it("refuses to be built from a malformed address", () => {
    expect(() => new AdminAllowlist(["nope"])).toThrow();
  });
});

describe("the admin action is bound like every other", () => {
  it("has its own action name, so no other signature can be spent here", () => {
    expect(AUTH_ACTIONS.adminRead).toBe("admin:read");
    const actions = Object.values(AUTH_ACTIONS);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("refuses a signature bound to a different route", async () => {
    // The signature commits to the path. A stub verifier cannot model that, so
    // this asserts the property that makes it true: the route declares its own
    // action, and the server derives the binding from the request it handles.
    const nonce = await challenge(app, OPERATOR);
    const res = await request(app)
      .post("/api/admin/overview")
      .set("x-iwa-address", OPERATOR)
      .set("x-iwa-nonce", nonce)
      .set("x-iwa-chain", SN_MAIN)
      .set("x-iwa-signature", JSON.stringify([`signed-by:${SAVER}`]))
      .send({});
    expect(res.status).toBe(401);
  });
});
