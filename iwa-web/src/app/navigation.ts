// app/navigation.ts — what the application offers, and which entry is current.
//
// Kept apart from the shell that renders it so the model can be checked
// directly: which destinations exist, which appear on a phone, and which one a
// given route lights up.
//
// ONLY WHAT WORKS. My circles and Invitations both need a coordination read
// that does not exist yet. A navigation entry that leads to an empty promise
// teaches people the product is broken, so they are absent rather than
// disabled: an entry nobody can use is not better greyed out, it is better not
// yet there.

import type { Route } from "../lib/router";

export interface NavEntry {
  route: Route;
  label: string;
  /** Shown in the phone's bottom bar. Kept few, so each stays tappable. */
  onMobile: boolean;
}

/** Places to go. */
export const PRIMARY_NAV: NavEntry[] = [
  { route: { name: "home" }, label: "Home", onMobile: true },
  { route: { name: "explore" }, label: "Explore", onMobile: true },
  { route: { name: "standing" }, label: "My standing", onMobile: true },
];

/** Things to do. */
export const ACTION_NAV: NavEntry[] = [
  { route: { name: "create" }, label: "Start a circle", onMobile: true },
];

export const MOBILE_NAV: NavEntry[] = [...PRIMARY_NAV, ...ACTION_NAV].filter((e) => e.onMobile);

/**
 * Whether a navigation entry is the section currently open.
 *
 * A circle is reached through Explore and belongs to it while open, so the
 * directory stays lit rather than nothing being lit at all.
 */
export function isActive(entry: NavEntry, route: Route): boolean {
  if (entry.route.name === route.name) return true;
  return entry.route.name === "explore" && route.name === "circle";
}

/** Which screen a route shows. The shell renders it; this names it. */
export type ScreenName = "home" | "explore" | "circle" | "standing" | "create" | "notFound";

export function screenFor(route: Route): ScreenName {
  switch (route.name) {
    case "home":
    case "explore":
    case "circle":
    case "standing":
    case "create":
      return route.name;
    default:
      return "notFound";
  }
}

/**
 * Whether a screen can be read without a wallet.
 *
 * Everything the chain publishes is public, so the application is browsable by
 * anyone. Only what is private, or what acts on the visitor's behalf, needs a
 * connection, and it is asked for at that point rather than at the door.
 */
export function needsWallet(screen: ScreenName): boolean {
  return screen === "standing";
}
