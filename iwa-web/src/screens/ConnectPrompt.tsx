// A wallet is needed for this, and nothing else is being claimed.
//
// Used wherever a screen is genuinely private or needs to act on the visitor's
// behalf. It never connects on its own: the visitor presses the button. Public
// parts of a screen keep working around it, so this replaces only the part that
// really cannot be shown.

import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { useWallet } from "../app/WalletProvider.tsx";
import styles from "./CircleView.module.css";

export function ConnectPrompt({
  title = "Connect your wallet",
  reason,
}: {
  title?: string;
  reason: string;
}) {
  const wallet = useWallet();
  return (
    <Island className={styles.card}>
      <h2 className={styles.h2}>{title}</h2>
      <p className={styles.meta}>{reason}</p>
      <div className={styles.stack}>
        <Button onClick={() => void wallet.connect()} disabled={wallet.connecting}>
          {wallet.connecting ? "Connecting…" : "Connect wallet"}
        </Button>
      </div>
      <p className={styles.meta}>
        Iwa needs a privacy-enabled Starknet wallet such as Ready. Your keys stay in your
        wallet, and nothing is stored on this device.
      </p>
    </Island>
  );
}
