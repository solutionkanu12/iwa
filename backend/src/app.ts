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
import {
  AUTH_MESSAGES,
  challengeTypedData,
  ChallengeStore,
  verifyCredentials,
  type SignatureVerifier,
} from "./auth.js";
import {
  acceptInviteSchema,
  assertNoSecrets,
  createDraftSchema,
  ForbiddenFieldError,
  markCreatedSchema,
  isFelt,
  normalizeFelt,
  reorderSchema,
  SN_MAIN,
} from "./validation.js";

export interface AppOptions {
  store: Store;
  corsOrigins: string[];
  /** Verifies wallet signatures. Injected so routes are testable without RPC. */
  verifier: SignatureVerifier;
  challenges?: ChallengeStore;
  /** Mutations allowed per window, per client. */
  rateLimit?: { windowMs: number; max: number };
  now?: () => number;
}

/**
 * Fixed-window limiter for mutating routes. In-process by design: one replica
 * is the deployment shape, and a shared limiter would be a dependency this
 * service does not need yet.
 */
function createRateLimiter(windowMs: number, max: number, now: () => number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): { allowed: boolean; retryAfterMs: number } => {
    const t = now();
    const entry = hits.get(key);
    if (entry === undefined || t >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: t + windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= max) return { allowed: false, retryAfterMs: entry.resetAt - t };
    entry.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  };
}

/** Slots as the frontend needs them. Invite tokens are never listed publicly. */
function publicDraft(draft: CircleDraft, includeTokens: boolean) {
  return {
    id: draft.id,
    chainId: draft.chainId,
    organizerAddress: draft.organizerAddress,
    token: draft.token,
    contributionAmount: draft.contributionAmount,
    cadenceSeconds: draft.cadenceSeconds,
    graceSeconds: draft.graceSeconds,
    memberCount: draft.memberCount,
    status: draft.status,
    circleId: draft.circleId,
    createdTx: draft.createdTx,
    createdAt: draft.createdAt,
    acceptedCount: draft.slots.filter((s) => s.memberRef !== null).length,
    slots: draft.slots.map((s) => ({
      slotIndex: s.slotIndex,
      accepted: s.memberRef !== null,
      memberRef: s.memberRef,
      authPublicKey: s.authPublicKey,
      acceptedAt: s.acceptedAt,
      ...(includeTokens ? { inviteToken: s.inviteToken } : {}),
    })),
  };
}

export function createApp(options: AppOptions): Express {
  const { store, corsOrigins } = options;
  const now = options.now ?? (() => Date.now());
  const limit = options.rateLimit ?? { windowMs: 60_000, max: 20 };
  const limiter = createRateLimiter(limit.windowMs, limit.max, now);

  const challenges = options.challenges ?? new ChallengeStore(now);
  const verifier = options.verifier;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "32kb" }));

  // Exact-origin CORS. No wildcard, and no credentials: the API is
  // origin-restricted but not cookie-authenticated.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
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
   * Proves the caller controls the address they claim. Returns the verified
   * address, or null after already sending the error response.
   */
  const authenticate = async (req: Request, res: Response): Promise<string | null> => {
    const address = req.header("x-iwa-address");
    const nonce = req.header("x-iwa-nonce");
    const chainId = req.header("x-iwa-chain") ?? SN_MAIN;
    const rawSignature = req.header("x-iwa-signature");

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

    const result = await verifyCredentials(
      { address, nonce, chainId, signature },
      challenges,
      verifier,
    );
    if (!result.ok) {
      res.status(401).json({ error: result.reason, message: AUTH_MESSAGES[result.reason] });
      return null;
    }
    return result.address;
  };

  // --- health ---

  app.get("/health", async (_req, res) => {
    const dbOk = await store.healthy();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? "ok" : "degraded",
      database: dbOk ? "up" : "down",
      custody: "none",
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
    res.json({
      nonce: challenge.nonce,
      chainId: challenge.chainId,
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      // The exact payload the wallet must sign.
      typedData: challengeTypedData(challenge.nonce, challenge.chainId),
    });
  });

  // --- drafts ---

  app.post("/api/drafts", async (req, res, next) => {
    if (!mutate(req, res)) return;
    const parsed = createDraftSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues);
    try {
      const caller = await authenticate(req, res);
      if (caller === null) return;
      if (caller !== parsed.data.organizerAddress) {
        return res.status(403).json({ error: "not_organizer", message: "Sign in with the wallet that will organize this circle." });
      }
      const draft = await store.createDraft(parsed.data);
      // The organizer alone receives the invite tokens, at creation time.
      res.status(201).json(publicDraft(draft, true));
    } catch (e) {
      next(e);
    }
  });

  // Public read: terms and progress, never invite tokens.
  app.get("/api/drafts/:id", async (req, res, next) => {
    try {
      const draft = await store.getDraft(req.params.id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      res.json(publicDraft(draft, false));
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
      const draft = await store.getDraft(req.params.id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      const caller = await authenticate(req, res);
      if (caller === null) return;
      if (caller !== draft.organizerAddress) {
        return res.status(403).json({ error: "not_organizer", message: "Only the organizer can see the invitations." });
      }
      res.json(publicDraft(draft, true));
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/drafts/mine", async (req, res, next) => {
    if (!mutate(req, res)) return;
    try {
      const caller = await authenticate(req, res);
      if (caller === null) return;
      const drafts = await store.listDraftsByOrganizer(caller);
      res.json(drafts.map((d) => publicDraft(d, true)));
    } catch (e) {
      next(e);
    }
  });

  // --- invitations ---

  /** What an invited member sees before accepting. Never leaks other tokens. */
  app.get("/api/invites/:token", async (req, res, next) => {
    try {
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
        draft: publicDraft(result.draft, false),
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
      const draft = await store.getDraft(req.params.id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      const caller = await authenticate(req, res);
      if (caller === null) return;
      if (draft.organizerAddress !== caller) {
        return res.status(403).json({ error: "not_organizer" });
      }
      if (draft.status === "created") {
        return res.status(409).json({ error: "already_created", message: "This circle already exists." });
      }
      const updated = await store.reorderSlots(req.params.id, parsed.data.order);
      if (updated === null) return badRequest(res, "order must list every existing slot exactly once");
      res.json(publicDraft(updated, true));
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/drafts/:id/created", async (req, res, next) => {
    if (!mutate(req, res)) return;
    const parsed = markCreatedSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error.issues);
    try {
      const draft = await store.getDraft(req.params.id);
      if (draft === null) return res.status(404).json({ error: "not_found" });
      const caller = await authenticate(req, res);
      if (caller === null) return;
      if (draft.organizerAddress !== caller) {
        return res.status(403).json({ error: "not_organizer" });
      }
      const updated = await store.markCreated(
        req.params.id,
        parsed.data.circleId,
        parsed.data.txHash,
      );
      res.json(publicDraft(updated as CircleDraft, true));
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
      res.json(await store.listEventsForCircle(normalizeFelt(SN_MAIN), circleId));
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
