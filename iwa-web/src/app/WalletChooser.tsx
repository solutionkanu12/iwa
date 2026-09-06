// app/WalletChooser.tsx — the "Connect to Iwa" chooser.
//
// One chooser, two wallets. A visitor connects the wallet that matches what
// they want to do — Starknet for savings circles and standing, EVM for Prize
// Savings — and never needs to connect both. Connecting one leaves the other
// exactly as it was.
//
// This is the same Iwa visual system: the lavender palette, the cloud surface,
// the soft island shadow. Nothing here asks for both connections, and nothing
// here looks like two products sharing a page.

import styles from "./WalletChooser.module.css";
import { Button } from "../components/Button";

export interface WalletChooserProps {
  open: boolean;
  /** The connected Starknet address, or null when there is none. */
  starknetAddress: string | null;
  /** Whether the EVM slot is connected (any network). */
  evmConnected: boolean;
  /** The connected EVM address, or null when there is none. */
  evmAddress: string | null;
  /** "starknet" | "evm" while that connection is being established. */
  busy: "starknet" | "evm" | null;
  onClose: () => void;
  onConnectStarknet: () => void;
  onConnectEvm: () => void;
  onDisconnectStarknet: () => void;
  onDisconnectEvm: () => void;
}

function short(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-4)}`;
}

export function WalletChooser({
  open,
  starknetAddress,
  evmConnected,
  evmAddress,
  busy,
  onClose,
  onConnectStarknet,
  onConnectEvm,
  onDisconnectStarknet,
  onDisconnectEvm,
}: WalletChooserProps) {
  if (!open) return null;

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="chooser-title">
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>Connect to Iwa</p>
            <h2 className={styles.title}>Choose the wallet that matches what you want to do.</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className={styles.options}>
          <div className={styles.option}>
            <div className={styles.optionText}>
              <p className={styles.chain}>Starknet</p>
              <p className={styles.detail}>For savings circles and your Iwa standing.</p>
            </div>
            {starknetAddress === null ? (
              <Button onClick={onConnectStarknet} disabled={busy !== null}>
                {busy === "starknet" ? "Connecting…" : "Connect Starknet wallet"}
              </Button>
            ) : (
              <div className={styles.connectedRow}>
                <span className={styles.connected}>
                  <span className={styles.dot} aria-hidden="true" />
                  Connected
                </span>
                <span className={styles.addr}>{short(starknetAddress)}</span>
                <button type="button" className={styles.disconnect} onClick={onDisconnectStarknet}>
                  Disconnect
                </button>
              </div>
            )}
          </div>

          <div className={styles.option}>
            <div className={styles.optionText}>
              <p className={styles.chain}>EVM</p>
              <p className={styles.detail}>For Prize Savings.</p>
            </div>
            {!evmConnected ? (
              <Button variant="ghost" onClick={onConnectEvm} disabled={busy !== null}>
                {busy === "evm" ? "Connecting…" : "Connect EVM wallet"}
              </Button>
            ) : (
              <div className={styles.connectedRow}>
                <span className={styles.connected}>
                  <span className={styles.dot} aria-hidden="true" />
                  Connected
                </span>
                {evmAddress !== null ? <span className={styles.addr}>{short(evmAddress)}</span> : null}
                <button type="button" className={styles.disconnect} onClick={onDisconnectEvm}>
                  Disconnect
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}