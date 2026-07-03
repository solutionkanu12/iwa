import { scrollToId } from "./smoothScroll.ts";
import styles from "./LandingNav.module.css";

// Section 1 of 8: the fixed glass nav. Matched to the prototype's landing nav.
// "How it works" smooth-scrolls to that section; "Roadmap" goes to the roadmap
// page. "Enter the circle" opens the real wallet connect flow (onEnterCircle).
// "Log in" remains a placeholder. The app and its nav are untouched.

// The cowrie glyph, the same lavender mark used elsewhere (inline SVG).
function CowrieGlyph() {
  return (
    <svg width="22" height="24" viewBox="0 0 60 70" aria-hidden="true">
      <ellipse cx="30" cy="36" rx="20" ry="26" fill="#B6A6F2" />
      <ellipse cx="25" cy="29" rx="11" ry="15" fill="#CECBF6" opacity=".8" />
      <path d="M30 12C34 30 34 42 30 60C26 42 26 30 30 12Z" fill="#F6F4FC" />
    </svg>
  );
}

export function LandingNav({
  onEnterCircle,
}: {
  onEnterCircle: () => void;
}) {
  return (
    <nav className={styles.nav} aria-label="Main">
      <div className={styles.links}>
        <span className={styles.glyph} aria-hidden="true">
          <CowrieGlyph />
        </span>
        <button
          type="button"
          className={styles.link}
          onClick={() => scrollToId("how")}
        >
          How it works
        </button>
        <a className={styles.link} href="/roadmap.html">
          Roadmap
        </a>
      </div>

      <div className={styles.brand}>iwa</div>

      <div className={styles.right}>
        <span className={styles.login}>Log in</span>
        <a
          className={styles.cta}
          href="/app"
          onClick={(e) => {
            e.preventDefault();
            onEnterCircle();
          }}
        >
          Enter the circle
        </a>
        <span className={styles.gridBtn} aria-hidden="true">
          <span className={styles.gridDots} />
        </span>
      </div>
    </nav>
  );
}
