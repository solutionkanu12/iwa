// Recording that a circle was created, and recovering when that record was
// never made.
//
// Two failures matter here and they are opposites. A creation the chain does
// not support must never be recorded, or a draft could be pointed at somebody
// else's circle by anyone who can call the endpoint. And a creation that DID
// happen must never be lost because the browser closed or the service blinked:
// the transaction is irreversible, so the coordination record has to be able to
// catch up with it afterwards.

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

/**
 * Stands in for the chain. Answers the three ways the real verifier can:
 * verified, rejected with a reason, or unavailable because the chain could not
 * be reached at all. That third answer is the one that must stay retryable.
 */
class StubCircleVerifier implements CircleVerifier {
  outcome: VerifyOutcome = { status: "verified" };
  discovery: DiscoveryOutcome = { status: "absent" };
  verifyCalls = 0;

  async verifyCreated(): Promise<VerifyOutcome> {
    this.verifyCalls += 1;
    return this.outcome;
  }

  async findCircleForDraft(): Promise<DiscoveryOutcome> {
    return this.discovery;
  }
}

const ORGANIZER = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const STRANGER = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const MEMBER_A = "0x45325587024dc0326f740bc5268c766620a4a51dbdec04894256480aecbae0f";
const MEMBER_B = "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced";
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
let store: MemoryStore;
let circles: StubCircleVerifier;

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
  store = new MemoryStore();
  circles = new StubCircleVerifier();
  app = createApp({
    store,
    corsOrigins: ["http://localhost:5173"],
    rateLimit: { windowMs: 60_000, max: 500 },
    verifier: new StubVerifier(),
    circleVerifier: circles,
    challenges: new ChallengeStore(),
  });
});

/** A draft with both places accepted, which is the state creation happens in. */
async function readyDraft() {
  const created = await request(app)
    .post("/api/drafts")
    .set(await authHeaders(ORGANIZER))
    .send(DRAFT)
    .expect(201);
  const draft = created.body;
  const members: [string, string][] = [
    [MEMBER_A, KEY_A],
    [MEMBER_B, KEY_B],
  ];
  for (const [i, [memberRef, authPublicKey]] of members.entries()) {
    await request(app)
      .post("/api/invites/accept")
      .send({
        inviteToken: draft.slots[i].inviteToken,
        memberRef,
        authPublicKey,
        address: memberRef,
      })
      .expect(200);
  }
  return draft;
}

