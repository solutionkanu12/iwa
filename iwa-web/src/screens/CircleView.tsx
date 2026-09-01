import { useCallback, useEffect, useRef, useState } from "react";
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
  connectWallet,
  deriveMemberCommitment,
  disconnectWallet,
  WalletCancelledError,
} from "../lib/starknetWallet.ts";
import type { MemberCommitment } from "../lib/starknetWallet.ts";
import {
  tokenSymbol,
  tokenDecimals,
} from "../lib/starknetConfig.ts";
import { formatAmount } from "../lib/amount.ts";
import { circleHref } from "../lib/appRoute.ts";
import { generateProof } from "../lib/zk.ts";
import type { SnarkProof } from "../lib/convert.ts";
import type { Circle, Reputation } from "../lib/types.ts";
import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import { ProveView, CLAIMS } from "./ProveView.tsx";
import { BrowseCirclesView } from "./BrowseCirclesView.tsx";
import { canJoin } from "../chains/strk20/circleState.ts";
import styles from "./CircleView.module.css";

// Flow 1 (the circle view) and Flow 2 (contribute and collect), matched to
// design/iwa-prototype.html. Connect gate first (real Stellar Wallets Kit
// connect plus member commitment), then the circle screen from mocked
// get_circle. Contribute opens a confirm step that calls pay_contribution;
// collect calls collect_pot. Connect and the commitment are live; the rest of
// the chain access still runs on the mocked lib seam this stage.

