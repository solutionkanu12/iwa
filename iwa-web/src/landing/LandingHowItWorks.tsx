import { useReveal } from "./useReveal.ts";
import styles from "./LandingHowItWorks.module.css";

// Section 4 of 8: how it works. Two-up, matched to the prototype: the coin-hands
// image on the left (sticky), the 01/02/03 steps on the right. Step copy is
// exact from design/iwa-prototype.html. Nav, hero, community, app, and seams are
// untouched.

const STEPS = [
  {
    n: "01",
    h: "Save with your circle",
    p: "Join a circle and contribute your fixed amount each round, the same way ajo has always worked.",
  },
  {
    n: "02",
    h: "Build your standing",
    p: "Every on-time contribution quietly builds your Private Proof of Reliability. Only you can see your record.",
  },
  {
    n: "03",
    h: "Prove it, reveal nothing",
    p: "Generate a proof of your good standing. A lender checks it on Stellar and sees only that you are reliable.",
  },
];

export function LandingHowItWorks() {
  // Staggered reveal that replays on every re-entry, ~130ms apart by index.
  const sectionRef = useReveal<HTMLElement>({
    visibleClass: styles.in,
    stagger: 0.13,
  });

  return (
    <section className={styles.how} id="how" ref={sectionRef}>
      <h2 className={styles.label}>how it works</h2>
      <div className={styles.grid}>
        <div className={styles.aside}>
          <img
            className={styles.asideImg}
            src="/assets/iwa-coin-hands.png"
            alt="Two hands passing a coin"
          />
        </div>
        <div className={styles.steps}>
          {STEPS.map((s) => (
            <div
              key={s.n}
              className={`${styles.step} ${styles.reveal}`}
              data-reveal
            >
              <div className={styles.num}>{s.n}</div>
              <div>
                <h3 className={styles.stepH}>{s.h}</h3>
                <p className={styles.stepP}>{s.p}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
