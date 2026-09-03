// The application's front door.
//
// Still deliberately not a dashboard. What it adds is the one thing a saver
// opens an app to find out, which is whether anything is waiting on them. That
// list is derived from circles they already belong to and rounds the chain
// already holds; nothing is stored, and nothing is invented. Its most common
// correct answer is that there is nothing to do, and it says so plainly rather
// than filling the space.
//
// It never signs anything. Every task is a place to go, and the money still
// moves only where it moved before, behind an explicit confirmation.
//
// AND IT NEVER ASKS FOR A SIGNATURE BY ITSELF.
//
// Reading somebody's circles needs the read-only session, and creating that
// session costs one wallet signature. Doing that on mount would mean a person
// who connected a wallet and did nothing else is asked to sign for something
// they never asked to see. So this loads by itself only when a session already
// exists, and otherwise waits behind a button. The gate lives in
// lib/homeActions.ts, where it can be tested without a browser.

import { useCallback, useEffect, useState } from "react";

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import { useSession } from "../app/SessionProvider.tsx";
import { backend, type CircleAssociation } from "../lib/backend.ts";
import { get_circle, get_round_obligation } from "../lib/iwaStarknet.ts";
import { actionCenter, type CircleTask } from "../lib/actionCenter.ts";
import {
  actionCenterView,
  HOME_COPY,
  shouldLoadActionCenter,
} from "../lib/homeActions.ts";
import { roundSummary } from "../lib/roundState.ts";
import { canJoin } from "../chains/strk20/circleState.ts";
import { circlePath, type Route } from "../lib/router.ts";
import styles from "./CircleView.module.css";

