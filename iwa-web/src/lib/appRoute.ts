// lib/appRoute.ts — which circle the app is looking at, carried in the URL.
//
// A temporary bridge, and deliberately a small one. The circle being viewed is
// product identity: it has to survive a reload, travel in a shared link, and
// be the same circle the organizer just created. Holding it in React state
// alone loses it on the first refresh, and holding it in localStorage would
// make a stored value authoritative over the address bar, which for financial
// state is worse than losing it.
//
// So it lives in the query string, `/app?circle=<id>`, until the route model
// replaces this with `/app/circles/:circleId`. Only the id travels; the
// contents always come from the chain.
//
// Nothing here guesses. An id that is absent, malformed, or ambiguous resolves
// to null, and the app answers that by asking which circle, never by quietly
// substituting a different one.

/** The query parameter carrying the circle id. */
const CIRCLE_PARAM = "circle";

/** Circle ids are u32 on chain and assigned sequentially from 1. */
const MAX_CIRCLE_ID = 0xffff_ffff;

function isCircleId(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_CIRCLE_ID;
}

/**
 * The circle id named by a query string, or null when none is validly named.
 *
 * Strict on purpose: only plain decimal digits are accepted, so "1e3", "0x1"
 * and " 1 " are all refused rather than coerced into some other circle. A
 * repeated parameter is refused too, because there is no correct way to pick
 * between two answers.
 */
export function parseCircleId(search: string): number | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  const all = params.getAll(CIRCLE_PARAM);
  if (all.length !== 1) return null;

  const raw = all[0];
  if (!/^[0-9]+$/.test(raw)) return null;

  const value = Number(raw);
  return isCircleId(value) ? value : null;
}

/** The in-app link that opens one circle. */
export function circleHref(circleId: number): string {
  if (!isCircleId(circleId)) {
    throw new Error(`not a circle id: ${circleId}`);
  }
  return `/app?${CIRCLE_PARAM}=${circleId}`;
}
