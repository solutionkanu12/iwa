// Candidate P — local proof of the note-id DETERMINISM the precommitted-
// destination flow depends on, and the exact condition under which it breaks.
//
// The claim under test: a member's next open-note id for a token is a pure
// deterministic function of (their wallet material, token, subchannel note
// index). The two-phase flow (simulate → sign the resolved id → submit) is
// safe iff that index does not move between the two phases.

import { ec } from "starknet";
import { describe, expect, it } from "vitest";

import {
  computeNoteId,
  nextSelfOpenNoteId,
  poseidon,
  selfChannelKey,
  tagFelt,
} from "./precommittedNoteId";

// Fixture wallet material. Never used to hold value.
const MEMBER_ADDR = 0x049d36570d4e46f48e99674bd3fbcf03b9a9c2f5f8b4b3a2a1009f8e7d6c5b4an;
const VIEWING_KEY = 0x01a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081920a1b2c3d4e5fn;
// A distinct felt standing in for the member's STRK20 public viewing key
// (only used as a hash input here).
const pubkeyBig = 0x02f0c7b1a9e8d6543210fedcba9876543210abcdef0123456789abcdef012345n;
const USDC = 0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8n;
const STRK = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn;

describe("Cairo poseidon parity", () => {
  it("tagFelt matches Cairo short-string encoding", () => {
    // 'NOTE_ID_TAG:V1' as a Cairo short string.
    expect(tagFelt("NOTE_ID_TAG:V1")).toBe(
      BigInt("0x" + Buffer.from("NOTE_ID_TAG:V1", "ascii").toString("hex")),
    );
  });

  it("poseidon() is starkCurve.poseidonHashMany (single hash, not doubled)", () => {
    expect(poseidon([1n, 2n, 3n])).toBe(ec.starkCurve.poseidonHashMany([1n, 2n, 3n]));
  });
});

describe("note-id determinism (the property the flow relies on)", () => {
  const channelKey = selfChannelKey(MEMBER_ADDR, VIEWING_KEY, pubkeyBig);

  it("is a pure function of (channelKey, token, index)", () => {
    const a = computeNoteId({ channelKey, token: USDC, index: 4 });
    const b = computeNoteId({ channelKey, token: USDC, index: 4 });
    expect(a).toBe(b);
  });

  it("two 'compute' passes with an unchanged index yield the SAME id (simulate == submit)", () => {
    const simulatePhase = nextSelfOpenNoteId({
      memberAddr: MEMBER_ADDR,
      memberViewingKey: VIEWING_KEY,
      memberPublicKey: pubkeyBig,
      token: USDC,
      currentIndex: 7,
    });
    // No note created in between → index still 7 at submit.
    const submitPhase = nextSelfOpenNoteId({
      memberAddr: MEMBER_ADDR,
      memberViewingKey: VIEWING_KEY,
      memberPublicKey: pubkeyBig,
      token: USDC,
      currentIndex: 7,
    });
    expect(submitPhase).toBe(simulatePhase);
  });

  it("changes iff the subchannel index changes — the exact fragility condition", () => {
    const at7 = computeNoteId({ channelKey, token: USDC, index: 7 });
    const at8 = computeNoteId({ channelKey, token: USDC, index: 8 });
    // A note created in this (self-channel, USDC) subchannel between phases
    // advances the index and moves the id. The helper then rejects the stale
    // registration — pot is safe, flow retries.
    expect(at8).not.toBe(at7);
  });

  it("is token-scoped: activity in another token's subchannel does not move it", () => {
    const usdcAt3 = computeNoteId({ channelKey, token: USDC, index: 3 });
    const strkAtAnything = computeNoteId({ channelKey, token: STRK, index: 9 });
    expect(usdcAt3).not.toBe(strkAtAnything);
    // USDC id is unchanged regardless of STRK subchannel state.
    expect(computeNoteId({ channelKey, token: USDC, index: 3 })).toBe(usdcAt3);
  });

  it("needs the viewing key: the id cannot be derived from public data alone", () => {
    const real = selfChannelKey(MEMBER_ADDR, VIEWING_KEY, pubkeyBig);
    const guessWithZeroKey = selfChannelKey(MEMBER_ADDR, 0n, pubkeyBig);
    expect(guessWithZeroKey).not.toBe(real);
    // => the dapp must obtain the resolved id from the wallet
    //    (wallet_strk20PrepareInvoke), never compute it itself.
  });

  it("is bound to the member: a different wallet cannot produce the same id", () => {
    const mine = nextSelfOpenNoteId({
      memberAddr: MEMBER_ADDR,
      memberViewingKey: VIEWING_KEY,
      memberPublicKey: pubkeyBig,
      token: USDC,
      currentIndex: 0,
    });
    const attacker = nextSelfOpenNoteId({
      memberAddr: MEMBER_ADDR + 1n,
      memberViewingKey: VIEWING_KEY,
      memberPublicKey: pubkeyBig,
      token: USDC,
      currentIndex: 0,
    });
    expect(attacker).not.toBe(mine);
  });
});
