import { describe, expect, it, vi } from "vitest";

import * as accountModule from "./iwaAccount";

interface SessionView {
  user: {
    id: string;
    email: string;
    status: "active";
    onboardingStatus?: "new" | "incomplete" | "completed";
  };
  expiresAt: string;
}

interface CallbackCoordinator {
  complete(location: { hash: string; search: string }): Promise<SessionView>;
}

interface CallbackApi {
  createAuthCallbackCoordinator(deps: {
    exchangeCode(code: string, flowId?: string): Promise<string>;
    login(accessToken: string): Promise<SessionView>;
    replaceUrl(path: string): void;
  }): CallbackCoordinator;
}

const callbackApi = accountModule as unknown as CallbackApi;

const session: SessionView = {
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "ada@example.com",
    status: "active",
    onboardingStatus: "new",
  },
  expiresAt: "2026-10-19T00:00:00.000Z",
};

function setup() {
  const order: string[] = [];
  const exchangeCode = vi.fn(async (code: string, flowId?: string) => {
    order.push(`exchange:${code}:${flowId ?? ""}`);
    return "verified-supabase-access-token";
  });
  const login = vi.fn(async (accessToken: string) => {
    order.push(`login:${accessToken}`);
    return session;
  });
  const replaceUrl = vi.fn((path: string) => {
    order.push(`cleanup:${path}`);
  });
  const coordinator = callbackApi.createAuthCallbackCoordinator({
    exchangeCode,
    login,
    replaceUrl,
  });
  return { coordinator, exchangeCode, login, replaceUrl, order };
}

describe("Iwa Account auth callback", () => {
  it("exchanges a PKCE code and sends only the verified access token to Iwa login", async () => {
    const { coordinator, exchangeCode, login, order } = setup();

    await expect(
      coordinator.complete({ hash: "", search: "?code=authorization-code&sb_flow_id=flow-1" }),
    ).resolves.toEqual(session);

    expect(exchangeCode).toHaveBeenCalledWith("authorization-code", "flow-1");
    expect(login).toHaveBeenCalledWith("verified-supabase-access-token");
    expect(order).toEqual([
      "cleanup:/auth/callback",
      "exchange:authorization-code:flow-1",
      "login:verified-supabase-access-token",
    ]);
  });

  it("fails closed when the authorization code is invalid, reused, or expired", async () => {
    const { coordinator, exchangeCode, login, replaceUrl } = setup();
    exchangeCode.mockRejectedValueOnce(new Error("invalid authorization code"));

    await expect(
      coordinator.complete({ hash: "", search: "?code=bad-code" }),
    ).rejects.toMatchObject({ code: "invalid_callback" });

    expect(replaceUrl).toHaveBeenCalledWith("/auth/callback");
    expect(login).not.toHaveBeenCalled();
  });

  it("fails closed when the matching PKCE verifier is missing", async () => {
    const { coordinator, exchangeCode, login } = setup();
    exchangeCode.mockRejectedValueOnce(new Error("PKCE code verifier not found in storage"));

    await expect(
      coordinator.complete({ hash: "", search: "?code=code-without-verifier&sb_flow_id=flow-1" }),
    ).rejects.toMatchObject({ code: "invalid_callback" });

    expect(login).not.toHaveBeenCalled();
  });

  it("fails closed when neither a PKCE code nor a safe hash token is present", async () => {
    const { coordinator, exchangeCode, login, replaceUrl } = setup();

    await expect(coordinator.complete({ hash: "", search: "" })).rejects.toMatchObject({
      code: "missing_callback",
    });

    expect(replaceUrl).toHaveBeenCalledWith("/auth/callback");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("strips callback material synchronously before starting any network work", async () => {
    let releaseExchange!: (token: string) => void;
    const exchangeCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseExchange = resolve;
        }),
    );
    const login = vi.fn(async () => session);
    const replaceUrl = vi.fn();
    const coordinator = callbackApi.createAuthCallbackCoordinator({
      exchangeCode,
      login,
      replaceUrl,
    });

    const completion = coordinator.complete({
      hash: "#access_token=must-not-remain",
      search: "?code=authorization-code&sb_flow_id=flow-1",
    });

    expect(replaceUrl).toHaveBeenCalledWith("/auth/callback");
    expect(exchangeCode).toHaveBeenCalledWith("authorization-code", "flow-1");
    expect(login).not.toHaveBeenCalled();

    releaseExchange("verified-supabase-access-token");
    await completion;
  });

  it("keeps the legacy access-token fallback only in the URL fragment", async () => {
    const { coordinator, exchangeCode, login } = setup();

    await coordinator.complete({ hash: "#access_token=legacy-token&type=magiclink", search: "" });

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledWith("legacy-token");

    const queryOnly = setup();
    await expect(
      queryOnly.coordinator.complete({ hash: "", search: "?access_token=query-token" }),
    ).rejects.toMatchObject({ code: "missing_callback" });
    expect(queryOnly.login).not.toHaveBeenCalled();
  });

  it("reuses one in-flight completion when React Strict Mode starts the effect twice", async () => {
    let releaseExchange!: (token: string) => void;
    const exchangeCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseExchange = resolve;
        }),
    );
    const login = vi.fn(async () => session);
    const replaceUrl = vi.fn();
    const coordinator = callbackApi.createAuthCallbackCoordinator({
      exchangeCode,
      login,
      replaceUrl,
    });

    const first = coordinator.complete({ hash: "", search: "?code=authorization-code" });
    const second = coordinator.complete({ hash: "", search: "" });
    releaseExchange("verified-supabase-access-token");

    await expect(Promise.all([first, second])).resolves.toEqual([session, session]);
    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect(replaceUrl).toHaveBeenCalledTimes(1);
  });

  it("does not exchange or create another backend session when a completed callback is replayed", async () => {
    const { coordinator, exchangeCode, login } = setup();
    const location = { hash: "", search: "?code=authorization-code&sb_flow_id=flow-1" };

    await coordinator.complete(location);
    await expect(coordinator.complete(location)).resolves.toEqual(session);

    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledTimes(1);
  });
});
