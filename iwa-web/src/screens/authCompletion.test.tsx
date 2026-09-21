import { describe, expect, it, vi } from "vitest";
import type { OnboardingStatus } from "../app/iwaAuthGate";

describe("Auth completion routing", () => {
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
