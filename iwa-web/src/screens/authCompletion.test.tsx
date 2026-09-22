import { describe, expect, it, vi } from "vitest";
import type { OnboardingStatus } from "../app/iwaAuthGate";
import * as accountModule from "../lib/iwaAccount";

interface SessionView {
  user: {
    id: string;
    email: string;
    status: "active" | "suspended";
    onboardingStatus: OnboardingStatus;
  };
  expiresAt: string;
}

interface AccountApi {
  requireRecoveredIwaSession(created: SessionView, recovered: SessionView | null): SessionView;
}

const accountApi = accountModule as unknown as AccountApi;

describe("Auth completion routing", () => {
  it("does not navigate when login succeeds but the new cookie session cannot be recovered", async () => {
    const created: SessionView = {
      user: {
        id: "user-4",
        email: "cookie-blocked@example.com",
        status: "active",
        onboardingStatus: "new",
      },
      expiresAt: "2026-10-19T00:00:00.000Z",
    };
    const login = vi.fn(async () => created);
    const refresh = vi.fn(async (): Promise<SessionView | null> => null);
    const navigate = vi.fn();

    const loggedIn = await login();
    const recovered = await refresh();

    expect(() => accountApi.requireRecoveredIwaSession(loggedIn, recovered)).toThrow(
      "Iwa could not restore the secure session. Please sign in again.",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("routes new users to onboarding placeholder", async () => {
    const navigate = vi.fn();
    const session = {
      user: {
        id: "user-1",
        email: "new@example.com",
        status: "active" as const,
        onboardingStatus: "new" as OnboardingStatus,
      },
      expiresAt: "2026-10-19T00:00:00.000Z",
    };

    if (session.user.onboardingStatus === "completed") {
      navigate({ name: "home" });
    } else {
      navigate({ name: "onboarding" });
    }

    expect(navigate).toHaveBeenCalledWith({ name: "onboarding" });
  });

  it("routes incomplete onboarding users to onboarding placeholder", async () => {
    const navigate = vi.fn();
    const session = {
      user: {
        id: "user-2",
        email: "incomplete@example.com",
        status: "active" as const,
        onboardingStatus: "incomplete" as OnboardingStatus,
      },
      expiresAt: "2026-10-19T00:00:00.000Z",
    };

    if (session.user.onboardingStatus === "completed") {
      navigate({ name: "home" });
    } else {
      navigate({ name: "onboarding" });
    }

    expect(navigate).toHaveBeenCalledWith({ name: "onboarding" });
  });

  it("routes fully-onboarded users directly to /app (home)", async () => {
    const navigate = vi.fn();
    const session = {
      user: {
        id: "user-3",
        email: "complete@example.com",
        status: "active" as const,
        onboardingStatus: "completed" as OnboardingStatus,
      },
      expiresAt: "2026-10-19T00:00:00.000Z",
    };

    if (session.user.onboardingStatus === "completed") {
      navigate({ name: "home" });
    } else {
      navigate({ name: "onboarding" });
    }

    expect(navigate).toHaveBeenCalledWith({ name: "home" });
  });
});
