import type { OnboardingStatus } from "./iwaAuthGate";

/**
 * The order is fixed before individual stages are implemented. A stage may
 * only become reachable when its account and wallet security requirements are
 * ready on both the client and server.
 */
export const ONBOARDING_STEPS = [
  "profile",
  "passwordPin",
  "walletProvisioning",
  "recovery",
  "finish",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingDestination = "home" | "onboarding";

export function onboardingStepFor(status: OnboardingStatus | undefined): OnboardingStep {
  return status === "completed" ? "finish" : "profile";
}

/** Routes that would expose the saver app before account onboarding completes. */
function requiresCompletedOnboarding(routeName: string): boolean {
  return (
    routeName === "home" ||
    routeName === "explore" ||
    routeName === "myCircles" ||
    routeName === "invitations" ||
    routeName === "circle" ||
    routeName === "standing" ||
    routeName === "create" ||
    routeName === "prizeSavings"
  );
}

/**
 * The account status is the authority for routing. Treating an absent status
 * as incomplete is intentional: a stale or malformed session must not open
 * the application.
 */
export function onboardingRedirect(
  routeName: string,
  status: OnboardingStatus | undefined,
): OnboardingDestination | null {
  if (status === "completed") return routeName === "onboarding" ? "home" : null;
  return requiresCompletedOnboarding(routeName) ? "onboarding" : null;
}
