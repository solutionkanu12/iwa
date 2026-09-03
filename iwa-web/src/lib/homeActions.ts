// lib/homeActions.ts — when the front door is allowed to ask for a signature.
//
// The rule this exists to enforce: opening Home must never surprise somebody
// with a wallet prompt.
//
// The Action Center reads private data, so it needs the read-only session from
// Phase 6E-3, and creating that session costs one signature. Doing that on
// mount would mean a person who connected their wallet and did nothing else is
// asked to sign, for something they did not ask to see. A prompt nobody asked
// for is a prompt people learn to approve without reading, and that habit is
// the thing every signature in this product depends on not existing.
//
// So the session is created on a press and never on a render. Private data is
// loaded only when a session already exists, or when somebody has explicitly
// asked for it. Nothing is weakened: the same session, the same signature, the
// same authentication, just never uninvited.
//
// Pure and synchronous, so the rule is testable without a browser.

import type { CircleTask } from "./actionCenter";

export interface HomeState {
  /** A wallet is connected. */
  connected: boolean;
  /** A read-only session is already held, so no signature is needed. */
  hasSession: boolean;
  /** The person pressed the button asking to see this. */
  requested: boolean;
  /** A load is in flight. */
  loading: boolean;
  /** Loaded tasks, or null when nothing has been loaded. */
  tasks: CircleTask[] | null;
  /** The last load failed. */
  failed: boolean;
}

export type ActionCenterView =
  /** No wallet. Nothing private is loaded or shown. */
  | { kind: "signedOut" }
  /** A wallet, but no session yet. Waits for a press. */
  | { kind: "needsSession" }
  | { kind: "loading" }
  | { kind: "ready"; tasks: CircleTask[] }
  | { kind: "failed" };

/**
 * Whether private data may be fetched right now.
 *
 * The whole product rule lives in this one predicate. It is false without a
 * wallet, and false with a wallet but no session unless somebody asked, which
 * is what keeps a signature request off the front door.
 *
 * It is also false once a load has failed, until the person asks again. That is
 * what stops a failed read, or a declined signature, turning into a loop that
 * re-prompts every render.
 */
export function shouldLoadActionCenter(state: HomeState): boolean {
  if (!state.connected) return false;
  if (state.loading) return false;
  if (state.failed) return false;
  if (state.tasks !== null) return false;
  return state.hasSession || state.requested;
}

/** What the Action Center shows. */
export function actionCenterView(state: HomeState): ActionCenterView {
  if (!state.connected) return { kind: "signedOut" };
  if (state.failed) return { kind: "failed" };
  if (state.tasks !== null) return { kind: "ready", tasks: state.tasks };
  if (state.loading) return { kind: "loading" };
  // A wallet with no session, and nobody has asked yet.
  return { kind: "needsSession" };
}

/**
 * The words for each state.
 *
 * Deliberately about the person's circles rather than about signing in, which
 * is a thing Iwa needs and they do not. Nothing here mentions a wallet, a
 * session or a signature, because none of those is what they came to find out.
 */
export const HOME_COPY = {
  heading: "What needs you",
  signedOut: "Connect your wallet to see what needs your attention.",
  needsSession: "See whether anything is waiting on you across your circles.",
  needsSessionAction: "Check my circles",
  loading: "Checking your circles",
  failed: "Your circles could not be checked just now.",
  failedAction: "Try again",
  nothing: "You are up to date.",
} as const;
