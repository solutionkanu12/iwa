// The HTTP surface.
//
// Coordination and indexing only. This service never holds funds, never signs,
// and never receives key material — every financial action happens in the
// user's wallet against the chain.
//
// Exported as a factory so tests drive the real routes over a real HTTP stack
// with an in-memory store, rather than testing a mock of themselves.

import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { Store, CircleDraft } from "./store.js";
import type { CircleVerifier } from "./chainVerify.js";
import {
  AUTH_MESSAGES,
  ChallengeStore,
  verifyCredentials,
  type SignatureVerifier,
} from "./auth.js";
import {
  AUTH_ACTIONS,
  hashBody,
  hashResource,
  type AuthAction,
} from "./authBinding.js";
import { SessionStore } from "./session.js";
import {
  AdminAllowlist,
  adminOverview,
  NO_CHAIN_HEALTH,
  type ChainHealthReader,
} from "./admin.js";
import {
  acceptInviteSchema,
  isInviteToken,
  isUuid,
  assertNoSecrets,
  createDraftSchema,
  ForbiddenFieldError,
  markCreatedSchema,
  isFelt,
  normalizeFelt,
  reorderSchema,
  SN_MAIN,
} from "./validation.js";

/**
 * The headers an authenticated organizer request carries, in the order
 * `authenticate` reads them: address, nonce, chain, signature.
 *
 * This is the single source of truth. The CORS preflight advertises exactly
 * this list and the auth middleware reads exactly this list, because a header
 * the browser is not told about is a header the browser will not send: the
 * request never arrives and every server-side test still passes.
 */
export const AUTH_HEADERS = [
  "x-iwa-address",
  "x-iwa-nonce",
  "x-iwa-chain",
  "x-iwa-signature",
] as const;

/**
 * The header a read-only session travels in.
 *
 * Deliberately separate from the x-iwa-* wallet headers. They are different
 * credentials proving different things — one is a signature over this exact
 * request, the other a bearer token scoped to reading — and mixing them into
 * one header would make it easy to write code that stops caring which arrived.
 */
export const SESSION_HEADER = "authorization";

/** Request headers the API accepts cross-origin. Nothing beyond what it reads. */
const ALLOWED_HEADERS = ["content-type", SESSION_HEADER, ...AUTH_HEADERS].join(",");

export interface AppOptions {
  store: Store;
  corsOrigins: string[];
  /** Verifies wallet signatures. Injected so routes are testable without RPC. */
  verifier: SignatureVerifier;
  /** Verifies circle creation against the chain. Injected for the same reason. */
  circleVerifier: CircleVerifier;
  challenges?: ChallengeStore;
  sessions?: SessionStore;
  /**
   * Wallets allowed to read the operator dashboard. Absent or empty means the
   * admin API allows nobody, which is how an unconfigured deployment stays
   * closed rather than open.
   */
  adminAddresses?: readonly string[];
  /** Live chain health for the dashboard. Injected so routes test without RPC. */
  chainHealth?: ChainHealthReader;
  /** Reported to operators as the environment. Never a secret. */
  environment?: "development" | "test" | "production";
  /** Mutations allowed per window, per client. */
  rateLimit?: { windowMs: number; max: number };
  /**
   * How many reverse proxies sit in front of this service.
   *
   * One in the deployment: Railway's edge, which appends the real client to
   * X-Forwarded-For. Anything further left in that header is whatever the
   * client chose to send, so trusting the whole chain lets any client mint a
   * new identity per request and reset its own rate limit.
   */
  trustedProxies?: number;
  now?: () => number;
}

export interface RateLimiter {
  (key: string): { allowed: boolean; retryAfterMs: number };
  /** How many clients are currently remembered. For tests. */
  size(): number;
}

/**
 * Fixed-window limiter for mutating routes. In-process by design: one replica
 * is the deployment shape, and a shared limiter would be a dependency this
 * service does not need yet.
 *
 * It forgets a client as soon as their window has closed. Without that it
 * remembers every client it has ever seen, which is a slow leak on its own and
 * a fast one against anything that can present a new identity per request.
 *
 * The sweep is opportunistic rather than scheduled: it runs at most once per
 * window, on a request that was arriving anyway. A timer would keep the process
 * awake and would have to be torn down; this has no lifecycle to get wrong.
 */
