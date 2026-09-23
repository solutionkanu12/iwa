import { useState } from "react";

import { Button } from "../components/Button";
import { Island } from "../components/Island";
import { iwaAccount, IwaAccountError } from "../lib/iwaAccount";
import styles from "./AuthScreen.module.css";

export function CowrieGlyph() {
  return (
    <svg width="28" height="30" viewBox="0 0 60 70" aria-hidden="true">
      <ellipse cx="30" cy="36" rx="20" ry="26" fill="#B6A6F2" />
      <ellipse cx="25" cy="29" rx="11" ry="15" fill="#CECBF6" opacity=".8" />
      <path d="M30 12C34 30 34 42 30 60C26 42 26 30 30 12Z" fill="#F6F4FC" />
    </svg>
  );
}

export function AuthLoading() {
  return (
    <div className={styles.page}>
      <Island className={styles.card}>
        <div className={styles.mark}>
          <CowrieGlyph />
        </div>
        <p className={styles.loading}>Opening Iwa</p>
      </Island>
    </div>
  );
}

export function AuthSuspended({ message }: { message: string }) {
  return (
    <div className={styles.page}>
      <Island className={styles.card}>
        <div className={styles.mark}>
          <CowrieGlyph />
        </div>
        <h1 className={styles.title}>This Iwa account is suspended</h1>
        <p className={styles.lede}>{message}</p>
      </Island>
    </div>
  );
}

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"google" | "email" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onGoogle = async () => {
    setError(null);
    setNotice(null);
    setBusy("google");
    try {
      const url = await iwaAccount.googleUrl();
      window.location.assign(url);
    } catch (e) {
      setBusy(null);
      setError(e instanceof IwaAccountError ? e.message : "Google sign-in is not available right now.");
    }
  };

  const onEmail = async () => {
    setError(null);
    setNotice(null);
    setBusy("email");
    try {
      await iwaAccount.requestEmail(email);
      setNotice("Check your email for a link to continue. It opens Iwa in this browser.");
    } catch (e) {
      setError(e instanceof IwaAccountError ? e.message : "That email could not be sent. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  void onSignedIn;

  return (
    <div className={styles.page}>
      <Island className={styles.card}>
        <div className={styles.mark}>
          <CowrieGlyph />
        </div>
        <p className={styles.eyebrow}>Iwa</p>
        <h1 className={styles.title}>Continue to Iwa</h1>
        <p className={styles.lede}>
          Sign in with Google or email. Your browser will be remembered on this device.
        </p>

        {error ? <p className={styles.error}>{error}</p> : null}
        {notice ? <p className={styles.notice}>{notice}</p> : null}

        <div className={styles.actions}>
          <Button onClick={() => void onGoogle()} disabled={busy !== null}>
            {busy === "google" ? "Continuing…" : "Continue with Google"}
          </Button>
          <div className={styles.or}>or</div>
          <label className={styles.label} htmlFor="iwa-email">
            Email
          </label>
          <input
            id="iwa-email"
            className={styles.input}
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy !== null}
          />
          <Button variant="ghost" onClick={() => void onEmail()} disabled={busy !== null || email.trim() === ""}>
            {busy === "email" ? "Sending link…" : "Continue with email"}
          </Button>
        </div>
      </Island>
    </div>
  );
}
