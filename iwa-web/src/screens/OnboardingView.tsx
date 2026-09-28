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
import { IWA_WALLET_RECOVERY_FILE_LIMIT_BYTES, downloadRecoveryPackage, parseRecoveryPackageJson } from "../lib/walletVault/recoveryFile";
import { createRecoveryKey, formatRecoveryKey, parseRecoveryKey } from "../lib/walletVault/recoveryKey";
import styles from "./OnboardingView.module.css";

const STEP_COPY: Record<OnboardingStep, { label: string; detail: string }> = {
  profile: { label: "Your Iwa account", detail: "Your verified email is the account foundation." },
  passwordPin: { label: "Secure your Iwa Wallet", detail: "Create a wallet passkey, local vault password, and quick-confirmation PIN." },
  walletProvisioning: { label: "Your Iwa Wallet", detail: "Create and unlock the encrypted wallet container on this device." },
  recovery: { label: "Recovery", detail: "Choose how you can safely return to your wallet." },
  finish: { label: "Ready for Iwa", detail: "Your account and wallet setup are complete." },
};

function newRecoveryPackageId(): string {
  if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.randomUUID !== "function") {
    throw new Error("recovery package ids are unavailable");
  }
  return `iwa-recovery-${globalThis.crypto.randomUUID()}`;
}

async function selectedRecoveryPackage(file: File): Promise<ReturnType<typeof parseRecoveryPackageJson>> {
  if (file.size <= 0 || file.size > IWA_WALLET_RECOVERY_FILE_LIMIT_BYTES) {
    throw new Error("invalid recovery file");
  }
  return parseRecoveryPackageJson(await file.text());
}

