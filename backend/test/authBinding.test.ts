// What a signature is allowed to authorize.
//
// The vulnerability these pin: a signature said only "this wallet approves an
// Iwa organizer action", so one obtained for a harmless read authorized a
// reorder just as well. Challenges are issued to anyone who asks for an
// address, so a page that was not Iwa could obtain one, have a wallet sign that
// sentence, and spend it here.
//
// Each test below is one way of spending a signature on something other than
// what it was obtained for.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";
import { ChallengeStore, CHALLENGE_TTL_MS, type SignatureVerifier } from "../src/auth.js";
import {
  AUTH_ACTIONS,
  authorizationHash,
  canonicalJson,
  hashBody,
  hashResource,
  MAX_ACTION_LENGTH,
  type AuthorizationBinding,
} from "../src/authBinding.js";
import type { CircleVerifier, DiscoveryOutcome, VerifyOutcome } from "../src/chainVerify.js";

/**
 * Stands in for the account contract, and does the one thing that matters: it
 * accepts a signature only over the exact hash the wallet signed. A real
 * account behaves the same way, which is why binding the message is the fix.
 */
class HashBoundVerifier implements SignatureVerifier {
  async verify(address: string, messageHash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `${address}:${messageHash}`;
  }
}

class AlwaysVerifies implements CircleVerifier {
  async verifyCreated(): Promise<VerifyOutcome> {
    return { status: "verified" };
  }
  async findCircleForDraft(): Promise<DiscoveryOutcome> {
    return { status: "found", circleId: 9 };
  }
}

const ORGANIZER = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const STRANGER = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const ALICE = "0x45325587024dc0326f740bc5268c766620a4a51dbdec04894256480aecbae0f";
const BOB = "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";
const KEY_A = "0x6a77859939dd3948dd673b07b0d0929af6942731fa4815d152190bdeddb658d";
const KEY_B = "0x94edb9a04dbe7a9160830e8d755af5ee6becf8a82ad12ad5eb64509fbe9f41";

const DRAFT_BODY = {
  chainId: SN_MAIN,
  organizerAddress: ORGANIZER,
  token: USDC,
  contributionAmount: "10000000",
  cadenceSeconds: 604800,
  graceSeconds: 86400,
  memberCount: 2,
};

let app: Express;
let store: MemoryStore;
let clock: number;
let challenges: ChallengeStore;

beforeEach(() => {
  clock = Date.now();
  store = new MemoryStore();
  challenges = new ChallengeStore(() => clock);
  app = createApp({
    store,
    corsOrigins: ["https://useiwa.xyz"],
    rateLimit: { windowMs: 60_000, max: 2000 },
    verifier: new HashBoundVerifier(),
    circleVerifier: new AlwaysVerifies(),
    challenges,
    now: () => clock,
  });
});

/** A fresh nonce for an address. Anyone may ask; that is the point. */
async function nonceFor(address: string): Promise<string> {
  const r = await request(app).post("/api/auth/challenge").send({ address }).expect(200);
  return r.body.nonce as string;
}

/** Signs exactly one operation, the way the client is meant to. */
function sign(
  address: string,
  nonce: string,
  action: string,
  method: string,
  path: string,
  body: unknown,
  chainId = SN_MAIN,
) {
  const binding = {
    action,
    method,
    resourceHash: hashResource(path),
    bodyHash: hashBody(body),
    nonce,
    chainId,
  } as AuthorizationBinding;
  const messageHash = authorizationHash(binding, address);
  return {
    "x-iwa-address": address,
    "x-iwa-nonce": nonce,
    "x-iwa-chain": chainId,
    "x-iwa-signature": JSON.stringify([`${address}:${messageHash}`]),
  };
}

/** Signs and sends one authenticated call. */
async function authed(
  address: string,
  action: string,
  method: "post" | "get",
  path: string,
  body: unknown = {},
) {
  const headers = sign(address, await nonceFor(address), action, method, path, body);
  return request(app)[method](path).set(headers).send(body as object);
}

async function newDraft() {
  const res = await authed(ORGANIZER, AUTH_ACTIONS.draftCreate, "post", "/api/drafts", DRAFT_BODY);
  expect(res.status).toBe(201);
  return res.body;
}

async function readyDraft() {
  const draft = await newDraft();
  for (const [token, ref, key] of [
    [draft.slots[0].inviteToken, ALICE, KEY_A],
    [draft.slots[1].inviteToken, BOB, KEY_B],
  ]) {
    await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: token, memberRef: ref, authPublicKey: key, address: ref })
      .expect(200);
  }
  return draft;
}

