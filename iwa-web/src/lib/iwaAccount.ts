// Iwa User API client. Cookie-authenticated. Isolated from the wallet
// coordination client in backend.ts: this never sends a Bearer token and
// never asks a wallet to sign.

import type { IwaUser } from "../app/iwaAuthGate";
import { iwaSupabaseAuth } from "./supabaseAuth";

const BASE_URL = (import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");

const CSRF_COOKIE = "iwa_csrf";

export class IwaAccountError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "IwaAccountError";
    this.status = status;
    this.code = code;
  }
}

function readCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== CSRF_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return null;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCsrf();
    if (csrf !== null) headers["x-iwa-csrf"] = csrf;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      method,
      credentials: "include",
      headers,
    });
  } catch {
    throw new IwaAccountError(0, "offline", "Iwa cannot reach its coordination service right now.");
  }

  if (res.status === 204) return undefined as T;

  let body: { error?: string; message?: string } = {};
  try {
    body = (await res.json()) as { error?: string; message?: string };
  } catch {
    body = {};
  }

  if (!res.ok) {
    const code = body.error ?? "error";
    const message =
      code === "account_suspended"
        ? "This Iwa account is suspended. Your on-chain funds are untouched."
        : code === "session_invalid"
          ? "Please sign in to Iwa again."
          : (body.message ?? "Something went wrong.");
    throw new IwaAccountError(res.status, code, message);
  }

  return body as T;
}

export interface SessionView {
  user: IwaUser;
  expiresAt: string;
}

export interface AuthCallbackLocation {
  hash: string;
  search: string;
}

export interface AuthCallbackDependencies {
  exchangeCode(code: string, flowId?: string): Promise<string>;
  login(accessToken: string): Promise<SessionView>;
  replaceUrl(path: string): void;
}

export interface AuthCallbackCoordinator {
  complete(location: AuthCallbackLocation): Promise<SessionView>;
}

/**
 * Completes one browser auth redirect.
 *
 * Callback credentials are copied into memory and removed from the address bar
 * before either Supabase or the Iwa backend is called. One in-flight promise is
 * shared so React Strict Mode cannot exchange the same one-time code twice.
 */
export function createAuthCallbackCoordinator(
  dependencies: AuthCallbackDependencies,
): AuthCallbackCoordinator {
  let pending: Promise<SessionView> | null = null;
  let lastCode:
    | { code: string; flowId: string | undefined; result: Promise<SessionView> }
    | null = null;

  return {
    complete(location) {
      if (pending !== null) return pending;

      const query = new URLSearchParams(
        location.search.startsWith("?") ? location.search.slice(1) : location.search,
      );
      const fragment = new URLSearchParams(
        location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
      );
      const code = query.get("code");
      const flowId = query.get("sb_flow_id");
      const legacyAccessToken = fragment.get("access_token");

      dependencies.replaceUrl("/auth/callback");

      const normalizedFlowId = flowId !== null && flowId.length > 0 ? flowId : undefined;
      if (
        code !== null &&
        code.length > 0 &&
        lastCode !== null &&
        lastCode.code === code &&
        lastCode.flowId === normalizedFlowId
      ) {
        return lastCode.result;
      }

      pending = (async () => {
        let accessToken: string;
        if (code !== null && code.length > 0) {
          try {
            accessToken = await dependencies.exchangeCode(code, normalizedFlowId);
          } catch {
            throw new IwaAccountError(
              401,
              "invalid_callback",
              "That sign-in link is invalid, expired, or has already been used. Please try again from Iwa.",
            );
          }
        } else if (legacyAccessToken !== null && legacyAccessToken.length > 0) {
          accessToken = legacyAccessToken;
        } else {
          throw new IwaAccountError(
            400,
            "missing_callback",
            "That sign-in link is missing its confirmation. Please try again from Iwa.",
          );
        }

        return dependencies.login(accessToken);
      })();

      if (code !== null && code.length > 0) {
        lastCode = { code, flowId: normalizedFlowId, result: pending };
      }

      void pending.then(
        () => {
          pending = null;
        },
        () => {
          pending = null;
        },
      );
      return pending;
    },
  };
}

export const iwaAccount = {
  async me(): Promise<SessionView> {
    return call("/api/auth/me");
  },

  async requestEmail(email: string): Promise<void> {
    try {
      await iwaSupabaseAuth.requestEmail(email, authCallbackUrl());
    } catch (error) {
      throw new IwaAccountError(
        0,
        "auth_unavailable",
        error instanceof Error ? error.message : "The sign-in email could not be sent.",
      );
    }
  },

  async googleUrl(): Promise<string> {
    try {
      return await iwaSupabaseAuth.googleUrl(authCallbackUrl());
    } catch (error) {
      throw new IwaAccountError(
        0,
        "auth_unavailable",
        error instanceof Error ? error.message : "Google sign-in could not be started.",
      );
    }
  },

  async login(accessToken: string): Promise<SessionView> {
    return call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ accessToken }),
    });
  },

  async logout(): Promise<void> {
    await call("/api/auth/logout", { method: "POST", body: "{}" });
  },

  async logoutAll(): Promise<void> {
    await call("/api/auth/logout-all", { method: "POST", body: "{}" });
  },
};

function authCallbackUrl(): string {
  if (typeof window === "undefined") throw new Error("Iwa account sign-in requires a browser.");
  return new URL("/auth/callback", window.location.origin).toString();
}

export const iwaAuthCallback = createAuthCallbackCoordinator({
  exchangeCode: (code, flowId) => iwaSupabaseAuth.exchangeCode(code, flowId),
  login: (accessToken) => iwaAccount.login(accessToken),
  replaceUrl: (path) => window.history.replaceState(null, "", path),
});

/** Reads the legacy implicit-flow token from the fragment only. */
export function accessTokenFromLocation(hash: string, search: string): string | null {
  const fromHash = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  void search;
  const token = fromHash.get("access_token");
  if (token !== null && token.length > 0) return token;
  return null;
}
