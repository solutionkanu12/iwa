import { useEffect, useState, type FormEvent } from "react";

import { CowrieGlyph } from "../app/AuthScreen";
import { useIwaAuth } from "../app/IwaAuthProvider";
import { ONBOARDING_STEPS, onboardingStepFor } from "../app/onboarding";
import type { OnboardingStep } from "../app/iwaAuthGate";
import {
  emptyWalletCredentialInputs,
  pinDigits,
  validateWalletCredentialInputs,
  type WalletCredentialInputs,
  type WalletCredentialValidation,
} from "../app/onboardingCredentials";
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
  const [credentials, setCredentials] = useState<WalletCredentialInputs>(emptyWalletCredentialInputs);
  const [credentialErrors, setCredentialErrors] = useState<WalletCredentialValidation>({});
  const [credentialsReady, setCredentialsReady] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const status = auth.user?.onboardingStatus ?? "new";
  const currentStep = onboardingStepFor(status, auth.user?.onboardingStep);

  useEffect(() => {
    setError(null);
  }, [currentStep, status]);

  useEffect(() => {
    if (currentStep !== "passwordPin") {
      setCredentials(emptyWalletCredentialInputs());
      setCredentialErrors({});
      setCredentialsReady(false);
    }
  }, [currentStep]);

  const start = async () => {
    const userId = auth.user?.id;
    if (userId === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      await iwaAccount.startOnboarding();
      const session = await auth.refresh();
      if (
        session === null ||
        session.user.id !== userId ||
        session.user.onboardingStatus !== "incomplete" ||
        session.user.onboardingStep !== "profile"
      ) {
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

  const advanceToPasswordPin = async () => {
    const userId = auth.user?.id;
    if (userId === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      await iwaAccount.transitionOnboarding("profile", "passwordPin");
      const session = await auth.refresh();
      if (
        session === null ||
        session.user.id !== userId ||
        session.user.onboardingStatus !== "incomplete" ||
        session.user.onboardingStep !== "passwordPin"
      ) {
        throw new IwaAccountError(
          401,
          "onboarding_recovery_failed",
          "Iwa could not restore your account setup. Please sign in again.",
        );
      }
    } catch (cause) {
      setError(cause instanceof IwaAccountError ? cause.message : "Iwa could not continue account setup. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const updateCredential = (field: keyof WalletCredentialInputs, value: string) => {
    setCredentialsReady(false);
    setCredentialErrors({});
    setCredentials((current) => ({
      ...current,
      [field]: field === "pin" || field === "confirmPin" ? pinDigits(value) : value,
    }));
  };

  const validateCredentials = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateWalletCredentialInputs(credentials);
    setCredentialErrors(validation);
    setCredentialsReady(validation.passwordError === undefined && validation.pinError === undefined);
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
          {currentStep === "profile" && status === "new"
            ? "Start with your Iwa account. Your wallet will stay separate and self-custodied."
            : currentStep === "passwordPin"
              ? "Create local wallet credentials. They are not an Iwa sign-in password."
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

        {currentStep === "profile" && status === "new" ? (
          <Button onClick={() => void start()} disabled={busy}>
            {busy ? "Starting setup…" : "Start account setup"}
          </Button>
        ) : currentStep === "profile" ? (
          <Button onClick={() => void advanceToPasswordPin()} disabled={busy}>
            {busy ? "Continuing..." : "Continue to password and PIN"}
          </Button>
        ) : currentStep === "passwordPin" ? (
          <form className={styles.credentials} onSubmit={validateCredentials} noValidate>
            <div className={styles.credentialsHeading}>
              <h2>Create wallet password and PIN</h2>
              <p>
                Your password will later encrypt your wallet on this device. Your PIN is only for quick confirmation while it is already unlocked.
              </p>
            </div>

            <fieldset className={styles.fieldset}>
              <legend>Wallet password</legend>
              <label className={styles.label} htmlFor="iwa-wallet-password">Create wallet password</label>
              <div className={styles.inputRow}>
                <input
                  id="iwa-wallet-password"
                  className={styles.input}
                  type={showPassword ? "text" : "password"}
                  autoComplete="off"
                  minLength={12}
                  maxLength={128}
                  value={credentials.password}
                  onChange={(event) => updateCredential("password", event.target.value)}
                  aria-describedby="wallet-password-help"
                />
                <button
                  className={styles.visibility}
                  type="button"
                  aria-label={showPassword ? "Hide wallet password" : "Show wallet password"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
              <p id="wallet-password-help" className={styles.help}>Use 12 to 128 characters. This is not your Iwa login password.</p>
              <label className={styles.label} htmlFor="iwa-wallet-password-confirm">Confirm wallet password</label>
              <input
                id="iwa-wallet-password-confirm"
                className={styles.input}
                type={showPassword ? "text" : "password"}
                autoComplete="off"
                minLength={12}
                maxLength={128}
                value={credentials.confirmPassword}
                onChange={(event) => updateCredential("confirmPassword", event.target.value)}
              />
              {credentialErrors.passwordError !== undefined ? <p className={styles.error} role="alert">{credentialErrors.passwordError}</p> : null}
            </fieldset>

            <fieldset className={styles.fieldset}>
              <legend>Quick-confirmation PIN</legend>
              <label className={styles.label} htmlFor="iwa-wallet-pin">Create six-digit PIN</label>
              <div className={styles.inputRow}>
                <input
                  id="iwa-wallet-pin"
                  className={styles.input}
                  type={showPin ? "text" : "password"}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={credentials.pin}
                  onChange={(event) => updateCredential("pin", event.target.value)}
                />
                <button
                  className={styles.visibility}
                  type="button"
                  aria-label={showPin ? "Hide wallet PIN" : "Show wallet PIN"}
                  aria-pressed={showPin}
                  onClick={() => setShowPin((visible) => !visible)}
                >
                  {showPin ? "Hide" : "Show"}
                </button>
              </div>
              <label className={styles.label} htmlFor="iwa-wallet-pin-confirm">Confirm PIN</label>
              <input
                id="iwa-wallet-pin-confirm"
                className={styles.input}
                type={showPin ? "text" : "password"}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={credentials.confirmPin}
                onChange={(event) => updateCredential("confirmPin", event.target.value)}
              />
              {credentialErrors.pinError !== undefined ? <p className={styles.error} role="alert">{credentialErrors.pinError}</p> : null}
            </fieldset>

            {credentialsReady ? (
              <p className={styles.notice}>
                Your password and PIN are ready in this page only. Wallet setup will use them in the next secured stage.
              </p>
            ) : null}
            <Button type="submit">Review wallet credentials</Button>
          </form>
        ) : (
          <p className={styles.notice}>This account setup stage is not available yet.</p>
        )}
      </Island>
    </main>
  );
}