describe("a signature authorizes one operation and no other", () => {
  it("PROOF: a signature for a read cannot be spent on a reorder", async () => {
    const draft = await newDraft();
    const nonce = await nonceFor(ORGANIZER);

    // Obtained for the harmless read the organizer believed they approved.
    const forRead = sign(
      ORGANIZER,
      nonce,
      AUTH_ACTIONS.draftsList,
      "post",
      "/api/drafts/mine",
      {},
    );

    const body = {
      organizerAddress: ORGANIZER,
      order: [draft.slots[1].slotId, draft.slots[0].slotId],
    };
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(forRead)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
  });

  it("refuses a signature for one action used on any other", async () => {
    const draft = await readyDraft();
    const attempts: [string, "post", string, object][] = [
      [AUTH_ACTIONS.draftReadOrganizer, "post", `/api/drafts/${draft.id}/organizer-view`, {}],
      [
        AUTH_ACTIONS.draftMarkCreated,
        "post",
        `/api/drafts/${draft.id}/created`,
        { organizerAddress: ORGANIZER, circleId: 9, txHash: "0xabc" },
      ],
      [AUTH_ACTIONS.draftReconcile, "post", `/api/drafts/${draft.id}/reconcile`, { organizerAddress: ORGANIZER }],
      [AUTH_ACTIONS.associationsList, "post", "/api/me/circles", {}],
      [AUTH_ACTIONS.invitationsList, "post", "/api/me/invitations", {}],
    ];

    for (const [rightAction, method, path, body] of attempts) {
      // Signed for the wrong action, everything else correct.
      const headers = sign(
        ORGANIZER,
        await nonceFor(ORGANIZER),
        AUTH_ACTIONS.draftsList,
        method,
        path,
        body,
      );
      const res = await request(app)[method](path).set(headers).send(body);
      expect(res.status, `${rightAction} accepted a drafts:list signature`).toBe(401);
    }
  });

  it("PROOF: a signature for one draft cannot be spent on another", async () => {
    const mine = await newDraft();
    const other = await newDraft();
    const body = {
      organizerAddress: ORGANIZER,
      order: [other.slots[1].slotId, other.slots[0].slotId],
    };

    // Correct action, correct method, correct body: only the resource differs.
    const headers = sign(
      ORGANIZER,
      await nonceFor(ORGANIZER),
      AUTH_ACTIONS.draftReorder,
      "post",
      `/api/drafts/${mine.id}/order`,
      body,
    );
    const res = await request(app).post(`/api/drafts/${other.id}/order`).set(headers).send(body);
    expect(res.status).toBe(401);
  });

  it("PROOF: a signature for one method cannot be spent on another", async () => {
    const draft = await newDraft();
    const headers = sign(
      ORGANIZER,
      await nonceFor(ORGANIZER),
      AUTH_ACTIONS.draftReadOrganizer,
      "GET",
      `/api/drafts/${draft.id}/organizer-view`,
      {},
    );
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/organizer-view`)
      .set(headers)
      .send({});
    expect(res.status).toBe(401);
  });

  it("PROOF: changing one field of the body invalidates the signature", async () => {
    const draft = await readyDraft();
    const signedBody = { organizerAddress: ORGANIZER, circleId: 9, txHash: "0xabc" };
    const headers = sign(
      ORGANIZER,
      await nonceFor(ORGANIZER),
      AUTH_ACTIONS.draftMarkCreated,
      "post",
      `/api/drafts/${draft.id}/created`,
      signedBody,
    );

    const tampered = { ...signedBody, circleId: 4321 };
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set(headers)
      .send(tampered);
    expect(res.status).toBe(401);

    // The draft is untouched by the attempt.
    const after = await request(app).get(`/api/drafts/${draft.id}`).expect(200);
    expect(after.body.circleId).toBeNull();
  });

  it("accepts the same body with its keys written in another order", async () => {
    const draft = await readyDraft();
    const signedBody = { organizerAddress: ORGANIZER, circleId: 9, txHash: "0xabc" };
    const headers = sign(
      ORGANIZER,
      await nonceFor(ORGANIZER),
      AUTH_ACTIONS.draftMarkCreated,
      "post",
      `/api/drafts/${draft.id}/created`,
      signedBody,
    );

    // Same meaning, different key order on the wire.
    const reordered = { txHash: "0xabc", organizerAddress: ORGANIZER, circleId: 9 };
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set(headers)
      .send(reordered);
    expect(res.status).toBe(200);
  });

  it("refuses the same array written in another order, because order means something", async () => {
    const draft = await readyDraft();
    const ids = draft.slots.map((s: { slotId: string }) => s.slotId);
    const signedBody = { organizerAddress: ORGANIZER, order: [ids[0], ids[1]] };
    const headers = sign(
      ORGANIZER,
      await nonceFor(ORGANIZER),
      AUTH_ACTIONS.draftReorder,
      "post",
      `/api/drafts/${draft.id}/order`,
      signedBody,
    );

    const res = await request(app)
      .post(`/api/drafts/${draft.id}/order`)
      .set(headers)
      .send({ organizerAddress: ORGANIZER, order: [ids[1], ids[0]] });
    expect(res.status).toBe(401);
  });
});

describe("the properties that were already right stay right", () => {
  it("refuses a nonce that has been spent", async () => {
    const nonce = await nonceFor(ORGANIZER);
    const headers = sign(ORGANIZER, nonce, AUTH_ACTIONS.draftsList, "post", "/api/drafts/mine", {});
    await request(app).post("/api/drafts/mine").set(headers).send({}).expect(200);
    const again = await request(app).post("/api/drafts/mine").set(headers).send({});
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("unknown_nonce");
  });

  it("refuses a nonce that has expired", async () => {
    const nonce = await nonceFor(ORGANIZER);
    clock += CHALLENGE_TTL_MS + 1_000;
    const headers = sign(ORGANIZER, nonce, AUTH_ACTIONS.draftsList, "post", "/api/drafts/mine", {});
    const res = await request(app).post("/api/drafts/mine").set(headers).send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("expired_nonce");
  });

  it("refuses a signature bound to another chain", async () => {
    const nonce = await nonceFor(ORGANIZER);
    const headers = sign(
      ORGANIZER,
      nonce,
      AUTH_ACTIONS.draftsList,
      "post",
      "/api/drafts/mine",
      {},
      "0x534e5f5345504f4c4941",
    );
    const res = await request(app).post("/api/drafts/mine").set(headers).send({});
    expect(res.status).toBe(401);
  });

  it("refuses a nonce issued to somebody else", async () => {
    const theirs = await nonceFor(STRANGER);
    const headers = sign(ORGANIZER, theirs, AUTH_ACTIONS.draftsList, "post", "/api/drafts/mine", {});
    const res = await request(app).post("/api/drafts/mine").set(headers).send({});
    expect(res.status).toBe(401);
  });

  it("refuses a stranger acting on somebody else's draft", async () => {
    const draft = await newDraft();
    const res = await authed(
      STRANGER,
      AUTH_ACTIONS.draftReadOrganizer,
      "post",
      `/api/drafts/${draft.id}/organizer-view`,
      {},
    );
    expect(res.status).toBe(403);
  });

  it("refuses missing or malformed auth headers", async () => {
    const draft = await newDraft();
    const path = `/api/drafts/${draft.id}/organizer-view`;
    await request(app).post(path).send({}).expect(401);
    await request(app)
      .post(path)
      .set({ "x-iwa-address": ORGANIZER, "x-iwa-nonce": "0x1", "x-iwa-chain": SN_MAIN })
      .send({})
      .expect(401);
    await request(app)
      .post(path)
      .set({
        "x-iwa-address": ORGANIZER,
        "x-iwa-nonce": "0x1",
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": "not json",
      })
      .send({})
      .expect(401);
  });

  // Nothing signed under the old, unbound format is spendable here.
  it("refuses a signature made under the previous unbound message", async () => {
    const nonce = await nonceFor(ORGANIZER);
    const legacy = {
      domain: { name: "Iwa", version: "1", chainId: SN_MAIN },
      types: {
        StarkNetDomain: [
          { name: "name", type: "felt" },
          { name: "version", type: "felt" },
          { name: "chainId", type: "felt" },
        ],
        Authorization: [
          { name: "purpose", type: "felt" },
          { name: "nonce", type: "felt" },
        ],
      },
      primaryType: "Authorization",
      message: { purpose: "Iwa organizer action", nonce },
    };
    const { typedData: snTypedData } = await import("starknet");
    const legacyHash = snTypedData.getMessageHash(legacy, ORGANIZER);
    const res = await request(app)
      .post("/api/drafts/mine")
      .set({
        "x-iwa-address": ORGANIZER,
        "x-iwa-nonce": nonce,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": JSON.stringify([`${ORGANIZER}:${legacyHash}`]),
      })
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("bad_signature");
  });
});

describe("every authenticated operation still works when signed correctly", () => {
  it("creates, reads, lists, reorders, records and reconciles", async () => {
    const draft = await readyDraft();
    const ids = draft.slots.map((s: { slotId: string }) => s.slotId);

    expect(
      (await authed(ORGANIZER, AUTH_ACTIONS.draftsList, "post", "/api/drafts/mine", {})).status,
    ).toBe(200);

    expect(
      (
        await authed(
          ORGANIZER,
          AUTH_ACTIONS.draftReadOrganizer,
          "post",
          `/api/drafts/${draft.id}/organizer-view`,
          {},
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await authed(ORGANIZER, AUTH_ACTIONS.draftReorder, "post", `/api/drafts/${draft.id}/order`, {
          organizerAddress: ORGANIZER,
          order: [ids[1], ids[0]],
        })
      ).status,
    ).toBe(200);

    expect(
      (await authed(ORGANIZER, AUTH_ACTIONS.associationsList, "post", "/api/me/circles", {})).status,
    ).toBe(200);
    expect(
      (await authed(ORGANIZER, AUTH_ACTIONS.invitationsList, "post", "/api/me/invitations", {}))
        .status,
    ).toBe(200);

    expect(
      (
        await authed(
          ORGANIZER,
          AUTH_ACTIONS.draftMarkCreated,
          "post",
          `/api/drafts/${draft.id}/created`,
          { organizerAddress: ORGANIZER, circleId: 9, txHash: "0xabc" },
        )
      ).status,
    ).toBe(200);

    const second = await readyDraft();
    expect(
      (
        await authed(
          ORGANIZER,
          AUTH_ACTIONS.draftReconcile,
          "post",
          `/api/drafts/${second.id}/reconcile`,
          { organizerAddress: ORGANIZER },
        )
      ).status,
    ).toBe(200);
  });
});

describe("canonical json", () => {
  it("gives the same text however the keys were written", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 } }));
  });

  it("keeps array order, which carries meaning here", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes values that differ", () => {
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
    expect(hashBody({ a: "1" })).not.toBe(hashBody({ a: 1 }));
    expect(hashBody({ a: null })).not.toBe(hashBody({}));
    expect(hashBody({ a: false })).not.toBe(hashBody({ a: 0 }));
  });

  it("drops undefined members exactly as the wire would", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("treats an absent body as an empty one, never as unbound", () => {
    expect(hashBody(undefined)).toBe(hashBody({}));
    expect(hashBody(null)).toBe(hashBody({}));
  });

  it("refuses what it cannot represent exactly", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
  });

  it("is insensitive to how a path was written, but not to which path", () => {
    expect(hashResource("/API/Drafts/ABC/order")).toBe(hashResource("/api/drafts/abc/order"));
    expect(hashResource("/api/drafts/abc/order/")).toBe(hashResource("/api/drafts/abc/order"));
    expect(hashResource("/api/drafts/abc/order")).not.toBe(hashResource("/api/drafts/abd/order"));
  });
});

describe("the action set", () => {
  it("fits every action in a felt short string, so a wallet can show it", () => {
    for (const action of Object.values(AUTH_ACTIONS)) {
      expect(action.length).toBeLessThanOrEqual(MAX_ACTION_LENGTH);
      expect(action).toMatch(/^[a-z:-]+$/);
    }
  });

  it("names each action exactly once", () => {
    const values = Object.values(AUTH_ACTIONS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// The frontend builds this message too, and cannot import this file. These are
// the same fixed vectors asserted in iwa-web/src/lib/authBinding.test.ts. If one
// side drifts, both suites fail rather than production.
//
// If one of these ever fails, do not update the expected value. Find out which
// side moved.
describe("fixed vectors shared with the client", () => {
  it("hashes an empty body to the same known value", () => {
    expect(hashBody({})).toBe("0x8d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d");
    expect(hashBody(undefined)).toBe(hashBody({}));
  });

  it("canonicalizes a representative organizer body to the same known string", () => {
    const body = {
      organizerAddress: "0x4099b8eb",
      order: ["b1", "a2"],
      circleId: 9,
      nested: { z: true, a: null },
    };
    expect(canonicalJson(body)).toBe(
      '{"circleId":9,"nested":{"a":null,"z":true},"order":["b1","a2"],"organizerAddress":"0x4099b8eb"}',
    );
  });

  it("normalizes a path the same way", () => {
    expect(hashResource("/api/drafts/mine")).toBe(hashResource("/API/Drafts/Mine/"));
  });

  it("names the same actions as the client", () => {
    expect(Object.values(AUTH_ACTIONS).sort()).toEqual(
      [
        "associations:list",
        "draft:create",
        "draft:mark-created",
        "draft:read-organizer",
        "draft:reconcile",
        "draft:reorder",
        "drafts:list",
        "invitations:list",
      ].sort(),
    );
  });
});
