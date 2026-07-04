import { useReveal } from "./useReveal.ts";
import styles from "./LandingShowcase.module.css";

// Section 5 of 8: see it in action. The circle-hands mark above the heading,
// then three phone frames with real app screenshots. Heading and lead copy
// are exact from design/iwa-prototype.html; frame labels are from the PRD. No
// mint here: the "Verified" caption follows the prototype's muted label
// treatment. Nav, hero, community, how it works, app, and seams untouched.

const FRAMES = [
  {
    label: "Your circle",
    src: "/assets/iwa-showcase-circle.jpg",
    alt: "The circle screen, showing joining and contributing to a savings circle",
  },
  {
    label: "Generate proof",
    src: "/assets/iwa-showcase-proof.jpg",
    alt: "The My standing screen, generating a proof of good standing",
  },
  {
    label: "Verified",
    src: "/assets/iwa-showcase-verified.jpg",
    alt: "The verified proof screen",
  },
];

export function LandingShowcase() {
  // Staggered reveal that replays on every re-entry, ~130ms apart by index.
  const framesRef = useReveal<HTMLDivElement>({
    visibleClass: styles.in,
    stagger: 0.13,
  });

  return (
    <section className={styles.showcase}>
      <img
        className={styles.mark}
        src="/assets/iwa-circle-hands.png"
        alt="A circle of people holding hands"
      />
      <h2 className={styles.h2}>See it in action</h2>
      <p className={styles.lead}>
        A calm savings circle in your pocket. Save with your circle, build your
        standing, and prove your good name when you need it.
      </p>
      <div className={styles.frames} ref={framesRef}>
        {FRAMES.map((f) => (
          <figure
            key={f.label}
            className={`${styles.phoneFig} ${styles.reveal}`}
            data-reveal
          >
            <div className={styles.phone}>
              <div className={styles.screen}>
                {f.src ? (
                  <img className={styles.screenImg} src={f.src} alt={f.alt} />
                ) : (
                  <span className={styles.phNote}>
                    {f.label}
                    <br />
                    screenshot goes here
                  </span>
                )}
              </div>
            </div>
            <figcaption className={styles.caption}>{f.label}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
