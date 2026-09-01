// The shared body of My circles and Invitations.
//
// Both screens answer the same question from the same two sources, and differ
// only in which associations they ask for and what they say when there are
// none. Writing them twice would eventually give one of them a lifecycle rule
// the other lacked, so they share this.
//
// The service says which circles are yours and whether the organizer has
// created them. The chain says whether you have actually joined and how far the
// circle has got. Neither is asked the other's question, and nothing here joins
// anything: a row opens a circle, and joining is confirmed on the circle
// itself.

import { useCallback, useEffect, useState } from "react";

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { ConnectPrompt } from "./ConnectPrompt.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import { backend, BackendError, type CircleAssociation, type WalletSigner } from "../lib/backend.ts";
import { currentWallet } from "../lib/starknetWallet.ts";
import { lifecycleOf, type ChainSnapshot, type Lifecycle } from "../lib/lifecycle.ts";
import { get_circle } from "../lib/iwaStarknet.ts";
import { formatAmount } from "../lib/amount.ts";
import { tokenDecimals, tokenSymbol } from "../lib/starknetConfig.ts";
import { circlePath, type Route } from "../lib/router.ts";
import styles from "./CircleView.module.css";

const CADENCE_WORDS: Record<number, string> = {
  604800: "every week",
  1209600: "every two weeks",
  2592000: "every month",
};

function cadenceWords(seconds: number): string {
  return CADENCE_WORDS[seconds] ?? `every ${Math.round(seconds / 86400)} days`;
}

/** Turns the connected wallet into the signer the API client expects. */
function walletSigner(): WalletSigner {
  return async (typedData) => {
    const wallet = currentWallet();
    if (wallet === null) throw new Error("Connect your wallet first.");
    const signature = await wallet.account.signMessage(typedData as never);
    return Array.isArray(signature) ? signature.map(String) : [String(signature)];
  };
}

type Row = { association: CircleAssociation; life: Lifecycle };

export interface CircleListViewProps {
  navigate: (to: string | Route) => void;
  /** Which associations this screen is about. */
  source: "circles" | "invitations";
  title: string;
  lede: string;
  /** What to say when the list is empty, and where that leads. */
  empty: { text: string; action: string; route: Route };
  connectReason: string;
}

export function CircleListView({
  navigate,
  source,
  title,
  lede,
  empty,
  connectReason,
}: CircleListViewProps) {
  const wallet = useWallet();
  const address = wallet.address;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (address === null) return;
    setError(null);
    setRows(null);
    try {
      const associations =
        source === "circles"
          ? await backend.myCircles(address, walletSigner())
          : await backend.myInvitations(address, walletSigner());

      // The service is asked first because it is cheap and it decides whether
      // there is a circle on chain worth reading at all.
      //
      // The member identity costs a wallet signature, so it is derived only if
      // some circle here actually has a place taken by this wallet. An
      // organizer who never took one is not asked to sign for nothing.
      const needsIdentity = associations.some((a) => a.accepted && a.status === "created");
      const identity = needsIdentity ? await wallet.ensureIdentity() : null;
      const enriched = await Promise.all(
        associations.map(async (association): Promise<Row> => {
          if (association.status !== "created" || association.circleId === null) {
            return { association, life: lifecycleOf(association, null) };
          }
          let chain: ChainSnapshot | null = null;
          try {
            const c = await get_circle(association.circleId, identity?.commitmentBytes);
            chain = {
              status: c.status,
              joinedCount: c.joinedCount,
              memberLimit: c.size,
              reserved: c.reserved,
              youJoined: c.youJoined,
            };
          } catch {
            // Unreadable right now. The row still shows, and says it is opening
            // rather than claiming something about membership.
          }
          return { association, life: lifecycleOf(association, chain) };
        }),
      );
      setRows(enriched);
    } catch (e) {
      setRows([]);
      setError(e instanceof BackendError ? e.message : "Could not load your circles.");
    }
  }, [address, source, wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  if (address === null) {
    return <ConnectPrompt title={title} reason={connectReason} />;
  }

  return (
    <>
      <Island className={styles.card}>
        <h2 className={styles.h2}>{title}</h2>
        <p className={styles.meta}>{lede}</p>
        {error !== null && <p className={styles.meta}>{error}</p>}
        {rows === null && <p className={styles.meta}>Reading your circles</p>}
        {rows !== null && rows.length === 0 && error === null && (
          <>
            <p className={styles.meta}>{empty.text}</p>
            <div className={styles.stack}>
              <Button onClick={() => navigate(empty.route)}>{empty.action}</Button>
            </div>
          </>
        )}
      </Island>

      {(rows ?? []).map(({ association, life }) => {
        const decimals = tokenDecimals(association.token);
        const symbol = tokenSymbol(association.token);
        return (
          <Island className={styles.card} key={association.draftId}>
            <h2 className={styles.h2}>
              {formatAmount(BigInt(association.contributionAmount), decimals)} {symbol}{" "}
              {cadenceWords(association.cadenceSeconds)}
            </h2>
            <div className={styles.rows}>
              <div className={styles.row}>
                <span className={styles.k}>Status</span>
                <span className={styles.v}>{life.label}</span>
              </div>
              <div className={styles.row}>
                <span className={styles.k}>People</span>
                <span className={styles.v}>
                  {association.acceptedCount} of {association.memberCount} places taken
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.k}>Your part</span>
                <span className={styles.v}>
                  {association.role === "organizer" ? "You organize this circle" : "You have a place"}
                </span>
              </div>
            </div>

            <div className={styles.stack}>
              {life.canOpen && life.circleId !== null ? (
                <Button onClick={() => navigate(circlePath(life.circleId as number))}>
                  {life.state === "readyToJoin" ? "Open circle to join" : "Open circle"}
                </Button>
              ) : null}
              {life.organizerAction ? (
                <Button variant="ghost" onClick={() => navigate({ name: "create" })}>
                  Continue setting up
                </Button>
              ) : null}
            </div>

            {!life.canOpen && !life.organizerAction ? (
              <p className={styles.meta}>
                This circle has not started yet. There is nothing to do until the organizer
                creates it.
              </p>
            ) : null}
          </Island>
        );
      })}
    </>
  );
}
