// Organizer flow: describe the circle, invite people, set the turn order, create it.
//
// Everything cryptographic stays out of sight. The organizer picks how many
// people and how much, shares a link per place, watches them accept, drags the
// turn order into shape, and confirms once. Words like commitment, member_ref
// and auth key never appear.

import { useCallback, useEffect, useMemo, useState } from "react";

import styles from "./CircleSetup.module.css";
import { Button } from "../components/Button";
import { backend, inviteLink, BackendError, type DraftView, type WalletSigner } from "../lib/backend";
import { connectWallet, currentWallet, disconnectWallet } from "../lib/starknetWallet";
import { create_circle_from_order } from "../lib/iwaStarknet";
import { CHAIN_ID, MAX_MEMBERS, MIN_MEMBERS, USDC_DECIMALS, USDC_TOKEN } from "../lib/starknetConfig";
import { formatUnits, parseUnits } from "../chains/strk20/funding";

const CADENCE_CHOICES = [
  { label: "Every week", seconds: 604800 },
  { label: "Every two weeks", seconds: 1209600 },
  { label: "Every month", seconds: 2592000 },
];

const GRACE_CHOICES = [
  { label: "1 day", seconds: 86400 },
  { label: "3 days", seconds: 259200 },
  { label: "7 days", seconds: 604800 },
];

/** Turns a wallet into the signer the API client expects. */
function walletSigner(): WalletSigner {
  return async (typedData) => {
    const wallet = currentWallet();
    if (wallet === null) throw new Error("Connect your wallet first.");
    const signature = await wallet.account.signMessage(typedData as never);
    return Array.isArray(signature) ? signature.map(String) : [String(signature)];
  };
}

