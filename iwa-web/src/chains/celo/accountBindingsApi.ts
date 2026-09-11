// chains/celo/accountBindingsApi.ts — typed client for the Celo
// account-binding endpoints of the IWA coordination service.
//
// A separate, small client from lib/backend.ts's `call()` on purpose: that
// helper's friendly-message table is written for a different chain's own
// wrong-network copy, which would be actively wrong for a Celo failure. The
// BackendError class itself is chain-neutral and is reused directly. Lives
// under chains/celo/, not lib/, because it is inherently Celo-specific,
// keeping the isolation boundary clean: lib/ itself stays free of
// Celo-specific imports.
//
// This module never accepts a caller-chosen recipient, contract, or amount:
// every field it sends is exactly what the organizer/saver flow computed,
// never free-form input forwarded as-is.

import { BackendError } from "../../lib/backend";
import type { SignedCeloAuthorization } from "./organizerAuthorization";

const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");

/** Human copy for Celo/EVM organizer-authorization failures. Mirrors backend/src/celoAuth.ts's CELO_AUTH_MESSAGES in meaning, not code. */
const FRIENDLY: Record<string, string> = {
  missing_auth: "Please confirm this action in your wallet.",
  malformed_authorization: "That confirmation could not be read. Please try again.",
  expired_authorization: "That confirmation expired. Please try again.",
  authorization_window_too_long: "That confirmation's validity window is too long. Please try again.",
  bad_signature: "Your wallet signature could not be verified.",
  wrong_signer: "This wallet is not the organizer for this circle.",
  reused_nonce: "That confirmation has already been used. Please try again.",
  no_contract_code: "That is not a deployed circle contract on Celo.",
  organizer_call_failed: "That circle contract could not be read.",
  malformed_organizer_response: "That circle contract returned an unexpected response.",
  rpc_unavailable: "Could not reach Celo right now. Please try again shortly.",
  wrong_chain: "Could not confirm this against Celo mainnet. Please try again shortly.",
  already_invited: "An invitation already exists for this member.",
  unknown_invite: "This invitation link is not valid.",
  already_used: "This invitation has already been used.",
  already_bound: "This member already has a linked wallet.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  forbidden_field: "Something went wrong preparing that request.",
  invalid_request: "Something went wrong preparing that request.",
};

async function call<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new BackendError(0, "offline", "Iwa cannot reach its coordination service right now.");
  }

  if (!res.ok) {
    let code = "error";
    let message = "Something went wrong.";
    try {
      const errBody = (await res.json()) as { error?: string; message?: string };
      code = errBody.error ?? code;
      message = FRIENDLY[code] ?? errBody.message ?? message;
    } catch {
      // Non-JSON error body; the generic message stands.
    }
    throw new BackendError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export interface AccountBinding {
  circleId: string;
  memberRef: string;
  chain: string;
  account: string;
  boundAt: string;
}

export type BindingStatus = "none" | "invited" | "bound";

/** Mints a single-use invite for exactly one (circleId, memberRef), authorized by the on-chain organizer. */
export async function createAccountBindingInvite(params: {
  circleId: string;
  circleContract: string;
  memberRef: string;
  chain: string;
  authorization: SignedCeloAuthorization;
}): Promise<{ inviteToken: string }> {
  return call("/api/account-bindings/invites", params);
}

/** Consumes an invite token, linking the caller's own connected account. */
export async function acceptAccountBindingInvite(params: {
  inviteToken: string;
  account: string;
}): Promise<{ binding: AccountBinding }> {
  return call("/api/account-bindings/accept", params);
}

/** Organizer-only: none / invited / bound. Never discloses which account a bound member is linked to. */
export async function readAccountBindingStatus(params: {
  circleId: string;
  circleContract: string;
  memberRef: string;
  authorization: SignedCeloAuthorization;
}): Promise<{ status: BindingStatus }> {
  return call("/api/account-bindings/status", params);
}
