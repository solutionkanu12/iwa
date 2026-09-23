import type { OnboardingStatus, OnboardingStep } from "./iwaAuthGate";

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

export type OnboardingDestination = "home" | "onboarding";

/**
 * Only server-persisted stages that this milestone implements can render.
 * Any absent or future stage fails closed to the account-profile entry point.
 */
export function onboardingStepFor(
  status: OnboardingStatus | undefined,
  persistedStep: OnboardingStep | undefined,
): OnboardingStep {
  if (status === "completed") return "finish";
  if (status === "incomplete" && persistedStep === "passwordPin") return "passwordPin";
  return "profile";
}

/** The only progress metadata the browser may send to the state machine. */
export function onboardingTransitionRequest(
  from: "new" | OnboardingStep,
  to: OnboardingStep,
): { from: "new" | OnboardingStep; to: OnboardingStep } {
  return { from, to };
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
