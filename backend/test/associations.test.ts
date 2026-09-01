// "Which circles are mine?"
//
// The answer already existed in the schema and nothing could ask for it. A
// draft records the organizer's address; a slot records the address that
// accepted it. Those two facts are the whole association, and they are what
// lets someone close their browser, come back, connect the same wallet and
// find their place again without the invitation link.
//
// What matters most here is the scoping. The reply is built from the
// AUTHENTICATED address, never from anything in the request body, so knowing
// an address buys nothing: no enumerating other people's invitations, no
// reading another organizer's coordination data.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

import { createApp } from "../src/app.js";
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
const OTHER_ORGANIZER = "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80";
const ALICE = "0x45325587024dc0326f740bc5268c766620a4a51dbdec04894256480aecbae0f";
const BOB = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";
const STRANGER = "0xdeadbeef";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const KEY_A = "0x6a77859939dd3948dd673b07b0d0929af6942731fa4815d152190bdeddb658d";
const KEY_B = "0x94edb9a04dbe7a9160830e8d755af5ee6becf8a82ad12ad5eb64509fbe9f41";

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

async function authHeaders(address: string) {
  const res = await request(app).post("/api/auth/challenge").send({ address }).expect(200);
  return {
    "x-iwa-address": address,
    "x-iwa-nonce": res.body.nonce as string,
    "x-iwa-chain": SN_MAIN,
    "x-iwa-signature": JSON.stringify([`signed-by:${address}`]),
  };
}

beforeEach(() => {
  app = createApp({
    store: new MemoryStore(),
    corsOrigins: ["http://localhost:5173"],
    rateLimit: { windowMs: 60_000, max: 500 },
    verifier: new StubVerifier(),
    circleVerifier: new AlwaysVerifies(),
    challenges: new ChallengeStore(),
  });
});

async function newDraft(organizer = ORGANIZER) {
  const res = await request(app)
    .post("/api/drafts")
    .set(await authHeaders(organizer))
    .send({ ...DRAFT, organizerAddress: organizer })
    .expect(201);
  return res.body;
}

async function accept(token: string, memberRef: string, key: string, address: string) {
  await request(app)
    .post("/api/invites/accept")
    .send({ inviteToken: token, memberRef, authPublicKey: key, address })
    .expect(200);
}

/** Awaits a request and asserts it succeeded, returning the response. */
async function ok(pending: Promise<{ status: number; body: unknown }>) {
  const res = await pending;
  expect(res.status).toBe(200);
  return res as { status: number; body: any };
}

const myCircles = async (address: string) =>
  request(app).post("/api/me/circles").set(await authHeaders(address)).send({});

const myInvitations = async (address: string) =>
  request(app).post("/api/me/invitations").set(await authHeaders(address)).send({});

