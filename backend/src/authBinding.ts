// What a signature actually authorizes.
//
// A signature used to say "this wallet approves an Iwa organizer action", and
// nothing more. One obtained for a harmless read therefore authorized a
// reorder, a creation record or a reconciliation just as well: the server had
// no way to tell what the person thought they were approving. Worse, challenges
// are issued to anyone who asks for an address, so a page that was not Iwa
// could obtain one, have a wallet sign that vague sentence, and spend it here.
//
// A signature now commits to the exact operation: which action, which method,
// which resource, and the exact body. Change any of them and the message hash
// changes, so the account's own signature no longer verifies.
//
// THE SERVER DERIVES EVERY BOUND VALUE ITSELF, from the request it is actually
// handling. Nothing in this file reads a client-supplied claim about what the
// request is. There is no `x-iwa-action` header to trust or to compare against,
// because the client is never asked what it is doing: it is observed. A client
// that signed something else simply fails to verify.
//
// The frontend mirrors this file exactly (iwa-web/src/lib/authBinding.ts). The
// two must stay in step, which is what the shared fixed vectors in the tests
// are for.

import { hash as snHash, typedData as snTypedData } from "starknet";

/**
 * The operations a signature can authorize.
 *
 * Explicit and closed. Each authenticated route declares exactly one, so an
 * action is never inferred from a path or from anything a caller sent. Each
 * fits in a felt short string, which is what lets a wallet display it.
 */
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

/** A felt short string holds 31 bytes. Every action has to fit one. */
export const MAX_ACTION_LENGTH = 31;

/**
 * Canonical JSON.
 *
 * Two bodies that mean the same thing must hash the same, or an organizer whose
 * client happened to serialise keys in another order would be refused. Two that
 * differ in any value must hash differently, or the binding is worthless.
 *
 * Object keys are sorted; array order is preserved, because in this API order
 * carries meaning (a payout order is the clearest case). Undefined members are
 * dropped exactly as JSON.stringify drops them, so what is hashed is what would
 * have been sent. Anything that cannot be represented exactly is refused rather
 * than coerced.
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
    // Order is meaningful and is preserved. A hole or an undefined member
    // serialises as null, matching JSON.stringify.
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

/**
 * The hash of a request body.
 *
 * A read carries no body, and binds the hash of an empty object rather than
 * being left unbound: an absent binding is a binding an attacker gets to
 * choose.
 */
export function hashBody(body: unknown): string {
  const value = body === undefined || body === null ? {} : body;
  return feltHash(canonicalJson(value));
}

/**
 * The hash of the resource being acted on.
 *
 * The path as the server sees it, lowercased and without a trailing slash, so
 * that a signature for one draft cannot be spent on another. Every
 * authenticated route's path is fixed segments plus a uuid, so lowercasing is
 * safe and makes the comparison insensitive to how the id was written.
 */
export function hashResource(path: string): string {
  const normalized = path.replace(/\/+$/, "").toLowerCase() || "/";
  return feltHash(normalized);
}

export interface AuthorizationBinding {
  action: AuthAction;
  /** Uppercase, so a signature for a read cannot be spent on a write. */
  method: string;
  /** The request path, normalized and hashed by hashResource. */
  resourceHash: string;
  /** The canonical body, hashed by hashBody. */
  bodyHash: string;
  nonce: string;
  chainId: string;
}

/**
 * The SNIP-12 payload the wallet displays and signs.
 *
 * Version 2. The bump is deliberate and is itself part of the fix: a signature
 * made under the old, unbound version one produces a different message hash and
 * can no longer be verified here, so nothing signed before this change is
 * spendable after it. There is no dual-mode fallback to accept the old shape.
 *
 * chainId stays in the domain, so an authorization for mainnet cannot be
 * replayed against another network. No hostname or origin is bound: the browser
 * does not attest one to the wallet, so binding it would look like protection
 * while resting on a value the attacker controls. The action being legible in
 * the wallet is the real defence against a page that is not Iwa asking for a
 * signature, and that is what the action field gives.
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

/** The hash the account is asked to have signed. */
export function authorizationHash(binding: AuthorizationBinding, address: string): string {
  return snTypedData.getMessageHash(authorizationTypedData(binding), address);
}
