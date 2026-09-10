// Candidate P (alternative V2 private payout) — precommitted destination note.
//
// This module contains ONLY the deterministic note-id math, ported verbatim
// from the pinned STRK20 pool source
// (`packages/privacy/src/hashes.cairo`, rev 66e3caae…). It is used to reason
// about — and test — whether a member's next open-note id can be known before
// the STRK20 payout transaction is assembled.
//
// It does NOT compute a real note id for production use: `channel_key` needs
// the member's STRK20 viewing key, which the dapp must never hold. In the real
// flow the id comes from the wallet via `wallet_strk20PrepareInvoke` and this
// math is the spec the wallet's resolution must match.

import { ec } from "starknet";

const NOTE_ID_TAG = "NOTE_ID_TAG:V1";
const CHANNEL_KEY_TAG = "CHANNEL_KEY_TAG:V1";

const asFelt = (v: bigint | string): bigint =>
  typeof v === "bigint" ? v : BigInt(v);

/** Cairo short-string felt for a domain tag (matches Cairo `'TAG'` literals). */
export function tagFelt(tag: string): bigint {
  if (tag.length > 31) throw new Error("tag too long");
  let acc = 0n;
  for (const ch of tag) acc = (acc << 8n) | BigInt(ch.charCodeAt(0));
  return acc;
}

/** `poseidon_hash_span` — the pinned pool's `hash()` (single Poseidon). */
export function poseidon(values: (bigint | string)[]): bigint {
  return ec.starkCurve.poseidonHashMany(values.map(asFelt));
}

/**
 * `channel_key = h(CHANNEL_KEY_TAG, sender_addr, sender_private_key,
 *                  recipient_addr, recipient_public_key)`
 *
 * `sender_private_key` here is the STRK20 VIEWING KEY, held only by the wallet.
 */
export function computeChannelKey(args: {
  senderAddr: bigint;
  senderViewingKey: bigint;
  recipientAddr: bigint;
  recipientPublicKey: bigint;
}): bigint {
  return poseidon([
    tagFelt(CHANNEL_KEY_TAG),
    args.senderAddr,
    args.senderViewingKey,
    args.recipientAddr,
    args.recipientPublicKey,
  ]);
}

/**
 * `note_id = h(NOTE_ID_TAG, channel_key, token, index, 0)`
 *
 * `index` is the (channel, token) subchannel's note nonce at creation time. It
 * advances by one for EVERY note (encrypted or open) created in that
 * subchannel — deposits, DeFi outputs, self-change notes.
 */
export function computeNoteId(args: {
  channelKey: bigint;
  token: bigint;
  index: number;
}): bigint {
  if (!Number.isInteger(args.index) || args.index < 0) {
    throw new Error("index must be a non-negative integer");
  }
  return poseidon([
    tagFelt(NOTE_ID_TAG),
    args.channelKey,
    args.token,
    BigInt(args.index),
    0n,
  ]);
}

/**
 * The self-channel key for a member's own open notes (DeFi outputs default to
 * `recipient = self`). Derivable entirely from the member's own wallet
 * material — no transaction-assembly-time randomness — which is why the
 * wallet CAN return a stable next-note id from a `simulate` prepare.
 */
export function selfChannelKey(memberAddr: bigint, memberViewingKey: bigint, memberPublicKey: bigint): bigint {
  return computeChannelKey({
    senderAddr: memberAddr,
    senderViewingKey: memberViewingKey,
    recipientAddr: memberAddr,
    recipientPublicKey: memberPublicKey,
  });
}

/**
 * The member's next self-channel open-note id for `token`, given the current
 * subchannel note count. This is the value the payout destination is
 * pre-registered as.
 */
export function nextSelfOpenNoteId(args: {
  memberAddr: bigint;
  memberViewingKey: bigint;
  memberPublicKey: bigint;
  token: bigint;
  currentIndex: number;
}): bigint {
  return computeNoteId({
    channelKey: selfChannelKey(args.memberAddr, args.memberViewingKey, args.memberPublicKey),
    token: args.token,
    index: args.currentIndex,
  });
}