describe("my circles", () => {
  it("shows an organizer the circle they are organizing", async () => {
    const draft = await newDraft();
    const res = await ok(myCircles(ORGANIZER));
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ draftId: draft.id, role: "organizer", accepted: false });
  });

  it("shows a member the circle they accepted a place in", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);

    const res = await ok(myCircles(ALICE));
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ draftId: draft.id, role: "member", accepted: true });
  });

  it("returns every circle a wallet is part of", async () => {
    const first = await newDraft();
    const second = await newDraft();
    await accept(first.slots[0].inviteToken, ALICE, KEY_A, ALICE);
    await accept(second.slots[0].inviteToken, ALICE, KEY_A, ALICE);

    const res = await ok(myCircles(ALICE));
    expect(res.body.map((a: { draftId: string }) => a.draftId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("gives a wallet with no circles an empty answer, not an error", async () => {
    await newDraft();
    const res = await ok(myCircles(STRANGER));
    expect(res.body).toEqual([]);
  });

  it("never shows one organizer another organizer's circles", async () => {
    await newDraft(ORGANIZER);
    const mine = await newDraft(OTHER_ORGANIZER);

    const res = await ok(myCircles(OTHER_ORGANIZER));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].draftId).toBe(mine.id);
  });

  // The organizer may also take a place. That is one circle, not two.
  it("reports a single entry when the organizer also holds a place", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ORGANIZER);

    const res = await ok(myCircles(ORGANIZER));
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ role: "organizer", accepted: true });
  });

  it("says honestly that a circle does not exist on chain yet", async () => {
    await newDraft();
    const res = await ok(myCircles(ORGANIZER));
    expect(res.body[0].circleId).toBeNull();
    expect(res.body[0].status).toBe("draft");
  });

  it("carries the circle id once the creation is recorded", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);
    await accept(draft.slots[1].inviteToken, BOB, KEY_B, BOB);
    await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set(await authHeaders(ORGANIZER))
      .send({ organizerAddress: ORGANIZER, circleId: 21, txHash: "0xabc" })
      .expect(200);

    const forMember = await ok(myCircles(ALICE));
    expect(forMember.body[0]).toMatchObject({ circleId: 21, status: "created" });
  });

  it("refuses an unauthenticated request", async () => {
    await request(app).post("/api/me/circles").send({}).expect(401);
  });

  // The answer is built from the signed-in address. A body field naming
  // somebody else must not change whose circles come back.
  it("ignores an address supplied in the body", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);

    const res = await request(app)
      .post("/api/me/circles")
      .set(await authHeaders(STRANGER))
      .send({ address: ALICE, organizerAddress: ORGANIZER })
      .expect(200);
    expect(res.body).toEqual([]);
  });
});

describe("my invitations", () => {
  it("recovers an accepted invitation without the original link", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);

    const res = await ok(myInvitations(ALICE));
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      draftId: draft.id,
      accepted: true,
      status: "draft",
      circleId: null,
    });
  });

  it("does not list a place this wallet never took", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);

    expect((await ok(myInvitations(BOB))).body).toEqual([]);
  });

  it("does not list a circle merely organized", async () => {
    await newDraft();
    expect((await ok(myInvitations(ORGANIZER))).body).toEqual([]);
  });

  it("shows the circle id once the organizer has created it", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);
    await accept(draft.slots[1].inviteToken, BOB, KEY_B, BOB);
    await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set(await authHeaders(ORGANIZER))
      .send({ organizerAddress: ORGANIZER, circleId: 7, txHash: "0xabc" })
      .expect(200);

    const res = await ok(myInvitations(ALICE));
    expect(res.body[0]).toMatchObject({ circleId: 7, status: "created" });
  });

  it("refuses an unauthenticated request", async () => {
    await request(app).post("/api/me/invitations").send({}).expect(401);
  });
});

// An association tells you about your own place and the circle's public terms.
// It is not a route to anybody else's data.
describe("what an association does not carry", () => {
  it("never carries an invite token", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);

    for (const res of [
      await ok(myCircles(ALICE)),
      await ok(myInvitations(ALICE)),
      await ok(myCircles(ORGANIZER)),
    ]) {
      const body = JSON.stringify(res.body);
      for (const slot of draft.slots) expect(body).not.toContain(slot.inviteToken);
    }
  });

  it("never carries another member's commitment or key", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);
    await accept(draft.slots[1].inviteToken, BOB, KEY_B, BOB);

    const body = JSON.stringify((await ok(myInvitations(ALICE))).body);
    expect(body).not.toContain(BOB);
    expect(body).not.toContain(KEY_B);
    expect(body).not.toContain(KEY_A);
  });

  it("never carries another member's address", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);
    await accept(draft.slots[1].inviteToken, BOB, KEY_B, BOB);

    const body = JSON.stringify((await ok(myCircles(ALICE))).body);
    expect(body).not.toContain(BOB);
  });

  it("carries the public terms the screen needs", async () => {
    const draft = await newDraft();
    await accept(draft.slots[0].inviteToken, ALICE, KEY_A, ALICE);

    const entry = (await ok(myInvitations(ALICE))).body[0];
    expect(entry).toMatchObject({
      contributionAmount: "10000000",
      cadenceSeconds: 604800,
      graceSeconds: 86400,
      memberCount: 2,
      acceptedCount: 1,
    });
    expect(entry.draftId).toBe(draft.id);
  });
});
