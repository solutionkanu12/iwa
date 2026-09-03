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
import { currentWallet } from "../lib/starknetWallet";
import { create_circle_from_order } from "../lib/iwaStarknet";
import { circlePath, type Route } from "../lib/router";
import { useWallet } from "../app/WalletProvider";
import { useSession } from "../app/SessionProvider.tsx";
import { mergePrivate, moveInOrder, orderOf } from "../lib/draftOrder";
import { inviteProgress } from "../lib/organizerView";
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

export function OrganizerCircleView({
  navigate,
}: {
  navigate: (to: string | Route) => void;
}) {
  const wallet = useWallet();
  const address = wallet.address;
  const { authorizedRead } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [memberCount, setMemberCount] = useState(4);
  const [amount, setAmount] = useState("10");
  const [cadence, setCadence] = useState(CADENCE_CHOICES[0].seconds);
  const [grace, setGrace] = useState(GRACE_CHOICES[0].seconds);

  // The draft as the service holds it. The service is authoritative for every
  // field here: places, invite links, who accepted, the payout order and the
  // circle it became. This is a view of that, never a second copy of it.
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [createdCircleId, setCreatedCircleId] = useState<number | null>(null);

  // The order the organizer is arranging, as slot ids. Local until they save
  // it, so moving a place does not cost a wallet signature per click.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  // A circle that exists on chain but is not recorded yet. Kept so a failed or
  // interrupted hand-off is a state the organizer can finish, not a dead end.
  const [unrecorded, setUnrecorded] = useState<{ circleId: number; txHash: string } | null>(null);

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

  /**
   * Picks up where the organizer left off.
   *
   * Invite links are handed out once and cannot be regenerated, so losing them
   * on a refresh would strand everyone who has not accepted yet. They live in
   * the service; this asks for them back rather than keeping a copy that a
   * reload would destroy.
   */
  const recoverDraft = useCallback(async () => {
    // Two reads, and before sessions they cost two signatures every time the
    // organizer opened this page. Both go through one sign-in now. Neither
    // changes anything; recording a creation, reordering and reconciling all
    // still ask the wallet for their own signature, every time.
    await authorizedRead(async (auth) => {
      const mine = await backend.listDrafts(auth);
      const open = mine.find((d) => d.status !== "created" && d.status !== "abandoned") ?? mine[0];
      if (open === undefined) return;
      setDraft(await backend.getDraftAsOrganizer(open.id, auth));
    });
  }, [authorizedRead]);

  const onConnect = useCallback(
    () =>
      run("Connecting your wallet", async () => {
        const addr = await wallet.connect();
        if (addr === null) return;
        await recoverDraft();
      }),
    [run, recoverDraft, wallet],
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
  //
  // The interval depends on the draft id alone, not on the draft: an effect
  // that both reads and writes the draft would tear down and rebuild its timer
  // on every single response.
  const draftId = draft?.id ?? null;
  const pollable = draft !== null && draft.status !== "created" && draft.status !== "abandoned";
  useEffect(() => {
    if (draftId === null || !pollable) return;
    const timer = window.setInterval(() => {
      void backend
        .getDraft(draftId)
        .then((fresh) => {
          setDraft((current) => {
            if (current === null || current.id !== fresh.id) return current;
            // The public view answers with progress only, so the organizer's
            // own fields are carried across from what they already hold.
            return mergePrivate(fresh, current);
          });
        })
        .catch(() => {
          // A transient poll failure is not worth interrupting the screen for.
        });
    }, 6000);
    return () => window.clearInterval(timer);
  }, [draftId, pollable]);

  const onCopy = useCallback(async (slotId: string, token: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(token));
      setCopied(slotId);
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
      await onCopy("", token);
    },
    [onCopy],
  );

  /**
   * How far the invitations have got.
   *
   * The same counts the screen already shows, said in words: a bar tells
   * somebody roughly how far along they are, and what they actually want to
   * know is how many people they still have to chase. No invitation is
   * described here beyond whether its place is taken, and no token is read.
   */
  const invites = useMemo(
    () =>
      draft === null
        ? null
        : inviteProgress({
            memberCount: draft.memberCount,
            acceptedCount: draft.acceptedCount,
          }),
    [draft],
  );

  /** The order on screen: what the organizer is arranging, or what is saved. */
  const shownOrder = useMemo(
    () => pendingOrder ?? orderOf(draft),
    [pendingOrder, draft],
  );

  /**
   * Moves a place, locally.
   *
   * Saving each arrow press would ask the wallet to sign again every time,
   * which is a confirmation prompt for something nobody has committed to yet.
   * The order is arranged here and saved once, deliberately.
   */
  const move = useCallback(
    (from: number, to: number) => {
      const next = moveInOrder(shownOrder, from, to);
      if (next !== shownOrder) setPendingOrder(next);
    },
    [shownOrder],
  );

  const saveOrder = useCallback(
    () =>
      run("Saving the turn order", async () => {
        if (draft === null || address === null || pendingOrder === null) return;
        const updated = await backend.reorder(draft.id, address, pendingOrder, walletSigner());
        // The saved order comes back from the service. Only once it has is the
        // local arrangement dropped, so a refusal leaves the organizer looking
        // at what they arranged rather than at a change that never happened.
        setDraft((current) => mergePrivate(updated, current));
        setPendingOrder(null);
      }),
    [run, draft, address, pendingOrder],
  );

  const discardOrder = useCallback(() => setPendingOrder(null), []);

  /** The places in the order currently on screen, saved or being arranged. */
  const orderedSlots = useMemo(() => {
    if (draft === null) return [];
    const bySlot = new Map(draft.slots.map((s) => [s.slotId, s]));
    const arranged = shownOrder.map((id) => bySlot.get(id)).filter((s) => s !== undefined);
    // Anything the arrangement does not name still belongs on screen.
    return arranged.length === draft.slots.length ? arranged : draft.slots;
  }, [draft, shownOrder]);

  const onCreateCircle = useCallback(
    () =>
      run("Creating your circle", async () => {
        if (draft === null || address === null) return;
        if (pendingOrder !== null) {
          throw new Error("Save the turn order before starting the circle.");
        }
        const payoutOrder = draft.slots.map((s) => s.memberRef);
        if (payoutOrder.some((r) => r === null)) {
          throw new Error("Everyone needs to accept before the circle can start.");
        }

        // The transaction is the irreversible half. Once it lands the circle
        // exists whatever happens next, so it is recorded locally before the
        // service is told, and the hand-off is allowed to fail on its own.
        const { circleId, txHash } = await create_circle_from_order(
          payoutOrder as string[],
          draft.contributionAmount,
          draft.cadenceSeconds,
          draft.graceSeconds,
        );
        setCreatedCircleId(circleId);
        setUnrecorded({ circleId, txHash });

        try {
          const updated = await backend.markCreated(
            draft.id,
            address,
            circleId,
            txHash,
            walletSigner(),
          );
          setDraft((current) => mergePrivate(updated, current));
          setUnrecorded(null);
        } catch (e) {
          // The circle is real either way. Say what is true, and leave a way to
          // finish rather than implying it has to be created again.
          throw new Error(
            `Your circle was created on Starknet, but Iwa could not record it yet. ${humanError(e)}`,
          );
        }
      }),
    [run, draft, address, pendingOrder],
  );

  /**
   * Finishes a creation the service never recorded.
   *
   * The circle id is not sent: the service finds the circle from the chain by
   * matching this draft's payout order, so this cannot point a draft at
   * somebody else's circle and cannot create a second one.
   */
  const onFinishSetup = useCallback(
    () =>
      run("Finding your circle on Starknet", async () => {
        if (draft === null || address === null) return;
        const updated = await backend.reconcile(draft.id, address, walletSigner());
        setDraft((current) => mergePrivate(updated, current));
        if (updated.circleId !== null) setCreatedCircleId(updated.circleId);
        setUnrecorded(null);
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
          <Button onClick={() => navigate(circlePath(createdCircleId))}>
            Go to the circle
          </Button>
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
            {invites !== null && <p className={styles.hint}>{invites.label}</p>}

            {orderedSlots.map((slot, position) => (
              <div
                key={slot.slotId}
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
                      : copied === slot.slotId
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
                      onClick={() => void onCopy(slot.slotId, slot.inviteToken as string)}
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
                      disabled={position === orderedSlots.length - 1 || busy !== null}
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

            {pendingOrder !== null && (
              <>
                <p className={styles.hint}>This new turn order is not saved yet.</p>
                <div className={styles.actions}>
                  <Button onClick={() => void saveOrder()} disabled={busy !== null}>
                    Save turn order
                  </Button>
                  <Button variant="ghost" onClick={discardOrder} disabled={busy !== null}>
                    Undo changes
                  </Button>
                </div>
              </>
            )}
          </section>

          {unrecorded !== null && (
            <section className={styles.card}>
              <p className={styles.cardTitle}>Your circle was created</p>
              <p className={styles.hint}>
                Circle {unrecorded.circleId} exists on Starknet. Iwa has not finished recording it
                yet, so it may not appear everywhere. Nothing is lost, and starting the circle
                again is neither needed nor possible.
              </p>
              <div className={styles.actions}>
                <Button onClick={() => void onFinishSetup()} disabled={busy !== null}>
                  Finish setting up
                </Button>
              </div>
            </section>
          )}

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
                {invites !== null && !invites.ready
                  ? `${invites.label} before the circle can start.`
                  : "Everyone needs to accept their invitation before the circle can start."}
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

        </>
      )}
    </div>
  );
}
