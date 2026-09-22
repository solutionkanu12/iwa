import { useEffect, useState } from "react";

import { AuthLoading } from "../app/AuthScreen";
import { useIwaAuth } from "../app/IwaAuthProvider";
import {
  captureAuthRedirectLocation,
  iwaAuthCallback,
  IwaAccountError,
  requireRecoveredIwaSession,
} from "../lib/iwaAccount";
import type { Route } from "../lib/router";
import styles from "../app/AuthScreen.module.css";
import { Island } from "../components/Island";

export function AuthCallbackView({ navigate }: { navigate: (to: string | Route) => void }) {
  const auth = useIwaAuth();
  const [error, setError] = useState<string | null>(null);
  // Keep the original PKCE redirect values before any effect clears the URL.
  const [redirectLocation] = useState(() => captureAuthRedirectLocation(window.location));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const created = await iwaAuthCallback.complete(redirectLocation);
        if (cancelled) return;
        const session = requireRecoveredIwaSession(created, await auth.refresh());
        if (cancelled) return;
        if (session.user.onboardingStatus === "completed") {
          navigate({ name: "home" });
        } else {
          navigate({ name: "onboarding" });
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof IwaAccountError ? e.message : "That sign-in could not be completed.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.refresh, navigate, redirectLocation]);

  if (error !== null) {
    return (
      <div className={styles.page}>
        <Island className={styles.card}>
          <h1 className={styles.title}>Could not finish signing in</h1>
          <p className={styles.lede}>{error}</p>
        </Island>
      </div>
    );
  }

  return <AuthLoading />;
}
