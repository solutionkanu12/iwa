import { useEffect, useRef, type RefObject } from "react";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface RevealOptions {
  /** CSS-module class toggled when an item is in view. */
  visibleClass: string;
  /** Reveal once then stop (no replay). Default false (replays on re-entry). */
  once?: boolean;
  /** Transition-delay in seconds added per item index, for staggering. */
  stagger?: number;
}

/**
 * Shared scroll-reveal for the landing page. Attach the returned ref to a group
 * container, and mark each reveal item inside it with the `data-reveal`
 * attribute plus the base reveal CSS class.
 *
 * By default the visible class is added when an item enters the viewport and
 * removed when it leaves, so the staggered fade-and-rise replays on every
 * re-entry (scrolling up and down re-triggers it). Pass `once: true` (the
 * footer) to reveal on first entry and then unobserve, with no replay.
 *
 * The per-item transition-delay (index * stagger) is kept across replays, so the
 * group re-staggers in order each time. Under reduced motion every item is shown
 * immediately and stays shown, with no observer and no toggling.
 */
export function useReveal<T extends HTMLElement>({
  visibleClass,
  once = false,
  stagger = 0,
}: RevealOptions): RefObject<T | null> {
  const containerRef = useRef<T | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = Array.from(
      container.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    if (items.length === 0) return;

    items.forEach((el, i) => {
      el.style.transitionDelay = `${(i * stagger).toFixed(2)}s`;
    });

    // Reduced motion or no observer: show everything immediately and stop.
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add(visibleClass));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          const el = e.target as HTMLElement;
          if (e.isIntersecting) {
            el.classList.add(visibleClass);
            if (once) io.unobserve(el);
          } else if (!once) {
            // Replay: clear the class so it fades and rises again on re-entry.
            el.classList.remove(visibleClass);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -12% 0px" },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [visibleClass, once, stagger]);

  return containerRef;
}
