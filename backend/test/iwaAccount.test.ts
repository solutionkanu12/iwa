// Iwa User accounts: Google/email identity, durable cookie sessions, logout.
//
// The session minted here is an application login. It must never authorize a
// draft mutation, an admin read, or anything that moves money. Those stay on
// wallet signatures, exactly as they were.

import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { SN_MAIN } from "../src/validation.js";
import { ChallengeStore, type SignatureVerifier } from "../src/auth.js";
import type { CircleVerifier, DiscoveryOutcome, VerifyOutcome } from "../src/chainVerify.js";
import {
  IWA_CSRF_COOKIE,
  IWA_CSRF_HEADER,
  IWA_SESSION_COOKIE,
  IWA_SESSION_TTL_MS,
  SupabaseJwtVerifier,
  hashSessionToken,
  identityFromSupabasePayload,
  isNormalizedEmail,
  normalizeEmail,
  sessionCookieAttributes,
  signHs256Jwt,
  verifyHs256Jwt,
  type IdentityVerifier,
  type VerifiedIdentity,
} from "../src/iwaAccount.js";

const ORIGIN = "https://www.useiwa.xyz";
const HOST = "iwa-production-2900.up.railway.app";
const USDC = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const ORGANIZER = "0x4099b8ebd6e6c642b4b31bfd27a9c781ab9b41d7f66f80d5c04cc51c0977e85";

class StubVerifier implements SignatureVerifier {
  async verify(address: string, _hash: string, signature: string[]): Promise<boolean> {
    return signature.length === 1 && signature[0] === `signed-by:${address}`;
  }
}

class AlwaysVerifies implements CircleVerifier {
  async verifyCreated(): Promise<VerifyOutcome> {
    return { status: "verified" };
  }
  async findCircleForDraft(): Promise<DiscoveryOutcome> {
    return { status: "absent" };
  }
}

const IDENTITIES: Record<string, VerifiedIdentity> = {
  "google-alice": {
    provider: "google",
    subject: "google-sub-alice",
    email: "alice@example.com",
  },
  "google-alice-again": {
    provider: "google",
    subject: "google-sub-alice",
    email: "alice@example.com",
  },
  "email-alice": {
    provider: "email",
    subject: "email-sub-alice",
    email: "Alice@example.com",
  },
  "email-bob": {
    provider: "email",
    subject: "email-sub-bob",
    email: "bob@example.com",
  },
  "google-carol": {
    provider: "google",
    subject: "google-sub-carol",
    email: "carol@example.com",
  },
};

class MapIdentityVerifier implements IdentityVerifier {
  async verify(accessToken: string): Promise<VerifiedIdentity | null> {
    return IDENTITIES[accessToken] ?? null;
  }
}

let app: Express;
let store: MemoryStore;
let clock: number;
let sentOtp: string[];

function build(over: Partial<Parameters<typeof createApp>[0]> = {}): Express {
  store = (over.store as MemoryStore) ?? new MemoryStore();
  sentOtp = [];
  return createApp({
    store,
    corsOrigins: [ORIGIN],
    rateLimit: { windowMs: 60_000, max: 500 },
    verifier: new StubVerifier(),
    circleVerifier: new AlwaysVerifies(),
    challenges: new ChallengeStore(() => clock),
    identityVerifier: new MapIdentityVerifier(),
    emailOtpSender: {
      async send(email: string) {
        sentOtp.push(email);
      },
    },
    environment: "test",
    now: () => clock,
    ...over,
    store,
  });
}

beforeEach(() => {
  clock = Date.parse("2026-09-16T12:00:00.000Z");
  app = build();
});

function cookieList(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function cookieNamed(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  return cookieList(res).find((c) => c.startsWith(`${name}=`));
}

function cookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const line = cookieNamed(res, name);
  if (line === undefined) return undefined;
  return line.split(";")[0]?.slice(name.length + 1);
}

