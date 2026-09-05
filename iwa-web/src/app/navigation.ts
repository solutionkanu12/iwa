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

/**
 * Iwa Prize Savings.
 *
 * Off the phone bar deliberately, like Standing: five destinations would
 * crowd a 320px row, so secondary features live in the sidebar and the
 * account control instead.
 */
const PRIZE_SAVINGS: NavEntry = {
  route: { name: "prizeSavings" },
  label: "Prize savings",
  shortLabel: "Prizes",
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
  PRIZE_SAVINGS,
];

/**
 * Reached from the account control rather than the phone bar. One tap on the
 * wallet chip, one tap here: never more than one interaction further than the
 * bar would have been.
 */
export const ACCOUNT_NAV: NavEntry[] = [STANDING, PRIZE_SAVINGS];

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
  | "prizeSavings"
  | "admin"
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
    case "prizeSavings":
    case "admin":
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
  return (
    screen === "standing" ||
    screen === "myCircles" ||
    screen === "invitations" ||
    screen === "admin"
  );
}

/**
 * Which frame a route is rendered in.
 *
 * The saver product and the operator area are different places. A person
 * running Iwa is not browsing circles, and the sidebar that helps a saver find
 * their invitations is noise on an operations page, so the two do not share a
 * shell. Kept here, pure, because "which shell" is a rule about routes rather
 * than something a component should decide while rendering.
 *
 * Everything except the operator area uses the ordinary shell, including
 * notFound: an unrecognised path under /admin is not an operator page, it is a
 * mistyped URL, and it gets the same plain answer every other one does.
 */
export type ShellName = "app" | "admin";

export function shellFor(route: Route): ShellName {
  return route.name === "admin" ? "admin" : "app";
}

/**
 * The operator area's own navigation.
 *
 * One page with sections rather than several routes, so these are anchors and
 * not destinations: there is no second admin page to route to, and inventing
 * one would mean a link that leads somewhere empty.
 *
 * The ids are the section keys the admin report actually produces. A test pins
 * them to that report, so a section cannot be renamed or dropped and leave a
 * navigation entry pointing at nothing.
 */
export interface AdminNavEntry {
  /** The element id this scrolls to. */
  id: string;
  label: string;
}

export const ADMIN_NAV: AdminNavEntry[] = [
  { id: "operations", label: "Operations" },
  { id: "overview", label: "Overview" },
  { id: "chain", label: "Chain" },
  { id: "security", label: "Security" },
  { id: "business", label: "Product" },
];
