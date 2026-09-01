import { useCallback, useEffect, useState } from "react";
import {
  classifyContractError,
  collect_pot,
  get_circle,
  get_reputation,
  has_contributed,
  join_circle,
  pay_contribution,
} from "../lib/iwaStarknet.ts";
import {
  tokenSymbol,
  tokenDecimals,
} from "../lib/starknetConfig.ts";
import { formatAmount } from "../lib/amount.ts";
import { standingFrom, standingSummary } from "../lib/standing.ts";
import { CREDENTIAL_VERIFICATION, POT_COLLECTION } from "../lib/features.ts";
import type { Route } from "../lib/router.ts";
import { useWallet } from "../app/WalletProvider.tsx";
import { ConnectPrompt } from "./ConnectPrompt.tsx";
import { generateProof } from "../lib/zk.ts";
import type { SnarkProof } from "../lib/convert.ts";
import type { Circle, Reputation } from "../lib/types.ts";
import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { ProveView, CLAIMS } from "./ProveView.tsx";
import { canJoin } from "../chains/strk20/circleState.ts";
import styles from "./CircleView.module.css";

// One circle: its seats, its round, and what you can do about it.
//
// The circle comes from the route and its contents from the chain, so this
// screen never chooses which circle to show and never holds that choice. It
// renders for anyone: terms, seats and round are public, and reading them needs
// no wallet. A connected wallet adds only what is yours, which is why the
// member identity is derived here rather than at the door.
//
// Within the circle it still has its own steps — contribute, your standing,
// prove — because those belong to this circle and not to the application's
// navigation, which the shell owns.

const PRIVACY_LINE =
  "Your contributions are private. Only your good standing can be proven, and only by you.";

// Map a failed contribution to an honest, specific message rather than a
// catch-all. RoundNotFunded belongs to collect, so it falls through to retry.
function payErrorMessage(err: unknown): string {
  switch (classifyContractError(err)) {
    case "AlreadyPaid":
      return "You have already contributed this round.";
    case "NotMember":
      return "Join the circle before contributing.";
    case "WrongRound":
      return "This round is not open for contributions.";
    case "InsufficientBalance":
      return "Not enough balance to contribute.";
    case "Declined":
      return "Signature was declined.";
    default:
      return "Could not contribute. Please try again.";
  }
}

// Map a failed collect to an honest, specific message.
function collectErrorMessage(err: unknown): string {
  switch (classifyContractError(err)) {
    case "RoundNotFunded":
      return "Everyone must contribute before the pot can be collected.";
    case "AlreadyCollected":
      return "This round's pot has already been collected.";
    case "NotCollector":
      return "It is not your turn to collect this round.";
    case "InsufficientBalance":
      return "Not enough balance to collect.";
    case "Declined":
      return "Signature was declined.";
    default:
      return "Could not collect the pot. Please try again.";
  }
}

const REQUIRES_STANDING_PROOF =
  "This circle requires proof of good standing to join.";

// Map a failed join to an honest, specific message.
function joinErrorMessage(err: unknown): string {
  switch (classifyContractError(err)) {
    case "AlreadyMember":
      return "You have already joined this circle.";
    case "CircleFull":
      return "This circle is already full.";
    case "TrustProofRequired":
    case "InvalidTrustProof":
      return REQUIRES_STANDING_PROOF;
    case "Declined":
      return "Signature was declined.";
    default:
      return "Could not join the circle. Please try again.";
  }
}

