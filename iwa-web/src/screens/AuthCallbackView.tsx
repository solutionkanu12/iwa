import { useEffect, useState } from "react";

import { AuthLoading } from "../app/AuthScreen";
import { useIwaAuth } from "../app/IwaAuthProvider";
import { iwaAuthCallback, IwaAccountError } from "../lib/iwaAccount";
import type { Route } from "../lib/router";
import styles from "../app/AuthScreen.module.css";
import { Island } from "../components/Island";

export function AuthCallbackView({ navigate }: { navigate: (to: string | Route) => void }) {
  const auth = useIwaAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await iwaAuthCallback.complete({
          hash: window.location.hash,
          search: window.location.search,
        });
        if (cancelled) return;
        await auth.refresh();
        navigate({ name: "home" });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof IwaAccountError ? e.message : "That sign-in could not be completed.");
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
          <h1 className={styles.title}>Could not finish signing in</h1>
          <p className={styles.lede}>{error}</p>
        </Island>
      </div>
    );
  }

  return <AuthLoading />;
}
