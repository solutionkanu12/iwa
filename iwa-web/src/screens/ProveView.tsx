import { useCallback, useEffect, useState } from "react";
import { generateProof } from "../lib/zk.ts";
import { verify_proof } from "../lib/iwaContract.ts";
import type { Claim } from "../lib/types.ts";
import { Island } from "../components/Island.tsx";
import { Button } from "../components/Button.tsx";
import styles from "./ProveView.module.css";

// Flow 3: Generate proof, then the Verified moment, then the lender view.
// generateProof runs on this device (mocked), then verify_proof checks on
// Stellar (mocked). The seam signatures are unchanged. This is the hero screen,
// so the verified motion follows the prototype exactly.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function short(s: string): string {
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

// The two claims a saver can prove (prototype wording). Demo threshold N = 2.
const CLAIMS: Claim[] = [
  { statement: "Completed 2 full cycles, always on time", threshold: 2 },
  { statement: "Never defaulted across 2 cycles", threshold: 2 },
];

type ProofData = { claim: Claim; proofId: string; txHash: string };

function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      aria-hidden="true"
    >
      <path d="M5 12l4 4 10-10" />
    </svg>
  );
}

// The cowrie seal. One mark, triple duty. Fills shift to mint in the verified
// state via CSS; the ring and halo draw and pulse there too.
function Cowrie() {
  return (
    <svg
      viewBox="-24 -20 248 264"
      className={styles.cowrieSvg}
      width="100%"
      role="img"
      aria-label="Verified cowrie seal"
    >
      <circle
        className={styles.cwHalo}
        cx="100"
        cy="110"
        r="96"
        fill="none"
        stroke="#4FD9C0"
        strokeWidth="3"
      />
      <g style={{ transformOrigin: "100px 110px" }}>
        <ellipse
          className={styles.cwShade}
          cx="108"
          cy="132"
          rx="58"
          ry="74"
          fill="#AFA9EC"
          opacity=".55"
        />
        <ellipse
          className={styles.cwBody}
          cx="100"
          cy="110"
          rx="62"
          ry="80"
          fill="#B6A6F2"
        />
        <ellipse
          className={styles.cwHi}
          cx="86"
          cy="90"
          rx="38"
          ry="52"
          fill="#CECBF6"
          opacity=".75"
        />
        <path
          d="M100 40C110 80 110 140 100 180C90 140 90 80 100 40Z"
          fill="#F6F4FC"
        />
        <g
          stroke="#8d80c4"
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity=".7"
        >
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
      </g>
      <circle
        className={styles.cwRing}
        cx="100"
        cy="110"
        r="96"
        fill="none"
        stroke="#4FD9C0"
        strokeWidth="4"
        strokeLinecap="round"
        style={{ transform: "rotate(-90deg)", transformOrigin: "100px 110px" }}
      />
    </svg>
  );
}

