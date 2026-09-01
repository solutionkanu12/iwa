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
  /**
   * A shorter word for the phone bar. Five destinations share a narrow row, so
   * each label has to stay one short word to remain readable and tappable.
   */
  shortLabel?: string;
  /** Shown in the phone's bottom bar. Kept few, so each stays tappable. */
  onMobile: boolean;
}

/** The label to render, given how much room there is. */
export function labelFor(entry: NavEntry, compact: boolean): string {
  return compact ? (entry.shortLabel ?? entry.label) : entry.label;
}

/**
 * My standing.
 *
 * Kept off the phone bar deliberately. Four destinations divide a 320px row
 * into 80px columns, which is comfortably tappable and readable; a fifth makes
 * every one of them cramped. Standing is the least frequent of the five and the
 * only one that is purely about you, so it lives with the account control,
 * where a person already looks for their own things.
 */
const STANDING: NavEntry = {
  route: { name: "standing" },
  label: "My standing",
  shortLabel: "Standing",
  onMobile: false,
};

/** Places to go. The sidebar shows all of these. */
export const PRIMARY_NAV: NavEntry[] = [
  { route: { name: "home" }, label: "Home", onMobile: true },
  { route: { name: "explore" }, label: "Explore", onMobile: true },
  { route: { name: "myCircles" }, label: "My circles", shortLabel: "Circles", onMobile: true },
  {
    route: { name: "invitations" },
    label: "Invitations",
    shortLabel: "Invites",
    onMobile: true,
  },
  STANDING,
];

/**
 * Reached from the account control rather than the phone bar. One tap on the
 * wallet chip, one tap here: never more than one interaction further than the
 * bar would have been.
 */
export const ACCOUNT_NAV: NavEntry[] = [STANDING];

/** Things to do. */
export const ACTION_NAV: NavEntry[] = [
  { route: { name: "create" }, label: "Start a circle", onMobile: false },
];

export const MOBILE_NAV: NavEntry[] = [...PRIMARY_NAV, ...ACTION_NAV].filter((e) => e.onMobile);

/**
 * Whether a navigation entry is the section currently open.
 *
 * An open circle lights My circles. It is reachable from both Explore and My
 * circles, so origin cannot decide it; the path can. A circle lives at
 * /app/circles/:id, under My circles, and following the path keeps the answer
 * the same however the visitor arrived.
 */
export function isActive(entry: NavEntry, route: Route): boolean {
  if (entry.route.name === route.name) return true;
  return entry.route.name === "myCircles" && route.name === "circle";
}

/** Which screen a route shows. The shell renders it; this names it. */
export type ScreenName =
  | "home"
  | "explore"
  | "myCircles"
  | "invitations"
  | "circle"
  | "standing"
  | "create"
  | "notFound";

export function screenFor(route: Route): ScreenName {
  switch (route.name) {
    case "home":
    case "explore":
    case "myCircles":
    case "invitations":
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
  return screen === "standing" || screen === "myCircles" || screen === "invitations";
}
