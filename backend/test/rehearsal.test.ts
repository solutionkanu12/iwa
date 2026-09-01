// Full coordination rehearsal, no chain writes.
//
// Walks the exact sequence a real circle goes through — organizer signs in,
// creates a draft, shares invitations, two members accept, the organizer sees
// the accepted places, reorders the payout order, and reaches the point where
// the only thing left is the wallet transaction.
//
// It deliberately stops before create_circle: that is the one step that costs
// money and touches mainnet.

import { describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";
import type { SignatureVerifier } from "../src/auth.js";
import type { CircleVerifier, DiscoveryOutcome, VerifyOutcome } from "../src/chainVerify.js";

class AlwaysVerifies implements CircleVerifier {
  async verifyCreated(): Promise<VerifyOutcome> {
    return { status: "verified" };
  }
  async findCircleForDraft(): Promise<DiscoveryOutcome> {
    return { status: "absent" };
  }
}

const ORGANIZER = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";
const ALICE_ADDR = "0xa11ce";
const BOB_ADDR = "0xb0b";

// The two identities generated earlier in this project, derived client-side.
const ALICE = {
  memberRef: "0x45325587024dc0326f740bc5268c766620a4a51dbdec04894256480aecbae0f",
  authPublicKey: "0x6a77859939dd3948dd673b07b0d0929af6942731fa4815d152190bdeddb658d",
};
const BOB = {
  memberRef: "0x711d1f99df6566d5731496a43f01c617927bc2d82d868d79718621cf02cdced",
  authPublicKey: "0x94edb9a04dbe7a9160830e8d755af5ee6becf8a82ad12ad5eb64509fbe9f41",
};

class StubVerifier implements SignatureVerifier {
  async verify(address: string, _hash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `signed-by:${address}`;
  }
}

describe("organizer -> invite -> accept -> reorder -> ready", () => {
  it("completes the whole coordination flow and stops before the chain write", async () => {
    const app = createApp({
      store: new MemoryStore(),
      corsOrigins: ["http://localhost:5173"],
      rateLimit: { windowMs: 60_000, max: 500 },
      verifier: new StubVerifier(),
      circleVerifier: new AlwaysVerifies(),
    });

    const signIn = async (address: string) => {
      const res = await request(app).post("/api/auth/challenge").send({ address }).expect(200);
      return {
        "x-iwa-address": address,
        "x-iwa-nonce": res.body.nonce as string,
        "x-iwa-chain": SN_MAIN,
        "x-iwa-signature": JSON.stringify([`signed-by:${address}`]),
      };
    };

    // 1. The organizer signs in and describes the circle: 2 people, 1 USDC each.
    const created = await request(app)
      .post("/api/drafts")
      .set(await signIn(ORGANIZER))
      .send({
        chainId: SN_MAIN,
        organizerAddress: ORGANIZER,
        token: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
        contributionAmount: "1000000",
        cadenceSeconds: 604800,
        graceSeconds: 86400,
        memberCount: 2,
      })
      .expect(201);

    const draftId = created.body.id as string;
    const invites = created.body.slots.map((s: { inviteToken: string }) => s.inviteToken);
    expect(invites).toHaveLength(2);
    expect(created.body.status).toBe("draft");

    // 2. Each invited person opens their link and sees the terms, not jargon.
    for (const token of invites) {
      const view = await request(app).get(`/api/invites/${token}`).expect(200);
      expect(view.body.contributionAmount).toBe("1000000");
      expect(view.body.memberCount).toBe(2);
      expect(view.body.alreadyAccepted).toBe(false);
      // A member never sees anyone else's invitation.
      const other = invites.find((t: string) => t !== token);
      expect(JSON.stringify(view.body)).not.toContain(other);
    }

    // 3. They accept, sending only public commitment data.
    const first = await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: invites[0], ...ALICE, address: ALICE_ADDR })
      .expect(200);
    expect(first.body.draft.status).toBe("draft");
    expect(first.body.draft.acceptedCount).toBe(1);

    const second = await request(app)
      .post("/api/invites/accept")
      .send({ inviteToken: invites[1], ...BOB, address: BOB_ADDR })
      .expect(200);
    expect(second.body.draft.status).toBe("ready");
    expect(second.body.draft.acceptedCount).toBe(2);

    // 4. The organizer reviews who accepted. Requires a fresh signature.
    const review = await request(app)
      .post(`/api/drafts/${draftId}/organizer-view`)
      .set(await signIn(ORGANIZER))
      .send({})
      .expect(200);
    expect(review.body.status).toBe("ready");
    expect(review.body.slots.map((s: { memberRef: string }) => s.memberRef)).toEqual([
      ALICE.memberRef,
      BOB.memberRef,
    ]);

    // 5. The organizer puts Bob first in the payout order.
    const reordered = await request(app)
      .post(`/api/drafts/${draftId}/order`)
      .set(await signIn(ORGANIZER))
      .send({
        organizerAddress: ORGANIZER,
        // Slot ids, not positions: the order names the places themselves.
        order: [review.body.slots[1].slotId, review.body.slots[0].slotId],
      })
      .expect(200);
    const payoutOrder = reordered.body.slots.map((s: { memberRef: string }) => s.memberRef);
    expect(payoutOrder).toEqual([BOB.memberRef, ALICE.memberRef]);

    // 6. Everything needed for create_circle is now known, and valid.
    expect(reordered.body.status).toBe("ready");
    expect(new Set(payoutOrder).size).toBe(2);
    expect(payoutOrder.every((r: string) => BigInt(r) > 0n)).toBe(true);
    expect(reordered.body.circleId).toBeNull();
    expect(reordered.body.createdTx).toBeNull();

    // STOP. The next step is the organizer's wallet transaction, which this
    // rehearsal deliberately does not perform.
  });

  it("never exposes anything secret across the whole flow", async () => {
    const app = createApp({
      store: new MemoryStore(),
      corsOrigins: [],
      rateLimit: { windowMs: 60_000, max: 500 },
      verifier: new StubVerifier(),
    });
    const res = await request(app).post("/api/auth/challenge").send({ address: ORGANIZER }).expect(200);
    const headers = {
      "x-iwa-address": ORGANIZER,
      "x-iwa-nonce": res.body.nonce as string,
      "x-iwa-chain": SN_MAIN,
      "x-iwa-signature": JSON.stringify([`signed-by:${ORGANIZER}`]),
    };
    const draft = await request(app)
      .post("/api/drafts")
      .set(headers)
      .send({
        chainId: SN_MAIN,
        organizerAddress: ORGANIZER,
        token: "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb",
        contributionAmount: "1000000",
        cadenceSeconds: 604800,
        graceSeconds: 86400,
        memberCount: 2,
      })
      .expect(201);

    const body = JSON.stringify(draft.body).toLowerCase();
    for (const word of ["privatekey", "seedphrase", "mnemonic", "viewingkey", "invitesecret", "authprivate"]) {
      expect(body).not.toContain(word);
    }
  });
});
