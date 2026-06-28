import { useReveal } from "./useReveal.ts";
import styles from "./LandingCommunity.module.css";

// Section 3 of 8: the community card. A frosted glass card centered over the
// continuing cowrie-basket imagery, holding the ring illustration
// (iwa-circle.png), the heading "Rooted in a real circle" (from the PRD), and
// the community body copy (exact from the prototype). The hero, nav, app, and
// seams are untouched.

export function LandingCommunity() {
  // Reveal that replays on every re-entry. Same motion as before, only replay.
  const sectionRef = useReveal<HTMLElement>({ visibleClass: styles.in });

  return (
    <section className={styles.community} aria-label="Community" ref={sectionRef}>
      <div className={`${styles.communityCard} ${styles.reveal}`} data-reveal>
        <img
          className={styles.communityIll}
          src="/assets/iwa-circle.png"
          alt="A ring of people in a savings circle"
        />
        <h2 className={styles.h2}>Rooted in a real circle</h2>
        <p className={styles.body}>
          Iwa is the savings circle your community already trusts, made portable
          and private. Your circle has always known you are reliable. Now you can
          prove it to anyone, and show nothing else.
        </p>
      </div>
    </section>
  );
}
