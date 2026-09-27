import { useEffect, useState, type FormEvent } from "react";

import { CowrieGlyph } from "../app/AuthScreen";
import { useIwaAuth } from "../app/IwaAuthProvider";
import { useIwaWalletVault } from "../app/IwaWalletVaultProvider";
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
import { iwaAccount, IwaAccountError, type WalletSetupView } from "../lib/iwaAccount";
import styles from "./OnboardingView.module.css";

const STEP_COPY: Record<OnboardingStep, { label: string; detail: string }> = {
  profile: { label: "Your Iwa account", detail: "Your verified email is the account foundation." },
  passwordPin: { label: "Secure your Iwa Wallet", detail: "Create a wallet passkey, local vault password, and quick-confirmation PIN." },
  walletProvisioning: { label: "Your Iwa Wallet", detail: "Create and unlock the encrypted wallet container on this device." },
  recovery: { label: "Recovery", detail: "Choose how you can safely return to your wallet." },
  finish: { label: "Ready for Iwa", detail: "Your account and wallet setup are complete." },
};

export function OnboardingView() {
  const auth = useIwaAuth();
  const { view: vaultView, inspect, provision, unlock } = useIwaWalletVault();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<WalletCredentialInputs>(emptyWalletCredentialInputs);
  const [credentialErrors, setCredentialErrors] = useState<WalletCredentialValidation>({});
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [walletSetup, setWalletSetup] = useState<WalletSetupView | null | undefined>(undefined);
  const [unlockPassword, setUnlockPassword] = useState("");
  const status = auth.user?.onboardingStatus ?? "new";
  const currentStep = onboardingStepFor(status, auth.user?.onboardingStep);

  useEffect(() => {
    setError(null);
  }, [currentStep, status]);

  useEffect(() => {
    if (currentStep !== "passwordPin") {
      setCredentials(emptyWalletCredentialInputs());
      setCredentialErrors({});
      setUnlockPassword("");
    }
  }, [currentStep]);

  useEffect(() => {
    if (currentStep !== "walletProvisioning") {
      setWalletSetup(undefined);
      return;
    }
    let active = true;
    setWalletSetup(undefined);
    void (async () => {
      try {
        const response = await iwaAccount.walletSetup();
        if (!active) return;
        setWalletSetup(response.wallet);
        if (response.wallet === null || response.wallet.status !== "vaultProvisioned") {
          setError("Iwa could not verify the local wallet setup. Please return to wallet security setup.");
          return;
        }
        await inspect(response.wallet.walletId);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof IwaAccountError ? cause.message : "Iwa could not check this device's local wallet.");
      }
    })();
    return () => {
      active = false;
    };
  }, [currentStep, auth.user?.id, inspect]);

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
    setCredentialErrors({});
    setCredentials((current) => ({
      ...current,
      [field]: field === "pin" || field === "confirmPin" ? pinDigits(value) : value,
    }));
  };

  const createWalletVault = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateWalletCredentialInputs(credentials);
    setCredentialErrors(validation);
    if (validation.passwordError !== undefined || validation.pinError !== undefined || busy) return;
    const userId = auth.user?.id;
    if (userId === undefined) return;
    setBusy(true);
    setError(null);
    try {
      // The reservation request is intentionally sent before any local secret
      // is used, and contains an empty JSON object only.
      const reservation = await iwaAccount.reserveWalletSetup();
      await inspect(reservation.wallet.walletId);
      await provision({
        walletId: reservation.wallet.walletId,
        password: credentials.password,
        pin: credentials.pin,
      });
      // Clear page-memory credentials before the server progress mutation.
      setCredentials(emptyWalletCredentialInputs());
      setCredentialErrors({});
      await iwaAccount.markWalletProvisioned(reservation.wallet.walletId);
      const session = await auth.refresh();
      if (
        session === null ||
        session.user.id !== userId ||
        session.user.onboardingStatus !== "incomplete" ||
        session.user.onboardingStep !== "walletProvisioning"
      ) {
        throw new IwaAccountError(
          401,
          "onboarding_recovery_failed",
          "Iwa could not restore your account setup. Please sign in again.",
        );
      }
    } catch (cause) {
      setError(
        cause instanceof IwaAccountError
          ? cause.message
          : "Iwa could not finish local wallet setup. Your wallet password and PIN were not sent to Iwa.",
      );
    } finally {
      setBusy(false);
    }
  };

  const unlockLocalVault = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || walletSetup === null || walletSetup === undefined || Array.from(unlockPassword).length < 12 || Array.from(unlockPassword).length > 128) {
      setError("Enter the 12 to 128 character wallet password to unlock this device.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unlock({ walletId: walletSetup.walletId, password: unlockPassword });
      setUnlockPassword("");
    } catch {
      setError("Iwa Wallet could not be unlocked on this device. Check your wallet password and complete your wallet passkey.");
    } finally {
      setBusy(false);
    }
  };

  const advanceToRecovery = async () => {
    const userId = auth.user?.id;
    if (userId === undefined || busy || walletSetup?.status !== "vaultProvisioned" || vaultView.state !== "warm") return;
    setBusy(true);
    setError(null);
    try {
      await iwaAccount.transitionOnboarding("walletProvisioning", "recovery");
      const session = await auth.refresh();
      if (
        session === null ||
        session.user.id !== userId ||
        session.user.onboardingStatus !== "incomplete" ||
        session.user.onboardingStep !== "recovery"
      ) {
        throw new IwaAccountError(
          401,
          "onboarding_recovery_failed",
          "Iwa could not restore your account setup. Please sign in again.",
        );
      }
    } catch (cause) {
      setError(cause instanceof IwaAccountError ? cause.message : "Iwa could not continue to recovery setup.");
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
          {currentStep === "profile" && status === "new"
            ? "Start with your Iwa account. Your wallet will stay separate and self-custodied."
            : currentStep === "passwordPin"
              ? "Secure your Iwa Wallet separately from your Iwa account sign-in."
              : currentStep === "walletProvisioning"
                ? "Your wallet is local to this device. Your Iwa account cannot unlock it."
                : currentStep === "recovery"
                  ? "Your local wallet is secured. Recovery setup is the next protected step."
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
          <form className={styles.credentials} onSubmit={createWalletVault} noValidate>
            <div className={styles.credentialsHeading}>
              <h2>Secure your Iwa Wallet</h2>
              <p>
                Create a wallet passkey on this device, then create local protection for your Iwa Wallet. This is separate from your Iwa account sign-in.
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
              <p id="wallet-password-help" className={styles.help}>Use 12 to 128 characters. This is not your Iwa login password and it never leaves this device.</p>
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

            <p className={styles.notice}>
              Your PIN is only for quick confirmation while Iwa Wallet is already unlocked. It cannot unlock a closed wallet or recover it.
            </p>
            <Button type="submit" disabled={busy}>{busy ? "Securing Iwa Wallet..." : "Create secure Iwa Wallet"}</Button>
          </form>
        ) : currentStep === "walletProvisioning" ? (
          walletSetup === undefined ? (
            <p className={styles.notice}>Checking the local Iwa Wallet on this device...</p>
          ) : walletSetup === null || walletSetup.status !== "vaultProvisioned" ? (
            <p className={styles.notice}>This wallet setup cannot continue on this device yet.</p>
          ) : vaultView.localVault === "unknown" ? (
            <p className={styles.notice}>Checking the local Iwa Wallet on this device...</p>
          ) : vaultView.localVault === "absent" ? (
            <p className={styles.notice}>This Iwa Wallet is not available on this device. Do not create another wallet. Recovery setup is required before it can be used here.</p>
          ) : vaultView.state === "warm" ? (
            <section className={styles.credentials} aria-labelledby="wallet-secured-title">
              <div className={styles.credentialsHeading}>
                <h2 id="wallet-secured-title">Iwa Wallet secured</h2>
                <p>Your encrypted local wallet is unlocked on this device. No blockchain account has been created yet.</p>
              </div>
              <Button onClick={() => void advanceToRecovery()} disabled={busy}>{busy ? "Continuing..." : "Continue to recovery"}</Button>
            </section>
          ) : (
            <form className={styles.credentials} onSubmit={unlockLocalVault} noValidate>
              <div className={styles.credentialsHeading}>
                <h2>Unlock Iwa Wallet</h2>
                <p>Use your wallet password and wallet passkey. Your PIN cannot unlock a closed wallet.</p>
              </div>
              <label className={styles.label} htmlFor="iwa-wallet-unlock-password">Wallet password</label>
              <input
                id="iwa-wallet-unlock-password"
                className={styles.input}
                type="password"
                autoComplete="off"
                minLength={12}
                maxLength={128}
                value={unlockPassword}
                onChange={(event) => setUnlockPassword(event.target.value)}
              />
              <Button type="submit" disabled={busy}>{busy ? "Unlocking Iwa Wallet..." : "Unlock Iwa Wallet"}</Button>
            </form>
          )
        ) : currentStep === "recovery" ? (
          <section className={styles.credentials} aria-labelledby="recovery-next-title">
            <div className={styles.credentialsHeading}>
              <h2 id="recovery-next-title">Recovery setup is next</h2>
              <p>Recovery and portability will be added in the next protected wallet phase. Iwa has not created a blockchain account or wallet key.</p>
            </div>
          </section>
        ) : (
          <p className={styles.notice}>This account setup stage is not available yet.</p>
        )}
      </Island>
    </main>
  );
}
