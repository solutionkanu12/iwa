// app/AppWalletControl.tsx — the compact wallet control in the app shell.
//
// One control for two connections. It renders two compact rows — Starknet,
// then EVM — so a visitor always knows which wallet Iwa is talking to and
// which one is still missing. Connecting or disconnecting one never touches
// the other, because the underlying wallet manager keeps the slots
// independent and this control only reports them.
//
// This is the shell's account area, deliberately not a dashboard: two short
// rows, two addresses, two actions, and nothing else.

import styles from "./AppWalletControl.module.css";
import { Button } from "../components/Button";
import type { EvmWalletState } from "../lib/evmWallet";

export interface AppWalletControlProps {
  starknetAddress: string | null;
  evmStatus: EvmWalletState["status"];
  evmAddress: string | null;
  busy: "starknet" | "evm" | null;
  /** Opens the Connect to Iwa chooser. Used when nothing is connected yet. */
  onOpenChooser: () => void;
  onConnectStarknet: () => void;
  onDisconnectStarknet: () => void;
  onConnectEvm: () => void;
  onDisconnectEvm: () => void;
}

function short(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-4)}`;
}

function evmHeld(status: EvmWalletState["status"]): boolean {
  return status === "connected" || status === "wrongNetwork";
}

export function AppWalletControl({
  starknetAddress,
  evmStatus,
  evmAddress,
  busy,
  onOpenChooser,
  onConnectStarknet,
  onDisconnectStarknet,
  onConnectEvm,
  onDisconnectEvm,
}: AppWalletControlProps) {
  const evmConnected = evmHeld(evmStatus);

  if (starknetAddress === null && !evmConnected) {
    return (
      <Button className={styles.connectAll} onClick={onOpenChooser} disabled={busy !== null}>
        {busy !== null ? "Connecting…" : "Connect to Iwa"}
      </Button>
    );
  }

  return (
    <div className={styles.control}>
      <div className={styles.rows}>
        <div className={styles.row}>
          <span className={styles.chain}>Starknet</span>
          {starknetAddress === null ? (
            <>
              <span className={styles.state}>Not connected</span>
              <button
                type="button"
                className={styles.action}
                onClick={onConnectStarknet}
                disabled={busy !== null}
              >
                Connect
              </button>
            </>
          ) : (
            <>
              <span className={styles.stateConnected}>Connected</span>
              <span className={styles.addr}>{short(starknetAddress)}</span>
              <button type="button" className={styles.action} onClick={onDisconnectStarknet}>
                Disconnect
              </button>
            </>
          )}
        </div>

        <div className={styles.row}>
          <span className={styles.chain}>EVM</span>
          {!evmConnected ? (
            <>
              <span className={styles.state}>Not connected</span>
              <button
                type="button"
                className={styles.action}
                onClick={onConnectEvm}
                disabled={busy !== null}
              >
                Connect
              </button>
            </>
          ) : (
            <>
              <span className={evmStatus === "wrongNetwork" ? styles.state : styles.stateConnected}>
                {evmStatus === "wrongNetwork" ? "Wrong network" : "Connected"}
              </span>
              {evmAddress !== null ? <span className={styles.addr}>{short(evmAddress)}</span> : null}
              <button type="button" className={styles.action} onClick={onDisconnectEvm}>
                Disconnect
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}