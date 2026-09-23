// The application login gate. Pure, so the loading / login / app split can
// be checked without rendering the rest of Iwa.
//
// A remembered browser is a valid Iwa User session cookie, not a wallet
// connection. Wallets stay on the screens that need them.

export type IwaUserStatus = "active" | "suspended";
export type OnboardingStatus = "new" | "incomplete" | "completed";
export type OnboardingStep = "profile" | "passwordPin" | "walletProvisioning" | "recovery" | "finish";

export interface IwaUser {
  id: string;
  email: string;
  status: IwaUserStatus;
  onboardingStatus?: OnboardingStatus;
  onboardingStep?: OnboardingStep;
}

export type AuthPhase = "loading" | "unauthenticated" | "authenticated" | "suspended";

export interface AuthSnapshot {
  loading: boolean;
  user: IwaUser | null;
}

/**
 * What the shell may show.
 *
 * Loading wins over everything else so a remembered session cannot flash the
 * login screen on the way into the app.
 */
export function authPhase(snapshot: AuthSnapshot): AuthPhase {
  if (snapshot.loading) return "loading";
  if (snapshot.user === null) return "unauthenticated";
  if (snapshot.user.status === "suspended") return "suspended";
  return "authenticated";
}

/** Marketing, invites and the OAuth/email callbacks stay reachable without a session. */
export function requiresIwaSession(routeName: string): boolean {
  return (
    routeName !== "landing" &&
    routeName !== "invite" &&
    routeName !== "celoBindInvite" &&
    routeName !== "authCallback" &&
    routeName !== "authConfirm" &&
    routeName !== "console"
  );
}
