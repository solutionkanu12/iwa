import { useReveal } from "./useReveal.ts";
import { scrollToId } from "./smoothScroll.ts";
import styles from "./LandingFooter.module.css";

// Section 7 of 8: footer. Dancers silhouette on top, four link columns, X and
// GitHub icon links, and a large faded "iwa" wordmark behind. Column headings
// and labels are exact from design/iwa-prototype.html. A few links have real
// destinations (Stellar, GitHub, the litepaper); the rest stay placeholders.
// This is the one reveal-once group (no replay). Nav, hero, and earlier
// sections, app, app nav, and seams are untouched.

const GITHUB_URL = "https://github.com/solutionkanu12/iwa";
const STELLAR_URL = "https://stellar.org";
const X_URL = "https://x.com/joinIwa";

// A footer link is one of: external (new tab), internal (same-site nav), a
// smooth-scroll to a section on this page, or inert (looks like a link, does
// nothing).
type FooterLink = {
  label: string;
  href?: string;
  external?: boolean;
  scrollTo?: string;
  inert?: boolean;
};

const COLUMNS: { heading: string; links: FooterLink[] }[] = [
  {
    heading: "product",
    links: [
      { label: "How it works", scrollTo: "how" },
      { label: "Roadmap", href: "/roadmap.html" }, // internal, same site
      { label: "Enter the circle", inert: true },
    ],
  },
  {
    heading: "resources",
    links: [
      { label: "Docs", inert: true },
      { label: "Guides", inert: true },
      { label: "Litepaper", href: "/litepaper.html" }, // internal, same site
      { label: "GitHub", href: GITHUB_URL, external: true },
    ],
  },
  {
    heading: "built on",
    links: [
      { label: "Stellar", href: STELLAR_URL, external: true },
      // No real destination yet, so inert rather than jumping to top.
      { label: "Soroban", inert: true },
      { label: "Zero-knowledge proofs", inert: true },
    ],
  },
  {
    heading: "company",
    links: [
      { label: "About Iwa", inert: true },
      { label: "Privacy policy", inert: true },
      { label: "Terms of service", inert: true },
    ],
  },
];

function FooterLinkA({ link }: { link: FooterLink }) {
  if (link.inert) {
    // Looks like a link, does nothing (no navigation, no scroll, no new tab).
    return (
      <a className={styles.link} onClick={(e) => e.preventDefault()}>
        {link.label}
      </a>
    );
  }
  if (link.scrollTo) {
    const id = link.scrollTo;
    return (
      <a
        className={styles.link}
        href={`#${id}`}
        onClick={(e) => {
          e.preventDefault();
          scrollToId(id);
        }}
      >
        {link.label}
      </a>
    );
  }
  return (
    <a
      className={styles.link}
      href={link.href}
      {...(link.external
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
    >
      {link.label}
    </a>
  );
}

export function LandingFooter() {
  // Footer columns reveal once on first entry and stay shown (no replay), still
  // staggered ~130ms apart by index.
  const colsRef = useReveal<HTMLDivElement>({
    visibleClass: styles.in,
    once: true,
    stagger: 0.13,
  });

  return (
    <footer className={styles.footer}>
      <div className={styles.wm} aria-hidden="true">
        iwa
      </div>
      <div className={styles.inner}>
        <div className={styles.top}>
          <img
            className={styles.topImg}
            src="/assets/iwa-dancers.png"
            alt="People dancing"
          />
        </div>

        <div className={styles.cols} ref={colsRef}>
          {COLUMNS.map((col) => (
            <div
              key={col.heading}
              className={`${styles.col} ${styles.reveal}`}
              data-reveal
            >
              <h4 className={styles.colH}>{col.heading}</h4>
              {col.links.map((link) => (
                <FooterLinkA key={link.label} link={link} />
              ))}
            </div>
          ))}
        </div>

        <div className={styles.bottom}>
          <div className={styles.social}>
            <a
              className={styles.socialLink}
              href={X_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Iwa on X"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
            <a
              className={styles.socialLink}
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Iwa on GitHub"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .5C5.73.5.5 5.74.5 12.02c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.05.78 2.12v3.14c0 .31.21.68.8.56A11.52 11.52 0 0 0 23.5 12.02C23.5 5.74 18.27.5 12 .5z" />
              </svg>
            </a>
          </div>
          <span className={styles.copy}>Iwa · Stellar Hacks, Real-World ZK</span>
        </div>
      </div>
    </footer>
  );
}
