import { useEffect, useState } from "react";

import { CowrieGlyph } from "../app/AuthScreen";
import { useIwaAuth } from "../app/IwaAuthProvider";
import { ONBOARDING_STEPS, onboardingStepFor, type OnboardingStep } from "../app/onboarding";
import { Button } from "../components/Button";
import { Island } from "../components/Island";
import { iwaAccount, IwaAccountError } from "../lib/iwaAccount";
import styles from "./OnboardingView.module.css";

const STEP_COPY: Record<OnboardingStep, { label: string; detail: string }> = {
  profile: { label: "Your Iwa account", detail: "Your verified email is the account foundation." },
  passwordPin: { label: "Password and PIN", detail: "Add a second layer of account protection." },
  walletProvisioning: { label: "Your wallet", detail: "Set up a self-custodial wallet you control." },
  recovery: { label: "Recovery", detail: "Choose how you can safely return to your wallet." },
  finish: { label: "Ready for Iwa", detail: "Your account and wallet setup are complete." },
};

export function OnboardingView() {
  const auth = useIwaAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = auth.user?.onboardingStatus ?? "new";
  const currentStep = onboardingStepFor(status);

  useEffect(() => {
    setError(null);
  }, [status]);

  const start = async () => {
    const userId = auth.user?.id;
    if (userId === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      await iwaAccount.startOnboarding();
      const session = await auth.refresh();
      if (session === null || session.user.id !== userId || session.user.onboardingStatus !== "incomplete") {
        throw new IwaAccountError(
          401,
          "onboarding_recovery_failed",
          "Iwa could not restore your account setup. Please sign in again.",
        );
      }
    } catch (cause) {
      setError(cause instanceof IwaAccountError ? cause.message : "Iwa could not start account setup. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const currentIndex = ONBOARDING_STEPS.indexOf(currentStep);

  return (
    <main className={styles.page} aria-labelledby="onboarding-title">
      <Island className={styles.card}>
        <div className={styles.mark}>
          <CowrieGlyph />
        </div>
        <p className={styles.eyebrow}>Iwa account</p>
        <h1 id="onboarding-title" className={styles.title}>
          Set up your place in Iwa
        </h1>
        <p className={styles.lede}>
          {status === "new"
            ? "Start with your Iwa account. Your wallet will stay separate and self-custodied."
            : "Your account setup is saved. Continue from the same place whenever you return."}
        </p>

        <section className={styles.account} aria-labelledby="account-title">
          <p id="account-title" className={styles.accountLabel}>Verified email</p>
          <p className={styles.email}>{auth.user?.email ?? "Your Iwa account"}</p>
        </section>

        <ol className={styles.steps} aria-label="Account setup steps">
          {ONBOARDING_STEPS.map((step, index) => {
            const copy = STEP_COPY[step];
            const state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
            return (
              <li key={step} className={styles.step} data-state={state}>
                <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
                <span>
                  <strong>{copy.label}</strong>
                  <small>{copy.detail}</small>
                </span>
              </li>
            );
          })}
        </ol>

        {error !== null ? <p className={styles.error} role="alert">{error}</p> : null}

        {status === "new" ? (
          <Button onClick={() => void start()} disabled={busy}>
            {busy ? "Starting setup…" : "Start account setup"}
          </Button>
        ) : (
          <p className={styles.notice}>
            Password and PIN setup is the next secured stage. It is not available in this foundation yet.
          </p>
        )}
      </Island>
    </main>
  );
}
