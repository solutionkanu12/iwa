// lib/backend.ts — typed client for the IWA coordination service.
//
// The backend coordinates circle drafts and invitations and indexes public
// chain data. It holds no funds, signs nothing, and is never sent key
// material: an invitation carries only the member's public commitment and the
// public x-coordinate of their settlement key, both of which are written to the
// circle contract anyway.
//
// If this service is unavailable, contributing to an existing circle still
// works — that path talks to the chain and the wallet directly.

import type { AdminOverviewFacts } from "./adminView";
import {
  AUTH_ACTIONS,
  authorizationTypedData,
  hashBody,
  hashResource,
  type AuthAction,
} from "./authBinding";

const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");

export class BackendError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}

export interface DraftSlotView {
  /**
   * Stable identity for this place. slotIndex is a position and is renumbered
   * by every reorder, so it must never be used to decide which invite link or
   * which member belongs to a row.
   */
  slotId: string;
  slotIndex: number;
  accepted: boolean;
  /**
   * The next four are the organizer's own coordination data and reach only
   * them. The public view of a draft carries the terms and the progress, so a
   * stranger holding a draft link never receives the set of people in it.
   */
  memberRef?: string | null;
  authPublicKey?: string | null;
  acceptedAt?: string | null;
  inviteToken?: string;
}

export interface DraftView {
  id: string;
  chainId: string;
  /** Organizer view only. */
  organizerAddress?: string;
  token: string;
  contributionAmount: string;
  cadenceSeconds: number;
  graceSeconds: number;
  memberCount: number;
  status: "draft" | "ready" | "created" | "abandoned";
  circleId: number | null;
  /** Organizer view only. */
  createdTx?: string | null;
  createdAt: string;
  acceptedCount: number;
  slots: DraftSlotView[];
}

export interface InviteView {
  draftId: string;
  chainId: string;
  organizerAddress: string;
  contributionAmount: string;
  token: string;
  cadenceSeconds: number;
  graceSeconds: number;
  memberCount: number;
  status: DraftView["status"];
  circleId: number | null;
  slotIndex: number | null;
  alreadyAccepted: boolean;
}

/**
 * One wallet's connection to one circle, as the service reports it.
 *
 * A summary by design: the circle's public terms and this wallet's own place.
 * No invite token, and nobody else's commitment, key or address.
 */
export interface CircleAssociation {
  draftId: string;
  role: "organizer" | "member";
  /** This wallet has taken a place in the circle. */
  accepted: boolean;
  chainId: string;
  token: string;
  /** Base units as a decimal string. Formatted once, at display. */
  contributionAmount: string;
  cadenceSeconds: number;
  graceSeconds: number;
  memberCount: number;
  acceptedCount: number;
  status: DraftView["status"];
  circleId: number | null;
  createdAt: string;
  acceptedAt: string | null;
}

/** Human copy for the coordination failures a person can actually act on. */
const FRIENDLY: Record<string, string> = {
  unknown_invite: "This invitation link is not valid. Ask the organizer for a new one.",
  already_accepted: "This place has already been taken.",
  duplicate_member: "You already hold a place in this circle.",
  draft_closed: "This circle has already been created and is no longer accepting members.",
  not_organizer: "Only the organizer can change this circle.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  missing_auth: "Please confirm this action in your wallet.",
  unknown_nonce: "That confirmation has already been used. Please try again.",
  expired_nonce: "That confirmation expired. Please try again.",
  wrong_address: "That confirmation was signed by a different wallet.",
  wrong_chain: "Please switch your wallet to Starknet mainnet.",
  bad_signature: "Your wallet signature could not be verified.",
  session_invalid: "Your Iwa sign-in has ended. Please sign in again.",
  sessions_unavailable: "Iwa could not sign you in just now. Please try again shortly.",
  forbidden_field: "Something went wrong preparing that request.",
  not_found: "We could not find that circle.",
  already_created: "This circle has already been created.",
  verification_unavailable:
    "We could not reach Starknet to confirm this. Nothing is lost, please try again in a moment.",
  unverified_creation: "Starknet does not show that circle as belonging to this draft.",
  no_circle_yet: "No circle for this draft exists on Starknet yet.",
  not_admin: "This wallet does not operate Iwa.",
};

/** True when the failure is worth retrying rather than reporting as final. */
export function isRetryable(err: unknown): boolean {
  return err instanceof BackendError && (err.status === 0 || err.status === 503);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    // A thrown fetch means the request never got a response: the service is
    // down, the URL is wrong, or CORS blocked it. In development that is
    // almost always a backend that is not running, so say so — a generic
    // "cannot reach" sends you looking in the wrong place.
    const hint = import.meta.env.DEV
      ? ` Expected it at ${BASE_URL}. Start it with: cd backend && npm run dev:memory`
      : "";
    throw new BackendError(
      0,
      "offline",
      `Iwa cannot reach its coordination service right now.${hint}`,
    );
  }

  if (!res.ok) {
    let code = "error";
    let message = "Something went wrong.";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error ?? code;
      message = FRIENDLY[code] ?? body.message ?? message;
    } catch {
      // Non-JSON error body; the generic message stands.
    }
    throw new BackendError(res.status, code, message);
  }

  return (await res.json()) as T;
}

