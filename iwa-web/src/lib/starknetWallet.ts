// lib/starknetWallet.ts — the app's wallet seam, on Starknet.
//
// Replaces the Stellar Wallets Kit seam. Connects a privacy-enabled Starknet
// wallet (Ready) through the STRK20 Wallet API client already proven by the
// operator console, and derives the user's IWA member identity.
//
// IDENTITY, AND WHY IT IS NOT STORED
//
// A member is a commitment, not an address:
//   member_ref = poseidon([IWA_INVITE_V1, invite_secret, auth_public_key])
//
// Both the invite secret and the settlement signing key are derived from a
// signature the wallet produces over one fixed message. That gives three
// properties at once:
//
//   - generated client-side, and never shown to the user;
//   - never persisted — no localStorage, no sessionStorage, no cookie;
//   - recoverable, because the same wallet signing the same message
//     reproduces the same identity on any device, at any time.
//
// The derivation assumes the wallet signs deterministically (RFC 6979), which
// starknet.js and the wallets built on it do. `verifyIdentityMatches` exists
// for the case where a wallet does not: rather than silently creating a second
// identity, the mismatch is detected against what the circle already recorded.

import { ec } from "starknet";

import {
  connectWallet as connectStrk20Wallet,
  createWalletStore,
  detectWallets,
  WalletUnsupportedError,
  type ConnectedWallet,
  type DetectedWallet,
} from "../chains/strk20/walletConnect";
import { deriveMemberIdentity, feltHex, type MemberIdentity } from "../chains/strk20/iwaSigning";
import { RPC_URL } from "./starknetConfig";

/** The message the wallet signs to derive this user's IWA identity. */
const IDENTITY_MESSAGE = "Iwa member identity v1";

export class WalletCancelledError extends Error {
  constructor(message = "Wallet connection cancelled") {
    super(message);
    this.name = "WalletCancelledError";
  }
}

export class NoPrivacyWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoPrivacyWalletError";
  }
}

let connected: ConnectedWallet | null = null;

/** The live connection, or null. Held in memory only. */
export function currentWallet(): ConnectedWallet | null {
  return connected;
}

/**
 * Opens the wallet picker and connects. Refuses anything IWA cannot settle
 * through — a wallet without STRK20 support, or one not on Starknet mainnet —
 * with a message a person can act on.
 */
export async function connectWallet(): Promise<string> {
  const store = createWalletStore();
  const detected: DetectedWallet[] = await detectWallets(store);

  if (detected.length === 0) {
    throw new NoPrivacyWalletError(
      "No Starknet wallet found. Install Ready to use private savings circles.",
    );
  }

  const capable = detected.filter((w) => w.supportsStrk20);
  if (capable.length === 0) {
    const names = detected.map((w) => w.name).join(", ");
    throw new NoPrivacyWalletError(
      `${names} cannot make private transfers yet. Iwa needs a privacy-enabled wallet such as Ready.`,
    );
  }

  // One capable wallet is the common case; with several, the first is used and
  // the picker can come later. Never silently prefer an incapable one.
  try {
    connected = await connectStrk20Wallet(capable[0], RPC_URL);
  } catch (e) {
    if (e instanceof WalletUnsupportedError) {
      if (e.reason === "CONNECTION_REFUSED") throw new WalletCancelledError(e.message);
      throw new NoPrivacyWalletError(e.message);
    }
    throw e;
  }
  return connected.address;
}

export async function disconnectWallet(): Promise<void> {
  connected = null;
  cachedIdentity = null;
}

/**
 * The user's IWA identity for the session.
 *
 * `commitment` is the member_ref the contracts use. The private parts live in
 * `identity` and never leave the browser tab: nothing here logs them, renders
 * them, or writes them anywhere.
 */
export interface MemberCommitment {
  /**
   * The private field element the local reliability circuit commits to. Held
   * in memory only, never shown, never stored.
   */
  secret: bigint;
  /** member_ref, the public commitment the circle stores. */
  commitment: bigint;
  commitmentHex: string;
  /** member_ref as 32 big-endian bytes, the form the existing UI seam passes. */
  commitmentBytes: Uint8Array;
  /** Private material for settlement signing. Session memory only. */
  identity: MemberIdentity;
}

let cachedIdentity: { address: string; value: MemberCommitment } | null = null;

const STARK_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const CURVE_ORDER = ec.starkCurve.CURVE.n;

/** A felt as 32 big-endian bytes. Exact and reversible. */
export function feltToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Inverse of feltToBytes32. */
export function bytes32ToFelt(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc;
}

/** SNIP-12 typed data for the identity signature. Contains no secret. */
function identityTypedData(address: string) {
  return {
    domain: { name: "Iwa", version: "1", chainId: "SN_MAIN" },
    types: {
      StarkNetDomain: [
        { name: "name", type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
      ],
      Identity: [
        { name: "purpose", type: "felt" },
        { name: "account", type: "felt" },
      ],
    },
    primaryType: "Identity",
    message: { purpose: IDENTITY_MESSAGE, account: address },
  };
}

/** Folds signature material into one 256-bit value. */
async function digestOf(parts: string[]): Promise<bigint> {
  const encoded = new TextEncoder().encode(parts.join("|"));
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let acc = 0n;
  for (const b of digest) acc = (acc << 8n) | BigInt(b);
  return acc;
}

/**
 * Derives the member identity from a wallet signature. The same wallet and the
 * same message always yield the same member_ref, so a returning user is
 * recognised without anything having been stored.
 */
export async function deriveMemberCommitment(address: string): Promise<MemberCommitment> {
  if (cachedIdentity !== null && cachedIdentity.address === address) return cachedIdentity.value;

  const wallet = connected;
  if (wallet === null) throw new Error("connect a wallet first");

  const signature = await wallet.account.signMessage(identityTypedData(address));
  const parts = Array.isArray(signature) ? signature.map(String) : [String(signature)];

  // Two independent values from one signature, domain-separated so neither can
  // be derived from the other.
  const base = await digestOf([IDENTITY_MESSAGE, address, ...parts]);
  const secretSeed = await digestOf(["invite", base.toString(16)]);
  const keySeed = await digestOf(["auth", base.toString(16)]);

  // Keep both strictly inside their ranges, and never zero.
  const inviteSecret = (secretSeed % (STARK_PRIME - 1n)) + 1n;
  const authPrivateKey = (keySeed % (CURVE_ORDER - 1n)) + 1n;

  const identity = deriveMemberIdentity("you", inviteSecret, authPrivateKey);
  const value: MemberCommitment = {
    secret: inviteSecret,
    commitment: identity.memberRef,
    commitmentHex: feltHex(identity.memberRef),
    commitmentBytes: feltToBytes32(identity.memberRef),
    identity,
  };
  cachedIdentity = { address, value };
  return value;
}

/**
 * Confirms the derived identity is the one the circle recorded.
 *
 * If a wallet ever signs non-deterministically, the derived member_ref would
 * silently become a stranger's. Comparing against what the circle stored turns
 * that into a clear, explainable failure instead of a lost membership.
 */
export function identityMatches(commitment: MemberCommitment, storedMemberRef: string): boolean {
  try {
    return BigInt(storedMemberRef) === commitment.commitment;
  } catch {
    return false;
  }
}
