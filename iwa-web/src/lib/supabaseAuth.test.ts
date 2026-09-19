import { describe, expect, it, vi } from "vitest";

import * as authModule from "./supabaseAuth";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SupabaseAuthClient {
  auth: {
    signInWithOAuth(options: unknown): Promise<unknown>;
    signInWithOtp(options: unknown): Promise<unknown>;
    exchangeCodeForSession(code: string, options?: unknown): Promise<unknown>;
  };
}

interface SupabaseAuthApi {
  createPkceVerifierStorage(backing: StorageLike): StorageLike;
  createIwaSupabaseAuth(createClient: () => SupabaseAuthClient): {
    googleUrl(redirectTo: string): Promise<string>;
    requestEmail(email: string, redirectTo: string): Promise<void>;
    exchangeCode(code: string, flowId?: string): Promise<string>;
  };
}

const authApi = authModule as unknown as SupabaseAuthApi;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
}

describe("Supabase PKCE storage", () => {
  it("persists only PKCE verifier material and never auth sessions or provider tokens", () => {
    const backing = memoryStorage();
    const storage = authApi.createPkceVerifierStorage(backing.storage);

    storage.setItem("sb-project-auth-token-code-verifier", "verifier");
    storage.setItem("sb-project-flow-1-auth-token-code-verifier", "flow-verifier");
    storage.setItem(
      "sb-project-auth-token",
      JSON.stringify({
        access_token: "supabase-access-token",
        refresh_token: "supabase-refresh-token",
        provider_token: "provider-access-token",
        provider_refresh_token: "provider-refresh-token",
      }),
    );

    expect(storage.getItem("sb-project-auth-token-code-verifier")).toBe("verifier");
    expect(storage.getItem("sb-project-flow-1-auth-token-code-verifier")).toBe("flow-verifier");
    expect(storage.getItem("sb-project-auth-token")).toBeNull();
    expect([...backing.values.values()]).toEqual(["verifier", "flow-verifier"]);
  });
});

describe("Supabase PKCE auth adapter", () => {
  it("starts Google sign-in with PKCE in the current browser", async () => {
    const signInWithOAuth = vi.fn(async () => ({
      data: { url: "https://supabase.example/auth/v1/authorize?provider=google" },
      error: null,
    }));
    const auth = authApi.createIwaSupabaseAuth(() => ({
      auth: {
        signInWithOAuth,
        signInWithOtp: vi.fn(),
        exchangeCodeForSession: vi.fn(),
      },
    }));

    await expect(auth.googleUrl("https://iwa.example/auth/callback")).resolves.toBe(
      "https://supabase.example/auth/v1/authorize?provider=google",
    );
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "https://iwa.example/auth/callback",
        skipBrowserRedirect: true,
      },
    });
  });

  it("starts email-link sign-in with a PKCE callback", async () => {
    const signInWithOtp = vi.fn(async () => ({ data: {}, error: null }));
    const auth = authApi.createIwaSupabaseAuth(() => ({
      auth: {
        signInWithOAuth: vi.fn(),
        signInWithOtp,
        exchangeCodeForSession: vi.fn(),
      },
    }));

    await auth.requestEmail("ada@example.com", "https://iwa.example/auth/callback");

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "ada@example.com",
      options: {
        emailRedirectTo: "https://iwa.example/auth/callback",
        shouldCreateUser: true,
      },
    });
  });

  it("exchanges the one-time code and exposes only the Supabase access token", async () => {
    const exchangeCodeForSession = vi.fn(async () => ({
      data: {
        session: {
          access_token: "verified-access-token",
          refresh_token: "supabase-refresh-token",
          provider_token: "provider-access-token",
          provider_refresh_token: "provider-refresh-token",
        },
      },
      error: null,
    }));
    const auth = authApi.createIwaSupabaseAuth(() => ({
      auth: {
        signInWithOAuth: vi.fn(),
        signInWithOtp: vi.fn(),
        exchangeCodeForSession,
      },
    }));

    await expect(auth.exchangeCode("authorization-code", "flow-1")).resolves.toBe(
      "verified-access-token",
    );
    expect(exchangeCodeForSession).toHaveBeenCalledWith("authorization-code", {
      flowId: "flow-1",
    });
  });

  it("fails closed when Supabase rejects a code or returns no access token", async () => {
    const rejected = authApi.createIwaSupabaseAuth(() => ({
      auth: {
        signInWithOAuth: vi.fn(),
        signInWithOtp: vi.fn(),
        exchangeCodeForSession: vi.fn(async () => ({
          data: { session: null },
          error: new Error("invalid authorization code"),
        })),
      },
    }));
    const empty = authApi.createIwaSupabaseAuth(() => ({
      auth: {
        signInWithOAuth: vi.fn(),
        signInWithOtp: vi.fn(),
        exchangeCodeForSession: vi.fn(async () => ({
          data: { session: null },
          error: null,
        })),
      },
    }));

    await expect(rejected.exchangeCode("bad-code")).rejects.toThrow("invalid authorization code");
    await expect(empty.exchangeCode("empty-code")).rejects.toThrow("access token");
  });

  it("fails closed when Supabase cannot find the callback's PKCE verifier", async () => {
    const auth = authApi.createIwaSupabaseAuth(() => ({
      auth: {
        signInWithOAuth: vi.fn(),
        signInWithOtp: vi.fn(),
        exchangeCodeForSession: vi.fn(async () => ({
          data: { session: null },
          error: new Error("PKCE code verifier not found in storage"),
        })),
      },
    }));

    await expect(auth.exchangeCode("code-without-verifier", "flow-1")).rejects.toThrow(
      "PKCE code verifier",
    );
  });
});
