import { LandingNav } from "./LandingNav.tsx";
import { LandingHero } from "./LandingHero.tsx";
import { LandingCommunity } from "./LandingCommunity.tsx";
import { LandingHowItWorks } from "./LandingHowItWorks.tsx";
import { LandingShowcase } from "./LandingShowcase.tsx";
import { LandingFaq } from "./LandingFaq.tsx";
import { LandingFooter } from "./LandingFooter.tsx";
import { LandingDock } from "./LandingDock.tsx";
import styles from "./LandingPage.module.css";

// Public marketing landing page (PRD section 9). All 8 sections complete:
// 1 glass nav, 2 hero, 3 community, 4 how it works, 5 see it in action, 6 FAQ,
// 7 footer, 8 dock (fixed glass).
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
      <LandingShowcase />
      <LandingFaq />
      <LandingFooter />
      <LandingDock />
    </div>
  );
}
