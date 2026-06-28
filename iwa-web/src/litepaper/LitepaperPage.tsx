import styles from "./LitepaperPage.module.css";

// Standalone Iwa litepaper page. Iwa brand: Bricolage display, Inter body, Space
// Mono for eyebrow/meta/data. Lavender and iris palette, off-white surfaces, no
// gradient text, no mint, sentence case. Separate from the app and the landing
// page; touches nothing else.

const SAVINGS_CONTRACT = "CCP7O24JQ6FUJP5BC6P22M35YXK2B3Q7IRL4VHQBBCB5VNC55L32GYNQ";
const VERIFIER_CONTRACT = "CBEUUHRLMSBAOX2NTNZFKKP2FBN3XMNTY6JCIOGBKYHMC5AEQTI3ZKDS";

const META = [
  { label: "Author", value: "Solution" },
  { label: "Version", value: "1.0" },
  { label: "Date", value: "June 28, 2026" },
  { label: "Network", value: "Stellar" },
];

const REFERENCES = [
  {
    n: 1,
    name: "Stellar",
    desc: "the network Iwa is built on.",
    url: "https://stellar.org",
  },
  {
    n: 2,
    name: "Iwa source code",
    desc: "the savings circle contract, reputation circuit, prover, and verifier.",
    url: "https://github.com/solutionkanu12/iwa",
  },
  {
    n: 3,
    name: "Iwa on X",
    desc: "updates and announcements.",
    url: "https://x.com/joinIwa",
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

export function LitepaperPage() {
  return (
    <main className={styles.page}>
      <article className={styles.doc}>
        <div className={styles.masthead}>
          <CowrieGlyph />
          <span className={styles.wordmark}>Iwa</span>
        </div>

        <header className={styles.hero}>
          <p className={styles.eyebrow}>litepaper · v1.0</p>
          <h1 className={styles.title}>Your good name, proven and private</h1>
          <p className={styles.subhead}>
            Iwa is a digital savings circle on Stellar that turns your everyday
            contributions into a private proof of reliability you can carry
            anywhere. Save with your circle, then prove your good standing
            without revealing your money, your circle, or your identity.
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
          <h2 className={styles.h2}>Abstract</h2>
          <p className={styles.p}>
            Iwa is a digital ajo, a rotating savings circle, built on Stellar.
            Members save together in rounds, and every on-time contribution
            quietly builds a private record of their reliability. With a
            zero-knowledge proof, a member can show a lender, or anyone, that
            they are reliable, without revealing their amounts, their circle, or
            their identity. The result is a Portable Trust Credential, your good
            name made portable and private.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>The problem</h2>
          <p className={styles.p}>
            Savings circles, known as ajo or esusu, have always built real
            trust. Members who show up round after round earn a reputation their
            community knows by heart. But that trust is trapped. It lives inside
            the group and cannot travel.
          </p>
          <p className={styles.p}>
            To prove you are reliable to a bank or a lender, you are asked to
            expose your whole financial history, and even then the people who
            save in circles are often the ones the formal system cannot see.
            There has been no way to prove you are reliable without revealing
            everything.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>How Iwa works</h2>
          <p className={styles.p}>
            A member joins a savings circle and contributes a fixed amount each
            round, the same way ajo has always worked, now handled by a smart
            contract on Stellar. Every on-time contribution builds the member's
            private reputation, a record only they can open.
          </p>
          <p className={styles.p}>
            When they want to prove their reliability, they choose a claim, for
            example that they completed at least two cycles with zero defaults,
            and generate a zero-knowledge proof of it. A lender, or anyone, can
            verify that proof on Stellar. The claim is confirmed as true, and
            nothing else is shown.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>The technology</h2>
          <p className={styles.p}>
            Iwa is built on Stellar. A Rust and Soroban smart contract runs the
            savings circle and derives each member's reputation from their
            contribution history, so the numbers can never drift from the record.
          </p>
          <p className={styles.p}>
            The reputation claim is encoded by an original Circom circuit over
            the BN254 curve, with 3,088 constraints. Proofs are Groth16, and they
            are checked on-chain by a Soroban verifier contract. Every on-chain
            verification check passes. A valid proof from a member in good
            standing is accepted, and a tampered proof is rejected.
          </p>
          <div className={styles.addrCard}>
            <div className={styles.addrItem}>
              <span className={styles.addrLabel}>Savings contract · testnet</span>
              <code className={styles.addr}>{SAVINGS_CONTRACT}</code>
            </div>
            <div className={styles.addrItem}>
              <span className={styles.addrLabel}>
                Verifier contract · testnet
              </span>
              <code className={styles.addr}>{VERIFIER_CONTRACT}</code>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Privacy model</h2>
          <p className={styles.p}>
            The prover runs in the browser, compiled to WebAssembly, so the
            member's secret never leaves their device. Only the proof and its
            public signals are sent on-chain.
          </p>
          <p className={styles.p}>
            A verifier learns exactly one thing, that the claim is true, and
            nothing more. No amounts, no circle, no other members, no identity.
            This is what makes the credential portable and private at the same
            time, and it is why we call it a Portable Trust Credential.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>What is next</h2>
          <p className={styles.p}>
            This build was made for Stellar Hacks, Real-World ZK, and runs on
            testnet. From here the work is steady and specific. More claim types
            beyond cycles and defaults, richer circle features for larger and
            longer running groups, and a path to mainnet once the contracts have
            been reviewed. The aim stays narrow. Prove reliability, reveal
            nothing.
          </p>
        </section>
      </article>

      <section className={styles.darkBand}>
        <div className={styles.darkInner}>
          <p className={styles.darkEyebrow}>in closing</p>
          <p className={styles.darkP}>
            A savings circle already knows who is reliable. Iwa lets that truth
            travel, on terms the saver controls. You decide what to prove, you
            prove it on Stellar, and your history stays yours.
          </p>
          <p className={styles.darkClose}>Your good name, proven and private.</p>
        </div>
      </section>

      <article className={styles.doc}>
        <section className={styles.section}>
          <h2 className={styles.h2}>References and notes</h2>
          <p className={styles.refLead}>
            The sources and references below support this litepaper.
          </p>
          <ol className={styles.refs}>
            {REFERENCES.map((r) => (
              <li key={r.url} className={styles.refItem}>
                <span className={styles.refNum}>[{r.n}]</span>
                <div className={styles.refBody}>
                  <p className={styles.refText}>
                    <span className={styles.refName}>{r.name}</span>
                    <span className={styles.refSep}> · </span>
                    <span className={styles.refDesc}>{r.desc}</span>
                  </p>
                  <a
                    className={styles.refLink}
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {r.url}
                  </a>
                </div>
              </li>
            ))}
          </ol>
          <p className={styles.note}>
            This litepaper describes Iwa as built for Stellar Hacks, Real-World
            ZK. The contracts run on Stellar testnet, and details may evolve as
            the project grows. This document is informational and is not
            financial, investment, or legal advice.
          </p>
        </section>

        <p className={styles.docFooter}>
          Iwa litepaper v1.0 · June 28, 2026 · Solution
        </p>
      </article>
    </main>
  );
}
