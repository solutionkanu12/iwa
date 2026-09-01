// Wallet-signature authentication.
//
// Organizer actions are authorized by proving control of the organizer's
// account, not by claiming its address. The flow is:
//
//   1. client asks for a challenge for an address
//   2. server issues a single-use nonce with a short expiry
//   3. client signs SNIP-12 typed data containing that nonce
//   4. server verifies the signature against the account ON CHAIN, then burns
//      the nonce
//
// Starknet accounts are contracts, so signature schemes differ between wallets.
// The only correct check is to ask the account itself via `is_valid_signature`,
// which is what OnChainSignatureVerifier does. The verifier is injected so the
// route logic can be tested without RPC.
//
// No private key ever reaches this service. A signature is a public artefact.

import { randomBytes } from "node:crypto";
import { RpcProvider } from "starknet";

import { authorizationHash, type AuthorizationBinding } from "./authBinding.js";
import { SN_MAIN, normalizeFelt } from "./validation.js";

/** Challenges are short-lived: long enough to sign, short enough to be useless if leaked. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface Challenge {
  nonce: string;
  address: string;
  chainId: string;
  expiresAt: number;
}

// The message a wallet signs lives in authBinding.ts, because what it says is
// the security property: it names the exact operation being authorized. A
// challenge here is only the nonce that message consumes.

export interface SignatureVerifier {
  /** True when `address` really signed `messageHash`. */
  verify(address: string, messageHash: string, signature: string[]): Promise<boolean>;
}

/**
 * Asks the account contract whether the signature is valid. This is the only
 * scheme-agnostic way to verify on Starknet, where accounts are contracts and
 * a wallet may use a hardware key, a multisig, or a session key.
 */
export class OnChainSignatureVerifier implements SignatureVerifier {
  constructor(private readonly provider: RpcProvider) {}

  async verify(address: string, messageHash: string, signature: string[]): Promise<boolean> {
    try {
      const result = await this.provider.callContract(
        {
          contractAddress: address,
          entrypoint: "is_valid_signature",
          calldata: [messageHash, String(signature.length), ...signature],
        },
        "latest",
      );
      const first = result[0];
      if (first === undefined) return false;
      // Accounts answer either the 'VALID' short string or 1.
      const VALID = BigInt("0x56414c4944");
      const value = BigInt(first);
      return value === VALID || value === 1n;
    } catch {
      // A revert means the account rejected it. Anything else is unavailable,
      // and both fail closed.
      return false;
    }
  }
}

/**
 * Single-use challenges with expiry.
 *
 * In-process, matching the single-replica deployment. A restart invalidates
 * outstanding challenges, which is correct: the client simply asks for another.
 */
export class ChallengeStore {
  private readonly items = new Map<string, Challenge>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(address: string, chainId: string = SN_MAIN): Challenge {
    this.sweep();
    const challenge: Challenge = {
      // A felt, not base64: the nonce is signed as a SNIP-12 felt field, and a
      // short string caps at 31 characters. 128 bits of randomness.
      nonce: `0x${randomBytes(16).toString("hex")}`,
      address: normalizeFelt(address),
      chainId: normalizeFelt(chainId),
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    };
    this.items.set(challenge.nonce, challenge);
    return challenge;
  }

  /**
   * Consumes a challenge. Returns it only if it exists, has not expired, and
   * belongs to this address on this chain. The nonce is removed on EVERY
   * outcome, so a failed attempt cannot be retried and a valid one cannot be
   * replayed.
   */
  consume(
    nonce: string,
    address: string,
    chainId: string,
  ): { ok: true; challenge: Challenge } | { ok: false; reason: "unknown" | "expired" | "wrong_address" | "wrong_chain" } {
    const challenge = this.items.get(nonce);
    if (challenge === undefined) return { ok: false, reason: "unknown" };
    this.items.delete(nonce);

    if (this.now() > challenge.expiresAt) return { ok: false, reason: "expired" };
    let normalized: string;
    let normalizedChain: string;
    try {
      normalized = normalizeFelt(address);
      normalizedChain = normalizeFelt(chainId);
    } catch {
      return { ok: false, reason: "wrong_address" };
    }
    if (normalized !== challenge.address) return { ok: false, reason: "wrong_address" };
    if (normalizedChain !== challenge.chainId) return { ok: false, reason: "wrong_chain" };
    return { ok: true, challenge };
  }

  private sweep(): void {
    const t = this.now();
    for (const [nonce, c] of this.items) {
      if (t > c.expiresAt) this.items.delete(nonce);
    }
  }

  get size(): number {
    return this.items.size;
  }
}

export type AuthFailure =
  | "missing_auth"
  | "unknown_nonce"
  | "expired_nonce"
  | "wrong_address"
  | "wrong_chain"
  | "bad_signature";

export const AUTH_MESSAGES: Record<AuthFailure, string> = {
  missing_auth: "Please confirm this action in your wallet.",
  unknown_nonce: "That confirmation has already been used. Please try again.",
  expired_nonce: "That confirmation expired. Please try again.",
  wrong_address: "That confirmation was signed by a different wallet.",
  wrong_chain: "Please switch your wallet to Starknet mainnet.",
  bad_signature: "Your wallet signature could not be verified.",
};

export interface AuthCredentials {
  address: string;
  nonce: string;
  chainId: string;
  signature: string[];
}

/** Verifies a credential set. Every failure path burns the nonce. */
/**
 * Verifies that this wallet authorized THIS operation.
 *
 * `operation` is derived by the server from the request it is actually
 * handling: the action the route declares, the method, the path, and the hash
 * of the parsed body. Nothing in it comes from a client claim, so there is no
 * asserted binding to compare and nothing to be fooled by. A caller who signed
 * a different operation produces a different message hash, and the account's
 * own signature check fails.
 */
export async function verifyCredentials(
  credentials: AuthCredentials,
  operation: Omit<AuthorizationBinding, "nonce" | "chainId">,
  challenges: ChallengeStore,
  verifier: SignatureVerifier,
): Promise<{ ok: true; address: string } | { ok: false; reason: AuthFailure }> {
  const consumed = challenges.consume(
    credentials.nonce,
    credentials.address,
    credentials.chainId,
  );
  if (!consumed.ok) {
    const map: Record<string, AuthFailure> = {
      unknown: "unknown_nonce",
      expired: "expired_nonce",
      wrong_address: "wrong_address",
      wrong_chain: "wrong_chain",
    };
    return { ok: false, reason: map[consumed.reason] };
  }

  const hash = authorizationHash(
    { ...operation, nonce: consumed.challenge.nonce, chainId: consumed.challenge.chainId },
    consumed.challenge.address,
  );
  const valid = await verifier.verify(consumed.challenge.address, hash, credentials.signature);
  if (!valid) return { ok: false, reason: "bad_signature" };
  return { ok: true, address: consumed.challenge.address };
}
