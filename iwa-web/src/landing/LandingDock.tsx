import styles from "./LandingDock.module.css";

// Section 8 of 8: the dock (fixed glass). A slim frosted-glass island pinned to
// the bottom of the viewport, floating over content, the bottom bookend to the
// fixed top nav. Left: cowrie glyph, name, descriptor. Right: the network tag
// and an iris CTA. Matched to design/iwa-prototype.html, with one copy change:
// the network tag reads "Live on Stellar" (prototype said "Stellar testnet").
// Nav, hero, and earlier sections, the footer, app, app nav, and seams are
// untouched.

function CowrieGlyph() {
  return (
    <svg width="24" height="26" viewBox="0 0 60 70" aria-hidden="true">
      <ellipse cx="30" cy="36" rx="20" ry="26" fill="#B6A6F2" />
      <ellipse cx="25" cy="29" rx="11" ry="15" fill="#CECBF6" opacity=".8" />
      <path d="M30 12C34 30 34 42 30 60C26 42 26 30 30 12Z" fill="#F6F4FC" />
    </svg>
  );
}

export function LandingDock() {
  return (
    <div className={styles.dock}>
      <div className={styles.l}>
        <CowrieGlyph />
        <span className={styles.nm}>Iwa</span>
        <span className={styles.sep} aria-hidden="true" />
        <span className={styles.tag}>savings circles, private proof</span>
      </div>
      <div className={styles.r}>
        <span className={styles.net}>Live on Stellar</span>
        <button type="button" className={styles.cta}>
          Enter the circle
        </button>
      </div>
    </div>
  );
}
