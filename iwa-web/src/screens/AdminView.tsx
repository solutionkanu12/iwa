// The operator dashboard.
//
// It reports and it does nothing else. There is one button on this screen and
// it performs the read; every other element is text. That is not restraint for
// its own sake: Iwa's deployed contracts carry no administrative power, so any
// control here would either do nothing or would be a power the product has said
// it does not grant.
//
// THE PATH IS NOT THE PROTECTION. /admin is reachable by anybody who types it,
// and reaching it buys nothing. What appears on it comes from an authenticated
// API that verifies a wallet signature against the account contract and then
// checks an allowlist held in the service's own environment. A visitor who is
// not an operator gets a plain answer and no platform data, and the same is
// true of anybody who skips this screen and calls the API directly.
//
// IT NEVER SIGNS BY ITSELF. Reading costs one wallet confirmation, and it is
// asked for by a press rather than by a render, the same rule Home follows. An
// operator who opens this page and changes their mind is never prompted.
//
// Nothing about an individual saver is available to render. The API answers with
// counts, health flags and public contract addresses, so there is no wallet,
// member reference, invitation or circle membership here to leak.

import { useCallback, useState } from "react";

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import { backend, BackendError, type WalletSigner } from "../lib/backend.ts";
import { currentWallet } from "../lib/starknetWallet.ts";
import { STARKNET_MAINNET } from "../chains/starknetProduction.ts";
import { CHAIN_ID } from "../lib/starknetConfig.ts";
import {
  ADMIN_COPY,
  adminReport,
  SOURCE_LABEL,
  type AdminOverviewFacts,
  type AdminReport,
  type DeploymentFacts,
} from "../lib/adminView.ts";
import type { Route } from "../lib/router.ts";
import styles from "./CircleView.module.css";

/** What this build is pinned to. The third source, and labelled as one. */
const DEPLOYMENT: DeploymentFacts = {
  network: CHAIN_ID,
  circleContract: STARKNET_MAINNET.iwaCircle,
  helperContract: STARKNET_MAINNET.iwaHelper,
  privacyPool: STARKNET_MAINNET.privacyPool,
};

/** Turns the connected wallet into the signer the API client expects. */
function walletSigner(): WalletSigner {
  return async (typedData) => {
    const wallet = currentWallet();
    if (wallet === null) throw new Error("Connect your wallet first.");
    const signature = await wallet.account.signMessage(typedData as never);
    return Array.isArray(signature) ? signature.map(String) : [String(signature)];
  };
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; report: AdminReport }
  /** Authenticated, and not an operator. Said plainly, with nothing else. */
  | { kind: "forbidden" }
  | { kind: "failed"; message: string };

export function AdminView({ navigate }: { navigate: (to: string | Route) => void }) {
  const wallet = useWallet();
  const address = wallet.address;
  const [state, setState] = useState<State>({ kind: "idle" });

  /**
   * Reads the platform. Called by a press, never by an effect.
   *
   * One signature, bound to this exact read, and never a session: the service
   * refuses a bearer token on this route, so a captured session cannot become
   * operator access.
   */
  const load = useCallback(async () => {
    if (address === null) return;
    setState({ kind: "loading" });
    try {
      const facts: AdminOverviewFacts = await backend.adminOverview(address, walletSigner());
      setState({
        kind: "ready",
        report: adminReport(facts, DEPLOYMENT, Date.now()),
      });
    } catch (e) {
      // A wallet that is not an operator is not an error to apologise for, and
      // it is told apart from a service that could not be reached.
      if (e instanceof BackendError && e.code === "not_admin") {
        setState({ kind: "forbidden" });
        return;
      }
      setState({
        kind: "failed",
        message: e instanceof BackendError ? e.message : ADMIN_COPY.failed,
      });
    }
  }, [address]);

  return (
    <>
      <Island className={styles.card}>
        <h2 className={styles.h2}>{ADMIN_COPY.heading}</h2>
        <p className={styles.meta}>{ADMIN_COPY.lede}</p>

        {address === null ? (
          <>
            <p className={styles.meta}>{ADMIN_COPY.signedOut}</p>
            <div className={styles.stack}>
              <Button onClick={() => void wallet.connect()}>Connect wallet</Button>
            </div>
          </>
        ) : null}

        {address !== null && state.kind === "idle" ? (
          <>
            <p className={styles.meta}>{ADMIN_COPY.needsAuth}</p>
            <div className={styles.stack}>
              <Button onClick={() => void load()}>{ADMIN_COPY.needsAuthAction}</Button>
            </div>
          </>
        ) : null}

        {state.kind === "loading" ? <p className={styles.meta}>{ADMIN_COPY.loading}</p> : null}

        {state.kind === "forbidden" ? (
          <>
            <p className={styles.meta}>{ADMIN_COPY.forbidden}</p>
            <p className={styles.meta}>{ADMIN_COPY.forbiddenDetail}</p>
            <div className={styles.stack}>
              <Button variant="ghost" onClick={() => navigate({ name: "home" })}>
                Back to Iwa
              </Button>
            </div>
          </>
        ) : null}

        {state.kind === "failed" ? (
          <>
            <p className={styles.meta}>{state.message}</p>
            <div className={styles.stack}>
              <Button variant="ghost" onClick={() => void load()}>
                {ADMIN_COPY.failedAction}
              </Button>
            </div>
          </>
        ) : null}

        {state.kind === "ready" ? (
          <p className={styles.meta}>{ADMIN_COPY.readOnly}</p>
        ) : null}
      </Island>

      {state.kind === "ready" ? (
        <>
          <section id="operations">
          <Island className={styles.card}>
            <h2 className={styles.h2}>{ADMIN_COPY.operationsHeading}</h2>
            {state.report.operations.length === 0 ? (
              <p className={styles.meta}>{ADMIN_COPY.nothingOperational}</p>
            ) : (
              <ul className={styles.timeline} aria-label="What needs looking at">
                {state.report.operations.map((item) => (
                  <li
                    key={item.key}
                    className={styles.timelineItem}
                    data-tone={item.tone === "attention" ? "current" : "upcoming"}
                  >
                    <span className={styles.timelineLabel}>{item.title}</span>
                    <span className={styles.timelineDetail}>{item.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Island>
          </section>

          {state.report.sections.map((section) => (
            <section id={section.key} key={section.key}>
            <Island className={styles.card}>
              <h2 className={styles.h2}>{section.title}</h2>
              <div className={styles.rows}>
                {section.rows.map((row) => (
                  <div key={row.key} className={styles.row}>
                    <span className={styles.k}>{row.label}</span>
                    <span className={styles.v}>{row.value}</span>
                  </div>
                ))}
              </div>
              {/* Which source these figures came from, said once per section
                  rather than per row: a coordination count and a live chain
                  read must never be read as the same kind of fact. */}
              <p className={styles.meta}>
                {[...new Set(section.rows.map((r) => SOURCE_LABEL[r.source]))].join(". ")}.
              </p>
            </Island>
            </section>
          ))}

          <Island className={styles.card}>
            <p className={styles.meta}>Read at {state.report.generatedAt}.</p>
            <div className={styles.stack}>
              <Button variant="ghost" onClick={() => void load()}>
                Read again
              </Button>
            </div>
          </Island>
        </>
      ) : null}
    </>
  );
}
