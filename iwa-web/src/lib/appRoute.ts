// lib/appRoute.ts — the legacy circle query.
//
// The first reconnect phase carried the open circle as `/app?circle=<id>`,
// before there were real routes. Links in that shape are still in the wild, so
// the router keeps reading it and replaces it with `/app/circles/<id>`.
//
// Parsing only. Nothing new is written in this shape, and `lib/router.ts` is
// where a circle link is built. Strict on purpose: an id that is absent,
// malformed or ambiguous resolves to null, and the app answers that by asking
// which circle rather than quietly substituting a different one.

/** The query parameter the first phase carried the circle id in. */
const CIRCLE_PARAM = "circle";

/** Circle ids are u32 on chain and assigned sequentially from 1. */
const MAX_CIRCLE_ID = 0xffff_ffff;

/**
 * The circle id named by a legacy query string, or null when none is validly
 * named.
 *
 * Only plain decimal digits are accepted, so "1e3", "0x1" and " 1 " are refused
 * rather than coerced into some other circle. A repeated parameter is refused
 * too: there is no correct way to choose between two answers.
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
  return Number.isInteger(value) && value >= 1 && value <= MAX_CIRCLE_ID ? value : null;
}