/** Where a circle is started: the invite flow, which reserves each place. */
const START_A_CIRCLE = "/start";

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
  onBrowse,
  onStanding,
  onCreate,
  onDisconnect,
}: {
  address: string | null;
  section: "circle" | "browse" | "standing" | "create";
  onCircle: () => void;
  onBrowse: () => void;
  onStanding: () => void;
  onCreate: () => void;
  onDisconnect: () => void;
}) {
  const enabled = !!address;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the wallet menu when clicking anywhere outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  return (
    <>
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
            className={`${styles.tab} ${section === "browse" ? styles.tabActive : ""}`}
            role="tab"
            aria-selected={section === "browse"}
            onClick={onBrowse}
            disabled={!enabled}
          >
            Browse
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
          <button
            type="button"
            className={`${styles.tab} ${section === "create" ? styles.tabActive : ""}`}
            role="tab"
            aria-selected={section === "create"}
            onClick={onCreate}
            disabled={!enabled}
          >
            New circle
          </button>
        </div>
        <div className={styles.walletSlot}>
          {address ? (
            <div className={styles.walletMenu} ref={menuRef}>
              <button
                type="button"
                className={styles.wallet}
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className={styles.walletDot} />
                <span className={styles.walletAddr}>{short(address)}</span>
              </button>
              {menuOpen ? (
                <div className={styles.dropdown} role="menu">
                  <button
                    type="button"
                    className={styles.dropdownItem}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onDisconnect();
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Island>

      {/* Mobile-only bottom tab bar (native-app style). Hidden on desktop via
          CSS; a separate block from the top bar's tabs above, which are
          untouched and still render (hidden on mobile by CSS instead). */}
      <nav
        className={styles.bottomNav}
        role="tablist"
        aria-label="App sections"
      >
        <button
          type="button"
          className={`${styles.bottomTab} ${section === "circle" ? styles.bottomTabActive : ""}`}
          role="tab"
          aria-selected={section === "circle"}
          onClick={onCircle}
          disabled={!enabled}
        >
          Circle
        </button>
        <button
          type="button"
          className={`${styles.bottomTab} ${section === "browse" ? styles.bottomTabActive : ""}`}
          role="tab"
          aria-selected={section === "browse"}
          onClick={onBrowse}
          disabled={!enabled}
        >
          Browse
        </button>
        <button
          type="button"
          className={`${styles.bottomTab} ${section === "standing" ? styles.bottomTabActive : ""}`}
          role="tab"
          aria-selected={section === "standing"}
          onClick={onStanding}
          disabled={!enabled}
        >
          My standing
        </button>
        <button
          type="button"
          className={`${styles.bottomTab} ${section === "create" ? styles.bottomTabActive : ""}`}
          role="tab"
          aria-selected={section === "create"}
          onClick={onCreate}
          disabled={!enabled}
        >
          New circle
        </button>
      </nav>
    </>
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
  initialAddress = null,
  circleId = null,
}: {
  // Set when the wallet was already connected before this screen mounted
  // (the visitor connected from the landing page). Skips the connect gate
  // and picks up exactly where handleConnect would have left off.
  initialAddress?: string | null;
  // The circle named in the URL. Null means none was named, and the app opens
  // Browse to ask rather than choosing a circle on the visitor's behalf.
  circleId?: number | null;
} = {}) {
  const [address, setAddress] = useState<string | null>(null);
  const [commitment, setCommitment] = useState<MemberCommitment | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [circle, setCircle] = useState<Circle | null>(null);

  // With no circle named in the URL there is nothing to open, so the app asks
  // which circle rather than picking one.
  const [screen, setScreen] = useState<Screen>(circleId === null ? "browse" : "circle");
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

  // Everything that happens once we have an address, whether it came from a
  // connect click here or was already connected before this screen mounted.
  const finishConnect = useCallback(
    async (addr: string) => {
      // Derive the member commitment first so the circle read can flag your
      // slot and your streak. If the wallet cannot sign, the reads still run
      // without it and the app stays usable.
      let mc: MemberCommitment | null = null;
      try {
        mc = await deriveMemberCommitment(addr);
        setCommitment(mc);
      } catch (err) {
        console.warn("member commitment unavailable", err);
      }

      // Real read: the circle state, composed from the deployed savings
      // contract. Only the circle the URL named: with none named there is
      // nothing to read, and Browse asks instead of a circle being guessed.
      if (circleId === null) {
        setConnecting(false);
        return;
      }
      try {
        const c = await get_circle(circleId, mc?.commitmentBytes);
        setCircle(c);
        await loadPaidStatus(c, mc?.commitmentBytes);
      } catch (err) {
        console.warn("circle read failed", err);
      } finally {
        setConnecting(false);
      }
    },
    [loadPaidStatus, circleId],
  );

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    let addr: string;
    try {
      addr = await connectWallet();
    } catch (err) {
      // A cancelled modal is expected: stay on the connect gate, no crash.
      if (!(err instanceof WalletCancelledError)) {
        console.warn("wallet connect failed", err);
      }
      setConnecting(false);
      return;
    }
    setAddress(addr);
    await finishConnect(addr);
  }, [finishConnect]);

  // Picked up an already-connected wallet from the landing page: same
  // connectWallet() seam, already run there, so there is no second connect
  // prompt here. Runs once.
  const pickedUpInitialAddress = useRef(false);
  useEffect(() => {
    if (!initialAddress || pickedUpInitialAddress.current) return;
    pickedUpInitialAddress.current = true;
    setConnecting(true);
    setAddress(initialAddress);
    void finishConnect(initialAddress);
  }, [initialAddress, finishConnect]);

  const handleDisconnect = useCallback(async () => {
    await disconnectWallet();
    // Clear every piece of per-wallet state so a newly connected wallet is
    // evaluated fresh, with no stale membership, commitment, or paid status.
    setAddress(null);
    setCommitment(null);
    setCircle(null);
    setConnecting(false);
    setScreen("circle");
    setContribStatus("idle");
    setContribTx(null);
    setContribError(null);
    setContribOnTime(true);
    setAlreadyPaid(false);
    setCollectStatus("idle");
    setCollectTx(null);
    setCollectError(null);
    setCollectAmount(0);
    setJoinStatus("idle");
    setJoinTx(null);
    setJoinError(null);
    setReputation(null);
  }, []);

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
    if (reputation) return;
    // Real read: your reputation for this circle. Needs your commitment; without
    // it (wallet could not sign) show an all-zero standing rather than crash.
    if (!circle || !commitment) {
      setReputation({ completedCycles: 0, onTimeRate: 0, defaultCount: 0 });
      return;
    }
    const r = await get_reputation(circle.id, commitment.commitmentBytes);
    setReputation(r);
  }, [reputation, circle, commitment]);

  const goProve = useCallback(() => setScreen("prove"), []);
  const backToStanding = useCallback(() => setScreen("standing"), []);
  // Starting a circle is the invite flow at /start: places are reserved for
  // named people before the circle exists, so there is no separate create form
  // to duplicate here. A plain navigation until the app routes properly.
  const goCreate = useCallback(() => window.location.assign(START_A_CIRCLE), []);
  const goBrowse = useCallback(() => setScreen("browse"), []);

  // Load and switch to a circle by id (used after creating one). Resets the
  // transient per-circle state so nothing carries over from another circle.
  const goToCircle = useCallback(
    async (id: number) => {
      setScreen("circle");
      setJoinStatus("idle");
      setJoinTx(null);
      setJoinError(null);
      setContribStatus("idle");
      setContribTx(null);
      setContribError(null);
      setCollectStatus("idle");
      setCollectTx(null);
      setCollectError(null);
      setReputation(null);
      // The circle goes into the URL, so a reload comes back to this circle
      // and the link can be shared.
      window.history.pushState(null, "", circleHref(id));
      try {
        const c = await get_circle(id, commitment?.commitmentBytes);
        setCircle(c);
        await loadPaidStatus(c, commitment?.commitmentBytes);
      } catch (err) {
        console.warn("circle read failed", err);
      }
    },
    [commitment, loadPaidStatus],
  );

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
  if (!address) {
    body = (
      <Island className={`${styles.card} ${styles.cardCenter}`}>
        <div className={styles.seal}>
          <CowrieSeal />
        </div>
        <h2 className={`${styles.h2} ${styles.connectH2}`}>Join the circle</h2>
        <p className={styles.connectLede}>
          Connect your Starknet wallet to see the circle and claim your spot.
        </p>
        <div className={styles.stack}>
          <Button onClick={handleConnect} disabled={connecting}>
            {connecting ? "Connecting" : "Connect wallet"}
          </Button>
        </div>
        <p className={`${styles.mono} ${styles.connectNote}`}>
          Starknet mainnet · private contributions
        </p>
      </Island>
    );
  } else if (screen === "browse") {
    // Discovery does not depend on the demo circle, so it renders before the
    // circle-loading gate.
    body = <BrowseCirclesView onView={goToCircle} />;
  } else if (!circle && connecting) {
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
          <Button onClick={goBrowse}>Browse circles</Button>
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

  const section: "circle" | "browse" | "standing" | "create" =
    screen === "browse"
      ? "browse"
      : screen === "create"
        ? "create"
        : screen === "standing" || screen === "prove"
          ? "standing"
          : "circle";

  return (
    <>
      <AppNav
        address={address}
        section={section}
        onCircle={backToCircle}
        onBrowse={goBrowse}
        onStanding={goStanding}
        onCreate={goCreate}
        onDisconnect={handleDisconnect}
      />
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
