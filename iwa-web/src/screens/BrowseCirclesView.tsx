import { useEffect, useState } from "react";
import { Island } from "../components/Island.tsx";
import { listCircles } from "../lib/iwaStarknet.ts";
import type { CircleSummary } from "../lib/iwaStarknet.ts";
import { tokenSymbol, tokenDecimals } from "../lib/starknetConfig.ts";
import { formatAmount } from "../lib/amount.ts";
import styles from "./CircleView.module.css";

// Flow 5: discover circles. The contract has no list call, so listCircles scans
// sequential ids on chain. Open (joinable) circles are shown first, then full,
// then complete; within each, newest first.

function statusLabel(c: CircleSummary): string {
  if (c.status === "complete") return "Complete";
  if (c.members >= c.size) return "Full";
  return "Open";
}

function rank(c: CircleSummary): number {
  if (c.status === "complete") return 2;
  if (c.members >= c.size) return 1;
  return 0;
}

export function BrowseCirclesView({ onView }: { onView: (id: number) => void }) {
  const [circles, setCircles] = useState<CircleSummary[] | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await listCircles();
        if (active) setCircles(list);
      } catch (err) {
        console.warn("listCircles failed", err);
        if (active) setCircles([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const loading = circles === null;
  const sorted = circles
    ? [...circles].sort((a, b) => rank(a) - rank(b) || b.id - a.id)
    : [];

  return (
    <Island className={styles.card}>
      <h2 className={styles.h2}>Browse circles</h2>
      <p className={styles.meta}>
        Circles on Starknet. Open ones you can join, active ones in progress.
      </p>

      {loading ? (
        <p className={styles.meta}>Scanning circles on Starknet</p>
      ) : sorted.length === 0 ? (
        <p className={styles.meta}>No circles yet. Create the first one.</p>
      ) : (
        <div className={styles.browseList}>
          {sorted.map((c) => (
            <div key={c.id} className={styles.browseRow}>
              <div className={styles.browseInfo}>
                <span className={styles.browseAmount}>
                  {formatAmount(c.amount, tokenDecimals(c.token))}{" "}
                  {tokenSymbol(c.token)}
                </span>
                <span className={styles.browseSub}>
                  each round · {c.members} of {c.size} joined · {statusLabel(c)}
                </span>
                {c.trust_required ? (
                  <span className={styles.browseSub}>
                    Requires proof of good standing
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className={styles.browseBtn}
                onClick={() => onView(c.id)}
              >
                View
              </button>
            </div>
          ))}
        </div>
      )}
    </Island>
  );
}