function humanError(e: unknown): string {
  if (e instanceof BackendError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Please try again.";
}

export function OrganizerCircleView() {
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [memberCount, setMemberCount] = useState(4);
  const [amount, setAmount] = useState("10");
  const [cadence, setCadence] = useState(CADENCE_CHOICES[0].seconds);
  const [grace, setGrace] = useState(GRACE_CHOICES[0].seconds);

  const [draft, setDraft] = useState<DraftView | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [createdCircleId, setCreatedCircleId] = useState<number | null>(null);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const onConnect = useCallback(
    () =>
      run("Connecting your wallet", async () => {
        setAddress(await connectWallet());
      }),
    [run],
  );

  const potPerRound = useMemo(() => {
    try {
      return formatUnits(parseUnits(amount || "0", USDC_DECIMALS) * BigInt(memberCount), USDC_DECIMALS);
    } catch {
      return null;
    }
  }, [amount, memberCount]);

  const onCreateDraft = useCallback(
    () =>
      run("Setting up your circle", async () => {
        if (address === null) throw new Error("Connect your wallet first.");
        let base: bigint;
        try {
          base = parseUnits(amount.trim(), USDC_DECIMALS);
        } catch {
          throw new Error("Enter an amount like 10 or 12.50.");
        }
        if (base <= 0n) throw new Error("The amount must be more than zero.");

        const created = await backend.createDraft(
          {
            chainId: CHAIN_ID,
            organizerAddress: address,
            token: USDC_TOKEN,
            contributionAmount: base.toString(),
            cadenceSeconds: cadence,
            graceSeconds: grace,
            memberCount,
          },
          walletSigner(),
        );
        setDraft(created);
      }),
    [run, address, amount, cadence, grace, memberCount],
  );

  // Acceptances arrive while the organizer waits, so the public view is polled.
  useEffect(() => {
    if (draft === null || draft.status === "created") return;
    const id = window.setInterval(() => {
      void backend
        .getDraft(draft.id)
        .then((fresh) => {
          setDraft((current) =>
            current === null
              ? current
              : // Keep the invite links the organizer already holds; the public
                // view does not include them.
                { ...fresh, slots: fresh.slots.map((s, i) => ({ ...s, inviteToken: current.slots[i]?.inviteToken })) },
          );
        })
        .catch(() => {
          // A transient poll failure is not worth interrupting the screen for.
        });
    }, 6000);
    return () => window.clearInterval(id);
  }, [draft]);

  const onCopy = useCallback(async (slotIndex: number, token: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(token));
      setCopied(slotIndex);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Could not copy. Long-press the link to copy it manually.");
    }
  }, []);

  const onShare = useCallback(
    async (token: string) => {
      const url = inviteLink(token);
      const nav = navigator as Navigator & { share?: (d: { title: string; text: string; url: string }) => Promise<void> };
      if (typeof nav.share === "function") {
        try {
          await nav.share({ title: "Join my Iwa savings circle", text: "Here is your place:", url });
          return;
        } catch {
          // The share sheet was dismissed; fall through to copying.
        }
      }
      await onCopy(-1, token);
    },
    [onCopy],
  );

  const move = useCallback(
    (from: number, to: number) =>
      run("Saving the turn order", async () => {
        if (draft === null || address === null) return;
        const order = draft.slots.map((s) => s.slotIndex);
        if (to < 0 || to >= order.length) return;
        [order[from], order[to]] = [order[to], order[from]];
        const updated = await backend.reorder(draft.id, address, order, walletSigner());
        setDraft((current) =>
          current === null
            ? updated
            : { ...updated, slots: updated.slots.map((s, i) => ({ ...s, inviteToken: current.slots[i]?.inviteToken })) },
        );
      }),
    [run, draft, address],
  );

  const onCreateCircle = useCallback(
    () =>
      run("Creating your circle", async () => {
        if (draft === null || address === null) return;
        const payoutOrder = draft.slots.map((s) => s.memberRef);
        if (payoutOrder.some((r) => r === null)) {
          throw new Error("Everyone needs to accept before the circle can start.");
        }
        const { circleId, txHash } = await create_circle_from_order(
          payoutOrder as string[],
          draft.contributionAmount,
          draft.cadenceSeconds,
          draft.graceSeconds,
        );
        setCreatedCircleId(circleId);
        await backend.markCreated(draft.id, address, circleId, txHash, walletSigner());
        setDraft((d) => (d === null ? d : { ...d, status: "created", circleId, createdTx: txHash }));
      }),
    [run, draft, address],
  );

  // --- render ---

  if (createdCircleId !== null) {
    return (
      <div className={styles.wrap}>
        <h1 className={styles.title}>Your circle is live</h1>
        <p className={styles.lede}>
          Everyone can now make their first contribution. Their turn order is fixed and cannot be
          changed by anyone, including you.
        </p>
        <div className={styles.success}>Circle {createdCircleId} created.</div>
        <div className={styles.actions}>
          <Button onClick={() => window.location.assign("/app")}>Go to the circle</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Start a savings circle</h1>
      <p className={styles.lede}>
        Pick how many people and how much each puts in. Everyone takes a turn collecting the whole
        pot. Contributions stay private.
      </p>

      {error && <div className={styles.notice}>{error}</div>}

      {address === null ? (
        <section className={styles.card}>
          <p className={styles.cardTitle}>First, connect your wallet</p>
          <p className={styles.hint}>
            Iwa needs a privacy-enabled Starknet wallet such as Ready.
          </p>
          <div className={styles.actions}>
            <Button onClick={() => void onConnect()} disabled={busy !== null}>
              Connect wallet
            </Button>
          </div>
        </section>
      ) : draft === null ? (
        <section className={styles.card}>
          <label className={styles.field}>
            <span className={styles.label}>How many people?</span>
            <select
              className={styles.select}
              value={memberCount}
              onChange={(e) => setMemberCount(Number(e.target.value))}
            >
              {Array.from({ length: MAX_MEMBERS - MIN_MEMBERS + 1 }, (_, i) => i + MIN_MEMBERS).map(
                (n) => (
                  <option key={n} value={n}>
                    {n} people
                  </option>
                ),
              )}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>How much does each person put in?</span>
            <input
              className={styles.input}
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="10"
              aria-describedby="pot-hint"
            />
            <p className={styles.hint} id="pot-hint">
              USDC each round.{" "}
              {potPerRound !== null && <>Whoever collects takes {potPerRound} USDC.</>}
            </p>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>How often?</span>
            <select
              className={styles.select}
              value={cadence}
              onChange={(e) => setCadence(Number(e.target.value))}
            >
              {CADENCE_CHOICES.map((c) => (
                <option key={c.seconds} value={c.seconds}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>How long is the grace period?</span>
            <select
              className={styles.select}
              value={grace}
              onChange={(e) => setGrace(Number(e.target.value))}
            >
              {GRACE_CHOICES.map((c) => (
                <option key={c.seconds} value={c.seconds}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className={styles.hint}>Extra time to contribute before a round counts as missed.</p>
          </label>

          <div className={styles.actions}>
            <Button onClick={() => void onCreateDraft()} disabled={busy !== null}>
              Create invitations
            </Button>
          </div>
          {busy && <p className={styles.busy}>{busy}…</p>}
        </section>
      ) : (
        <>
          <section className={styles.card}>
            <p className={styles.cardTitle}>Invite your circle</p>
            <p className={styles.progress}>
              {draft.acceptedCount} of {draft.memberCount} places taken
            </p>
            <div className={styles.bar}>
              <div
                className={styles.barFill}
                style={{ width: `${(draft.acceptedCount / draft.memberCount) * 100}%` }}
              />
            </div>

            {draft.slots.map((slot, position) => (
              <div
                key={slot.slotIndex}
                className={`${styles.slot} ${slot.accepted ? styles.accepted : styles.pending}`}
              >
                <span className={styles.slotNum}>{position + 1}</span>
                <div className={styles.slotBody}>
                  <div className={styles.slotName}>
                    {slot.accepted ? `Member ${position + 1}` : `Place ${position + 1}`}
                  </div>
                  <div className={styles.slotMeta}>
                    {slot.accepted
                      ? "Accepted"
                      : copied === slot.slotIndex
                        ? "Link copied"
                        : "Waiting for them to accept"}
                  </div>
                </div>
                {!slot.accepted && slot.inviteToken && (
                  <div className={styles.slotActions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`Copy invitation for place ${position + 1}`}
                      onClick={() => void onCopy(slot.slotIndex, slot.inviteToken as string)}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`Share invitation for place ${position + 1}`}
                      onClick={() => void onShare(slot.inviteToken as string)}
                    >
                      Share
                    </button>
                  </div>
                )}
                {slot.accepted && (
                  <div className={styles.slotActions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`Move member ${position + 1} earlier`}
                      disabled={position === 0 || busy !== null}
                      onClick={() => void move(position, position - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`Move member ${position + 1} later`}
                      disabled={position === draft.slots.length - 1 || busy !== null}
                      onClick={() => void move(position, position + 1)}
                    >
                      ↓
                    </button>
                  </div>
                )}
              </div>
            ))}

            <p className={styles.hint}>
              The order above is the order people collect the pot. You can change it until the
              circle starts, and never after.
            </p>
          </section>

          <section className={styles.card}>
            <p className={styles.cardTitle}>Start the circle</p>
            <div className={styles.summary}>
              <div className={styles.row}>
                <span className={styles.rowLabel}>People</span>
                <span className={styles.rowValue}>{draft.memberCount}</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Each round</span>
                <span className={styles.rowValue}>
                  {formatUnits(BigInt(draft.contributionAmount), USDC_DECIMALS)} USDC
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Whoever collects takes</span>
                <span className={styles.rowValue}>
                  {formatUnits(
                    BigInt(draft.contributionAmount) * BigInt(draft.memberCount),
                    USDC_DECIMALS,
                  )}{" "}
                  USDC
                </span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>First to collect</span>
                <span className={styles.rowValue}>Member 1</span>
              </div>
            </div>

            {draft.status !== "ready" ? (
              <p className={styles.hint}>
                Everyone needs to accept their invitation before the circle can start.
              </p>
            ) : (
              <p className={styles.hint}>
                This creates the circle on Starknet. You will confirm once in your wallet, and the
                turn order is locked from then on.
              </p>
            )}

            <div className={styles.actions}>
              <Button
                onClick={() => void onCreateCircle()}
                disabled={draft.status !== "ready" || busy !== null}
              >
                Create circle
              </Button>
            </div>
            {busy && <p className={styles.busy}>{busy}…</p>}
          </section>

          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => {
                void disconnectWallet();
                setAddress(null);
                setDraft(null);
              }}
            >
              Sign out
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
