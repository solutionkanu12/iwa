import { useCallback, useEffect, useState } from "react";
import {
  collect_pot,
  connectWallet,
  get_circle,
  get_reputation,
  pay_contribution,
} from "../lib/iwaContract.ts";
import type { Circle, Reputation } from "../lib/types.ts";
import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { ProveView } from "./ProveView.tsx";
import styles from "./CircleView.module.css";

// Flow 1 (the circle view) and Flow 2 (contribute and collect), matched to
// design/iwa-prototype.html. Connect gate first (mocked connectWallet), then the
// circle screen from mocked get_circle. Contribute opens a confirm step that
// calls pay_contribution; collect calls collect_pot. All chain access stays
// behind the lib seam; the seam signatures are unchanged.

const PRIVACY_LINE =
  "Your contributions are private. Only your good standing can be proven, and only by you.";

// Short middle-truncation for addresses and tx ids.
function short(s: string): string {
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// Collector for a round follows the savings contract rule:
// members[(round - 1) % size]. It is your turn when that seat is yours.
function collectorSlotOf(circle: Circle): number {
  return (circle.current_round - 1) % circle.size;
}

// The small cowrie glyph used as the app mark.
function NavGlyph() {
  return (
    <svg width="22" height="24" viewBox="0 0 60 70" aria-hidden="true">
      <ellipse cx="30" cy="36" rx="20" ry="26" fill="#B6A6F2" />
      <ellipse cx="25" cy="29" rx="11" ry="15" fill="#CECBF6" opacity=".8" />
      <path d="M30 12C34 30 34 42 30 60C26 42 26 30 30 12Z" fill="#F6F4FC" />
    </svg>
  );
}

// The cowrie seal (inline SVG for now, replaced with a polished asset later).
function CowrieSeal() {
  return (
    <svg
      className={styles.cowrieSvg}
      viewBox="-24 -20 248 264"
      width="100%"
      role="img"
      aria-label="Cowrie seal"
    >
      <ellipse cx="108" cy="132" rx="58" ry="74" fill="#AFA9EC" opacity=".55" />
      <ellipse cx="100" cy="110" rx="62" ry="80" fill="#B6A6F2" />
      <ellipse cx="86" cy="90" rx="38" ry="52" fill="#CECBF6" opacity=".75" />
      <path d="M100 40C110 80 110 140 100 180C90 140 90 80 100 40Z" fill="#F6F4FC" />
      <g stroke="#8d80c4" strokeWidth="2.4" strokeLinecap="round" opacity=".7">
        <line x1="93" y1="66" x2="85" y2="66" />
        <line x1="107" y1="66" x2="115" y2="66" />
        <line x1="92" y1="86" x2="83" y2="86" />
        <line x1="108" y1="86" x2="117" y2="86" />
        <line x1="91" y1="108" x2="82" y2="108" />
        <line x1="109" y1="108" x2="118" y2="108" />
        <line x1="92" y1="130" x2="83" y2="130" />
        <line x1="108" y1="130" x2="117" y2="130" />
        <line x1="93" y1="152" x2="85" y2="152" />
        <line x1="107" y1="152" x2="115" y2="152" />
      </g>
    </svg>
  );
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
  const onTime = useCountUp(reputation.onTimeRate, 750);
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

      <div className={styles.statline}>
        <div className={styles.stat}>
          <div
            className={`${styles.statN} ${fullyOnTime ? styles.statGood : ""}`}
          >
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

      <p className={`${styles.mono} ${styles.standingSummary}`}>
        {reputation.completedCycles} cycles · {reputation.onTimeRate}% on time ·{" "}
        {reputation.defaultCount} defaults
      </p>

      <div className={styles.stack}>
        <Button onClick={onGenerate}>Generate proof</Button>
      </div>
    </Island>
  );
}

function AppNav({
  address,
  section,
  onCircle,
  onStanding,
}: {
  address: string | null;
  section: "circle" | "standing";
  onCircle: () => void;
  onStanding: () => void;
}) {
  const enabled = !!address;
  return (
    <Island className={styles.appNav}>
      <div className={styles.navL}>
        <NavGlyph />
        <span className={styles.nm}>Iwa</span>
      </div>
      <div className={styles.tabs} role="tablist" aria-label="App sections">
        <button
          type="button"
          className={`${styles.tab} ${section === "circle" ? styles.tabActive : ""}`}
          role="tab"
          aria-selected={section === "circle"}
          onClick={onCircle}
          disabled={!enabled}
        >
          Circle
        </button>
        <button
          type="button"
          className={`${styles.tab} ${section === "standing" ? styles.tabActive : ""}`}
          role="tab"
          aria-selected={section === "standing"}
          onClick={onStanding}
          disabled={!enabled}
        >
          My standing
        </button>
      </div>
      <div className={styles.walletSlot}>
        {address ? (
          <span className={styles.wallet}>
            <span className={styles.walletDot} />
            <span className={styles.walletAddr}>{short(address)}</span>
          </span>
        ) : null}
      </div>
    </Island>
  );
}

type Screen = "circle" | "contribute" | "standing" | "prove";
type Status = "idle" | "working" | "done";

