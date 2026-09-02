// My standing.
//
// A record, not a rating. Every figure comes from the obligations the contract
// holds for this member: rounds completed, rounds paid on time, rounds paid
// late, defaults. There is no score, no band and no grade, because a score
// would be a judgement about a person and the contract does not make one.
//
// Which circles to look at comes from the coordination service, which knows
// which ones this wallet belongs to. What happened inside each comes from the
// chain. A circle that has not been created yet has no record to read, and says
// so rather than showing zeroes.
//
// Nothing here is shared with anyone. Proving a claim to someone outside a
// circle is the Portable Trust Credential, which is explained honestly and is
// not open in this version.

import { useCallback, useEffect, useState } from "react";

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { ConnectPrompt } from "./ConnectPrompt.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import { backend, BackendError, type CircleAssociation, type WalletSigner } from "../lib/backend.ts";
import { currentWallet } from "../lib/starknetWallet.ts";
import { get_reputation } from "../lib/iwaStarknet.ts";
import { standingSummary, type Standing } from "../lib/standing.ts";
import { CREDENTIAL_VERIFICATION } from "../lib/features.ts";
import { formatAmount } from "../lib/amount.ts";
import { tokenDecimals, tokenSymbol } from "../lib/starknetConfig.ts";
import { circlePath, type Route } from "../lib/router.ts";
import styles from "./CircleView.module.css";

/** Turns the connected wallet into the signer the API client expects. */
function walletSigner(): WalletSigner {
  return async (typedData) => {
    const wallet = currentWallet();
    if (wallet === null) throw new Error("Connect your wallet first.");
    const signature = await wallet.account.signMessage(typedData as never);
    return Array.isArray(signature) ? signature.map(String) : [String(signature)];
  };
}

type Entry = { association: CircleAssociation; standing: Standing | null };

export function StandingView({ navigate }: { navigate: (to: string | Route) => void }) {
  const { address, ensureIdentity } = useWallet();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (address === null) return;
    setError(null);
    setEntries(null);
    try {
      // Only circles where this wallet took a place have a record to read.
      // Organizing one is not participating in it.
      const mine = (await backend.myCircles(address, walletSigner())).filter((a) => a.accepted);
      const identity = mine.some((a) => a.status === "created")
        ? await ensureIdentity()
        : null;

      const read = await Promise.all(
        mine.map(async (association): Promise<Entry> => {
          if (
            association.status !== "created" ||
            association.circleId === null ||
            identity === null
          ) {
            return { association, standing: null };
          }
          try {
            return {
              association,
              standing: await get_reputation(association.circleId, identity.commitmentBytes),
            };
          } catch {
            // Unreadable right now. No record is shown rather than a wrong one.
            return { association, standing: null };
          }
        }),
      );
      setEntries(read);
    } catch (e) {
      setEntries([]);
      setError(e instanceof BackendError ? e.message : "Could not read your standing.");
    }
  }, [address, ensureIdentity]);

  useEffect(() => {
    void load();
  }, [load]);

  if (address === null) {
    return (
      <ConnectPrompt
        title="Your standing is private"
        reason="It is built from your own contributions and shown to nobody else, so it needs your wallet before it can be read."
      />
    );
  }

  return (
    <>
      <Island className={styles.card}>
        <h2 className={styles.h2}>Your standing</h2>
        <p className={styles.meta}>
          How reliably you have paid, in each circle you are part of. Private to you, and
          shared with nobody unless you choose to.
        </p>
        {error !== null && <p className={styles.meta}>{error}</p>}
        {entries === null && <p className={styles.meta}>Reading your record</p>}
        {entries !== null && entries.length === 0 && error === null && (
          <>
            <p className={styles.meta}>
              You do not hold a place in a circle yet, so there is nothing recorded. Your
              standing begins with your first contribution.
            </p>
            <div className={styles.stack}>
              <Button onClick={() => navigate({ name: "explore" })}>Browse circles</Button>
            </div>
          </>
        )}
      </Island>

      {(entries ?? []).map(({ association, standing }) => {
        const decimals = tokenDecimals(association.token);
        const symbol = tokenSymbol(association.token);
        return (
          <Island className={styles.card} key={association.draftId}>
            <h2 className={styles.h2}>
              {formatAmount(BigInt(association.contributionAmount), decimals)} {symbol} circle
            </h2>

            {standing === null ? (
              <p className={styles.meta}>
                This circle has not started yet, so there is nothing recorded.
              </p>
            ) : (
              <div className={styles.rows}>
                <div className={styles.row}>
                  <span className={styles.k}>Rounds completed</span>
                  <span className={styles.v}>{standing.completedCycles}</span>
                </div>
                {standing.lateCount > 0 ? (
                  <div className={styles.row}>
                    <span className={styles.k}>Paid late</span>
                    <span className={styles.v}>{standing.lateCount}</span>
                  </div>
                ) : null}
                <div className={styles.row}>
                  <span className={styles.k}>Defaults</span>
                  <span className={styles.v}>{standing.defaultCount}</span>
                </div>
                {standing.onTimeRate !== null ? (
                  <div className={styles.row}>
                    <span className={styles.k}>Paid on time</span>
                    <span className={styles.v}>{standing.onTimeRate}%</span>
                  </div>
                ) : null}
              </div>
            )}

            {standing !== null ? (
              <p className={`${styles.mono} ${styles.standingSummary}`}>
                {standingSummary(standing)}
              </p>
            ) : null}

            {association.circleId !== null ? (
              <div className={styles.stack}>
                <Button
                  variant="ghost"
                  onClick={() => navigate(circlePath(association.circleId as number))}
                >
                  Open circle
                </Button>
              </div>
            ) : null}
          </Island>
        );
      })}

      <Island className={styles.card}>
        <h2 className={styles.h2}>{CREDENTIAL_VERIFICATION.title}</h2>
        <p className={styles.meta}>
          The point of keeping this record is that you can one day prove a piece of it, to a
          lender or a landlord, without handing over the rest. You would show that you
          completed a number of rounds without defaulting, and nothing else: not the amounts,
          not the circle, not who else was in it.
        </p>
        <p className={styles.meta}>{CREDENTIAL_VERIFICATION.reason}</p>
      </Island>
    </>
  );
}
