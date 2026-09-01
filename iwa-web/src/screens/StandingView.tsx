// My standing.
//
// Standing is recorded per circle: the contract holds one obligation per member
// per round, and a member's record is the history of those. There is no
// cross-circle aggregate on chain and no coordination read that lists the
// circles a wallet belongs to, so this page cannot yet total anything up.
//
// It says that, and sends you to the circle where the record actually lives,
// rather than inventing a figure. Aggregating across circles is real work with
// a real design, not a number to fabricate here.

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { ConnectPrompt } from "./ConnectPrompt.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import type { Route } from "../lib/router.ts";
import styles from "./CircleView.module.css";

export function StandingView({ navigate }: { navigate: (to: string | Route) => void }) {
  const wallet = useWallet();

  if (wallet.address === null) {
    return (
      <ConnectPrompt
        title="Your standing is private"
        reason="It is derived from your own contributions and shown to nobody else, so it needs your wallet before it can be read."
      />
    );
  }

  return (
    <Island className={styles.card}>
      <h2 className={styles.h2}>Your standing</h2>
      <p className={styles.meta}>
        Your record lives with each circle you are part of: how many rounds you completed,
        how many you paid on time, and whether you ever defaulted. Open a circle you belong
        to and it is there, private to you.
      </p>
      <p className={styles.meta}>
        A single standing gathered across every circle is not built yet. Rather than show a
        figure that would not mean anything, Iwa shows nothing here until it does.
      </p>
      <div className={styles.stack}>
        <Button onClick={() => navigate({ name: "explore" })}>Find your circle</Button>
      </div>
    </Island>
  );
}