export function HomeView({ navigate }: { navigate: (to: string | Route) => void }) {
  const wallet = useWallet();
  const { address, ensureIdentity } = wallet;
  const { authorizedRead, hasSession } = useSession();
  const connected = address !== null;

  const [tasks, setTasks] = useState<CircleTask[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The person pressed the button. Never set by a render. */
  const [requested, setRequested] = useState(false);

  const view = actionCenterView({
    connected,
    hasSession: hasSession(),
    requested,
    loading,
    tasks,
    failed,
  });

  /**
   * Everything waiting on this person.
   *
   * The service is asked first because it is cheap and it decides which
   * circles are worth reading at all. The chain is then read only for circles
   * that actually exist, and the member identity is derived only if one of
   * them has a place this wallet took, so nobody is asked to sign in order to
   * be told they have nothing to do.
   */
  const load = useCallback(async () => {
    if (address === null) return;
    setLoading(true);
    setFailed(false);
    try {
      const mine: CircleAssociation[] = await authorizedRead((auth) => backend.myCircles(auth));
      const live = mine.filter((a) => a.status === "created" && a.circleId !== null);
      const identity = live.some((a) => a.accepted) ? await ensureIdentity() : null;

      const inputs = await Promise.all(
        mine.map(async (a) => {
          const base = {
            draftId: a.draftId,
            circleId: a.circleId,
            role: a.role,
            accepted: a.accepted,
            status: a.status,
            memberCount: a.memberCount,
            acceptedCount: a.acceptedCount,
            readyToJoin: false,
            round: null,
          };
          if (a.status !== "created" || a.circleId === null || identity === null || !a.accepted) {
            return base;
          }
          try {
            const c = await get_circle(a.circleId, identity.commitmentBytes);
            const yourSlot = c.members.findIndex((m) => m.isYou);
            const obligation = c.youJoined
              ? await get_round_obligation(a.circleId, c.current_round, identity.commitmentBytes)
              : null;
            return {
              ...base,
              readyToJoin: canJoin({
                reservedForYou: c.reserved,
                youJoined: c.youJoined,
                joinedCount: c.joinedCount,
                memberLimit: c.size,
                status: c.status,
              }),
              round: c.youJoined
                ? roundSummary({
                    round: c.current_round,
                    memberLimit: c.size,
                    contributionAmount: c.amount,
                    circleStatus: c.status,
                    youJoined: c.youJoined,
                    reserved: c.reserved,
                    yourSlot: yourSlot === -1 ? null : yourSlot,
                    obligation,
                    now: Math.floor(Date.now() / 1000),
                  })
                : null,
            };
          } catch {
            // Unreadable right now. No task is invented from a failed read.
            return base;
          }
        }),
      );

      setTasks(actionCenter(inputs));
    } catch {
      // Could not be built, or the person declined the signature. Either way
      // this stops and waits to be asked again. It never retries by itself,
      // because a retry is another prompt.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [address, authorizedRead, ensureIdentity]);

  /**
   * Loads only when the gate allows it.
   *
   * With a session that is immediate and silent. Without one it waits, so
   * arriving on Home never opens a wallet.
   */
  useEffect(() => {
    if (!shouldLoadActionCenter({ connected, hasSession: hasSession(), requested, loading, tasks, failed })) {
      return;
    }
    void load();
  }, [connected, hasSession, requested, loading, tasks, failed, load]);

  /** Forgets what was loaded when the wallet changes, so nothing stale shows. */
  useEffect(() => {
    setTasks(null);
    setRequested(false);
    setFailed(false);
  }, [address]);

  return (
    <>
      {connected ? (
        <Island className={styles.card}>
          <h2 className={styles.h2}>{HOME_COPY.heading}</h2>

          {view.kind === "needsSession" ? (
            <>
              <p className={styles.meta}>{HOME_COPY.needsSession}</p>
              <div className={styles.stack}>
                <Button onClick={() => setRequested(true)}>
                  {HOME_COPY.needsSessionAction}
                </Button>
              </div>
            </>
          ) : null}

          {view.kind === "loading" ? (
            <p className={styles.meta}>{HOME_COPY.loading}</p>
          ) : null}

          {view.kind === "failed" ? (
            <>
              <p className={styles.meta}>{HOME_COPY.failed}</p>
              <div className={styles.stack}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setFailed(false);
                    setRequested(true);
                  }}
                >
                  {HOME_COPY.failedAction}
                </Button>
              </div>
            </>
          ) : null}

          {view.kind === "ready" && view.tasks.length === 0 ? (
            <p className={styles.meta}>{HOME_COPY.nothing}</p>
          ) : null}

          {view.kind === "ready" && view.tasks.length > 0 ? (
            <ol className={styles.timeline}>
              {view.tasks.map((task) => (
                <li
                  key={task.key}
                  className={styles.timelineItem}
                  data-tone={task.priority === "info" ? "upcoming" : "current"}
                >
                  <span className={styles.timelineLabel}>{task.title}</span>
                  <span className={styles.timelineDetail}>{task.detail}</span>
                  {task.circleId !== null ? (
                    <Button
                      variant="ghost"
                      onClick={() => navigate(circlePath(task.circleId as number))}
                    >
                      Open
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </Island>
      ) : null}

      <Island className={styles.card}>
        <h2 className={styles.h2}>Welcome to Iwa</h2>
        <p className={styles.meta}>
          A savings circle is a group who agree an amount and a turn order. Every round
          everyone contributes, and one person collects the whole pot. Iwa keeps the money
          private and the record of who paid verifiable.
        </p>

        <div className={styles.stack}>
          <Button onClick={() => navigate({ name: "explore" })}>Browse circles</Button>
        </div>

        {!connected && (
          <p className={styles.meta}>
            You can look around without connecting. A wallet is needed to join a circle,
            contribute, see your own standing, or start a circle of your own.
          </p>
        )}
      </Island>

      <Island className={styles.card}>
        <h2 className={styles.h2}>Start a circle</h2>
        <p className={styles.meta}>
          Circles are invite only. You choose how many places, how much each round and how
          long the grace period is, then send one invitation per place.
        </p>
        <div className={styles.stack}>
          <Button variant="ghost" onClick={() => navigate({ name: "create" })}>
            Start a circle
          </Button>
        </div>
      </Island>

      {connected && (
        <Island className={styles.card}>
          <h2 className={styles.h2}>Your standing</h2>
          <p className={styles.meta}>
            How reliably you have contributed, private to you and shown to nobody else.
          </p>
          <div className={styles.stack}>
            <Button variant="ghost" onClick={() => navigate({ name: "standing" })}>
              My standing
            </Button>
          </div>
        </Island>
      )}
    </>
  );
}
