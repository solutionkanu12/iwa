import { describe, expect, it, vi } from "vitest";

import * as accountModule from "./iwaAccount";

interface SessionView {
  user: {
    id: string;
    email: string;
    status: "active" | "suspended";
    onboardingStatus?: "new" | "incomplete" | "completed";
  };
  expiresAt: string;
}

interface ConfirmCoordinator {
  complete(location: { hash: string; search: string }): Promise<SessionView>;
}

interface ConfirmApi {
  captureAuthRedirectLocation(location: { hash: string; search: string }): { hash: string; search: string };
  createAuthConfirmCoordinator(deps: {
    verifyOtp(params: { token_hash?: string; token?: string; type: string; email?: string }): Promise<string>;
    exchangeCode?(code: string, flowId?: string): Promise<string>;
    login(accessToken: string): Promise<SessionView>;
    replaceUrl(path: string): void;
  }): ConfirmCoordinator;
}

const confirmApi = accountModule as unknown as ConfirmApi;

const newSession: SessionView = {
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "ada@example.com",
    status: "active",
    onboardingStatus: "new",
  },
  expiresAt: "2026-10-19T00:00:00.000Z",
};

const completedSession: SessionView = {
  user: {
    id: "22222222-2222-4222-8222-222222222222",
    email: "bob@example.com",
    status: "active",
    onboardingStatus: "completed",
  },
  expiresAt: "2026-10-19T00:00:00.000Z",
};

function setup(targetSession = newSession) {
  const order: string[] = [];
  const verifyOtp = vi.fn(async (params: { token_hash?: string; token?: string; type: string; email?: string }) => {
    order.push(`verifyOtp:${params.token_hash ?? params.token}:${params.type}`);
    return "verified-email-access-token";
  });
  const exchangeCode = vi.fn(async (code: string, flowId?: string) => {
    order.push(`exchangeCode:${code}:${flowId ?? ""}`);
    return "verified-pkce-access-token";
  });
  const login = vi.fn(async (accessToken: string) => {
    order.push(`login:${accessToken}`);
    return targetSession;
  });
  const replaceUrl = vi.fn((path: string) => {
    order.push(`cleanup:${path}`);
  });
  const coordinator = confirmApi.createAuthConfirmCoordinator({
    verifyOtp,
    exchangeCode,
    login,
    replaceUrl,
  });
  return { coordinator, verifyOtp, exchangeCode, login, replaceUrl, order };
}