export function createRateLimiter(windowMs: number, max: number, now: () => number): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let nextSweepAt = now() + windowMs;

  const sweep = (t: number) => {
    for (const [key, entry] of hits) {
      if (t >= entry.resetAt) hits.delete(key);
    }
    nextSweepAt = t + windowMs;
  };

  const limiter = (key: string): { allowed: boolean; retryAfterMs: number } => {
    const t = now();
    if (t >= nextSweepAt) sweep(t);

    const entry = hits.get(key);
    if (entry === undefined || t >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= max) return { allowed: false, retryAfterMs: entry.resetAt - t };
    entry.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  };

  limiter.size = () => hits.size;
  return limiter;
}

/** Who is being answered. The projection follows from this and nothing else. */
type Audience = "public" | "organizer";

/**
 * A draft, as the audience is entitled to see it.
 *
 * A draft is coordination in progress. The id travels inside a link that can be
 * forwarded, pasted or logged, and before the circle exists on chain nothing
 * about who is in it is public. So the public answer carries the terms and the
 * progress, which is what an invited person needs in order to decide, and
 * carries nothing that ties people to each other.
 *
 * Withheld from the public answer, each for its own reason:
 *
 *   memberRef       a member's commitment. Public on chain once the circle is
 *                   created, but not before, and never together with the rest
 *                   of the set in one request.
 *   authPublicKey   the same, for their settlement key.
 *   acceptedAt      when somebody took their place. Timing is a correlation
 *                   handle even when the identity is not shown.
 *   organizerAddress  ties a wallet to the whole member set in one read.
 *   createdTx       a transaction hash leads back to the organizer's account.
 *   inviteToken     a coordination pointer for one person only.
 *
 * The organizer sees all of it for their own draft: it is their coordination
 * data, and the flow does not work without it.
 */
function draftFor(draft: CircleDraft, audience: Audience) {
  const acceptedCount = draft.slots.filter((s) => s.memberRef !== null).length;
  const terms = {
    id: draft.id,
    chainId: draft.chainId,
    token: draft.token,
    contributionAmount: draft.contributionAmount,
    cadenceSeconds: draft.cadenceSeconds,
    graceSeconds: draft.graceSeconds,
    memberCount: draft.memberCount,
    status: draft.status,
    circleId: draft.circleId,
    createdAt: draft.createdAt,
    acceptedCount,
  };

  if (audience === "public") {
    return {
      ...terms,
      slots: draft.slots.map((s) => ({
        slotId: s.slotId,
        slotIndex: s.slotIndex,
        accepted: s.memberRef !== null,
      })),
    };
  }

  return {
    ...terms,
    organizerAddress: draft.organizerAddress,
    createdTx: draft.createdTx,
    slots: draft.slots.map((s) => ({
      slotId: s.slotId,
      slotIndex: s.slotIndex,
      accepted: s.memberRef !== null,
      memberRef: s.memberRef,
      authPublicKey: s.authPublicKey,
      acceptedAt: s.acceptedAt,
      inviteToken: s.inviteToken,
    })),
  };
}

