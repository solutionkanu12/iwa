import { describe, expect, it } from "vitest";

import { onboardingRedirect, onboardingStepFor } from "./onboarding";

describe("onboarding route guard", () => {
  it("sends a new user who enters the app to onboarding", () => {
    expect(onboardingRedirect("home", "new")).toBe("onboarding");
  });

  it("keeps an incomplete user at the persisted profile step after a refresh", () => {
    expect(onboardingStepFor("incomplete")).toBe("profile");
    expect(onboardingRedirect("explore", "incomplete")).toBe("onboarding");
  });

  it("does not let new or incomplete users bypass onboarding through /app", () => {
    expect(onboardingRedirect("home", "new")).toBe("onboarding");
    expect(onboardingRedirect("home", "incomplete")).toBe("onboarding");
  });

  it("does not force a completed user back into onboarding", () => {
    expect(onboardingRedirect("home", "completed")).toBeNull();
    expect(onboardingRedirect("onboarding", "completed")).toBe("home");
  });
});
