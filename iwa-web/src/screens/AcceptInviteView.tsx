// Invited member flow: see the circle, connect, accept your place.
//
// The person reads plain terms and taps Accept. Behind that, their wallet
// signs once and the browser derives their savings identity from that
// signature. The private half never leaves this tab and is never stored; only
// the public commitment is sent, and that is what goes into the circle anyway.

import { useCallback, useEffect, useState } from "react";

import styles from "./CircleSetup.module.css";
import { Button } from "../components/Button";
import { backend, BackendError, type InviteView } from "../lib/backend";
import { connectWallet, deriveMemberCommitment } from "../lib/starknetWallet";
import { feltHex } from "../chains/strk20/iwaSigning";
import { USDC_DECIMALS } from "../lib/starknetConfig";
import { formatUnits } from "../chains/strk20/funding";

const CADENCE_WORDS: Record<number, string> = {
  604800: "every week",
  1209600: "every two weeks",
  2592000: "every month",
};

function cadenceWords(seconds: number): string {
  return CADENCE_WORDS[seconds] ?? `every ${Math.round(seconds / 86400)} days`;
}

function humanError(e: unknown): string {
  if (e instanceof BackendError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Please try again.";
}

export function AcceptInviteView({ token }: { token: string }) {
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    void backend
      .getInvite(token)
      .then(setInvite)
      .catch((e) => setLoadError(humanError(e)));
  }, [token]);

  const onAccept = useCallback(async () => {
    setError(null);
    setBusy("Confirming in your wallet");
    try {
      const address = await connectWallet();
      setBusy("Setting up your place");
      // One signature produces the whole identity. Nothing is stored.
      const commitment = await deriveMemberCommitment(address);
      await backend.acceptInvite({
        inviteToken: token,
        memberRef: commitment.commitmentHex,
        authPublicKey: feltHex(commitment.identity.authPublicKeyX),
        address,
      });
      setAccepted(true);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  }, [token]);

  if (loadError !== null) {
    return (
      <div className={styles.wrap}>
        <h1 className={styles.title}>This invitation is not valid</h1>
        <p className={styles.lede}>{loadError}</p>
      </div>
    );
  }

  if (invite === null) {
    return (
      <div className={styles.wrap}>
        <p className={styles.lede}>Opening your invitation…</p>
      </div>
    );
  }

  if (accepted || invite.alreadyAccepted) {
    return (
      <div className={styles.wrap}>
        <h1 className={styles.title}>You are in</h1>
        <p className={styles.lede}>
          Your place is reserved. The circle starts once everyone has accepted, and you will
          contribute {formatUnits(BigInt(invite.contributionAmount), USDC_DECIMALS)} USDC{" "}
          {cadenceWords(invite.cadenceSeconds)}.
        </p>
        <div className={styles.success}>
          {accepted ? "Place accepted." : "You have already accepted this invitation."}
        </div>
        <p className={styles.hint}>
          Keep using this same wallet. It is how Iwa recognises you — nothing is saved on this
          device, so there is no code to write down and nothing to lose.
        </p>
      </div>
    );
  }

  if (invite.status === "created") {
    return (
      <div className={styles.wrap}>
        <h1 className={styles.title}>This circle has already started</h1>
        <p className={styles.lede}>
          The places were filled and the circle is running. Ask the organizer to include you next
          time.
        </p>
      </div>
    );
  }

  const pot = BigInt(invite.contributionAmount) * BigInt(invite.memberCount);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>You have been invited to a savings circle</h1>
      <p className={styles.lede}>
        Everyone puts in the same amount each round, and takes turns collecting the whole pot.
      </p>

      {error && <div className={styles.notice}>{error}</div>}

      <section className={styles.card}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>You put in</span>
          <span className={styles.rowValue}>
            {formatUnits(BigInt(invite.contributionAmount), USDC_DECIMALS)} USDC{" "}
            {cadenceWords(invite.cadenceSeconds)}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>People in the circle</span>
          <span className={styles.rowValue}>{invite.memberCount}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>You collect, on your turn</span>
          <span className={styles.rowValue}>{formatUnits(pot, USDC_DECIMALS)} USDC</span>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Grace period</span>
          <span className={styles.rowValue}>
            {Math.round(invite.graceSeconds / 86400)} day
            {invite.graceSeconds > 86400 ? "s" : ""}
          </span>
        </div>
      </section>

      <section className={styles.card}>
        <p className={styles.cardTitle}>Your contributions stay private</p>
        <p className={styles.hint}>
          What you put in, and when, is hidden from everyone else. Only your good standing can be
          shown, and only by you.
        </p>
      </section>

      <div className={styles.actions}>
        <Button onClick={() => void onAccept()} disabled={busy !== null}>
          Accept invitation
        </Button>
      </div>
      {busy && <p className={styles.busy}>{busy}…</p>}
      <p className={styles.hint}>
        Accepting reserves your place. No money moves yet, and you contribute only when the circle
        starts.
      </p>
    </div>
  );
}