describe("Iwa Account email auth confirm (cross-device)", () => {
  it("captures a real confirm URL before it is scrubbed", async () => {
    const original = new URL("https://useiwa.xyz/auth/confirm?token_hash=test-hash&type=email");
    const captured = confirmApi.captureAuthRedirectLocation(original);

    original.search = "";

    const { coordinator, verifyOtp } = setup();
    await expect(coordinator.complete(captured)).resolves.toEqual(newSession);
    expect(original.href).toBe("https://useiwa.xyz/auth/confirm");
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "test-hash", type: "email" });
  });

  it("successfully verifies a token_hash on first use without a local PKCE verifier", async () => {
    const { coordinator, verifyOtp, login, order } = setup();

    const res = await coordinator.complete({
      hash: "",
      search: "?token_hash=email-otp-hash-123&type=email",
    });

    expect(res).toEqual(newSession);
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "email-otp-hash-123", type: "email" });
    expect(login).toHaveBeenCalledWith("verified-email-access-token");
    expect(order).toEqual([
      "cleanup:/auth/confirm",
      "verifyOtp:email-otp-hash-123:email",
      "login:verified-email-access-token",
    ]);
  });

  it("verifies magiclink / signup type tokens correctly", async () => {
    const { coordinator, verifyOtp, login } = setup(completedSession);

    const res = await coordinator.complete({
      hash: "",
      search: "?token_hash=magic-link-token&type=magiclink",
    });

    expect(res.user.onboardingStatus).toBe("completed");
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "magic-link-token", type: "magiclink" });
    expect(login).toHaveBeenCalledWith("verified-email-access-token");
  });

  it("scrubs query and hash parameters immediately before network requests", async () => {
    let releaseVerify!: (token: string) => void;
    const verifyOtp = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseVerify = resolve;
        }),
    );
    const login = vi.fn(async () => newSession);
    const replaceUrl = vi.fn();
    const coordinator = confirmApi.createAuthConfirmCoordinator({
      verifyOtp,
      login,
      replaceUrl,
    });

    const completion = coordinator.complete({
      hash: "#access_token=secret-hash",
      search: "?token_hash=secret-token-hash&type=email",
    });

    expect(replaceUrl).toHaveBeenCalledWith("/auth/confirm");
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "secret-token-hash", type: "email" });
    expect(login).not.toHaveBeenCalled();

    releaseVerify("verified-email-access-token");
    await completion;
  });

  it("rejects an expired token and tells the user to request a new link", async () => {
    const { coordinator, verifyOtp, login, replaceUrl } = setup();
    verifyOtp.mockRejectedValueOnce(new Error("Token has expired or is invalid"));

    await expect(
      coordinator.complete({ hash: "", search: "?token_hash=bad-token&type=email" }),
    ).rejects.toMatchObject({
      code: "invalid_callback",
      message: "That sign-in link is invalid, expired, or has already been used. Please request a new sign-in link.",
    });

    expect(replaceUrl).toHaveBeenCalledWith("/auth/confirm");
    expect(login).not.toHaveBeenCalled();
  });

  it("fails closed when parameters are missing", async () => {
    const { coordinator, verifyOtp, login, replaceUrl } = setup();

    await expect(coordinator.complete({ hash: "", search: "" })).rejects.toMatchObject({
      code: "missing_callback",
    });

    expect(replaceUrl).toHaveBeenCalledWith("/auth/confirm");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("reuses in-flight promise and prevents duplicate execution in React Strict Mode", async () => {
    let releaseVerify!: (token: string) => void;
    const verifyOtp = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseVerify = resolve;
        }),
    );
    const login = vi.fn(async () => newSession);
    const replaceUrl = vi.fn();
    const coordinator = confirmApi.createAuthConfirmCoordinator({
      verifyOtp,
      login,
      replaceUrl,
    });

    const first = coordinator.complete({ hash: "", search: "?token_hash=email-hash&type=email" });
    const second = coordinator.complete({ hash: "", search: "" });
    releaseVerify("verified-email-access-token");

    await expect(Promise.all([first, second])).resolves.toEqual([newSession, newSession]);
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect(replaceUrl).toHaveBeenCalledTimes(1);
  });

  it("rejects a later replay of a successfully consumed token", async () => {
    const { coordinator, verifyOtp, login } = setup();
    const location = { hash: "", search: "?token_hash=email-hash&type=email" };
    verifyOtp.mockReset();
    verifyOtp.mockResolvedValueOnce("verified-email-access-token");
    verifyOtp.mockRejectedValueOnce(new Error("Token has expired or is invalid"));

    await expect(coordinator.complete(location)).resolves.toEqual(newSession);
    await expect(coordinator.complete(location)).rejects.toMatchObject({
      code: "invalid_callback",
      message: "That sign-in link is invalid, expired, or has already been used. Please request a new sign-in link.",
    });

    expect(verifyOtp).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("does not treat a different token as the same in-flight verification", async () => {
    let releaseVerify!: (token: string) => void;
    const verifyOtp = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseVerify = resolve;
        }),
    );
    const login = vi.fn(async () => newSession);
    const coordinator = confirmApi.createAuthConfirmCoordinator({
      verifyOtp,
      login,
      replaceUrl: vi.fn(),
    });

    const first = coordinator.complete({ hash: "", search: "?token_hash=first&type=email" });
    const second = coordinator.complete({ hash: "", search: "?token_hash=second&type=email" });
    releaseVerify("verified-email-access-token");

    await expect(first).resolves.toEqual(newSession);
    await expect(second).rejects.toMatchObject({ code: "confirmation_in_progress" });
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
  });
});
