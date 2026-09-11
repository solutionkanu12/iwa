// Celo/EVM wallet-signature authorization.
//
// Mirrors auth.ts's shape (a store of one-time authorizations, a verify
// function that fails closed on every rejection path) without reusing its
// Starknet-specific internals: there is no challenge round-trip here, no
// felt encoding. A standard EOA wallet's ECDSA signature recovers off-chain
// (no on-chain is_valid_signature call needed the way Starknet accounts
// require), so the client picks its own random nonce and the server's job
// is twofold: make sure a given (organizer, nonce) pair is spent at most
// once, and confirm the claimed organizer really is the one the circle
// contract itself names — never a cached or first-claimed value.

import {
  celoAuthorizationTypedData,
  normalizeEvmAddress,
  recoverCeloAuthSigner,
  type CeloAuthorizationMessage,
} from "./celoAuthBinding.js";
import type { CeloOrganizerReader, CeloOrganizerReadResult } from "./celoChainVerify.js";

/** Signed authorizations must expire soon: long enough to sign, short enough that a leaked one is nearly worthless. */
export const CELO_AUTH_MAX_TTL_SECONDS = 5 * 60;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

export type CeloAuthFailure =
  | "missing_auth"
  | "malformed_authorization"
  | "expired_authorization"
  | "authorization_window_too_long"
  | "bad_signature"
  | "wrong_signer"
  | "reused_nonce"
  | "no_contract_code"
  | "organizer_call_failed"
  | "malformed_organizer_response"
  | "rpc_unavailable"
  | "wrong_chain";

export const CELO_AUTH_MESSAGES: Record<CeloAuthFailure, string> = {
  missing_auth: "Please confirm this action in your wallet.",
  malformed_authorization: "That confirmation could not be read.",
  expired_authorization: "That confirmation expired. Please try again.",
  authorization_window_too_long: "That confirmation's validity window is too long. Please try again.",
  bad_signature: "Your wallet signature could not be verified.",
  wrong_signer: "That confirmation was signed by a different wallet.",
  reused_nonce: "That confirmation has already been used. Please try again.",
  no_contract_code: "That address is not a deployed circle contract.",
  organizer_call_failed: "That circle contract could not be read.",
  malformed_organizer_response: "That circle contract returned an unexpected response.",
  rpc_unavailable: "Could not reach Celo to confirm this. Please try again shortly.",
  wrong_chain: "Could not confirm this against Celo mainnet. Please try again shortly.",
};

export interface CeloOrganizerCredentials {
  organizer: string;
  nonce: string;
  expiresAt: number;
  signature: string;
}

/**
 * One-time nonces, scoped per organizer address so one wallet's nonce space
 * cannot collide with another's. In-process, matching this service's
 * documented single-replica deployment (see session.ts) — a restart simply
 * invalidates outstanding authorizations, which costs nothing since a
 * client can always sign a fresh one.
 */
export class CeloAuthNonceStore {
  private readonly used = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Atomically checks-and-marks a (organizer, nonce) pair. No `await`
   * happens between the check and the write, so within this process two
   * concurrent callers cannot both observe "unused" for the same pair.
   *
   * Returns false when the pair was already spent.
   */
  consume(organizer: string, nonce: string, expiresAtMs: number): boolean {
    this.sweep();
    const key = `${organizer}:${nonce}`;
    if (this.used.has(key)) return false;
    this.used.set(key, expiresAtMs);
    return true;
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, expiresAtMs] of this.used) {
      if (t > expiresAtMs) this.used.delete(key);
    }
  }

  get size(): number {
    return this.used.size;
  }
}

type CeloOrganizerReadFailureReason = Extract<CeloOrganizerReadResult, { ok: false }>["reason"];

const READ_FAILURE: Record<CeloOrganizerReadFailureReason, CeloAuthFailure> = {
  no_code: "no_contract_code",
  organizer_call_failed: "organizer_call_failed",
  malformed_organizer_response: "malformed_organizer_response",
  rpc_unavailable: "rpc_unavailable",
  wrong_chain: "wrong_chain",
};

