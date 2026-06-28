import { LandingNav } from "./LandingNav.tsx";
import { LandingHero } from "./LandingHero.tsx";
import styles from "./LandingPage.module.css";

// Public marketing landing page (PRD section 9). Grows section by section.
// Done: section 1 (glass nav), section 2 (hero). Later sections (community and
// so on) will be added below the hero.
export function LandingPage() {
  return (
    <div className={styles.page}>
      <LandingNav />
      <LandingHero />
    </div>
  );
}