function cookieHeaderFrom(res: { headers: Record<string, unknown> }): string {
  return cookieList(res)
    .map((c) => c.split(";")[0])
    .filter((p): p is string => typeof p === "string" && p.includes("=") && !p.endsWith("="))
    .join("; ");
}

function login(token: string, extra: { cookie?: string; origin?: string } = {}) {
  const req = request(app).post("/api/auth/login").send({ accessToken: token });
  req.set("Origin", extra.origin ?? ORIGIN);
  req.set("Host", HOST);
  if (extra.cookie) req.set("Cookie", extra.cookie);
  return req;
}

function me(cookie: string) {
  return request(app).get("/api/auth/me").set("Origin", ORIGIN).set("Cookie", cookie);
}

function csrfFrom(res: { headers: Record<string, unknown> }): { cookie: string; token: string } {
  const cookie = cookieHeaderFrom(res);
  const token = cookieValue(res, IWA_CSRF_COOKIE);
  if (token === undefined) throw new Error("missing csrf cookie");
  return { cookie, token };
}

// ---------------------------------------------------------------- identity helpers

describe("email normalization", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("rejects an un-normalized or malformed address", () => {
    expect(isNormalizedEmail("alice@example.com")).toBe(true);
    expect(isNormalizedEmail("Alice@example.com")).toBe(false);
    expect(isNormalizedEmail("not-an-email")).toBe(false);
  });
});

describe("Supabase JWT identity", () => {
  const secret = "test-supabase-jwt-secret";
  const supabaseUrl = "https://project-ref.supabase.co";
  const issuer = `${supabaseUrl}/auth/v1`;

  it("accepts a verified Google token and refuses an expired one", () => {
    const now = Math.floor(clock / 1000);
    const good = signHs256Jwt(
      {
        sub: "google-sub-1",
        email: "ada@example.com",
        role: "authenticated",
        exp: now + 60,
        app_metadata: { provider: "google" },
      },
      secret,
    );
    expect(verifyHs256Jwt(good, secret, now)?.email).toBe("ada@example.com");
    expect(identityFromSupabasePayload(verifyHs256Jwt(good, secret, now)!)).toEqual({
      provider: "google",
      subject: "google-sub-1",
      email: "ada@example.com",
    });

    const expired = signHs256Jwt(
      {
        sub: "google-sub-1",
        email: "ada@example.com",
        role: "authenticated",
        exp: now - 1,
        app_metadata: { provider: "google" },
      },
      secret,
    );
    expect(verifyHs256Jwt(expired, secret, now)).toBeNull();
  });

  it("refuses a token whose signature does not match", () => {
    const now = Math.floor(clock / 1000);
    const token = signHs256Jwt(
      {
        sub: "x",
        email: "a@b.co",
        role: "authenticated",
        exp: now + 60,
        app_metadata: { provider: "email" },
      },
      secret,
    );
    expect(verifyHs256Jwt(token, "other-secret", now)).toBeNull();
  });

  it("accepts only the configured Supabase issuer and authenticated audience", async () => {
    const now = Math.floor(clock / 1000);
    const verifier = new SupabaseJwtVerifier(secret, supabaseUrl, () => clock);
    const claims = {
      sub: "google-sub-1",
      email: "ada@example.com",
      role: "authenticated",
      aud: "authenticated",
      iss: issuer,
      exp: now + 60,
      app_metadata: { provider: "google" },
    };

    await expect(verifier.verify(signHs256Jwt(claims, secret))).resolves.toEqual({
      provider: "google",
      subject: "google-sub-1",
      email: "ada@example.com",
    });
    await expect(
      verifier.verify(signHs256Jwt({ ...claims, aud: "service_role" }, secret)),
    ).resolves.toBeNull();
    await expect(
      verifier.verify(signHs256Jwt({ ...claims, iss: "https://evil.example/auth/v1" }, secret)),
    ).resolves.toBeNull();
    const { aud: _aud, iss: _iss, ...missingTrustClaims } = claims;
    void _aud;
    void _iss;
    await expect(verifier.verify(signHs256Jwt(missingTrustClaims, secret))).resolves.toBeNull();
  });

  it("creates the backend session from a correctly scoped Supabase token", async () => {
    const verifier = new SupabaseJwtVerifier(secret, supabaseUrl, () => clock);
    app = build({ identityVerifier: verifier });
    const token = signHs256Jwt(
      {
        sub: "google-sub-session",
        email: "session@example.com",
        role: "authenticated",
        aud: "authenticated",
        iss: issuer,
        exp: Math.floor(clock / 1000) + 60,
        app_metadata: { provider: "google" },
      },
      secret,
    );

    const res = await login(token).expect(200);
    expect(res.body.user.email).toBe("session@example.com");
    expect(res.body).not.toHaveProperty("accessToken");
    expect(cookieNamed(res, IWA_SESSION_COOKIE)).toContain("HttpOnly");
  });
});

