import { useEffect, useState } from "react";

import { AuthLoading } from "../app/AuthScreen";
import { useIwaAuth } from "../app/IwaAuthProvider";
import { iwaAuthConfirm, IwaAccountError } from "../lib/iwaAccount";
import type { Route } from "../lib/router";
import styles from "../app/AuthScreen.module.css";
import { Island } from "../components/Island";

export function AuthConfirmView({ navigate }: { navigate: (to: string | Route) => void }) {
  const auth = useIwaAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await iwaAuthConfirm.complete({
          hash: window.location.hash,
          search: window.location.search,
        });
        if (cancelled) return;
        await auth.refresh();
        if (session.user.onboardingStatus === "completed") {
          navigate({ name: "home" });
        } else {
          navigate({ name: "onboarding" });
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof IwaAccountError ? e.message : "That confirmation link could not be verified.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.refresh, navigate]);

  if (error !== null) {
    return (
      <div className={styles.page}>
        <Island className={styles.card}>
          <h1 className={styles.title}>Could not confirm sign-in</h1>
          <p className={styles.lede}>{error}</p>
        </Island>
      </div>
    );
  }

  return <AuthLoading />;
}