function ClaimStep({
  onBack,
  onVerified,
}: {
  onBack: () => void;
  onVerified: (data: ProofData) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [proving, setProving] = useState(false);
  const [bar, setBar] = useState(0);
  const [label, setLabel] = useState("Building proof on this device");

  const run = useCallback(async () => {
    setProving(true);
    // Verbatim progress copy, in sequence.
    setBar(38);
    setLabel("Building proof on this device");
    const p = await generateProof(CLAIMS[selected]);

    setBar(72);
    setLabel("Checking on Stellar");
    const v = await verify_proof(p.proof, p.publicSignals);

    setBar(100);
    setLabel("Verified");
    await sleep(350);

    onVerified({ claim: p.claim, proofId: p.proof, txHash: v.txHash });
  }, [selected, onVerified]);

  return (
    <Island className={styles.card}>
      <button
        type="button"
        className={styles.backBtn}
        onClick={onBack}
        disabled={proving}
      >
        ‹ back to standing
      </button>
      <h2 className={styles.h2}>Generate proof</h2>
      <p className={styles.meta}>
        Choose what to prove. The proof is built on this device. Your amounts,
        your circle, and your identity never leave it.
      </p>

      <div className={styles.claimList}>
        {CLAIMS.map((c, i) => (
          <button
            key={c.statement}
            type="button"
            className={styles.claim}
            aria-pressed={selected === i}
            onClick={() => setSelected(i)}
            disabled={proving}
          >
            <span className={styles.ck} />
            {c.statement}
          </button>
        ))}
      </div>

      {!proving ? (
        <div className={styles.stack}>
          <Button onClick={run}>Generate proof</Button>
        </div>
      ) : (
        <div className={styles.progressWrap}>
          <div className={styles.progress}>
            <div className={styles.bar} style={{ width: `${bar}%` }} />
          </div>
          <p className={styles.progLabel}>{label}</p>
        </div>
      )}
    </Island>
  );
}

function VerifiedCard({
  data,
  onLender,
}: {
  data: ProofData;
  onLender: () => void;
}) {
  // Start verified immediately under reduced motion (content and the mint fill
  // show at once); otherwise flip on the next frame so the motion plays.
  const [verified, setVerified] = useState(prefersReducedMotion());
  useEffect(() => {
    if (prefersReducedMotion()) {
      setVerified(true);
      return;
    }
    const id = requestAnimationFrame(() => setVerified(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const [copyLabel, setCopyLabel] = useState("Copy proof link");
  const copy = useCallback(() => {
    const link = `https://iwa.app/proof/${short(data.proofId)}`;
    if (navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
    setCopyLabel("Proof link copied");
    setTimeout(() => setCopyLabel("Copy proof link"), 1800);
  }, [data]);

  return (
    <Island
      className={`${styles.card} ${styles.center} ${verified ? styles.verify : ""}`}
    >
      <div className={styles.proofSeal}>
        <Cowrie />
      </div>
      <p className={styles.verifiedLine}>
        <span className={styles.vdot}>
          <CheckIcon size={13} />
        </span>
        Verified on Stellar. Your money and identity stayed private.
      </p>

      <div className={styles.proofCard}>
        <span className={styles.badge}>
          <span className={styles.badgeDot} />
          Verified
        </span>
        <p className={styles.claimtext}>{data.claim.statement}</p>
        <div className={styles.kv}>
          <span className={styles.k}>Credential</span>
          <span className={styles.v}>Portable Trust Credential</span>
        </div>
        <div className={styles.kv}>
          <span className={styles.k}>Proof id</span>
          <span className={styles.v}>{short(data.proofId)}</span>
        </div>
        <div className={styles.kv}>
          <span className={styles.k}>Stellar tx</span>
          <span className={styles.v}>
            <a href="/" onClick={(e) => e.preventDefault()}>
              {short(data.txHash)}
            </a>
          </span>
        </div>
      </div>

      <div className={styles.stack}>
        <Button variant="dark" onClick={copy}>
          {copyLabel}
        </Button>
        <Button variant="ghost" onClick={onLender}>
          Open as a lender sees it
        </Button>
      </div>
    </Island>
  );
}

function LenderCard({
  data,
  onBack,
}: {
  data: ProofData;
  onBack: () => void;
}) {
  return (
    <Island className={styles.card}>
      <p className={styles.lenderNote}>a lender opened your proof link</p>
      <div className={styles.proofCard}>
        <div className={styles.lenderHead}>
          <svg width="20" height="22" viewBox="0 0 60 70" aria-hidden="true">
            <ellipse cx="30" cy="36" rx="20" ry="26" fill="#4FD9C0" />
            <ellipse cx="25" cy="29" rx="11" ry="15" fill="#bdf0e6" opacity=".8" />
            <path d="M30 12C34 30 34 42 30 60C26 42 26 30 30 12Z" fill="#F6F4FC" />
          </svg>
          <strong className={styles.lenderBrand}>
            Iwa · Private Proof of Reliability
          </strong>
        </div>
        <span className={styles.badge}>
          <span className={styles.badgeDot} />
          Verified on Stellar
        </span>
        <p className={`${styles.claimtext} ${styles.lenderClaim}`}>
          {data.claim.statement}
        </p>
        <div className={styles.kv}>
          <span className={styles.k}>Stellar tx</span>
          <span className={styles.v}>
            <a href="/" onClick={(e) => e.preventDefault()}>
              {short(data.txHash)}
            </a>
          </span>
        </div>
      </div>
      <p className={styles.lenderMuted}>
        This is everything the lender can see. No amounts, no circle, no
        identity.
      </p>
      <div className={styles.stack}>
        <Button variant="ghost" onClick={onBack}>
          Back to your proof
        </Button>
      </div>
    </Island>
  );
}

export function ProveView({
  onBackToStanding,
}: {
  onBackToStanding: () => void;
}) {
  const [step, setStep] = useState<"claim" | "verified" | "lender">("claim");
  const [data, setData] = useState<ProofData | null>(null);

  if (step === "verified" && data) {
    return <VerifiedCard data={data} onLender={() => setStep("lender")} />;
  }
  if (step === "lender" && data) {
    return <LenderCard data={data} onBack={() => setStep("verified")} />;
  }
  return (
    <ClaimStep
      onBack={onBackToStanding}
      onVerified={(d) => {
        setData(d);
        setStep("verified");
      }}
    />
  );
}
