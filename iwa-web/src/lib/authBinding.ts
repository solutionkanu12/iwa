// What a signature actually authorizes.
//
// MIRRORS backend/src/authBinding.ts exactly. The two build the same message
// from the same inputs, and the fixed vectors in both test suites are what keep
// them in step: if either drifts, every authenticated call stops verifying.
//
// A signature used to say "this wallet approves an Iwa organizer action", which
// meant one obtained for a harmless read authorized a reorder just as well. It
// now commits to the exact operation: which action, which method, which
// resource, and the exact body. The wallet shows the action, so a person can
// see what they are approving rather than a sentence that fits anything.
//
// The server derives every bound value from the request it actually receives
// and never from a claim made here. This file exists so the client signs the
// same thing the server will check, not so the client can assert it.

import { hash as snHash } from "starknet";

/** The operations a signature can authorize. Mirrors the server's list. */
export const AUTH_ACTIONS = {
  /**
   * Mints a read-only session. It is an action like any other and is bound
   * like any other: a signature that says session:create cannot be spent on a
   * reorder, and a signature obtained for a read cannot mint a session.
   */
  sessionCreate: "session:create",
  draftCreate: "draft:create",
  draftReadOrganizer: "draft:read-organizer",
  draftReorder: "draft:reorder",
  draftMarkCreated: "draft:mark-created",
  draftReconcile: "draft:reconcile",
  draftsList: "drafts:list",
  associationsList: "associations:list",
  invitationsList: "invitations:list",
} as const;

export type AuthAction = (typeof AUTH_ACTIONS)[keyof typeof AUTH_ACTIONS];

/**
 * Canonical JSON.
 *
 * Object keys sorted, array order preserved because order carries meaning here,
 * undefined members dropped exactly as JSON.stringify drops them, and anything
 * that cannot be represented exactly refused rather than coerced.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") throw new Error("cannot canonicalize a bigint");
  if (t === "undefined" || t === "function" || t === "symbol") {
    throw new Error(`cannot canonicalize ${t}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** A felt-sized digest of a string. Same function on both sides of the wire. */
function feltHash(text: string): string {
  return `0x${snHash.starknetKeccak(text).toString(16)}`;
}

/** The hash of a request body. An absent body binds an empty one, never nothing. */
export function hashBody(body: unknown): string {
  const value = body === undefined || body === null ? {} : body;
  return feltHash(canonicalJson(value));
}

/** The hash of the resource being acted on: the path, normalized. */
export function hashResource(path: string): string {
  const normalized = path.replace(/\/+$/, "").toLowerCase() || "/";
  return feltHash(normalized);
}

export interface AuthorizationBinding {
  action: AuthAction;
  method: string;
  resourceHash: string;
  bodyHash: string;
  nonce: string;
  chainId: string;
}

/**
 * The SNIP-12 payload the wallet displays and signs.
 *
 * Version 2. The bump is part of the fix: anything signed under the old,
 * unbound version one produces a different hash and is no longer accepted, so
 * a signature obtained before this change cannot be spent after it.
 */
export function authorizationTypedData(binding: AuthorizationBinding) {
  return {
    domain: { name: "Iwa", version: "2", chainId: binding.chainId },
    types: {
      StarkNetDomain: [
        { name: "name", type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
      ],
      Authorization: [
        { name: "action", type: "felt" },
        { name: "method", type: "felt" },
        { name: "resource", type: "felt" },
        { name: "body", type: "felt" },
        { name: "nonce", type: "felt" },
      ],
    },
    primaryType: "Authorization",
    message: {
      action: binding.action,
      method: binding.method.toUpperCase(),
      resource: binding.resourceHash,
      body: binding.bodyHash,
      nonce: binding.nonce,
    },
  };
}
