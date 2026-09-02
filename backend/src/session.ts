// Read-only sessions.
//
// WHY THIS EXISTS
//
// Phase 6C bound every wallet signature to one exact operation, which is right
// and is not changing. But a signature per request meant a wallet prompt per
// private page: opening My circles, then Invitations, then a standing summary
// asked a person to approve three separate reads of their own data. People
// approve prompts they stop reading, and a prompt nobody reads is not consent.
//
// So a session is traded for the repetition, once, and only for reads. One
// signature that says session:create in the wallet, and the reads that follow
// carry an opaque token instead.
//
// WHAT A SESSION IS NOT
//
// It is not a weaker signature. It authorizes strictly less: read-only, one
// wallet, one chain, and nothing that changes coordination state or moves
// money. Every mutation still requires the full Phase 6C action-bound
// signature, and no route accepts a session in its place. The reads a session
// permits are the reads that wallet could already perform by signing; the
// session only removes the asking.
//
// WHAT IS STORED
//
// The token is the credential, so what is kept here is its SHA-256 hash. A
// dump of this process, or of a future table with the same columns, yields
// nothing anybody can present. Nothing else about the person is recorded: no
// signature, no key, no member commitment, no financial history. Address,
// chain, scope and three timestamps, which is exactly what an authorization
// decision needs and no more.
//
// WHERE IT LIVES
//
// In this process, matching ChallengeStore and the single-replica deployment
// the service already documents. A restart invalidates outstanding sessions,
// which costs one new sign-in and loses nothing: a session holds no state that
// is not derivable again from the wallet.

import { createHash, randomBytes } from "node:crypto";

import { normalizeFelt } from "./validation.js";

/**
 * The only scope that exists.
 *
 * Deliberately a closed set of one. A scope field that could hold "write" is an
 * invitation to add it later without the argument being had again; a route that
 * wants more than reading must ask for a signature.
 */
export const SESSION_SCOPE = "read" as const;
export type SessionScope = typeof SESSION_SCOPE;

/**
 * How long a session survives without being used.
 *
 * Thirty minutes. A person checking their circles comes back well inside it,
 * and an abandoned tab stops being a credential before the machine it is on is
 * likely to change hands.
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * How long a session may live however busy it is.
 *
 * Eight hours, so that continuous use cannot extend a single sign-in
 * indefinitely. In practice the client holds the token in memory only and a
 * closed tab already ends the session, so this is the ceiling rather than the
 * common case.
 */
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

/**
 * How many live sessions one wallet may hold at once.
 *
 * Several is normal: two tabs, a phone and a laptop. Unbounded is not, and
 * capping per wallet is what keeps one wallet from filling the store. The
 * oldest is dropped, so signing in again always works.
 */
export const MAX_SESSIONS_PER_ADDRESS = 5;

/**
 * How many live sessions this process will hold in total.
 *
 * At the cap, creation is refused rather than evicting somebody else. Evicting
 * would let whoever can mint sessions push everyone else out; refusing costs
 * the newcomer a retry and takes nothing from anyone already signed in.
 */
export const MAX_SESSIONS = 10_000;

export interface SessionRecord {
  /** SHA-256 of the token. The token itself is never stored. */
  tokenHash: string;
  address: string;
  chainId: string;
  scope: SessionScope;
  createdAt: number;
  lastUsedAt: number;
  /** The absolute end, fixed at creation and never extended. */
  expiresAt: number;
}

export type SessionFailure = "unknown" | "idle" | "expired" | "wrong_chain";

export interface CreatedSession {
  /** Returned to the caller once and never recoverable from this store. */
  token: string;
  expiresAt: number;
  scope: SessionScope;
}

/** SHA-256 of a token, hex. The stored form. */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SessionStore {
  private readonly items = new Map<string, SessionRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Mints a session for a wallet that has just proved control of its account.
   *
   * The caller is responsible for that proof; this store does not verify
   * signatures and must never be reachable without one. Returns null when the
   * process is already holding as many sessions as it will.
   */
  create(address: string, chainId: string): CreatedSession | null {
    this.sweep();

    const normalizedAddress = normalizeFelt(address);
    const normalizedChain = normalizeFelt(chainId);

    this.trimFor(normalizedAddress);
    if (this.items.size >= MAX_SESSIONS) return null;

    // 256 bits from the system CSPRNG. base64url so it travels in a header
    // without escaping.
    const token = randomBytes(32).toString("base64url");
    const t = this.now();
    this.items.set(hashToken(token), {
      tokenHash: hashToken(token),
      address: normalizedAddress,
      chainId: normalizedChain,
      scope: SESSION_SCOPE,
      createdAt: t,
      lastUsedAt: t,
      expiresAt: t + SESSION_ABSOLUTE_MS,
    });

    return { token, expiresAt: t + SESSION_ABSOLUTE_MS, scope: SESSION_SCOPE };
  }

  /**
   * Checks a token and, if it is good, records that it was used.
   *
   * `expectedChainId` is the chain the route operates on, supplied by the
   * server rather than by the caller. A session minted for another network
   * cannot read this one's coordination data even though the wallet is the
   * same, because what a circle means depends on which chain it is on.
   */
  validate(
    token: string,
    expectedChainId: string,
  ): { ok: true; session: SessionRecord } | { ok: false; reason: SessionFailure } {
    const record = this.items.get(hashToken(token));
    if (record === undefined) return { ok: false, reason: "unknown" };

    const t = this.now();
    if (t > record.expiresAt) {
      this.items.delete(record.tokenHash);
      return { ok: false, reason: "expired" };
    }
    if (t - record.lastUsedAt > SESSION_IDLE_MS) {
      this.items.delete(record.tokenHash);
      return { ok: false, reason: "idle" };
    }

    let normalizedChain: string;
    try {
      normalizedChain = normalizeFelt(expectedChainId);
    } catch {
      return { ok: false, reason: "wrong_chain" };
    }
    // Not deleted: the session is perfectly good, it is simply not good here.
    if (normalizedChain !== record.chainId) return { ok: false, reason: "wrong_chain" };

    record.lastUsedAt = t;
    return { ok: true, session: record };
  }

  /** Ends a session. True when there was one to end. */
  revoke(token: string): boolean {
    return this.items.delete(hashToken(token));
  }

  /** Ends every session belonging to one wallet. Returns how many. */
  revokeAllFor(address: string): number {
    let normalized: string;
    try {
      normalized = normalizeFelt(address);
    } catch {
      return 0;
    }
    let count = 0;
    for (const [key, record] of this.items) {
      if (record.address === normalized) {
        this.items.delete(key);
        count += 1;
      }
    }
    return count;
  }

  /** The stored records, for tests and for a health count. Never the tokens. */
  records(): SessionRecord[] {
    return [...this.items.values()];
  }

  get size(): number {
    return this.items.size;
  }

  /** Drops everything that has ended, by either clock. */
  private sweep(): void {
    const t = this.now();
    for (const [key, record] of this.items) {
      if (t > record.expiresAt || t - record.lastUsedAt > SESSION_IDLE_MS) {
        this.items.delete(key);
      }
    }
  }

  /** Keeps one wallet inside its cap, dropping its oldest sessions first. */
  private trimFor(address: string): void {
    const mine = [...this.items.values()]
      .filter((r) => r.address === address)
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = mine.length - (MAX_SESSIONS_PER_ADDRESS - 1);
    for (let i = 0; i < excess; i += 1) {
      const record = mine[i];
      if (record !== undefined) this.items.delete(record.tokenHash);
    }
  }
}
