// Iwa User accounts and durable browser sessions.
//
// Email and Google identify a person to Iwa. They are not a member_ref, not a
// wallet, and not authorization to move money. A session minted here is an
// application login: it may open Iwa, and it may never sign a contribution,
// mint an admin overview, or stand in for a chain signature.
//
// The token is an opaque random string. Only its SHA-256 lives in storage.
// The raw value travels in an HttpOnly cookie and is never returned in JSON.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

export const IWA_SESSION_COOKIE = "iwa_session";
export const IWA_CSRF_COOKIE = "iwa_csrf";
export const IWA_CSRF_HEADER = "x-iwa-csrf";

/** Thirty days. Each authenticated use renews this window. */
export const IWA_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Several devices are normal. Unbounded is not. Oldest live session is dropped. */
export const MAX_ACCOUNT_SESSIONS_PER_USER = 20;

export type IwaUserStatus = "active" | "suspended";
export type OnboardingStatus = "new" | "incomplete" | "completed";
export type AuthProvider = "google" | "email";

/**
 * The fixed account-and-wallet onboarding order. This account layer owns only
 * the entry transition today; later stages need their own reviewed security
 * requirements before the server will permit them.
 */
export const ONBOARDING_STEPS = [
  "profile",
  "passwordPin",
  "walletProvisioning",
  "recovery",
  "finish",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingTransition = { from: "new" | OnboardingStep; to: OnboardingStep };
export type OnboardingTransitionKind = "start" | "advance" | "retry";

export interface OnboardingProgress {
  status: OnboardingStatus;
  step: OnboardingStep;
}

/**
 * The database owns this stage. It is progress metadata only and never proves
 * that a wallet, credential, or recovery method exists.
 */
export function onboardingProgress(status: OnboardingStatus, step: OnboardingStep): OnboardingProgress {
  return { status, step };
}

/**
 * Only the opening state change belongs to this foundation. Retrying that
 * same start request after its response was lost is harmless, while every
 * future or out-of-order step is fail-closed.
 */
export function onboardingTransitionKind(
  status: OnboardingStatus,
  step: OnboardingStep,
  transition: OnboardingTransition,
): OnboardingTransitionKind | null {
  if (status === "new" && step === "profile" && transition.from === "new" && transition.to === "profile") {
    return "start";
  }
  if (
    status === "incomplete" &&
    step === "profile" &&
    transition.to === "profile" &&
    (transition.from === "new" || transition.from === "profile")
  ) {
    return "retry";
  }
  if (status === "incomplete" && step === "profile" && transition.from === "profile" && transition.to === "passwordPin") {
    return "advance";
  }
  if (
    status === "incomplete" &&
    step === "passwordPin" &&
    transition.to === "passwordPin" &&
    (transition.from === "profile" || transition.from === "passwordPin")
  ) {
    return "retry";
  }
  return null;
}

export function parseOnboardingTransition(value: unknown): OnboardingTransition | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return null;
  const from = record.from;
  const to = record.to;
  if (from !== "new" && !ONBOARDING_STEPS.includes(from as OnboardingStep)) return null;
  if (!ONBOARDING_STEPS.includes(to as OnboardingStep)) return null;
  return {
    from: from === "new" ? "new" : (from as OnboardingStep),
    to: to as OnboardingStep,
  };
}

export interface IwaUser {
  id: string;
  email: string;
  status: IwaUserStatus;
  onboardingStatus: OnboardingStatus;
  onboardingStep: OnboardingStep;
  createdAt: string;
  updatedAt: string;
}

export interface AuthIdentity {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerSubject: string;
  verifiedEmail: string;
  createdAt: string;
}

export interface AccountSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  userAgent: string | null;
  deviceLabel: string | null;
}

export interface VerifiedIdentity {
  provider: AuthProvider;
  subject: string;
  email: string;
}

export interface IdentityVerifier {
  /** Returns a verified identity, or null when the credential is not acceptable. */
  verify(accessToken: string): Promise<VerifiedIdentity | null>;
}

export interface EmailOtpSender {
  send(email: string, redirectTo?: string): Promise<void>;
}

/** Trim + lowercase. The only email form Iwa stores or compares. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isNormalizedEmail(email: string): boolean {
  if (email !== normalizeEmail(email)) return false;
  if (email.length < 3 || email.length > 254) return false;
  return EMAIL.test(email);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== "string" || header.length === 0) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name.length === 0) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Cookie attributes for the Iwa session.
 *
 * SameSite=Lax is the default (same-site localhost and a same-origin proxy).
 * Cross-site SPAs (frontend host ≠ API host) cannot receive Lax cookies on
 * fetch, so those responses use None — which browsers require to be Secure.
 */