export interface CreateDraftInput {
  chainId: string;
  organizerAddress: string;
  token: string;
  /** Base units as a decimal string. Never a float. */
  contributionAmount: string;
  cadenceSeconds: number;
  graceSeconds: number;
  memberCount: number;
}

/**
 * Signs an organizer action.
 *
 * The service issues a single-use challenge; the wallet signs it; the signature
 * travels as headers. Knowing the organizer address is never enough, because an
 * address is public. Nothing private leaves the browser: a signature is a
 * public artefact and the key that made it stays in the wallet.
 */
export type WalletSigner = (typedData: unknown) => Promise<string[]>;

/** One authenticated call: what it does, where, and with what. */
interface SignedCall {
  action: AuthAction;
  method: "POST";
  path: string;
  body?: unknown;
}

/**
 * Signs exactly one operation and returns the headers for it.
 *
 * The only place auth headers are built. A signature commits to the action, the
 * method, the resource and the body, so one obtained for a harmless read cannot
 * be spent on a reorder, and the wallet shows which of those the person is
 * approving instead of a sentence that fits anything.
 *
 * The service derives all of that from the request it receives and compares
 * nothing this sends: a call signed for something else simply fails to verify.
 */
async function signedHeaders(
  address: string,
  sign: WalletSigner,
  op: SignedCall,
): Promise<Record<string, string>> {
  const challenge = await call<{ nonce: string; chainId: string }>("/api/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ address }),
  });

  const typedData = authorizationTypedData({
    action: op.action,
    method: op.method,
    resourceHash: hashResource(op.path),
    bodyHash: hashBody(op.body),
    nonce: challenge.nonce,
    chainId: challenge.chainId,
  });

  const signature = await sign(typedData);
  return {
    "x-iwa-address": address,
    "x-iwa-nonce": challenge.nonce,
    "x-iwa-chain": challenge.chainId,
    "x-iwa-signature": JSON.stringify(signature),
  };
}

/**
 * Signs and sends one authenticated call.
 *
 * The body is serialised once and both signed and sent, so what was approved
 * and what arrives cannot drift apart.
 */
async function signedCall<T>(address: string, sign: WalletSigner, op: SignedCall): Promise<T> {
  const body = op.body ?? {};
  const headers = await signedHeaders(address, sign, { ...op, body });
  return call<T>(op.path, { method: op.method, headers, body: JSON.stringify(body) });
}

/**
 * How a private READ proves who is asking.
 *
 * Either an opaque read-only session token, obtained once by signing in, or a
 * full per-request signature. Both are verified; the session is not a weaker
 * proof, it is the same proof made once instead of every time.
 *
 * Only reads take this. Everything that changes state takes an address and a
 * signer and nothing else, because a session must never be able to authorize
 * a reorder, a creation record, or anything that moves money.
 */
export type ReadAuth = { session: string } | { address: string; sign: WalletSigner };

/**
 * Sends one authenticated read.
 *
 * With a session the address is not sent at all: the service reads it from the
 * session record. That is the point — a client claim about who is asking has
 * never been the credential, and with a session there is not even a claim to
 * ignore.
 */
async function readCall<T>(auth: ReadAuth, op: SignedCall): Promise<T> {
  if ("session" in auth) {
    return call<T>(op.path, {
      method: op.method,
      headers: { authorization: `Bearer ${auth.session}` },
      body: JSON.stringify(op.body ?? {}),
    });
  }
  return signedCall<T>(auth.address, auth.sign, op);
}

export interface SessionView {
  token: string;
  scope: "read";
  expiresAt: string;
}

