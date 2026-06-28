import { useEffect, useRef, useState } from "react";
import styles from "./LandingCommunity.module.css";

// Section 3 of 8: the community card. A frosted glass card centered over the
// continuing cowrie-basket imagery, holding the ring illustration
// (iwa-circle.png), the heading "Rooted in a real circle" (from the PRD), and
// the community body copy (exact from the prototype). The hero, nav, app, and
// seams are untouched.

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function LandingCommunity() {
  const cardRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  // Reveal once when the card enters view; off (shown immediately) under
  // reduced motion or without IntersectionObserver.
  useEffect(() => {
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      setShown(true);
      return;
    }
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setShown(true);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -12% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section className={styles.community} aria-label="Community">
      <div
        ref={cardRef}
        className={`${styles.communityCard} ${styles.reveal} ${shown ? styles.in : ""}`}
      >
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
