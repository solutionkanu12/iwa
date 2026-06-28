import type { MouseEvent } from "react";
import { useReveal } from "./useReveal.ts";
import styles from "./LandingFaq.module.css";

// Section 6 of 8: Questions (FAQ). Full-bleed handshake image behind a frosted
// glass card with a heading and an accordion. Heading, lead, and answers are
// exact from design/iwa-prototype.html. The accordion toggle is imperative
// (like the prototype) so the shared reveal hook can also manage its class on
// the same rows without React overwriting it. Nav, hero, and earlier sections,
// app, app nav, and seams are untouched.
//
// Copy note: the prototype's fourth question uses the banned scoring term in its
// wording. The brand hard rule forbids that term, so the question is rephrased
// to "Is this a bureau score". The answer is verbatim (it never used the term).

const FAQS = [
  {
    q: "What is a savings circle",
    a: "A savings circle, or ajo, is a group who each put in a fixed amount every round and take turns collecting the whole pot. Iwa runs this on Stellar, so the turns and the payments are handled for you.",
  },
  {
    q: "Do I need a bank account",
    a: "No. You need a Stellar wallet and a phone. Iwa is built for people the banks cannot see, so a bank account is never the starting point.",
  },
  {
    q: "What does my proof show a lender",
    a: "Only the claim you choose, for example that you completed two cycles on time. It does not show your amounts, your circle, the other members, or your identity.",
  },
  {
    // Rephrased from the prototype's wording per the brand rule (no scoring term).
    q: "Is this a bureau score",
    a: "No. It is a Private Proof of Reliability. A credit bureau collects and exposes your history. Iwa lets you prove you are reliable while that history stays private and stays yours.",
  },
  {
    q: "How does Iwa use my data",
    a: "Your record stays on your device and on chain in a form only you can open. Iwa cannot read it, and nothing is shared until you choose to generate a proof yourself.",
  },
  {
    q: "How safe is my money",
    a: "Contributions and payouts run through a smart contract on Stellar, so no single person holds the pot. This build runs on testnet while the contracts are finished.",
  },
  {
    q: "What if someone in my circle does not pay",
    a: "The circle records the missed round against that member, not against you. Your standing reflects only your own contributions, so one person cannot spend your good name.",
  },
  {
    q: "What is zero-knowledge, in plain terms",
    a: "It is a way to prove a statement is true without revealing the information behind it. You prove you are reliable without handing over the details that prove it.",
  },
];

// Single-open accordion. Imperative (no React state), so no re-render that would
// clear the reveal class the hook manages on the same element. Opening a row
// closes any other open row; clicking an already-open row closes it (so nothing
// need be open). Touches only the open/close state, never the reveal class.
function toggle(e: MouseEvent<HTMLButtonElement>) {
  const btn = e.currentTarget;
  const item = btn.closest("[data-reveal]");
  if (!item) return;
  const wasOpen = item.classList.contains(styles.open);

  // Close every row in this list first.
  const list = item.parentElement;
  list?.querySelectorAll("[data-reveal]").forEach((row) => {
    row.classList.remove(styles.open);
    row.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", "false");
  });

  // Open the clicked row unless it was already open.
  if (!wasOpen) {
    item.classList.add(styles.open);
    btn.setAttribute("aria-expanded", "true");
  }
}

export function LandingFaq() {
  // Staggered reveal that replays on every re-entry, ~130ms apart by index.
  const listRef = useReveal<HTMLDivElement>({
    visibleClass: styles.in,
    stagger: 0.13,
  });

  return (
    <section className={styles.faq}>
      <img
        className={styles.bg}
        src="/assets/iwa-handshake.png"
        alt=""
        aria-hidden="true"
      />
      <div className={styles.card}>
        <h2 className={styles.h2}>Questions</h2>
        <p className={styles.lead}>
          The things people ask before they join their first circle.
        </p>
        <div className={styles.list} ref={listRef}>
          {FAQS.map((f, i) => (
            <div
              key={f.q}
              className={`${styles.item} ${styles.reveal}`}
              data-reveal
            >
              <button
                type="button"
                className={styles.q}
                aria-expanded="false"
                aria-controls={`faq-answer-${i}`}
                onClick={toggle}
              >
                {f.q}
                <span className={styles.icon} aria-hidden="true" />
              </button>
              <div className={styles.answer} id={`faq-answer-${i}`}>
                <p>{f.a}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