export function CircleView() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [circle, setCircle] = useState<Circle | null>(null);

  const [screen, setScreen] = useState<Screen>("circle");
  const [contribStatus, setContribStatus] = useState<Status>("idle");
  const [contribTx, setContribTx] = useState<string | null>(null);
  const [collectStatus, setCollectStatus] = useState<Status>("idle");
  const [collectTx, setCollectTx] = useState<string | null>(null);
  const [reputation, setReputation] = useState<Reputation | null>(null);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setAddress(addr);
      const c = await get_circle();
      setCircle(c);
    } finally {
      setConnecting(false);
    }
  }, []);

  const openContribute = useCallback(() => {
    setContribStatus("idle");
    setContribTx(null);
    setScreen("contribute");
  }, []);

  const backToCircle = useCallback(() => setScreen("circle"), []);

  const goStanding = useCallback(async () => {
    setScreen("standing");
    if (!reputation) {
      const r = await get_reputation(circle?.id);
      setReputation(r);
    }
  }, [reputation, circle]);

  const goProve = useCallback(() => setScreen("prove"), []);
  const backToStanding = useCallback(() => setScreen("standing"), []);

  const pay = useCallback(async () => {
    if (!circle) return;
    setContribStatus("working");
    const r = await pay_contribution(circle.id, circle.current_round);
    setContribTx(r.txHash);
    setContribStatus("done");
  }, [circle]);

  const collect = useCallback(async () => {
    if (!circle) return;
    setCollectStatus("working");
    const r = await collect_pot(circle.id);
    setCollectTx(r.txHash);
    setCollectStatus("done");
  }, [circle]);

  let body;
  if (!address) {
    body = (
      <Island className={`${styles.card} ${styles.cardCenter}`}>
        <div className={styles.seal}>
          <CowrieSeal />
        </div>
        <h2 className={`${styles.h2} ${styles.connectH2}`}>Join the circle</h2>
        <p className={styles.connectLede}>
          Connect your Stellar wallet to see the circle and claim your spot.
        </p>
        <div className={styles.stack}>
          <Button onClick={handleConnect} disabled={connecting}>
            {connecting ? "Connecting" : "Connect wallet"}
          </Button>
        </div>
        <p className={`${styles.mono} ${styles.connectNote}`}>
          Stellar testnet · Stellar Wallets Kit
        </p>
      </Island>
    );
  } else if (!circle) {
    body = (
      <Island className={styles.card}>
        <h2 className={styles.h2}>Loading your circle</h2>
        <p className={styles.meta}>Reading the circle from Stellar</p>
      </Island>
    );
  } else if (screen === "contribute") {
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
              {circle.amount} USDC
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
          <div className={styles.stack}>
            <Button onClick={pay} disabled={contribStatus === "working"}>
              {contribStatus === "working"
                ? "Contributing"
                : `Contribute ${circle.amount} USDC`}
            </Button>
          </div>
        ) : (
          <div className={styles.done}>
            <span className={`${styles.vdot} ${styles.vdotLg}`}>
              <CheckIcon size={20} />
            </span>
            <p className={styles.doneMsg}>Recorded. On time, as always.</p>
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
    body = <ProveView onBackToStanding={backToStanding} />;
  } else {
    const collectorSlot = collectorSlotOf(circle);
    const yourTurn = circle.members.some(
      (m) => m.slot === collectorSlot && m.isYou,
    );
    body = (
      <Island className={styles.card}>
        <h2 className={styles.h2}>Weekly circle</h2>
        <p className={styles.meta}>
          {circle.size} members · {circle.amount} USDC each round
        </p>

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
            <span className={styles.v}>{circle.amount} USDC</span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>Pot</span>
            <span className={styles.v}>{circle.pot} USDC</span>
          </div>
          <div className={styles.row}>
            <span className={styles.k}>Your streak</span>
            <span className={styles.v}>
              {circle.yourStreak} cycles, always on time
            </span>
          </div>
        </div>

        <div className={styles.promise}>
          <LockIcon />
          <p className={styles.promiseText}>{PRIVACY_LINE}</p>
        </div>

        <div className={styles.stack}>
          <Button onClick={openContribute}>
            Contribute {circle.amount} USDC
          </Button>
          {yourTurn && collectStatus === "done" ? (
            <div className={styles.collectConfirm}>
              <span className={`${styles.vdot} ${styles.vdotSm}`}>
                <CheckIcon size={13} />
              </span>
              Pot collected privately
            </div>
          ) : yourTurn ? (
            <Button
              variant="ghost"
              onClick={collect}
              disabled={collectStatus === "working"}
            >
              {collectStatus === "working" ? "Collecting" : "Collect the pot"}
            </Button>
          ) : null}
        </div>
        {yourTurn && collectStatus === "done" && collectTx ? (
          <p
            className={`${styles.mono} ${styles.doneTx}`}
            style={{ textAlign: "center", marginTop: "8px" }}
          >
            tx {short(collectTx)}
          </p>
        ) : null}
      </Island>
    );
  }

  const section: "circle" | "standing" =
    screen === "standing" || screen === "prove" ? "standing" : "circle";

  return (
    <>
      <AppNav
        address={address}
        section={section}
        onCircle={backToCircle}
        onStanding={goStanding}
      />
      {body}
      <p className={`${styles.mono} ${styles.protoNote}`}>
        Mocked contract seam · live contracts wire in behind it
      </p>
    </>
  );
}
