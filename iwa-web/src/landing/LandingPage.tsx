import { LandingNav } from "./LandingNav.tsx";
import { LandingHero } from "./LandingHero.tsx";
import { LandingCommunity } from "./LandingCommunity.tsx";
import { LandingHowItWorks } from "./LandingHowItWorks.tsx";
import styles from "./LandingPage.module.css";

// Public marketing landing page (PRD section 9). Grows section by section.
// Done: section 1 (glass nav), section 2 (hero), section 3 (community),
// section 4 (how it works). Later sections will be added below.
export function LandingPage() {
  return (
    <div className={styles.page}>
      <LandingNav />
      {/* One shared cowrie-basket field (the prototype's topband) spanning the
          hero and community as a single continuous image, no seam. */}
      <div className={styles.topband}>
        <img
          className={styles.topbandBg}
          src="/assets/iwa-cowrie-basket.jpg"
          alt=""
          aria-hidden="true"
        />
        <LandingHero />
        <LandingCommunity />
      </div>
      <LandingHowItWorks />
    </div>
  );
}
