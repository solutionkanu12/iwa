import styles from "./RoadmapPage.module.css";

// Standalone Iwa roadmap page. Same brand and layout language as the litepaper.
// Honest, not overpromising. Separate from the app and other pages; touches
// nothing else.

const META = [
  { label: "Author", value: "Solution" },
  { label: "Version", value: "1.0" },
  { label: "Date", value: "June 28, 2026" },
  { label: "Network", value: "Stellar" },
];

const NOW = [
  {
    lead: "The savings circle and reputation contract",
    rest: "a Rust and Soroban contract that runs the rounds and derives each member's reputation from their own contribution history.",
  },
  {
    lead: "The reputation circuit",
    rest: "an original Circom circuit over the BN254 curve that encodes the claim a member can prove.",
  },
  {
    lead: "The browser prover",
    rest: "compiled to WebAssembly, so the member's secret never leaves their device.",
  },
  {
    lead: "The on-chain verifier",
    rest: "a Soroban contract that checks the Groth16 proof. A valid proof from a member in good standing is accepted, and a tampered proof is rejected.",
  },
];

const NEXT = [
  {
    lead: "More claim types",
    rest: "so a member can prove things beyond completed cycles and zero defaults, matching what different lenders and services actually ask for.",
  },
  {
    lead: "Richer circle features",
    rest: "built for larger groups and longer running circles, so reputation can grow over real time.",
  },
];

const LATER = [
  {
    lead: "A reviewed path to Stellar mainnet",
    rest: "moving off testnet once the contracts have been through proper review.",
  },
  {
    lead: "Credentials that travel further",
    rest: "usable across more lenders and more contexts, so one proof can open many doors.",
  },
];

function CowrieGlyph() {
  return (
    <svg width="22" height="24" viewBox="0 0 60 70" aria-hidden="true">
      <ellipse cx="30" cy="36" rx="20" ry="26" fill="#B6A6F2" />
      <ellipse cx="25" cy="29" rx="11" ry="15" fill="#CECBF6" opacity=".8" />
      <path d="M30 12C34 30 34 42 30 60C26 42 26 30 30 12Z" fill="#F6F4FC" />
    </svg>
  );
}

function PhaseList({ items }: { items: { lead: string; rest: string }[] }) {
  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.lead} className={styles.li}>
          <span className={styles.liLead}>{item.lead}</span>
          <span className={styles.liSep}> · </span>
          {item.rest}
        </li>
      ))}
    </ul>
  );
}

export function RoadmapPage() {
  return (
    <main className={styles.page}>
      <article className={styles.doc}>
        <div className={styles.masthead}>
          <CowrieGlyph />
          <span className={styles.wordmark}>Iwa</span>
        </div>

        <header className={styles.hero}>
          <p className={styles.eyebrow}>roadmap · v1.0</p>
          <h1 className={styles.title}>Where Iwa is going</h1>
          <p className={styles.subhead}>
            Iwa is built for Stellar Hacks, Real-World ZK, and runs on Stellar
            testnet today. This roadmap lays out what is already working and the
            steady, specific steps that come next.
          </p>
          <dl className={styles.meta}>
            {META.map((m) => (
              <div key={m.label} className={styles.metaField}>
                <dt className={styles.metaLabel}>{m.label}</dt>
                <dd className={styles.metaValue}>{m.value}</dd>
              </div>
            ))}
          </dl>
        </header>

        <section className={styles.section}>
          <h2 className={styles.h2}>Where things stand</h2>
          <p className={styles.p}>
            Iwa already proves the core idea end to end on Stellar testnet. A
            member can save in a circle, build a private record of reliability,
            and prove their good standing with a zero-knowledge proof that anyone
            can verify on-chain. The work from here is to widen what can be
            proven and where the credential can travel, without changing that
            foundation.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Now, shipped</h2>
          <p className={styles.p}>
            Everything below runs on Stellar testnet today, with on-chain checks
            passing.
          </p>
          <PhaseList items={NOW} />
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Next</h2>
          <p className={styles.p}>
            The near term widens what a member can prove and who they can prove
            it to.
          </p>
          <PhaseList items={NEXT} />
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Later</h2>
          <p className={styles.p}>
            Further out, the credential earns its name by working in more places,
            on terms the saver still controls.
          </p>
          <PhaseList items={LATER} />
        </section>
      </article>

      <section className={styles.darkBand}>
        <div className={styles.darkInner}>
          <p className={styles.darkEyebrow}>the throughline</p>
          <p className={styles.darkP}>
            Every step widens what a saver can prove and where it can travel,
            while the rule underneath stays fixed. Your record is yours, and you
            decide what to share.
          </p>
          <p className={styles.darkClose}>Prove reliability, reveal nothing.</p>
        </div>
      </section>

      <article className={styles.doc}>
        <section className={styles.section}>
          <h2 className={styles.h2}>A note on this roadmap</h2>
          <p className={styles.note}>
            This roadmap is indicative. Scope and timing may change as the
            project grows, and the contract addresses described elsewhere run on
            Stellar testnet for now.
          </p>
        </section>
        <p className={styles.docFooter}>
          Iwa roadmap v1.0 · June 28, 2026 · Solution
        </p>
      </article>
    </main>
  );
}
