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
export interface LandingPageProps {
  // Opens the same Stellar Wallets Kit connect flow the app uses (lib/wallet.ts
  // connectWallet). Wired to every live "Enter the circle" CTA (nav, hero, dock).
  onEnterCircle: () => void;
}

export function LandingPage({ onEnterCircle }: LandingPageProps) {
  return (
    <div className={styles.page}>
      <LandingNav onEnterCircle={onEnterCircle} />
      {/* One shared cowrie-basket field (the prototype's topband) spanning the
          hero and community as a single continuous image, no seam. */}
      <div className={styles.topband}>
        <img
          className={styles.topbandBg}
          src="/assets/iwa-cowrie-basket.jpg"
          alt=""
          aria-hidden="true"
        />
        <LandingHero onEnterCircle={onEnterCircle} />
        <LandingCommunity />
      </div>
      <LandingHowItWorks />
      <LandingShowcase />
      <LandingFaq />
      <LandingFooter />
      <LandingDock onEnterCircle={onEnterCircle} />
    </div>
  );
}
