// A Celo circle has no backend listing (account bindings are
// verify-not-disclose by design), so it is always reached by its contract
// address rather than appearing automatically in this list.

import { useState } from "react";

import styles from "./CircleView.module.css";
import { Island } from "../components/Island";
import { Button } from "../components/Button";
import { celoCirclePath, isEvmAddress, type Route } from "../lib/router";

export function OpenCeloCircle({ navigate }: { navigate: (to: string | Route) => void }) {
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onOpen = () => {
    const trimmed = address.trim();
    if (!isEvmAddress(trimmed)) {
      setError("That does not look like a circle contract address on Celo.");
      return;
    }
    setError(null);
    navigate(celoCirclePath(trimmed));
  };

  return (
    <Island className={styles.card}>
      <h2 className={styles.h2}>Open a Celo circle</h2>
      <p className={styles.meta}>
        Have a circle contract address? Open it directly to view or take part in it.
      </p>
      {error && <p className={styles.meta}>{error}</p>}
      <div className={styles.inputRow}>
        <input
          className={styles.input}
          placeholder="0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Button onClick={onOpen}>Open</Button>
      </div>
    </Island>
  );
}