export function OnboardingView() {
  const auth = useIwaAuth();
  const { view: vaultView, inspect, provision, unlock, exportRecovery, verifyRecovery, recover } = useIwaWalletVault();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<WalletCredentialInputs>(emptyWalletCredentialInputs);
  const [credentialErrors, setCredentialErrors] = useState<WalletCredentialValidation>({});
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [walletSetup, setWalletSetup] = useState<WalletSetupView | null | undefined>(undefined);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [recoveryKeyReveal, setRecoveryKeyReveal] = useState<string | null>(null);
  const [recoveryFile, setRecoveryFile] = useState<File | null>(null);
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  const [recoveryCredentials, setRecoveryCredentials] = useState<WalletCredentialInputs>(emptyWalletCredentialInputs);
  const [recoveryCredentialErrors, setRecoveryCredentialErrors] = useState<WalletCredentialValidation>({});
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
    if (currentStep !== "recovery") {
      setRecoveryKeyReveal(null);
      setRecoveryFile(null);
      setRecoveryKeyInput("");
      setRecoveryCredentials(emptyWalletCredentialInputs());
      setRecoveryCredentialErrors({});
    }
  }, [currentStep]);

  useEffect(() => {
    if (recoveryKeyReveal === null) return;
    // This user-visible recovery code is the one narrow UI exception to the
    // normal no-secret-state rule. Limit its display lifetime and clear it on
    // verification or route exit; it is never persisted or transmitted.
    const timeout = window.setTimeout(() => setRecoveryKeyReveal(null), 5 * 60_000);
    return () => window.clearTimeout(timeout);
  }, [recoveryKeyReveal]);

  useEffect(() => {
    if (currentStep !== "walletProvisioning" && currentStep !== "recovery") {
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

  const updateRecoveryCredential = (field: keyof WalletCredentialInputs, value: string) => {
    setRecoveryCredentialErrors({});
    setRecoveryCredentials((current) => ({
      ...current,
      [field]: field === "pin" || field === "confirmPin" ? pinDigits(value) : value,
    }));
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
    const canEnterRecovery =
      vaultView.state === "warm" ||
      (vaultView.localVault === "absent" && walletSetup?.recoveryStatus === "verified");
    if (userId === undefined || busy || walletSetup?.status !== "vaultProvisioned" || !canEnterRecovery) return;
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

  const revealRecoveryPackage = async () => {
    if (
      busy ||
      walletSetup?.status !== "vaultProvisioned" ||
      walletSetup.recoveryStatus !== "notConfigured" ||
      vaultView.state !== "warm"
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    let recoveryKey: Uint8Array | undefined;
    try {
      recoveryKey = createRecoveryKey();
      const recovery = await exportRecovery({
        walletId: walletSetup.walletId,
        recoveryKey,
        packageId: newRecoveryPackageId(),
      });
      downloadRecoveryPackage(recovery);
      // This is an explicit, short-lived user reveal. It is not a vault
      // plaintext and is cleared after package verification or route exit.
      setRecoveryKeyReveal(formatRecoveryKey(recoveryKey));
    } catch {
      setError("Iwa Wallet could not create the encrypted recovery package. No recovery key was sent to Iwa.");
    } finally {
      recoveryKey?.fill(0);
      setBusy(false);
    }
  };

  const copyRecoveryKey = async () => {
    if (recoveryKeyReveal === null || busy) return;
    try {
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(recoveryKeyReveal);
    } catch {
      setError("Iwa could not copy the recovery key. Select it and copy it yourself.");
    }
  };

  const verifySavedRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || walletSetup === null || walletSetup === undefined || recoveryFile === null || vaultView.state !== "warm") {
      setError("Choose your saved recovery package and enter its recovery key to verify it.");
      return;
    }
    setBusy(true);
    setError(null);
    let recoveryKey: Uint8Array | undefined;
    try {
      const recovery = await selectedRecoveryPackage(recoveryFile);
      recoveryKey = parseRecoveryKey(recoveryKeyInput);
      const verified = await verifyRecovery({
        recovery,
        recoveryKey,
        walletId: walletSetup.walletId,
        generation: walletSetup.recoveryGeneration ?? 1,
      });
      const recorded = await iwaAccount.markWalletRecoveryVerified(verified.walletId, verified.generation);
      setWalletSetup(recorded.wallet);
      setRecoveryKeyReveal(null);
      setRecoveryFile(null);
      setRecoveryKeyInput("");
    } catch (cause) {
      setError(
        cause instanceof IwaAccountError && cause.code === "recovery_generation_conflict"
          ? "That recovery package is not the current package for this Iwa Wallet."
          : "Iwa Wallet could not verify that recovery package and recovery key.",
      );
    } finally {
      recoveryKey?.fill(0);
      setBusy(false);
    }
  };

  const recoverOnNewDevice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateWalletCredentialInputs(recoveryCredentials);
    setRecoveryCredentialErrors(validation);
    if (
      busy ||
      walletSetup === null ||
      walletSetup === undefined ||
      walletSetup.recoveryStatus !== "verified" ||
      walletSetup.recoveryGeneration === null ||
      recoveryFile === null ||
      validation.passwordError !== undefined ||
      validation.pinError !== undefined
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    let recoveryKey: Uint8Array | undefined;
    try {
      const recovery = await selectedRecoveryPackage(recoveryFile);
      recoveryKey = parseRecoveryKey(recoveryKeyInput);
      const replacement = await recover({
        recovery,
        recoveryKey,
        walletId: walletSetup.walletId,
        expectedGeneration: walletSetup.recoveryGeneration,
        password: recoveryCredentials.password,
        pin: recoveryCredentials.pin,
        replacementPackageId: newRecoveryPackageId(),
      });
      // Clear all page credentials before the non-secret coordination report.
      setRecoveryCredentials(emptyWalletCredentialInputs());
      setRecoveryCredentialErrors({});
      setRecoveryFile(null);
      setRecoveryKeyInput("");
      downloadRecoveryPackage(replacement);
      const recorded = await iwaAccount.markWalletRecoveryVerified(replacement.walletId, replacement.generation);
      setWalletSetup(recorded.wallet);
    } catch (cause) {
      setError(
        cause instanceof IwaAccountError && cause.code === "recovery_generation_conflict"
          ? "Recovery completed locally, but Iwa reports that another recovery package is now current. Keep the replacement package and resolve this safely before continuing."
          : "Iwa Wallet could not recover this device. Check the saved package, recovery key, and new local credentials.",
      );
    } finally {
      recoveryKey?.fill(0);
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
            walletSetup.recoveryStatus === "verified" ? (
              <section className={styles.credentials} aria-labelledby="wallet-recovery-required-title">
                <div className={styles.credentialsHeading}>
                  <h2 id="wallet-recovery-required-title">Recover Iwa Wallet</h2>
                  <p>This Iwa Wallet exists, but its local encrypted vault is not on this device. Do not create a second wallet.</p>
                </div>
                <Button onClick={() => void advanceToRecovery()} disabled={busy}>{busy ? "Continuing..." : "Recover Iwa Wallet"}</Button>
              </section>
            ) : (
              <p className={styles.notice}>This Iwa Wallet is not available on this device. Recovery has not been verified yet, so Iwa cannot safely create another local wallet here.</p>
            )
          ) : vaultView.localVault === "conflict" ? (
            <p className={styles.notice}>This browser already contains a different local Iwa Wallet. Do not replace it. Use a separate browser profile or the approved recovery flow.</p>
          ) : vaultView.localVault === "corrupt" ? (
            <p className={styles.notice}>This local Iwa Wallet record is corrupted. Do not create another wallet. Use the explicit recovery flow after recovery has been configured.</p>
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
          walletSetup === undefined ? (
            <p className={styles.notice}>Checking recovery setup for this Iwa Wallet...</p>
          ) : walletSetup === null || walletSetup.status !== "vaultProvisioned" ? (
            <p className={styles.notice}>Iwa could not verify recovery setup for this wallet.</p>
          ) : vaultView.localVault === "unknown" ? (
            <p className={styles.notice}>Checking the local Iwa Wallet on this device...</p>
          ) : vaultView.localVault === "conflict" ? (
            <p className={styles.notice}>This browser already contains a different local Iwa Wallet. Do not replace it. Use a separate browser profile before recovery.</p>
          ) : vaultView.localVault === "present" && vaultView.state === "cold" ? (
            <form className={styles.credentials} onSubmit={unlockLocalVault} noValidate>
              <div className={styles.credentialsHeading}>
                <h2>Unlock Iwa Wallet</h2>
                <p>Use your wallet password and wallet passkey before creating or checking recovery.</p>
              </div>
              <label className={styles.label} htmlFor="iwa-wallet-recovery-unlock-password">Wallet password</label>
              <input
                id="iwa-wallet-recovery-unlock-password"
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
          ) : vaultView.localVault === "present" && vaultView.state === "warm" && walletSetup.recoveryStatus === "notConfigured" ? (
            recoveryKeyReveal === null ? (
              <section className={styles.credentials} aria-labelledby="create-recovery-title">
                <div className={styles.credentialsHeading}>
                  <h2 id="create-recovery-title">Create recovery package</h2>
                  <p>Create an encrypted recovery package and save its separate recovery key. Iwa does not keep the recovery key or a copy of the package.</p>
                </div>
                <p className={styles.notice}>You need both the saved package and recovery key. Losing both can mean permanent loss of wallet access once real funds exist.</p>
                <Button onClick={() => void revealRecoveryPackage()} disabled={busy}>{busy ? "Creating recovery package..." : "Create recovery package"}</Button>
              </section>
            ) : (
              <section className={styles.credentials} aria-labelledby="save-recovery-title">
                <div className={styles.credentialsHeading}>
                  <h2 id="save-recovery-title">Save your recovery key</h2>
                  <p>Your encrypted recovery package has been downloaded. Save this separate recovery key somewhere safe. Iwa cannot recover it for you.</p>
                </div>
                <output className={styles.recoveryKey} aria-label="Iwa Wallet recovery key">{recoveryKeyReveal}</output>
                <Button onClick={() => void copyRecoveryKey()} disabled={busy}>Copy recovery key</Button>
                <form className={styles.credentials} onSubmit={verifySavedRecovery} noValidate>
                  <div className={styles.credentialsHeading}>
                    <h2>Verify recovery</h2>
                    <p>Select the saved package and enter its recovery key. Downloading a file alone is not enough.</p>
                  </div>
                  <label className={styles.label} htmlFor="iwa-recovery-file">Saved recovery package</label>
                  <input
                    id="iwa-recovery-file"
                    className={styles.input}
                    type="file"
                    accept=".iwa,application/vnd.iwa.wallet-recovery+json,application/json"
                    onChange={(event) => setRecoveryFile(event.target.files?.[0] ?? null)}
                  />
                  <label className={styles.label} htmlFor="iwa-recovery-key-verify">Recovery key</label>
                  <input
                    id="iwa-recovery-key-verify"
                    className={styles.input}
                    type="password"
                    autoComplete="off"
                    value={recoveryKeyInput}
                    onChange={(event) => setRecoveryKeyInput(event.target.value)}
                  />
                  <Button type="submit" disabled={busy}>{busy ? "Verifying recovery..." : "Verify recovery"}</Button>
                </form>
              </section>
            )
          ) : vaultView.localVault === "present" && vaultView.state === "warm" ? (
            <section className={styles.credentials} aria-labelledby="recovery-verified-title">
              <div className={styles.credentialsHeading}>
                <h2 id="recovery-verified-title">Recovery verified</h2>
                <p>Your portable recovery package is verified. Iwa has not created a blockchain account or wallet key.</p>
              </div>
              <p className={styles.notice}>Keep the current recovery package and its separate recovery key together only when you need to recover. A later wallet phase will add chain authority.</p>
            </section>
          ) : walletSetup.recoveryStatus !== "verified" || walletSetup.recoveryGeneration === null ? (
            <section className={styles.credentials} aria-labelledby="recovery-unavailable-title">
              <div className={styles.credentialsHeading}>
                <h2 id="recovery-unavailable-title">Recovery is not configured</h2>
                <p>This device does not have the local Iwa Wallet, and Iwa has no verified recovery package for it. Return to the device where this wallet was secured.</p>
              </div>
            </section>
          ) : (
            <form className={styles.credentials} onSubmit={recoverOnNewDevice} noValidate>
              <div className={styles.credentialsHeading}>
                <h2>{vaultView.localVault === "corrupt" ? "Recover corrupted local wallet" : "Recover Iwa Wallet"}</h2>
                <p>{vaultView.localVault === "corrupt" ? "The local encrypted record cannot be opened. Use the saved recovery package and its separate recovery key to replace it explicitly." : "Use the saved recovery package and its separate recovery key. Then create new local protection for this device."}</p>
              </div>
              <label className={styles.label} htmlFor="iwa-recovery-import-file">Recovery package</label>
              <input
                id="iwa-recovery-import-file"
                className={styles.input}
                type="file"
                accept=".iwa,application/vnd.iwa.wallet-recovery+json,application/json"
                onChange={(event) => setRecoveryFile(event.target.files?.[0] ?? null)}
              />
              <label className={styles.label} htmlFor="iwa-recovery-import-key">Recovery key</label>
              <input
                id="iwa-recovery-import-key"
                className={styles.input}
                type="password"
                autoComplete="off"
                value={recoveryKeyInput}
                onChange={(event) => setRecoveryKeyInput(event.target.value)}
              />
              <fieldset className={styles.fieldset}>
                <legend>New local protection</legend>
                <label className={styles.label} htmlFor="iwa-recovery-password">New wallet password</label>
                <input
                  id="iwa-recovery-password"
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  minLength={12}
                  maxLength={128}
                  value={recoveryCredentials.password}
                  onChange={(event) => updateRecoveryCredential("password", event.target.value)}
                />
                <label className={styles.label} htmlFor="iwa-recovery-password-confirm">Confirm new wallet password</label>
                <input
                  id="iwa-recovery-password-confirm"
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  minLength={12}
                  maxLength={128}
                  value={recoveryCredentials.confirmPassword}
                  onChange={(event) => updateRecoveryCredential("confirmPassword", event.target.value)}
                />
                {recoveryCredentialErrors.passwordError !== undefined ? <p className={styles.error} role="alert">{recoveryCredentialErrors.passwordError}</p> : null}
                <label className={styles.label} htmlFor="iwa-recovery-pin">New six-digit PIN</label>
                <input
                  id="iwa-recovery-pin"
                  className={styles.input}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={recoveryCredentials.pin}
                  onChange={(event) => updateRecoveryCredential("pin", event.target.value)}
                />
                <label className={styles.label} htmlFor="iwa-recovery-pin-confirm">Confirm new PIN</label>
                <input
                  id="iwa-recovery-pin-confirm"
                  className={styles.input}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={recoveryCredentials.confirmPin}
                  onChange={(event) => updateRecoveryCredential("confirmPin", event.target.value)}
                />
                {recoveryCredentialErrors.pinError !== undefined ? <p className={styles.error} role="alert">{recoveryCredentialErrors.pinError}</p> : null}
              </fieldset>
              <p className={styles.notice}>Your old wallet passkey and PIN are not copied to this device. A replacement encrypted package will be downloaded after recovery.</p>
              <Button type="submit" disabled={busy}>{busy ? "Recovering Iwa Wallet..." : "Recover Iwa Wallet"}</Button>
            </form>
          )
        ) : (
          <p className={styles.notice}>This account setup stage is not available yet.</p>
        )}
      </Island>
    </main>
  );
}
