// The application's front door.
//
// Deliberately small, and deliberately not a dashboard. It opens no circle of
// its own, invents no figures, and says only what is true for whoever is
// looking: where to find circles, what a wallet is needed for, and how a circle
// gets started. Anything richer needs coordination reads that do not exist yet,
// and a made-up summary would be worse than none.

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import type { Route } from "../lib/router.ts";
import styles from "./CircleView.module.css";

export function HomeView({ navigate }: { navigate: (to: string | Route) => void }) {
  const wallet = useWallet();
  const connected = wallet.address !== null;

  return (
    <>
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