async function markCreated(draftId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/drafts/${draftId}/created`)
    .set(await authHeaders(ORGANIZER))
    .send({ organizerAddress: ORGANIZER, ...body });
}

async function reconcile(draftId: string, address = ORGANIZER) {
  return request(app)
    .post(`/api/drafts/${draftId}/reconcile`)
    .set(await authHeaders(address))
    .send({ organizerAddress: address });
}

describe("markCreated is verified against the chain", () => {
  it("records a creation the chain confirms", async () => {
    const draft = await readyDraft();
    const res = await markCreated(draft.id, { circleId: 9, txHash: "0xabc" });
    expect(res.status).toBe(200);
    expect(res.body.circleId).toBe(9);
    expect(res.body.status).toBe("created");
  });

  it("refuses a circle the chain does not tie to this draft", async () => {
    const draft = await readyDraft();
    circles.outcome = { status: "rejected", reason: "payout order does not match this draft" };
    const res = await markCreated(draft.id, { circleId: 4321, txHash: "0xabc" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("unverified_creation");

    const after = await request(app).get(`/api/drafts/${draft.id}`).expect(200);
    expect(after.body.circleId).toBeNull();
    expect(after.body.status).not.toBe("created");
  });

  it("refuses a transaction that did not succeed", async () => {
    const draft = await readyDraft();
    circles.outcome = { status: "rejected", reason: "transaction reverted" };
    const res = await markCreated(draft.id, { circleId: 9, txHash: "0xdead" });
    expect(res.status).toBe(422);
  });

  it("refuses a fabricated transaction hash", async () => {
    const draft = await readyDraft();
    circles.outcome = { status: "rejected", reason: "transaction not found" };
    const res = await markCreated(draft.id, { circleId: 9, txHash: "0x1234" });
    expect(res.status).toBe(422);
  });

  it("refuses a transaction that never touched the circle contract", async () => {
    const draft = await readyDraft();
    circles.outcome = { status: "rejected", reason: "transaction did not call IwaCircle" };
    const res = await markCreated(draft.id, { circleId: 9, txHash: "0xfeed" });
    expect(res.status).toBe(422);
  });

  // A chain that cannot be reached is not evidence of wrongdoing. The organizer
  // has to be able to try again, not be told their circle is invalid.
  it("asks the caller to retry when the chain cannot be reached", async () => {
    const draft = await readyDraft();
    circles.outcome = { status: "unavailable" };
    const res = await markCreated(draft.id, { circleId: 9, txHash: "0xabc" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("verification_unavailable");

    circles.outcome = { status: "verified" };
    const retry = await markCreated(draft.id, { circleId: 9, txHash: "0xabc" });
    expect(retry.status).toBe(200);
    expect(retry.body.circleId).toBe(9);
  });

  it("is idempotent when the same creation is reported twice", async () => {
    const draft = await readyDraft();
    await markCreated(draft.id, { circleId: 9, txHash: "0xabc" });
    const callsAfterFirst = circles.verifyCalls;

    const again = await markCreated(draft.id, { circleId: 9, txHash: "0xabc" });
    expect(again.status).toBe(200);
    expect(again.body.circleId).toBe(9);
    // Already settled: nothing re-verified, nothing rewritten.
    expect(circles.verifyCalls).toBe(callsAfterFirst);
  });

  it("refuses to repoint a created draft at a different circle", async () => {
    const draft = await readyDraft();
    await markCreated(draft.id, { circleId: 9, txHash: "0xabc" });

    const res = await markCreated(draft.id, { circleId: 10, txHash: "0xbeef" });
    expect(res.status).toBe(409);

    const after = await request(app).get(`/api/drafts/${draft.id}`).expect(200);
    expect(after.body.circleId).toBe(9);
  });

  it("still refuses anyone but the organizer", async () => {
    const draft = await readyDraft();
    const res = await request(app)
      .post(`/api/drafts/${draft.id}/created`)
      .set(await authHeaders(STRANGER))
      .send({ organizerAddress: STRANGER, circleId: 9, txHash: "0xabc" });
    expect(res.status).toBe(403);
  });
});

describe("reconciling a creation the backend never recorded", () => {
  it("recovers the circle from the chain", async () => {
    const draft = await readyDraft();
    circles.discovery = { status: "found", circleId: 12 };

    const res = await reconcile(draft.id);
    expect(res.status).toBe(200);
    expect(res.body.circleId).toBe(12);
    expect(res.body.status).toBe("created");
  });

  it("says plainly when no circle exists yet, rather than inventing one", async () => {
    const draft = await readyDraft();
    circles.discovery = { status: "absent" };
    const res = await reconcile(draft.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_circle_yet");
  });

  it("stays retryable when the chain is unreachable", async () => {
    const draft = await readyDraft();
    circles.discovery = { status: "unavailable" };
    expect((await reconcile(draft.id)).status).toBe(503);

    circles.discovery = { status: "found", circleId: 12 };
    const retry = await reconcile(draft.id);
    expect(retry.status).toBe(200);
    expect(retry.body.circleId).toBe(12);
  });

  it("is idempotent once the circle is recorded", async () => {
    const draft = await readyDraft();
    circles.discovery = { status: "found", circleId: 12 };
    await reconcile(draft.id);

    const again = await reconcile(draft.id);
    expect(again.status).toBe(200);
    expect(again.body.circleId).toBe(12);
  });

  it("refuses anyone but the organizer", async () => {
    const draft = await readyDraft();
    circles.discovery = { status: "found", circleId: 12 };
    const res = await reconcile(draft.id, STRANGER);
    expect(res.status).toBe(403);

    const after = await request(app).get(`/api/drafts/${draft.id}`).expect(200);
    expect(after.body.circleId).toBeNull();
  });

  // The whole point: chain success followed by a backend failure leaves an
  // organizer who can recover, and who never sends a second create_circle.
  it("recovers after a failed markCreated without a second creation", async () => {
    const draft = await readyDraft();

    circles.outcome = { status: "unavailable" };
    expect((await markCreated(draft.id, { circleId: 12, txHash: "0xabc" })).status).toBe(503);

    // Browser closed, txHash lost. The chain still knows.
    circles.discovery = { status: "found", circleId: 12 };
    const recovered = await reconcile(draft.id);
    expect(recovered.status).toBe(200);
    expect(recovered.body.circleId).toBe(12);
    expect(recovered.body.status).toBe("created");
  });
});