export function sessionCookieAttributes(input: {
  token: string;
  maxAgeSeconds: number;
  secure: boolean;
  sameSite: "Lax" | "None";
}): string {
  const sameSite = input.sameSite;
  const secure = sameSite === "None" ? true : input.secure;
  const parts = [
    `${IWA_SESSION_COOKIE}=${input.token}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${input.maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function csrfCookieAttributes(input: {
  token: string;
  maxAgeSeconds: number;
  secure: boolean;
  sameSite: "Lax" | "None";
}): string {
  const sameSite = input.sameSite;
  const secure = sameSite === "None" ? true : input.secure;
  const parts = [
    `${IWA_CSRF_COOKIE}=${input.token}`,
    "Path=/",
    `SameSite=${sameSite}`,
    `Max-Age=${input.maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieAttributes(secure: boolean, sameSite: "Lax" | "None"): string {
  const parts = [
    `${IWA_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    "Max-Age=0",
  ];
  if (secure || sameSite === "None") parts.push("Secure");
  return parts.join("; ");
}

export function clearCsrfCookieAttributes(secure: boolean, sameSite: "Lax" | "None"): string {
  const parts = [`${IWA_CSRF_COOKIE}=`, "Path=/", `SameSite=${sameSite}`, "Max-Age=0"];
  if (secure || sameSite === "None") parts.push("Secure");
  return parts.join("; ");
}

export function sameSiteFor(requestOrigin: string | undefined, requestHost: string): "Lax" | "None" {
  if (typeof requestOrigin !== "string" || requestOrigin.length === 0) return "Lax";
  try {
    const originHost = new URL(requestOrigin).hostname;
    if (originHost === requestHost) return "Lax";
    if (originHost === "localhost" && requestHost === "localhost") return "Lax";
    return "None";
  } catch {
    return "Lax";
  }
}

/** Public user projection. Never includes session material. */
export function publicUser(user: IwaUser): {
  id: string;
  email: string;
  status: IwaUserStatus;
  onboardingStatus: OnboardingStatus;
  onboardingStep: OnboardingStep;
} {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    onboardingStatus: user.onboardingStatus,
    onboardingStep: user.onboardingStep,
  };
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function parseB64urlJson(part: string): unknown {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(padded, "base64");
  return JSON.parse(buf.toString("utf8"));
}

/** Legacy HS256 helper retained for bounded compatibility tests and old tokens. */
export function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

export function verifyHs256Jwt(
  token: string,
  secret: string,
  nowSeconds: number,
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, bodyB64, sigB64] = parts;
  if (!headerB64 || !bodyB64 || !sigB64) return null;

  let header: { alg?: unknown };
  try {
    header = parseB64urlJson(headerB64) as { alg?: unknown };
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  const data = `${headerB64}.${bodyB64}`;
  const expected = createHmac("sha256", secret).update(data).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let payload: Record<string, unknown>;
  try {
    const parsed = parseB64urlJson(bodyB64);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) return null;
  return payload;
}

/**
 * Reads a Supabase Auth access token into an Iwa identity.
 *
 * Fail closed: missing email, unverified email, wrong audience, or unknown
 * provider are all refusals. The token is proof of identity, not a session.
 */
export function identityFromSupabasePayload(payload: Record<string, unknown>): VerifiedIdentity | null {
  const emailRaw = payload.email;
  if (typeof emailRaw !== "string") return null;
  const email = normalizeEmail(emailRaw);
  if (!isNormalizedEmail(email)) return null;

  const confirmed =
    payload.email_confirmed === true ||
    typeof payload.email_confirmed_at === "string" ||
    payload.role === "authenticated";
  if (!confirmed) return null;

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) return null;

  const meta = payload.app_metadata;
  const providerRaw =
    meta !== null && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as { provider?: unknown }).provider
      : undefined;
  const provider =
    providerRaw === "google" ? "google" : providerRaw === "email" ? "email" : null;
  if (provider === null) return null;

  return { provider, subject: sub, email };
}

export class SupabaseJwtVerifier implements IdentityVerifier {
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    supabaseUrl: string,
    private readonly legacyHs256Secret = "",
    private readonly now: () => number = () => Date.now(),
  ) {
    this.issuer = `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(accessToken: string): Promise<VerifiedIdentity | null> {
    try {
      const header = decodeProtectedHeader(accessToken);
      const currentDate = new Date(this.now());
      let payload: Record<string, unknown>;

      if (header.alg === "ES256") {
        const verified = await jwtVerify(accessToken, this.jwks, {
          algorithms: ["ES256"],
          audience: "authenticated",
          issuer: this.issuer,
          currentDate,
        });
        payload = verified.payload as Record<string, unknown>;
      } else if (header.alg === "HS256" && this.legacyHs256Secret.length > 0) {
        const verified = await jwtVerify(
          accessToken,
          new TextEncoder().encode(this.legacyHs256Secret),
          {
            algorithms: ["HS256"],
            audience: "authenticated",
            issuer: this.issuer,
            currentDate,
          },
        );
        payload = verified.payload as Record<string, unknown>;
      } else {
        return null;
      }

      const nowSeconds = Math.floor(this.now() / 1000);
      if (
        payload.aud !== "authenticated" ||
        payload.iss !== this.issuer ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        payload.exp <= nowSeconds
      ) {
        return null;
      }
      return identityFromSupabasePayload(payload);
    } catch {
      return null;
    }
  }
}

export function googleAuthorizeUrl(supabaseUrl: string, redirectTo: string): string {
  const base = supabaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/auth/v1/authorize`);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", redirectTo);
  return url.toString();
}

export class SupabaseEmailOtpSender implements EmailOtpSender {
  constructor(
    private readonly supabaseUrl: string,
    private readonly anonKey: string,
  ) {}

  async send(email: string, redirectTo?: string): Promise<void> {
    const base = this.supabaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/auth/v1/otp`, {
      method: "POST",
      headers: {
        apikey: this.anonKey,
        authorization: `Bearer ${this.anonKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email,
        create_user: true,
        ...(redirectTo !== undefined ? { options: { email_redirect_to: redirectTo } } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error("otp_send_failed");
    }
  }
}