export function createApp(options: AppOptions): Express {
  const { store, corsOrigins } = options;
  const now = options.now ?? (() => Date.now());
  const limit = options.rateLimit ?? { windowMs: 60_000, max: 20 };
  const limiter = createRateLimiter(limit.windowMs, limit.max, now);

  const challenges = options.challenges ?? new ChallengeStore(now);
  const sessions = options.sessions ?? new SessionStore(now);
  const verifier = options.verifier;
  const circleVerifier = options.circleVerifier;
  const admins = new AdminAllowlist(options.adminAddresses ?? []);
  const chainHealth = options.chainHealth ?? NO_CHAIN_HEALTH;
  const environment = options.environment ?? "development";

  const app = express();
  app.disable("x-powered-by");
  // Exactly the hops that are really there. Not `true`, which trusts the
  // entire forwarding chain including the part the client wrote.
  app.set("trust proxy", options.trustedProxies ?? 1);
  // Exact-origin CORS. No wildcard, and no credentials: the API is
  // origin-restricted but not cookie-authenticated.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "32kb" }));

  /**
   * The body parser's own refusals.
   *
   * Both are the client's doing and both used to arrive at the catch-all as an
   * unhandled error, which answered a bad request with a server error. Neither
   * carries anything the client needs beyond the fact of the refusal.
   */
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err === null || typeof err !== "object") return next(err);
    const e = err as { type?: string; status?: number };
    if (e.type === "entity.too.large") {
      return res.status(413).json({
        error: "payload_too_large",
        message: "That request was too large.",
      });
    }
    if (e.type === "entity.parse.failed" || e.type === "encoding.unsupported") {
      return res.status(400).json({
        error: "invalid_request",
        message: "That request could not be read.",
      });
    }
    return next(err);
  });

  // No client may send key material, even by accident. Rejected loudly.
  app.use((req: Request, res: Response, next: NextFunction) => {
    try {
      assertNoSecrets(req.body);
      next();
    } catch (e) {
      if (e instanceof ForbiddenFieldError) {
        res.status(400).json({ error: "forbidden_field", message: e.message, field: e.field });
        return;
      }
      next(e);
    }
  });

  const mutate = (req: Request, res: Response): boolean => {
    const key = req.ip ?? "unknown";
    const { allowed, retryAfterMs } = limiter(key);
    if (!allowed) {
      res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
      res.status(429).json({ error: "rate_limited", message: "Too many requests. Try again shortly." });
      return false;
    }
    return true;
  };

  const badRequest = (res: Response, issues: unknown) =>
    res.status(400).json({ error: "invalid_request", issues });

  /**
   * The draft id from the path, or null after answering.
   *
   * A path parameter is written by whoever followed the link, and draft ids are
   * a uuid column. An id that is not one reached Postgres, failed the cast, and
   * came back as a server error: a stranger could turn a mistyped link into a
   * 500 and a logged exception. Checked here, an unknown id is simply not
   * found, which is also what it is.
   */
  const draftIdOf = (req: Request, res: Response): string | null => {
    const id = req.params.id;
    if (typeof id === "string" && isUuid(id)) return id;
    res.status(404).json({ error: "not_found" });
    return null;
  };

  /**
   * The chain could not be reached. Not a verdict on the request: an outage
   * must never look like a rejection, or an organizer with a real circle is
   * told their real circle is invalid.
   */
  const verificationUnavailable = (res: Response) =>
    res.status(503).json({
      error: "verification_unavailable",
      message: "Could not reach Starknet to confirm this. Please try again shortly.",
    });

  /**
   * Proves the caller controls the address they claim. Returns the verified
   * address, or null after already sending the error response.
   */
  const authenticate = async (
    req: Request,
    res: Response,
    action: AuthAction,
  ): Promise<string | null> => {
    const [addressHeader, nonceHeader, chainHeader, signatureHeader] = AUTH_HEADERS;
    const address = req.header(addressHeader);
    const nonce = req.header(nonceHeader);
    const chainId = req.header(chainHeader) ?? SN_MAIN;
    const rawSignature = req.header(signatureHeader);

    if (!address || !nonce || !rawSignature) {
      res.status(401).json({ error: "missing_auth", message: AUTH_MESSAGES.missing_auth });
      return null;
    }

    let signature: string[];
    try {
      const parsed: unknown = JSON.parse(rawSignature);
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) throw new Error();
      signature = parsed as string[];
    } catch {
      res.status(401).json({ error: "bad_signature", message: AUTH_MESSAGES.bad_signature });
      return null;
    }

    // Every bound value is taken from the request being handled, never from
    // anything the caller said about it. A body that failed to parse is an
    // empty one here, which is also what the route will see.
    let bodyHash: string;
    try {
      bodyHash = hashBody(req.body);
    } catch {
      res.status(400).json({ error: "invalid_request", message: "That request could not be read." });
      return null;
    }

    const result = await verifyCredentials(
      { address, nonce, chainId, signature },
      {
        action,
        method: req.method,
        resourceHash: hashResource(req.path),
        bodyHash,
      },
      challenges,
      verifier,
    );
    if (!result.ok) {
      res.status(401).json({ error: result.reason, message: AUTH_MESSAGES[result.reason] });
      return null;
    }
    return result.address;
  };

  /**
   * The opaque session token, or null when the caller did not present one.
   *
   * Only the Bearer scheme. Anything else is not a session and is not treated
   * as one: the caller falls through to the signature path and is told what is
   * missing, rather than being handed a confusing session error.
   */
  const bearerToken = (req: Request): string | null => {
    const header = req.header(SESSION_HEADER);
    if (typeof header !== "string") return null;
    const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
    return match === null ? null : (match[1] as string);
  };

  /**
   * Authenticates a READ.
   *
   * Two credentials are accepted here and nowhere else. A read-only session
   * token, which proves the wallet signed in and authorizes nothing but
   * reading. Or the full Phase 6C signature, which is strictly stronger and
   * remains the only credential every other route will take.
   *
   * A session, when present, is the whole answer: the address comes from the
   * session record and no header, body field or claim can influence it. A
   * caller who presents a bearer token is never silently downgraded to the
   * signature path, because that would let a bad token become a prompt for a
   * signature the person did not ask to give.
   *
   * THIS FUNCTION IS FOR READS. Applying it to anything that changes state
   * would let a bearer token authorize a mutation, which is the one thing the
   * session design exists to prevent.
   */
  const authenticateRead = async (
    req: Request,
    res: Response,
    action: AuthAction,
  ): Promise<string | null> => {
    const token = bearerToken(req);
    if (token === null) return authenticate(req, res, action);

    // The chain is the server's, never the caller's: a session minted for
    // another network must not read this one's coordination data.
    const result = sessions.validate(token, SN_MAIN);
    if (!result.ok) {
      // One code for every failure. Expired, idle, revoked, forged or issued
      // for another chain all mean the same thing to the person holding it,
      // and distinguishing them would only tell a guesser how close they are.
      res.status(401).json({
        error: "session_invalid",
        message: "Please sign in to Iwa again.",
      });
      return null;
    }
    return result.session.address;
  };

  // --- health ---

  app.get("/health", async (_req, res) => {
    const dbOk = await store.healthy();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? "ok" : "degraded",
      database: dbOk ? "up" : "down",
      custody: "none",
      // Outstanding challenges live in this process and nowhere else, which
      // means this service must run as exactly one replica. Reported here so
      // the constraint is observable from outside rather than only true in a
      // comment: if this says "in-process" and the service is scaled, roughly
      // half of all organizer actions will fail to authenticate.
      challenges: "in-process",
      // Sessions live here too, and for the same reason: one replica. Scaled
      // out, a token minted by one process is unknown to the next and every
      // other private read would ask the person to sign in again.
      sessions: "in-process",
      time: new Date(now()).toISOString(),
    });
  });

  // --- authentication ---

  app.post("/api/auth/challenge", async (req, res) => {
    if (!mutate(req, res)) return;
    const address = (req.body as { address?: unknown })?.address;
    if (typeof address !== "string" || !isFelt(address)) {
      return res.status(400).json({ error: "invalid_request", message: "address must be a felt" });
    }
    const challenge = challenges.issue(address);
    // A nonce and the chain it is good for. The message that will consume it
    // names the operation, and the client builds that from the call it is about
    // to make, so nothing here needs to know or to be trusted about it.
    res.json({
      nonce: challenge.nonce,
      chainId: challenge.chainId,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
    });
  });

  /**
   * Signs in.
   *
   * One action-bound signature is exchanged for a read-only session, so that
   * looking at your own circles, invitations and standing does not ask you to
   * approve three separate prompts you have stopped reading.
   *
   * The signature is verified exactly as every other Phase 6C signature is,
   * against this route, this method and this body. The address that comes back
   * is the verified one, and it is the only thing the session is bound to.
   */
  app.post("/api/auth/session", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const caller = await authenticate(req, res, AUTH_ACTIONS.sessionCreate);
      if (caller === null) return;

      // Challenges are only ever issued for mainnet and consuming one requires
      // the header to match, so a verified caller is a mainnet caller. The
      // session records the chain anyway, because the check that matters is
      // made when the token is used, not when it is minted.
      const created = sessions.create(caller, SN_MAIN);
      if (created === null) {
        return res.status(503).json({
          error: "sessions_unavailable",
          message: "Iwa cannot sign you in right now. Please try again shortly.",
        });
      }

      res.json({
        token: created.token,
        scope: created.scope,
        expiresAt: new Date(created.expiresAt).toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  /**
   * Signs out.
   *
   * Presenting the token is the whole authorization: it destroys that one
   * session and can do nothing else, so possession is proof enough and no
   * signature is asked for. Always 204, whether or not the token existed —
   * the caller is dropping their copy either way, and an honest answer here
   * would only tell a stranger whether a token they found is live.
   */
  app.post("/api/auth/session/revoke", (req, res) => {
    if (!mutate(req, res)) return;
    const token = bearerToken(req);
    if (token !== null) sessions.revoke(token);
    res.status(204).end();
  });

  // --- drafts ---

  app.post("/api/drafts", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      // Authenticate first, then read the body.
      //
      // The order matters even though the body is not secret. Validating first
      // meant an unauthenticated caller received the whole schema back as a
      // 400, while every other authenticated route answers 401 and says
      // nothing. It also meant attacker-controlled input was parsed before
      // anybody had proved who they were. Neither is dangerous here, and both
      // are the wrong shape.
      //
      // The signature binding is unaffected: `authenticate` hashes the parsed
      // body itself, from the request it is handling, exactly as before.
      const caller = await authenticate(req, res, AUTH_ACTIONS.draftCreate);
      if (caller === null) return;
      const parsed = createDraftSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error.issues);
      if (caller !== parsed.data.organizerAddress) {
        return res.status(403).json({ error: "not_organizer", message: "Sign in with the wallet that will organize this circle." });
      }
      const draft = await store.createDraft(parsed.data);
      // The organizer alone receives the invite tokens, at creation time.
      res.status(201).json(draftFor(draft, "organizer"));
    } catch (e) {
      next(e);
    }
  });

  // Public read: terms and progress, never invite tokens.
  app.get("/api/drafts/:id", async (req, res, next) => {
    try {
      const id = draftIdOf(req, res);
      if (id === null) return;
      const draft = await store.getDraft(id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      res.json(draftFor(draft, "public"));
    } catch (e) {
      next(e);
    }
  });

  /**
   * The organizer view, including invite tokens. Guarded by a signed challenge:
   * knowing the organizer address is not enough, because an address is public.
   */
  app.post("/api/drafts/:id/organizer-view", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const id = draftIdOf(req, res);
      if (id === null) return;
      const draft = await store.getDraft(id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      const caller = await authenticateRead(req, res, AUTH_ACTIONS.draftReadOrganizer);
      if (caller === null) return;
      if (caller !== draft.organizerAddress) {
        return res.status(403).json({ error: "not_organizer", message: "Only the organizer can see the invitations." });
      }
      res.json(draftFor(draft, "organizer"));
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/drafts/mine", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const caller = await authenticateRead(req, res, AUTH_ACTIONS.draftsList);
      if (caller === null) return;
      const drafts = await store.listDraftsByOrganizer(caller);
      res.json(drafts.map((d) => draftFor(d, "organizer")));
    } catch (e) {
      next(e);
    }
  });

  // --- invitations ---

  /** What an invited member sees before accepting. Never leaks other tokens. */
  app.get("/api/invites/:token", async (req, res, next) => {
    try {
      if (!isInviteToken(req.params.token)) {
        return res.status(404).json({ error: "unknown_invite" });
      }
      const draft = await store.getDraftByInviteToken(req.params.token);
      if (draft === null) return res.status(404).json({ error: "unknown_invite" });
      const slot = draft.slots.find((s) => s.inviteToken === req.params.token);
      res.json({
        draftId: draft.id,
        chainId: draft.chainId,
        organizerAddress: draft.organizerAddress,
        contributionAmount: draft.contributionAmount,
        token: draft.token,
        cadenceSeconds: draft.cadenceSeconds,
        graceSeconds: draft.graceSeconds,
        memberCount: draft.memberCount,
        status: draft.status,
        circleId: draft.circleId,
        slotIndex: slot?.slotIndex ?? null,
        alreadyAccepted: slot?.memberRef !== null && slot?.memberRef !== undefined,
      });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/invites/accept", async (req, res, next) => {
    if (!mutate(req, res)) return;
    const parsed = acceptInviteSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues);
    try {
      const result = await store.acceptInvite(parsed.data);
      if (!result.ok) {
        const messages: Record<string, string> = {
          unknown_invite: "This invitation link is not valid.",
          already_accepted: "This place has already been taken.",
          duplicate_member: "You already hold a place in this circle.",
          draft_closed: "This circle is no longer accepting members.",
        };
        return res.status(409).json({ error: result.reason, message: messages[result.reason] });
      }
      res.json({
        slotIndex: result.slotIndex,
        draft: draftFor(result.draft, "public"),
      });
    } catch (e) {
      next(e);
    }
  });

  // --- organizer actions ---

  app.post("/api/drafts/:id/order", async (req, res, next) => {
    if (!mutate(req, res)) return;
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues);
    try {
      const id = draftIdOf(req, res);
      if (id === null) return;
      const draft = await store.getDraft(id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      const caller = await authenticate(req, res, AUTH_ACTIONS.draftReorder);
      if (caller === null) return;
      if (draft.organizerAddress !== caller) {
        return res.status(403).json({ error: "not_organizer" });
      }
      if (draft.status === "created") {
        return res.status(409).json({ error: "already_created", message: "This circle already exists." });
      }
      const updated = await store.reorderSlots(id, parsed.data.order);
      if (updated === null) return badRequest(res, "order must list every existing slot exactly once");
      res.json(draftFor(updated, "organizer"));
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/drafts/:id/created", async (req, res, next) => {
    if (!mutate(req, res)) return;
    const parsed = markCreatedSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues);
    try {
      const id = draftIdOf(req, res);
      if (id === null) return;
      const draft = await store.getDraft(id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      const caller = await authenticate(req, res, AUTH_ACTIONS.draftMarkCreated);
      if (caller === null) return;
      if (draft.organizerAddress !== caller) {
        return res.status(403).json({ error: "not_organizer" });
      }

      // Already settled. Reporting the same creation again is the normal shape
      // of a retry, so it succeeds without re-verifying or rewriting anything.
      // A different circle is a different matter and is refused.
      if (draft.circleId !== null) {
        if (draft.circleId === parsed.data.circleId) {
          return res.json(draftFor(draft, "organizer"));
        }
        return res.status(409).json({
          error: "already_created",
          message: "This draft is already recorded against a different circle.",
        });
      }

      const evidence = await circleVerifier.verifyCreated({
        draft,
        circleId: parsed.data.circleId,
        txHash: parsed.data.txHash,
      });
      if (evidence.status === "unavailable") return verificationUnavailable(res);
      if (evidence.status === "rejected") {
        return res.status(422).json({
          error: "unverified_creation",
          message: `The chain does not support this: ${evidence.reason}.`,
        });
      }

      const updated = await store.markCreated(id, parsed.data.circleId, parsed.data.txHash);
      res.json(draftFor(updated as CircleDraft, "organizer"));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Recovers a creation that happened on chain but was never recorded here.
   *
   * Creation is irreversible and recording it is a separate step, so a closed
   * browser or a moment of downtime between the two leaves a real circle with
   * nothing pointing at it. The chain still knows: a draft's payout order
   * identifies its circle. Nothing is created here and no claim is taken from
   * the caller; the circle id is discovered, never supplied.
   */
  app.post("/api/drafts/:id/reconcile", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const id = draftIdOf(req, res);
      if (id === null) return;
      const draft = await store.getDraft(id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      const caller = await authenticate(req, res, AUTH_ACTIONS.draftReconcile);
      if (caller === null) return;
      if (draft.organizerAddress !== caller) {
        return res.status(403).json({ error: "not_organizer" });
      }
      if (draft.circleId !== null) return res.json(draftFor(draft, "organizer"));

      const found = await circleVerifier.findCircleForDraft(draft);
      if (found.status === "unavailable") return verificationUnavailable(res);
      if (found.status === "absent") {
        return res.status(404).json({
          error: "no_circle_yet",
          message: "No circle for this draft exists on chain yet.",
        });
      }

      const updated = await store.markCreated(id, found.circleId, draft.createdTx);
      res.json(draftFor(updated as CircleDraft, "organizer"));
    } catch (e) {
      next(e);
    }
  });

// --- what belongs to the signed-in wallet ---

  /**
   * The circles this wallet is part of, as organizer or as a member who took a
   * place. Answers "where was I?" after a browser is closed, which is what
   * makes an accepted invitation recoverable without its original link.
   *
   * Scoped to the AUTHENTICATED address and never to anything in the body, so
   * knowing somebody's address buys no access to their coordination data. The
   * reply is a summary: the circle's public terms and this wallet's own place.
   * Membership itself is still the chain's answer, not this one.
   */
  app.post("/api/me/circles", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const caller = await authenticateRead(req, res, AUTH_ACTIONS.associationsList);
      if (caller === null) return;
      res.json(await store.listAssociationsForAddress(caller));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Invitations this wallet accepted. The same associations, narrowed to the
   * ones where a place was actually taken, so organizing a circle does not put
   * it in your invitations.
   */
  app.post("/api/me/invitations", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const caller = await authenticateRead(req, res, AUTH_ACTIONS.invitationsList);
      if (caller === null) return;
      const all = await store.listAssociationsForAddress(caller);
      res.json(all.filter((a) => a.accepted));
    } catch (e) {
      next(e);
    }
  });

  // --- operator dashboard ---

  /**
   * The platform, as an operator needs to see it.
   *
   * THE SIGNATURE PATH ONLY. `authenticate`, deliberately, and never
   * `authenticateRead`: a read-only session is a bearer token, and whoever
   * holds one is treated as its wallet. Requiring a fresh per-request signature
   * means a captured session cannot become operator access, which is the one
   * question this route had to answer well.
   *
   * The allowlist is then checked against the address the signature proved, not
   * against anything the caller sent, and it lives in the environment rather
   * than the database, so writing to Postgres does not make anybody an
   * operator. An unconfigured deployment allows nobody.
   *
   * A caller who is authenticated but not an operator is told exactly that and
   * learns nothing else. There is no hidden URL doing any work here: this route
   * is as reachable as any other and simply refuses.
   *
   * Everything it returns is an aggregate, a health flag or a public contract
   * address. No draft, wallet, member reference, invitation token or circle
   * membership passes through it, and there is nothing here to mutate.
   */
  app.post("/api/admin/overview", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const caller = await authenticate(req, res, AUTH_ACTIONS.adminRead);
      if (caller === null) return;
      if (!admins.allows(caller)) {
        return res.status(403).json({
          error: "not_admin",
          message: "This wallet does not operate Iwa.",
        });
      }

      const [dbOk, coordination, chainHealthy] = await Promise.all([
        store.healthy(),
        store.coordinationCounts(normalizeFelt(SN_MAIN)),
        chainHealth.read(),
      ]);

      res.json(
        adminOverview({
          backend: {
            database: dbOk ? "up" : "down",
            challengeStore: "in-process",
            sessionStore: "in-process",
            liveChallenges: challenges.size,
            liveSessions: sessions.size,
            corsOriginsConfigured: corsOrigins.length,
            environment,
          },
          chain: {
            chainId: SN_MAIN,
            rpcConfigured: chainHealth.configured,
            rpcReachable: chainHealthy.rpcReachable,
            latestBlock: chainHealthy.latestBlock,
            circleContract: chainHealth.circleContract,
            circleReadOk: chainHealthy.circleReadOk,
          },
          coordination,
          now: now(),
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  // --- indexed public data ---

  app.get("/api/circles", async (req, res, next) => {
    try {
      const chain = typeof req.query.chainId === "string" ? req.query.chainId : SN_MAIN;
      res.json(await store.listIndexedCircles(normalizeFelt(chain)));
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/circles/:id/events", async (req, res, next) => {
    const circleId = Number(req.params.id);
    if (!Number.isInteger(circleId) || circleId <= 0) {
      return res.status(400).json({ error: "invalid_request", message: "circle id must be a positive integer" });
    }
    try {
      const events = await store.listEventsForCircle(normalizeFelt(SN_MAIN), circleId);
      // The chain publishes these, so nothing here is secret. What this
      // controls is the cost of correlation: handed a commitment per row,
      // anyone can assemble one person's whole payment history in a single
      // request. The activity is public, the identity is left on chain.
      //
      // txHash stays on purpose. It is the reference anyone needs to verify a
      // reported event against the chain itself, and an activity feed that
      // cannot be checked is worth less than one that can. It does mean the
      // commitment is still reachable, one lookup at a time, which is the
      // honest limit of what this change achieves: bulk correlation through
      // the API is gone, correlation itself is not, and cannot be while the
      // events are public on chain.
      //
      // The indexer's own storage is unchanged; this is the projection only.
      res.json(events.map(({ memberRef: _memberRef, ...event }) => event));
    } catch (e) {
      next(e);
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Errors never leak internals to the client; the detail goes to the log.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("request failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "internal_error", message: "Something went wrong." });
  });

  return app;
}