describe("session cookie attributes", () => {
  it("is HttpOnly, Path=/, SameSite=Lax, and not Secure off production", () => {
    const line = sessionCookieAttributes({
      token: "tok",
      maxAgeSeconds: IWA_SESSION_TTL_MS / 1000,
      secure: false,
      sameSite: "Lax",
    });
    expect(line).toContain("HttpOnly");
    expect(line).toContain("Path=/");
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(line).not.toMatch(/(?:^|; )Secure(?:;|$)/);
  });

  it("sets Secure in production", () => {
    const line = sessionCookieAttributes({
      token: "tok",
      maxAgeSeconds: 1,
      secure: true,
      sameSite: "Lax",
    });
    expect(line).toMatch(/(?:^|; )Secure(?:;|$)/);
  });
});

// ---------------------------------------------------------------- new user

describe("new user", () => {
  it("creates an Iwa user from Google auth", async () => {
    const res = await login("google-alice").expect(200);
    expect(res.body.user.email).toBe("alice@example.com");
    expect(res.body.user.status).toBe("active");
    expect(typeof res.body.user.id).toBe("string");
    expect(res.body.user.id.length).toBeGreaterThan(8);
    expect(res.body.token).toBeUndefined();
    expect(cookieNamed(res, IWA_SESSION_COOKIE)).toBeDefined();
    expect(cookieNamed(res, IWA_SESSION_COOKIE)).toContain("HttpOnly");
    expect(cookieNamed(res, IWA_SESSION_COOKIE)).toContain("Path=/");
    expect(cookieNamed(res, IWA_SESSION_COOKIE)).toMatch(/SameSite=None/i);
    expect(cookieNamed(res, IWA_SESSION_COOKIE)).toContain("Secure");
  });

  it("creates an Iwa user from email auth", async () => {
    const res = await login("email-bob").expect(200);
    expect(res.body.user.email).toBe("bob@example.com");
    expect(res.body.user.status).toBe("active");
  });

  it("maps a duplicate Google identity to the same user", async () => {
    const first = await login("google-alice").expect(200);
    const second = await login("google-alice-again").expect(200);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it("links a verified email identity to the existing user with the same normalized email", async () => {
    const google = await login("google-alice").expect(200);
    const email = await login("email-alice").expect(200);
    expect(email.body.user.id).toBe(google.body.user.id);
    expect(email.body.user.email).toBe("alice@example.com");
  });

  it("refuses a missing, unknown, or malformed credential", async () => {
    await request(app)
      .post("/api/auth/login")
      .set("Origin", ORIGIN)
      .send({})
      .expect(401);
    await login("not-a-real-token").expect(401);
  });
});

// ---------------------------------------------------------------- returning user / remembered browser

describe("returning user", () => {
  it("restores the user from the session cookie without logging in again", async () => {
    const signedIn = await login("google-alice").expect(200);
    const cookie = cookieHeaderFrom(signedIn);
    const res = await me(cookie).expect(200);
    expect(res.body.user.id).toBe(signedIn.body.user.id);
    expect(res.body.user.email).toBe("alice@example.com");
  });

  it("renews the session on use so a refresh during the window still works", async () => {
    const signedIn = await login("google-alice").expect(200);
    const cookie = cookieHeaderFrom(signedIn);
    clock += 24 * 60 * 60 * 1000;
    const res = await me(cookie).expect(200);
    expect(res.body.user.email).toBe("alice@example.com");
    const sessionLine = cookieNamed(res, IWA_SESSION_COOKIE);
    expect(sessionLine).toBeDefined();
    expect(sessionLine).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });

  it("still authenticates after a long gap inside the 30-day window", async () => {
    const signedIn = await login("email-bob").expect(200);
    const cookie = cookieHeaderFrom(signedIn);
    clock += IWA_SESSION_TTL_MS - 1000;
    await me(cookie).expect(200);
  });
});

// ---------------------------------------------------------------- session security

describe("session security", () => {
  it("never stores the raw session token on the user or session records", async () => {
    const res = await login("google-alice").expect(200);
    const raw = cookieValue(res, IWA_SESSION_COOKIE);
    expect(raw).toBeDefined();
    const user = await store.getIwaUser(res.body.user.id as string);
    expect(JSON.stringify(user)).not.toContain(raw);
    const sessions = await store.listAccountSessions(res.body.user.id as string);
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.tokenHash).toBe(hashSessionToken(raw!));
    expect(sessions[0]?.tokenHash).not.toBe(raw);
    expect(JSON.stringify(sessions)).not.toContain(raw);
  });

  it("rejects a tampered cookie", async () => {
    const signedIn = await login("google-alice").expect(200);
    const raw = cookieValue(signedIn, IWA_SESSION_COOKIE)!;
    const tampered = `${IWA_SESSION_COOKIE}=${raw.slice(0, -2)}aa`;
    await me(tampered).expect(401);
  });

  it("rejects an expired session", async () => {
    const signedIn = await login("google-alice").expect(200);
    const cookie = cookieHeaderFrom(signedIn);
    clock += IWA_SESSION_TTL_MS + 1;
    await me(cookie).expect(401);
  });

  it("rejects a revoked session", async () => {
    const signedIn = await login("google-alice").expect(200);
    const { cookie, token } = csrfFrom(signedIn);
    await request(app)
      .post("/api/auth/logout")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .set(IWA_CSRF_HEADER, token)
      .expect(204);
    await me(cookie).expect(401);
  });

  it("supports two devices at once", async () => {
    const a = await login("google-alice").expect(200);
    const b = await login("google-alice-again").expect(200);
    expect(a.body.user.id).toBe(b.body.user.id);
    await me(cookieHeaderFrom(a)).expect(200);
    await me(cookieHeaderFrom(b)).expect(200);
    const sessions = await store.listAccountSessions(a.body.user.id as string);
    expect(sessions.filter((s) => s.revokedAt === null).length).toBe(2);
  });

  it("logout current device only revokes that session", async () => {
    const a = await login("google-alice").expect(200);
    const b = await login("google-alice-again").expect(200);
    const { cookie, token } = csrfFrom(a);
    await request(app)
      .post("/api/auth/logout")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .set(IWA_CSRF_HEADER, token)
      .expect(204);
    await me(cookieHeaderFrom(a)).expect(401);
    await me(cookieHeaderFrom(b)).expect(200);
  });

  it("logout all devices revokes every session for the user", async () => {
    const a = await login("google-alice").expect(200);
    const b = await login("google-alice-again").expect(200);
    const { cookie, token } = csrfFrom(a);
    await request(app)
      .post("/api/auth/logout-all")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .set(IWA_CSRF_HEADER, token)
      .expect(204);
    await me(cookieHeaderFrom(a)).expect(401);
    await me(cookieHeaderFrom(b)).expect(401);
  });

  it("does not let an Iwa session create a circle draft", async () => {
    const signedIn = await login("google-alice").expect(200);
    const { cookie, token } = csrfFrom(signedIn);
    const res = await request(app)
      .post("/api/drafts")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .set(IWA_CSRF_HEADER, token)
      .send({
        chainId: SN_MAIN,
        organizerAddress: ORGANIZER,
        token: USDC,
        contributionAmount: "1000000",
        cadenceSeconds: 604800,
        graceSeconds: 86400,
        memberCount: 2,
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_auth");
  });

  it("does not let an Iwa session read the admin overview", async () => {
    const signedIn = await login("google-alice").expect(200);
    const { cookie, token } = csrfFrom(signedIn);
    const res = await request(app)
      .post("/api/admin/overview")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .set(IWA_CSRF_HEADER, token)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_auth");
  });
});

describe("CSRF", () => {
  it("refuses cookie-authenticated mutations without the CSRF header", async () => {
    const signedIn = await login("google-alice").expect(200);
    const cookie = cookieHeaderFrom(signedIn);
    await request(app)
      .post("/api/auth/logout")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .expect(403);
  });

  it("refuses a CSRF header that does not match the cookie", async () => {
    const signedIn = await login("google-alice").expect(200);
    const cookie = cookieHeaderFrom(signedIn);
    await request(app)
      .post("/api/auth/logout")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .set(IWA_CSRF_HEADER, "not-the-token")
      .expect(403);
  });

  it("refuses a mutation from an origin that is not allowed", async () => {
    const signedIn = await login("google-alice").expect(200);
    const { cookie, token } = csrfFrom(signedIn);
    await request(app)
      .post("/api/auth/logout")
      .set("Origin", "https://evil.example")
      .set("Cookie", cookie)
      .set(IWA_CSRF_HEADER, token)
      .expect(403);
  });
});

describe("suspension", () => {
  it("rejects a suspended user from protected app routes and from a new login", async () => {
    const signedIn = await login("google-carol").expect(200);
    const cookie = cookieHeaderFrom(signedIn);
    await store.setIwaUserStatus(signedIn.body.user.id as string, "suspended");
    const blocked = await me(cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("account_suspended");
    const again = await login("google-carol");
    expect(again.status).toBe(403);
    expect(again.body.error).toBe("account_suspended");
  });
});

describe("email magic link request", () => {
  it("sends an OTP for a normalized address and does not leak existence", async () => {
    const res = await request(app)
      .post("/api/auth/email")
      .set("Origin", ORIGIN)
      .send({ email: "  Dana@Example.com " })
      .expect(200);
    expect(res.body.sent).toBe(true);
    expect(sentOtp).toEqual(["dana@example.com"]);
  });

  it("refuses a malformed email without sending", async () => {
    await request(app)
      .post("/api/auth/email")
      .set("Origin", ORIGIN)
      .send({ email: "not-an-email" })
      .expect(400);
    expect(sentOtp).toEqual([]);
  });
});

describe("schema", () => {
  it("does not add private keys, seeds, or provider tokens to the new tables", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(resolve(here, "../migrations/005_iwa_accounts.sql"), "utf8")
      .replace(/--.*$/gm, "")
      .toLowerCase();
    expect(sql).toContain("create table");
    expect(sql).toContain("users");
    expect(sql).toContain("auth_identities");
    expect(sql).toContain("sessions");
    expect(sql).toContain("token_hash");
    for (const banned of [
      "private_key",
      "privatekey",
      "seed",
      "mnemonic",
      "access_token",
      "refresh_token",
      "provider_token",
      "viewing_key",
    ]) {
      expect(sql).not.toContain(banned);
    }
  });
});

describe("production cookie flags", () => {
  it("sets Secure on the session cookie in production", async () => {
    app = build({ environment: "production" });
    const res = await login("email-bob").expect(200);
    const line = cookieNamed(res, IWA_SESSION_COOKIE);
    expect(line).toMatch(/(?:^|; )Secure(?:;|$)/);
    expect(line).toContain("HttpOnly");
    expect(line).toContain("Path=/");
  });
});
