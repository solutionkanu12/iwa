import { Button } from "../components/Button";
import { Island } from "../components/Island";
import { useIwaAuth } from "../app/IwaAuthProvider";
import type { Route } from "../lib/router";
import styles from "../app/AuthScreen.module.css";

export function OnboardingPlaceholderView({
  navigate,
}: {
  navigate: (to: string | Route) => void;
}) {
  const auth = useIwaAuth();

  return (
    <div className={styles.page}>
      <Island className={styles.card}>
        <h1 className={styles.title}>Welcome to Iwa</h1>
        <p className={styles.lede}>
          {auth.user?.email
            ? `Signed in as ${auth.user.email}. Complete account onboarding to start saving.`
            : "Your Iwa account session is active."}
        </p>
        <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <Button variant="solid" onClick={() => navigate({ name: "home" })}>
            Continue to App
          </Button>
        </div>
      </Island>
    </div>
  );
}
