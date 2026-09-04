// Operator access, and what an operator is allowed to see.
//
// THE SECURITY REVIEW THIS DESIGN HAD TO PASS
//
// Who can reach /api/admin. Only a wallet whose address appears in the
// ADMIN_ADDRESSES environment variable of the running service. The list is read
// once at boot and normalized; an empty list disables the admin API entirely,
// so a deployment that has not been configured for operators has no admin
// surface rather than an open one.
//
// How access is proven. By the same thing every other privileged operation in
// Iwa is proven by: a single-use challenge, signed by the wallet as SNIP-12
// typed data naming the exact action, method, path and body, verified against
// the account contract on chain. An address is a public string and has never
// been a credential here.
//
// Where enforcement happens. In the route, on the server, after the signature
// verifies. The allowlist check reads the address the signature proved, never a
// header, a body field or anything the caller sent.
//
// What happens if the frontend is bypassed. Nothing changes. The screen is a
// client of this API and holds no authority: curl reaches the same route and
// meets the same signature check and the same allowlist. There is no hidden
// URL, no client-side flag and no shared secret in the bundle to extract.
//
// Whether the role can be forged. Not without the operator's wallet. The role
// is not stored anywhere a request can reach: it is not a column, not a claim
// in a token, and not a field in the session record. Forging it means producing
// a signature the operator's own account contract accepts.
//
// Whether an admin authorization is replayable. No. The nonce is single use and
// is burned on every outcome including failure, the signature commits to the
// method, the path and the body, and the chain id sits in the SNIP-12 domain.
// One admin read authorizes exactly one admin read.
//
// Whether admin reads expose cross-user data. Only in aggregate. Every figure
// this module produces is a count, a boolean or a timestamp. No wallet address,
// member reference, auth key, invitation token, draft id or circle membership
// leaves through it, so an operator learns that four drafts are waiting and
// never who is waiting.
//
// Whether a database compromise grants admin. No. The allowlist lives in the
// process environment, not in Postgres. Somebody who can write to the database
// can corrupt coordination data, which was already true, but cannot make
// themselves an operator.
//
// Whether a stolen read session becomes admin. No, and this is the reason the
// admin route refuses sessions outright. A session is a bearer token: whoever
// holds it is treated as its wallet until it expires. Admin reads therefore
// take the full per-request signature and nothing else, so the credential for
// an operational read cannot be captured and reused.
//
// WHAT THIS MODULE CANNOT DO. It reads. There is no admin mutation in Iwa, and
// this file adds no first one: no repair, no reconciliation on somebody's
// behalf, no pause, and nothing that touches a contract. The deployed contracts
// hold no administrative power to reach even if a route wanted to.

import { normalizeFelt } from "./validation.js";

/**
 * The operators, as the environment names them.
 *
 * Normalized at construction so that case and leading zeroes cannot be used to
 * slip past a comparison, and closed: an empty list matches nobody, which is
 * what makes an unconfigured deployment safe rather than open.
 */
export class AdminAllowlist {
  private readonly addresses: ReadonlySet<string>;

  constructor(addresses: readonly string[]) {
    const normalized = new Set<string>();
    for (const raw of addresses) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      // Throws on anything that is not a felt, at boot, where a misconfigured
      // operator list is a startup failure rather than a silent lockout.
      normalized.add(normalizeFelt(trimmed));
    }
    this.addresses = normalized;
  }

  /** Whether the admin API is configured at all. */
  get enabled(): boolean {
    return this.addresses.size > 0;
  }

  get size(): number {
    return this.addresses.size;
  }

  /**
   * Whether this address operates the platform.
   *
   * Fails closed on anything unparseable, and on every address when the list is
   * empty. The caller must pass an address a signature has already proved.
   */
  allows(address: string): boolean {
    if (this.addresses.size === 0) return false;
    let normalized: string;
    try {
      normalized = normalizeFelt(address);
    } catch {
      return false;
    }
    return this.addresses.has(normalized);
  }
}

/** Counts over the coordination store. Aggregates only, never a row. */
export interface CoordinationCounts {
  draftsTotal: number;
  /** Still collecting acceptances. */
  draftsCollecting: number;
  /** Everybody accepted; the organizer has not created the circle yet. */
  draftsReady: number;
  draftsCreated: number;
  draftsAbandoned: number;
  /** Places across every draft that is not abandoned. */
  placesTotal: number;
  placesAccepted: number;
  /**
   * Drafts recorded as created that carry no circle id. Should always be zero;
   * a non-zero figure is a coordination record that needs looking at.
   */
  createdWithoutCircleId: number;
  /** Circles the indexer has seen on chain. */
  indexedCircles: number;
  /**
   * Circles on chain that no draft records. Each is a creation that completed
   * on Starknet and never reached the coordination service, which is exactly
   * what the organizer's existing reconciliation exists to finish.
   */
  unrecordedChainCircles: number;
  /** ISO timestamp of the oldest draft still collecting, or null. */
  oldestCollectingAt: string | null;
  /** ISO timestamp of the oldest draft ready but not created, or null. */
  oldestReadyAt: string | null;
}

export interface BackendFacts {
  database: "up" | "down";
  /** Where challenges and sessions live. One replica is a deployment constraint. */
  challengeStore: "in-process";
  sessionStore: "in-process";
  liveChallenges: number;
  liveSessions: number;
  /** How many exact origins are configured. Never which. */
  corsOriginsConfigured: number;
  environment: "development" | "test" | "production";
}

export interface ChainFacts {
  chainId: string;
  /** An RPC endpoint is configured. The URL itself is never reported. */
  rpcConfigured: boolean;
  rpcReachable: boolean;
  latestBlock: number | null;
  /** The circle contract this service verifies creations against. Public. */
  circleContract: string;
  /** A view call against that contract answered. */
  circleReadOk: boolean;
}

/** Everything an operator receives. Aggregates, health and public addresses. */
export interface AdminOverview {
  generatedAt: string;
  backend: BackendFacts;
  chain: ChainFacts;
  coordination: CoordinationCounts;
}

/**
 * The response, assembled from facts the caller has already gathered.
 *
 * Deliberately a pass-through with a clock rather than a place where figures
 * are computed: everything here came from a counted query or a chain read, and
 * a number invented at this layer would be a number nobody could trace.
 */
export function adminOverview(input: {
  backend: BackendFacts;
  chain: ChainFacts;
  coordination: CoordinationCounts;
  now: number;
}): AdminOverview {
  return {
    generatedAt: new Date(input.now).toISOString(),
    backend: input.backend,
    chain: input.chain,
    coordination: input.coordination,
  };
}

/**
 * Chain health, read live.
 *
 * Injected so the route can be tested without RPC, and so the failure path is a
 * value rather than an exception: an unreachable node is an operational fact
 * the dashboard should state, not an error that empties the page.
 */
export interface ChainHealthReader {
  /** An RPC endpoint is configured. The URL itself never leaves the service. */
  readonly configured: boolean;
  /** The circle contract this service checks creations against. Public. */
  readonly circleContract: string;
  read(): Promise<Pick<ChainFacts, "rpcReachable" | "latestBlock" | "circleReadOk">>;
}

/**
 * A reader for a deployment with no RPC wired up.
 *
 * Used when nothing better is supplied, and it answers honestly rather than
 * optimistically: not configured, not reachable, no block. An operator reading
 * a dashboard that cannot see the chain should be told that, not shown a blank
 * that looks like calm.
 */
export const NO_CHAIN_HEALTH: ChainHealthReader = {
  configured: false,
  circleContract: "",
  async read() {
    return { rpcReachable: false, latestBlock: null, circleReadOk: false };
  },
};