/**
 * Verifies a signed authorization for exactly the (action, circleId,
 * circleContract, memberRef) the server is already handling, AND that the
 * signer really is the organizer `circleContract` names on chain right now
 * — never a cached, first-claimed, or client-supplied value. Every failure
 * path is terminal: nothing here retries or falls back to a weaker check.
 *
 * Cheap, local checks run before the network read on purpose: a malformed
 * or already-doomed request is rejected without spending an RPC call on it.
 * The nonce is consumed last, after every other check has passed, so two
 * concurrent requests for the same signed authorization can both reach the
 * (idempotent) on-chain read, but only one can ever win the final,
 * synchronous consume.
 */
export async function verifyCeloOrganizerAuthorization(
  action: CeloAuthorizationMessage["action"],
  circleId: string,
  circleContract: string,
  memberRef: string,
  credentials: CeloOrganizerCredentials | undefined,
  nonces: CeloAuthNonceStore,
  organizerReader: CeloOrganizerReader,
  now: () => number = () => Date.now(),
): Promise<{ ok: true; organizer: string } | { ok: false; reason: CeloAuthFailure }> {
  if (credentials === undefined) return { ok: false, reason: "missing_auth" };

  const { organizer, nonce, expiresAt, signature } = credentials;
  if (
    !EVM_ADDRESS.test(organizer) ||
    !EVM_ADDRESS.test(circleContract) ||
    !NONCE.test(nonce) ||
    !SIGNATURE.test(signature)
  ) {
    return { ok: false, reason: "malformed_authorization" };
  }
  if (!Number.isFinite(expiresAt) || !Number.isInteger(expiresAt)) {
    return { ok: false, reason: "malformed_authorization" };
  }

  const nowSeconds = Math.floor(now() / 1000);
  if (expiresAt <= nowSeconds) return { ok: false, reason: "expired_authorization" };
  if (expiresAt - nowSeconds > CELO_AUTH_MAX_TTL_SECONDS) {
    return { ok: false, reason: "authorization_window_too_long" };
  }

  const message: CeloAuthorizationMessage = {
    action,
    circleId,
    circleContract,
    memberRef,
    organizer,
    nonce,
    expiresAt,
  };
  const recovered = recoverCeloAuthSigner(message, signature);
  if (recovered === null) return { ok: false, reason: "bad_signature" };

  const normalizedOrganizer = normalizeEvmAddress(organizer);
  // The signature must have been produced by the exact address it claims to
  // authorize. A client cannot name one address in the message while a
  // different key actually signed it: recovery ties the two together
  // cryptographically, and this check refuses to trust the claimed field on
  // its own regardless. This also structurally covers "wrong circle" and
  // "contract mismatch": circleId/circleContract are baked into the signed
  // hash, so a signature produced for a different circle/contract recovers
  // to an unrelated address here, not to a validated-but-wrong claim.
  if (normalizeEvmAddress(recovered) !== normalizedOrganizer) {
    return { ok: false, reason: "wrong_signer" };
  }

  // The authoritative check: read organizer() from the contract itself.
  // Nothing about the client's claimed `organizer` field is trusted past
  // this point — only what the chain actually says.
  const onChain = await organizerReader.readOrganizer(circleContract);
  if (!onChain.ok) return { ok: false, reason: READ_FAILURE[onChain.reason] };
  if (normalizeEvmAddress(onChain.organizer) !== normalizedOrganizer) {
    return { ok: false, reason: "wrong_signer" };
  }

  if (!nonces.consume(normalizedOrganizer, nonce.toLowerCase(), expiresAt * 1000)) {
    return { ok: false, reason: "reused_nonce" };
  }

  return { ok: true, organizer: normalizedOrganizer };
}

export { celoAuthorizationTypedData };
