// Smooth-scroll to an element by id on the landing page, accounting for the
// fixed nav height so the target heading is not hidden under it. Respects
// reduced motion (jumps instantly instead of animating).
export function scrollToId(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  // Fixed nav sits at top 14px and is roughly 52px tall; leave a little room.
  const navOffset = 90;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const y = el.getBoundingClientRect().top + window.scrollY - navOffset;
  window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
}