export const backend = {
  async health(): Promise<{ status: string; database: string }> {
    return call("/health");
  },

  /**
   * Signs in: one action-bound signature, exchanged for a read-only session.
   *
   * The signature says session:create and is bound to this route and this
   * empty body, exactly as every other authorized operation is. It authorizes
   * one thing — the minting of a token that can read this wallet's own
   * coordination data — and cannot be spent on anything else.
   */
  async createSession(address: string, sign: WalletSigner): Promise<SessionView> {
    return signedCall(address, sign, {
      action: AUTH_ACTIONS.sessionCreate,
      method: "POST",
      path: "/api/auth/session",
    });
  },

  /**
   * Ends a session on the service. Holding the token is the whole
   * authorization, since it can do nothing but destroy itself.
   *
   * Never throws. The copy in memory is dropped by the caller either way, and
   * that is the part that protects the person; this is the tidy-up.
   */
  async revokeSession(token: string): Promise<void> {
    try {
      await fetch(`${BASE_URL}/api/auth/session/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
      });
    } catch {
      // Unreachable service. Already forgotten locally.
    }
  },

  /**
   * The operator dashboard.
   *
   * Takes an address and a signer, never a session, and that is the security
   * property rather than an inconvenience: a session is a bearer token, so
   * accepting one here would mean a captured token became operator access. The
   * service refuses a session on this route regardless of what this client does.
   *
   * The reply is aggregates, health flags and public contract addresses. Nothing
   * about any individual saver exists in it to be shown.
   */
  async adminOverview(address: string, sign: WalletSigner): Promise<AdminOverviewFacts> {
    return signedCall(address, sign, {
      action: AUTH_ACTIONS.adminRead,
      method: "POST",
      path: "/api/admin/overview",
    });
  },

  async createDraft(input: CreateDraftInput, sign: WalletSigner): Promise<DraftView> {
    return signedCall(input.organizerAddress, sign, {
      action: AUTH_ACTIONS.draftCreate,
      method: "POST",
      path: "/api/drafts",
      body: input,
    });
  },

  /** Public view: terms and progress. Never includes invitation links. */
  async getDraft(id: string): Promise<DraftView> {
    return call(`/api/drafts/${id}`);
  },

  /**
   * The organizer view, including the invitation links. Authenticated: the
   * service checks the caller really organizes this draft, whichever credential
   * they presented.
   */
  async getDraftAsOrganizer(id: string, auth: ReadAuth): Promise<DraftView> {
    return readCall(auth, {
      action: AUTH_ACTIONS.draftReadOrganizer,
      method: "POST",
      path: `/api/drafts/${id}/organizer-view`,
    });
  },

  async listDrafts(auth: ReadAuth): Promise<DraftView[]> {
    return readCall(auth, {
      action: AUTH_ACTIONS.draftsList,
      method: "POST",
      path: "/api/drafts/mine",
    });
  },

  /**
   * The circles this wallet is part of, however it got there.
   *
   * Scoped by the service to the signed-in wallet. This is what makes an
   * accepted invitation recoverable after a browser is closed: no token is
   * needed, only the same wallet.
   */
  async myCircles(auth: ReadAuth): Promise<CircleAssociation[]> {
    return readCall(auth, {
      action: AUTH_ACTIONS.associationsList,
      method: "POST",
      path: "/api/me/circles",
    });
  },

  /** The invitations this wallet accepted. */
  async myInvitations(auth: ReadAuth): Promise<CircleAssociation[]> {
    return readCall(auth, {
      action: AUTH_ACTIONS.invitationsList,
      method: "POST",
      path: "/api/me/invitations",
    });
  },

  async getInvite(token: string): Promise<InviteView> {
    return call(`/api/invites/${encodeURIComponent(token)}`);
  },

  /**
   * Accepts an invitation. Sends only public data — the commitment and the
   * public settlement key. The invite secret and the private key stay in the
   * browser and are never transmitted.
   */
  async acceptInvite(input: {
    inviteToken: string;
    memberRef: string;
    authPublicKey: string;
    address: string;
  }): Promise<{ slotIndex: number; draft: DraftView }> {
    return call("/api/invites/accept", { method: "POST", body: JSON.stringify(input) });
  },

  /** `order` names every slot id of the draft exactly once, in the new payout order. */
  async reorder(
    id: string,
    organizerAddress: string,
    order: string[],
    sign: WalletSigner,
  ): Promise<DraftView> {
    return signedCall(organizerAddress, sign, {
      action: AUTH_ACTIONS.draftReorder,
      method: "POST",
      path: `/api/drafts/${id}/order`,
      body: { organizerAddress, order },
    });
  },

  /**
   * Recovers a circle that was created on chain but never recorded here.
   *
   * The circle id is not supplied: the service finds it from the chain by
   * matching this draft's payout order. Safe to call at any time, and safe to
   * call twice.
   */
  async reconcile(
    id: string,
    organizerAddress: string,
    sign: WalletSigner,
  ): Promise<DraftView> {
    return signedCall(organizerAddress, sign, {
      action: AUTH_ACTIONS.draftReconcile,
      method: "POST",
      path: `/api/drafts/${id}/reconcile`,
      body: { organizerAddress },
    });
  },

  async markCreated(
    id: string,
    organizerAddress: string,
    circleId: number,
    txHash: string,
    sign: WalletSigner,
  ): Promise<DraftView> {
    return signedCall(organizerAddress, sign, {
      action: AUTH_ACTIONS.draftMarkCreated,
      method: "POST",
      path: `/api/drafts/${id}/created`,
      body: { organizerAddress, circleId, txHash },
    });
  },
};

/** Share link an organizer hands to one invited member. */
export function inviteLink(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}
