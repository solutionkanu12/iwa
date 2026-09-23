import { afterEach, describe, expect, it, vi } from "vitest";

const { createClient, signInWithOtp } = vi.hoisted(() => ({
  createClient: vi.fn(),
  signInWithOtp: vi.fn(async () => ({ data: { user: null, session: null }, error: null })),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { iwaAccount } from "./iwaAccount";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Iwa email sign-in initiation", () => {
  it("sends the current localhost:5174 auth-confirm URL to Supabase", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://supabase.example");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:5174" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    createClient.mockReturnValue({ auth: { signInWithOtp } });

    await iwaAccount.requestEmail("ada@example.com");

    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "ada@example.com",
      options: {
        emailRedirectTo: "http://localhost:5174/auth/confirm",
        shouldCreateUser: true,
      },
    });
  });

  it("sends only onboarding step metadata and never wallet credentials", async () => {
    vi.stubGlobal("document", { cookie: "iwa_csrf=test-csrf" });
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ onboarding: { status: "incomplete", step: "passwordPin" } }),
    }));
    vi.stubGlobal("fetch", fetch);

    await iwaAccount.transitionOnboarding("profile", "passwordPin");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/onboarding\/transition$/),
      expect.objectContaining({
        credentials: "include",
        method: "POST",
        body: JSON.stringify({ from: "profile", to: "passwordPin" }),
      }),
    );
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).not.toContain("wallet-password");
    expect(String(request.body)).not.toContain("123456");
  });
});