// Short middle-truncation for addresses and tx ids.
function short(s: string): string {
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// Collector for a round follows the savings contract rule:
// members[(round - 1) % size]. It is your turn when that seat is yours.
function collectorSlotOf(circle: Circle): number {
  return (circle.current_round - 1) % circle.size;
}

function LockIcon() {
  return (
    <svg
      className={styles.lk}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#6D4DF2"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function CheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Count a figure up to its target on mount. Respects reduced motion (jumps
// straight to the value).
function useCountUp(target: number, durationMs: number): number {
  const [value, setValue] = useState(() =>
    prefersReducedMotion() ? target : 0,
  );
  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / durationMs, 1);
      setValue(Math.round(target * p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

function StandingCard({
  reputation,
  onGenerate,
}: {
  reputation: Reputation;
  onGenerate: () => void;
}) {
  const cycles = useCountUp(reputation.completedCycles, 600);
  // No completed round means no rate. Counting up to nothing would show a
  // figure that the record does not support.
  const onTime = useCountUp(reputation.onTimeRate ?? 0, 750);
  const hasRecord = reputation.completedCycles > 0;
  const noDefaults = reputation.defaultCount === 0;
  const fullyOnTime = reputation.onTimeRate === 100;
  return (
    <Island className={styles.card}>
      <h2 className={styles.h2}>Your standing</h2>
      <p className={styles.meta}>
        Private to you. Nothing here is shared until you choose to prove it.
      </p>

      <div className={styles.bignum}>
        <span className={styles.bignumN}>{cycles}</span>
        <span className={styles.bignumU}>cycles completed</span>
      </div>

      {hasRecord ? (
        <div className={styles.statline}>
          <div className={styles.stat}>
            <div className={`${styles.statN} ${fullyOnTime ? styles.statGood : ""}`}>
              {onTime}%
            </div>
            <div className={styles.statL}>on time</div>
          </div>
          <div className={styles.stat}>
            <div className={`${styles.statN} ${noDefaults ? styles.statGood : ""}`}>
              {reputation.defaultCount}
            </div>
            <div className={styles.statL}>defaults</div>
          </div>
        </div>
      ) : null}

      <p className={`${styles.mono} ${styles.standingSummary}`}>
        {standingSummary(reputation)}
      </p>

      {CREDENTIAL_VERIFICATION.available ? (
        <div className={styles.stack}>
          <Button onClick={onGenerate}>Generate proof</Button>
        </div>
      ) : (
        <p className={styles.meta}>{CREDENTIAL_VERIFICATION.reason}</p>
      )}
    </Island>
  );
}

type Screen =
  | "circle"
  | "contribute"
  | "standing"
  | "prove"
  | "create"
  | "browse";
type Status = "idle" | "working" | "done";

export function CircleView({
  circleId,
  navigate,
}: {
  /** The circle this screen shows. Comes from the route, never from state. */
  circleId: number;
  navigate: (to: string | Route) => void;
}) {
  const { ensureIdentity } = useWallet();
  const { address, identity: commitment } = useWallet();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);

  const [screen, setScreen] = useState<Screen>("circle");
  const [contribStatus, setContribStatus] = useState<Status>("idle");
  const [contribTx, setContribTx] = useState<string | null>(null);
  const [contribError, setContribError] = useState<string | null>(null);
  const [contribOnTime, setContribOnTime] = useState(true);
  const [alreadyPaid, setAlreadyPaid] = useState(false);
  const [collectStatus, setCollectStatus] = useState<Status>("idle");
  const [collectTx, setCollectTx] = useState<string | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [collectAmount, setCollectAmount] = useState(0);
  const [joinStatus, setJoinStatus] = useState<Status>("idle");
  const [joinTx, setJoinTx] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [reputation, setReputation] = useState<Reputation | null>(null);

  // Whether the connected wallet has already contributed the circle's current
  // round, read from the contract, so we never offer a Contribute that will
  // revert with AlreadyPaid.
  const loadPaidStatus = useCallback(
    async (c: Circle, bytes: Uint8Array | undefined) => {
      if (!bytes || c.size === 0) {
        setAlreadyPaid(false);
        return;
      }
      try {
        setAlreadyPaid(await has_contributed(c.id, c.current_round, bytes));
      } catch {
        setAlreadyPaid(false);
      }
    },
    [],
  );

  // Loads the circle named by the route. Runs for everyone: the terms, the
  // seats and the round are public. A connected wallet additionally marks
  // which seat is yours, and that needs the member identity, so it is derived
  // here and nowhere earlier.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setCircle(null);
    setScreen("circle");
    setReputation(null);
    setJoinStatus("idle");
    setJoinTx(null);
    setJoinError(null);
    setContribStatus("idle");
    setContribTx(null);
    setContribError(null);
    setAlreadyPaid(false);
    setCollectStatus("idle");
    setCollectTx(null);
    setCollectError(null);
    void (async () => {
      const mine = address === null ? null : await ensureIdentity();
      if (!live) return;
      try {
        const c = await get_circle(circleId, mine?.commitmentBytes);
        if (!live) return;
        setCircle(c);
        await loadPaidStatus(c, mine?.commitmentBytes);
      } catch (err) {
        console.warn("circle read failed", err);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [circleId, address, ensureIdentity, loadPaidStatus]);

  const openContribute = useCallback(() => {
    setContribStatus("idle");
    setContribTx(null);
    setContribError(null);
    setScreen("contribute");
  }, []);

  const backToCircle = useCallback(() => setScreen("circle"), []);

  const join = useCallback(async () => {
    if (!circle || !commitment || !address) return;
    setJoinStatus("working");
    setJoinError(null);

    // Trust-gated circles need a real proof of standing before the on-chain
    // join is even attempted. Same circuit, same claim, same generateProof as
    // My standing / prove: no new crypto, just reused here.
    let trustProof: { proof: SnarkProof; publicSignals: string[] } | undefined;
    if (circle.trust_required) {
      try {
        const p = await generateProof(CLAIMS[0], commitment.secret);
        trustProof = { proof: p.proof, publicSignals: p.publicSignals };
      } catch (err) {
        console.warn("trust proof generation failed", err);
        setJoinError(REQUIRES_STANDING_PROOF);
        setJoinStatus("idle");
        return;
      }
    }

    try {
      const r = await join_circle(
        circle.id,
        commitment.commitmentBytes,
        address,
        trustProof,
      );
      setJoinTx(r.txHash);
      setJoinStatus("done");
      // Refresh the circle so the newly filled slot (yours) shows.
      const c = await get_circle(circle.id, commitment.commitmentBytes);
      setCircle(c);
      await loadPaidStatus(c, commitment.commitmentBytes);
    } catch (err) {
      console.warn("join failed", err);
      setJoinError(joinErrorMessage(err));
      setJoinStatus("idle");
    }
  }, [circle, commitment, address, loadPaidStatus]);

  const goStanding = useCallback(async () => {
    setScreen("standing");
    if (reputation !== null) return;
    if (circle === null || commitment === null) {
      setReputation(standingFrom([]));
      return;
    }
    setReputation(await get_reputation(circle.id, commitment.commitmentBytes));
  }, [reputation, circle, commitment]);

  const goProve = useCallback(() => setScreen("prove"), []);
  const backToStanding = useCallback(() => setScreen("standing"), []);

  const pay = useCallback(async () => {
    if (!circle || !commitment || !address) return;
    setContribStatus("working");
    setContribError(null);
    try {
      const r = await pay_contribution(
        circle.id,
        circle.current_round,
        commitment.commitmentBytes,
        address,
      );
      setContribTx(r.txHash);
      setContribOnTime(r.onTime);
      setContribStatus("done");
      setAlreadyPaid(true);
      // Re-read the circle so any state change shows.
      const c = await get_circle(circle.id, commitment.commitmentBytes);
      setCircle(c);
    } catch (err) {
      // Surface the real reason (AlreadyPaid, NotMember, declined, ...) instead
      // of a catch-all balance message.
      console.warn("pay failed", err);
      setContribError(payErrorMessage(err));
      setContribStatus("idle");
    }
  }, [circle, commitment, address]);

  const collect = useCallback(async () => {
    if (!circle || !commitment || !address) return;
    setCollectStatus("working");
    setCollectError(null);
    try {
      const r = await collect_pot(circle.id, commitment.commitmentBytes, address);
      setCollectTx(r.txHash);
      setCollectAmount(r.amount);
      setCollectStatus("done");
      // Re-read the circle so any state change shows.
      const c = await get_circle(circle.id, commitment.commitmentBytes);
      setCircle(c);
    } catch (err) {
      // Surface the real reason (RoundNotFunded, AlreadyCollected, not your
      // turn, ...) instead of a fake success.
      console.warn("collect failed", err);
      setCollectError(collectErrorMessage(err));
      setCollectStatus("idle");
    }
  }, [circle, commitment, address]);

  let body;
  if (false) {
    body = null;
  } else if (!circle && loading) {
    body = (
      <Island className={styles.card}>
        <h2 className={styles.h2}>Loading your circle</h2>
        <p className={styles.meta}>Reading the circle from Starknet</p>
      </Island>
    );
  } else if (!circle) {
    // The circle named in the link could not be read. Say so, and offer the
    // list, rather than leaving a spinner or quietly opening another circle.
    body = (
      <Island className={styles.card}>
        <h2 className={styles.h2}>That circle could not be opened</h2>
        <p className={styles.meta}>
          {circleId === null
            ? "No circle was chosen."
            : `Circle ${circleId} could not be read from Starknet.`}
        </p>
        <div className={styles.stack}>
          <Button onClick={() => navigate({ name: "explore" })}>Browse circles</Button>
        </div>
      </Island>
    );
  } else if (screen === "contribute") {
    const sym = tokenSymbol(circle.token);
    const decimals = tokenDecimals(circle.token);
    body = (
      <Island className={styles.card}>
        <button type="button" className={styles.backBtn} onClick={backToCircle}>
          ‹ back to circle
        </button>
        <h2 className={styles.h2}>
          Round {circle.current_round} of {circle.size}
        </h2>
        <p className={styles.meta}>Contribute your fixed amount for this round.</p>

        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.k}>Amount</span>
            <span className={`${styles.v} ${styles.vBig}`}>
              {formatAmount(circle.amount, decimals)} {sym}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>To</span>
            <span className={styles.v}>Weekly circle</span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>Status</span>
            <span className={`${styles.v} ${styles.statusMint}`}>on time</span>
          </div>
        </div>

        <div className={styles.promise}>
          <LockIcon />
          <p className={styles.promiseText}>{PRIVACY_LINE}</p>
        </div>

        {contribStatus !== "done" ? (
          <>
            <div className={styles.stack}>
              <Button
                onClick={pay}
                disabled={contribStatus === "working" || !commitment}
              >
                {contribStatus === "working"
                  ? "Contributing"
                  : `Contribute ${formatAmount(circle.amount, decimals)} ${sym}`}
              </Button>
            </div>
            {contribError ? (
              <p
                className={styles.meta}
                style={{ textAlign: "center", marginTop: "8px" }}
              >
                {contribError}
              </p>
            ) : null}
          </>
        ) : (
          <div className={styles.done}>
            <span className={`${styles.vdot} ${styles.vdotLg}`}>
              <CheckIcon size={20} />
            </span>
            <p className={styles.doneMsg}>
              {contribOnTime ? "Recorded. On time." : "Recorded. Late this round."}
            </p>
            <p className={`${styles.mono} ${styles.doneTx}`}>
              tx {contribTx ? short(contribTx) : ""}
            </p>
            <div className={styles.stack}>
              <Button
                variant="ghost"
                className={styles.doneBack}
                onClick={backToCircle}
              >
                Back to circle
              </Button>
            </div>
          </div>
        )}
      </Island>
    );
  } else if (screen === "standing") {
    body = !reputation ? (
      <Island className={styles.card}>
        <h2 className={styles.h2}>Your standing</h2>
        <p className={styles.meta}>Reading your record</p>
      </Island>
    ) : (
      <StandingCard reputation={reputation} onGenerate={goProve} />
    );
  } else if (screen === "prove") {
    body = (
      <ProveView
        onBackToStanding={backToStanding}
        secret={commitment?.secret ?? null}
      />
    );
  } else {
    const collectorSlot = collectorSlotOf(circle);
    const yourTurn = circle.members.some(
      (m) => m.slot === collectorSlot && m.isYou,
    );
    const sym = tokenSymbol(circle.token);
    const decimals = tokenDecimals(circle.token);
    // A seat in the payout order is a place reserved for you, not proof you
    // joined. Every seat is reserved the moment the circle is created, so the
    // join offer has to come from the contract's own joined count.
    const showJoin = canJoin({
      reservedForYou: circle.reserved,
      youJoined: circle.youJoined,
      joinedCount: circle.joinedCount,
      memberLimit: circle.size,
      status: circle.status,
    });
    body = (
      <Island className={styles.card}>
        <h2 className={styles.h2}>Weekly circle</h2>
        <p className={styles.meta}>
          {circle.size} members · {formatAmount(circle.amount, decimals)} {sym}{" "}
          each round
        </p>
        {circle.trust_required ? (
          <p className={styles.meta}>Requires proof of good standing to join</p>
        ) : null}

        <div className={styles.slots} aria-label="Circle members, anonymous">
          {circle.members.map((m, i) => {
            const cls = [
              styles.slot,
              !m.filled ? styles.slotEmpty : "",
              m.isYou ? styles.slotYou : "",
              m.slot === collectorSlot ? styles.slotTurn : "",
            ]
              .filter(Boolean)
              .join(" ");
            const label = m.isYou
              ? "your seat"
              : m.filled
                ? "an anonymous member"
                : "empty seat";
            return (
              <div
                key={m.slot}
                className={cls}
                role="img"
                aria-label={label}
                title={label}
                style={{ animationDelay: `${i * 0.045}s` }}
              >
                <span className={styles.ic} />
              </div>
            );
          })}
        </div>

        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.k}>Round</span>
            <span className={`${styles.v} ${styles.vBig}`}>
              {circle.current_round} of {circle.size}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>This round</span>
            <span className={styles.v}>
              {formatAmount(circle.amount, decimals)} {sym}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>Pot</span>
            <span className={styles.v}>
              {formatAmount(circle.pot, decimals)} {sym}
            </span>
          </div>
          {circle.youJoined ? (
            <div className={styles.row}>
              <span className={styles.k}>Your place</span>
              <span className={styles.v}>You are a member of this circle</span>
            </div>
          ) : null}
        </div>

        <div className={styles.promise}>
          <LockIcon />
          <p className={styles.promiseText}>{PRIVACY_LINE}</p>
        </div>

        {address === null ? (
          <ConnectPrompt
            title="Connect to take part"
            reason="Anyone can read a circle. Joining, contributing and seeing your own standing need your wallet."
          />
        ) : null}

        <div className={styles.stack}>
          {address !== null && circle.youJoined ? (
            <Button variant="ghost" onClick={() => void goStanding()}>
              Your standing in this circle
            </Button>
          ) : null}
          {showJoin && joinStatus !== "done" ? (
            <Button
              onClick={join}
              disabled={joinStatus === "working" || !commitment}
            >
              {joinStatus === "working"
                ? circle.trust_required
                  ? "Generating proof"
                  : "Joining"
                : "Join the circle"}
            </Button>
          ) : null}
          {joinStatus === "done" ? (
            <div className={styles.collectConfirm}>
              <span className={`${styles.vdot} ${styles.vdotSm}`}>
                <CheckIcon size={13} />
              </span>
              Joined the circle
            </div>
          ) : null}
          {alreadyPaid ? (
            <div className={styles.collectConfirm}>
              <span className={`${styles.vdot} ${styles.vdotSm}`}>
                <CheckIcon size={13} />
              </span>
              Contributed this round
            </div>
          ) : (
            <Button onClick={openContribute}>
              Contribute {formatAmount(circle.amount, decimals)} {sym}
            </Button>
          )}
          {yourTurn && collectStatus === "done" ? (
            <div className={styles.collectConfirm}>
              <span className={`${styles.vdot} ${styles.vdotSm}`}>
                <CheckIcon size={13} />
              </span>
              Pot collected privately
            </div>
          ) : yourTurn && POT_COLLECTION.available ? (
            <Button
              variant="ghost"
              onClick={collect}
              disabled={collectStatus === "working"}
            >
              {collectStatus === "working" ? "Collecting" : "Collect the pot"}
            </Button>
          ) : null}
          {yourTurn && !POT_COLLECTION.available && collectStatus !== "done" ? (
            <p className={styles.meta}>
              It is your turn to collect. {POT_COLLECTION.reason}
            </p>
          ) : null}
        </div>
        {joinError ? (
          <p
            className={styles.meta}
            style={{ textAlign: "center", marginTop: "8px" }}
          >
            {joinError}
          </p>
        ) : null}
        {joinStatus === "done" && joinTx ? (
          <p
            className={`${styles.mono} ${styles.doneTx}`}
            style={{ textAlign: "center", marginTop: "8px" }}
          >
            tx {short(joinTx)}
          </p>
        ) : null}
        {collectError ? (
          <p
            className={styles.meta}
            style={{ textAlign: "center", marginTop: "8px" }}
          >
            {collectError}
          </p>
        ) : null}
        {yourTurn && collectStatus === "done" && collectTx ? (
          <>
            <p
              className={`${styles.mono} ${styles.doneTx}`}
              style={{ textAlign: "center", marginTop: "8px" }}
            >
              received {formatAmount(collectAmount, decimals)} {sym}
            </p>
            <p
              className={`${styles.mono} ${styles.doneTx}`}
              style={{ textAlign: "center", marginTop: "8px" }}
            >
              tx {short(collectTx)}
            </p>
          </>
        ) : null}
      </Island>
    );
  }

  return (
    <>
      {body}
      <p className={`${styles.mono} ${styles.protoNote}`}>
        Live on Starknet mainnet · contributions settle privately
      </p>
      {commitment ? (
        <p className={`${styles.mono} ${styles.protoNote}`}>
          Member commitment ready · {short(commitment.commitmentHex)}
        </p>
      ) : null}
    </>
  );
}
