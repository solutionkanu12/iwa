import { useMemo, useState } from "react";
import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { classifyContractError, create_circle } from "../lib/iwaStarknet.ts";
import { TOKEN_OPTIONS } from "../lib/starknetConfig.ts";
import { parseAmount } from "../lib/amount.ts";
import styles from "./CircleView.module.css";

// Flow 4: create a circle. The connected wallet signs a real create_circle on
// the savings contract, choosing the token, amount, members, and round length.
// Amounts are entered in human units and converted to the token's base units.

const FREQUENCIES = [
  { label: "Daily", seconds: 86400 },
  { label: "Weekly", seconds: 604800 },
  { label: "Monthly", seconds: 2592000 },
];

function short(s: string): string {
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function createErrorMessage(err: unknown): string {
  switch (classifyContractError(err)) {
    case "InvalidConfig":
      return "Check the amount, members, and round length.";
    case "Declined":
      return "Signature was declined.";
    default:
      return "Could not create the circle. Please try again.";
  }
}

function Check() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <path d="M5 12l4 4 10-10" />
    </svg>
  );
}

export function CreateCircleView({
  address,
  onBack,
  onCreated,
}: {
  address: string;
  onBack: () => void;
  onCreated: (circleId: number) => void;
}) {
  const firstEnabled = TOKEN_OPTIONS.find((t) => t.enabled);
  const [tokenId, setTokenId] = useState(firstEnabled ? firstEnabled.id : "");
  const [amount, setAmount] = useState("");
  const [size, setSize] = useState("3");
  const [frequency, setFrequency] = useState(604800);
  const [status, setStatus] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState("");
  const [newId, setNewId] = useState(0);

  const token = TOKEN_OPTIONS.find((t) => t.id === tokenId && t.enabled) ?? null;
  const decimals = token?.decimals ?? 7;
  const symbol = token?.symbol ?? "";
  const busy = status === "working";

  // Amount in base units, or 0 when the input is not a valid positive number.
  const amountBase = useMemo(() => {
    if (!/^\d*\.?\d+$/.test(amount.trim())) return 0n;
    try {
      return parseAmount(amount, decimals);
    } catch {
      return 0n;
    }
  }, [amount, decimals]);

  const sizeNum = parseInt(size, 10);
  const sizeValid = Number.isInteger(sizeNum) && sizeNum >= 2;
  const valid = !!token && amountBase > 0n && sizeValid && frequency > 0;

  const submit = async () => {
    if (!valid || !token) return;
    setStatus("working");
    setError(null);
    try {
      const r = await create_circle(
        token.id,
        amountBase,
        frequency,
        sizeNum,
        address,
      );
      setNewId(r.circleId);
      setTxHash(r.txHash);
      setStatus("done");
    } catch (err) {
      console.warn("create failed", err);
      setError(createErrorMessage(err));
      setStatus("idle");
    }
  };

  return (
    <Island className={styles.card}>
      <button
        type="button"
        className={styles.backBtn}
        onClick={onBack}
        disabled={busy}
      >
        ‹ back to circle
      </button>
      <h2 className={styles.h2}>Create a circle</h2>
      <p className={styles.meta}>
        Set the terms. Others can join the circle once it is created.
      </p>

      {status === "done" ? (
        <div className={styles.done}>
          <span className={`${styles.vdot} ${styles.vdotLg}`}>
            <Check />
          </span>
          <p className={styles.doneMsg}>Circle created</p>
          <p className={`${styles.mono} ${styles.doneTx}`}>circle id {newId}</p>
          <p className={`${styles.mono} ${styles.doneTx}`}>tx {short(txHash)}</p>
          <div className={styles.stack}>
            <Button onClick={() => onCreated(newId)}>Go to the circle</Button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Token</span>
            <div className={styles.choiceRow}>
              {TOKEN_OPTIONS.map((t) => (
                <button
                  key={t.symbol}
                  type="button"
                  className={`${styles.choice} ${
                    t.enabled && tokenId === t.id ? styles.choiceActive : ""
                  }`}
                  aria-pressed={t.enabled && tokenId === t.id}
                  disabled={!t.enabled || busy}
                  onClick={() => setTokenId(t.id)}
                >
                  {t.enabled ? t.symbol : `${t.symbol} soon`}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Amount each round</span>
            <div className={styles.inputRow}>
              <input
                className={styles.input}
                inputMode="decimal"
                placeholder="5"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
              />
              <span className={styles.inputSuffix}>{symbol}</span>
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Members</span>
            <input
              className={styles.input}
              inputMode="numeric"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Round length</span>
            <div className={styles.choiceRow}>
              {FREQUENCIES.map((f) => (
                <button
                  key={f.seconds}
                  type="button"
                  className={`${styles.choice} ${
                    frequency === f.seconds ? styles.choiceActive : ""
                  }`}
                  aria-pressed={frequency === f.seconds}
                  disabled={busy}
                  onClick={() => setFrequency(f.seconds)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.stack}>
            <Button onClick={submit} disabled={!valid || busy}>
              {busy ? "Creating" : "Create circle"}
            </Button>
          </div>
          {error ? (
            <p
              className={styles.meta}
              style={{ textAlign: "center", marginTop: "8px" }}
            >
              {error}
            </p>
          ) : null}
        </>
      )}
    </Island>
  );
}
