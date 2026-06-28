import { LandingNav } from "./LandingNav.tsx";
import styles from "./LandingPage.module.css";

// Public marketing landing page (PRD section 9). Grows section by section.
// Section 1 of 8: the glass nav. Later sections (hero, community, and so on)
// will be added below the nav.
export function LandingPage() {
  return (
    <div className={styles.page}>
      <LandingNav />
    </div>
  );
}
