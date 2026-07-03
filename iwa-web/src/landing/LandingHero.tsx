import { useEffect, useRef } from "react";
import styles from "./LandingHero.module.css";

// Section 2 of 8: the hero. Matched to the prototype. The cowrie-basket image is
// full-bleed behind the hero (and will continue into the community card when
// that section is built). The seal is the lavender landing seal, not the mint
// verified state. Headline and CTA copy are from the PRD; eyebrow and subhead
// match the prototype exactly.

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function LandingHero({
  onEnterCircle,
}: {
  onEnterCircle: () => void;
}) {
  const heroRef = useRef<HTMLElement>(null);
  const sealRef = useRef<SVGSVGElement>(null);

  // Cursor-tilt on the hero seal. Off on touch and reduced-motion.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const area = heroRef.current;
    const svg = sealRef.current;
    if (!area || !svg) return;

    const onMove = (e: PointerEvent) => {
      const r = area.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      svg.classList.add(styles.tilting);
      svg.style.transform = `perspective(560px) rotateY(${(x * 42).toFixed(1)}deg) rotateX(${(-y * 34).toFixed(1)}deg)`;
    };
    const onLeave = () => {
      svg.classList.remove(styles.tilting);
      svg.style.transform = "";
    };

    area.addEventListener("pointermove", onMove);
    area.addEventListener("pointerleave", onLeave);
    return () => {
      area.removeEventListener("pointermove", onMove);
      area.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <section className={styles.hero} ref={heroRef} aria-label="Hero">
        <p className={styles.eyebrow}>savings circles · private proof</p>
        <div className={styles.seal}>
          <svg
            ref={sealRef}
            className={styles.cowrieSvg}
            viewBox="-24 -20 248 264"
            width="100%"
            role="img"
            aria-label="Cowrie seal"
          >
            <g style={{ transformOrigin: "100px 110px" }}>
              <ellipse
                cx="108"
                cy="132"
                rx="58"
                ry="74"
                fill="#AFA9EC"
                opacity=".55"
              />
              <ellipse cx="100" cy="110" rx="62" ry="80" fill="#B6A6F2" />
              <ellipse
                cx="86"
                cy="90"
                rx="38"
                ry="52"
                fill="#CECBF6"
                opacity=".75"
              />
              <path
                d="M100 40C110 80 110 140 100 180C90 140 90 80 100 40Z"
                fill="#F6F4FC"
              />
              <g
                stroke="#8d80c4"
                strokeWidth="2.4"
                strokeLinecap="round"
                opacity=".7"
              >
                <line x1="93" y1="66" x2="85" y2="66" />
                <line x1="107" y1="66" x2="115" y2="66" />
                <line x1="92" y1="86" x2="83" y2="86" />
                <line x1="108" y1="86" x2="117" y2="86" />
                <line x1="91" y1="108" x2="82" y2="108" />
                <line x1="109" y1="108" x2="118" y2="108" />
                <line x1="92" y1="130" x2="83" y2="130" />
                <line x1="108" y1="130" x2="117" y2="130" />
                <line x1="93" y1="152" x2="85" y2="152" />
                <line x1="107" y1="152" x2="115" y2="152" />
              </g>
            </g>
          </svg>
        </div>
        <h1 className={styles.h1}>Your good name, proven and private</h1>
        <p className={styles.sub}>
          A savings circle on Stellar. Your everyday contributions become a
          private proof you are reliable. Show it to anyone, reveal nothing.
        </p>
        <div className={styles.ctaRow}>
          <a
            className={styles.cta}
            href="/app"
            onClick={(e) => {
              e.preventDefault();
              onEnterCircle();
            }}
          >
            {/* Check-circle glyph, inline. Uses currentColor (the button's cloud
                text), never mint. */}
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            Enter the circle
          </a>
        </div>
    </section>
  );
}
