// lib/router.ts — where the application is, in one place.
//
// The URL owns resource identity: which circle is open, which invitation is
// being read. The chain owns what a circle contains, the coordination service
// owns drafts and invitations, and React holds nothing but presentation. That
// division is what makes a reload, a shared link and the back button all agree.
//
// This is a small router rather than a library because the surface is small and
// static: nine routes, one parameter each at most, no nesting, no loaders, no
// lazy boundaries. A parser plus a popstate listener answers all of it, and it
// keeps a 3.7MB bundle from growing for the sake of a switch statement.
//
// Parsing is pure and total. Every path resolves to something, and anything
// unrecognised resolves to notFound rather than to a guess: a mistyped circle
// id must never quietly open a different circle.

import { useCallback, useEffect, useState } from "react";

import { parseCircleId } from "./appRoute";

export type Route =
  | { name: "landing" }
  | { name: "home" }
  | { name: "explore" }
  | { name: "myCircles" }
  | { name: "invitations" }
  | { name: "circle"; circleId: number }
  | { name: "standing" }
  | { name: "create" }
  | { name: "invite"; token: string }
  | { name: "console" }
  /**
   * The operator dashboard. Reachable by anybody who types it, and useful to
   * nobody but an operator: what it shows comes from an authenticated API that
   * checks an allowlist server side, so the path is not the protection.
   */
  | { name: "admin" }
  | { name: "notFound"; path: string };

export interface Resolved {
  route: Route;
  /**
   * A path this location should be replaced with, or null. Used for the
   * compatibility routes, so an old link resolves to the real one without
   * leaving a dead entry in the history.
   */
  redirectTo: string | null;
}

/** Circle ids are u32 on chain and assigned in sequence from 1. */
const MAX_CIRCLE_ID = 0xffff_ffff;

function isCircleId(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_CIRCLE_ID;
}

/** Strictly decimal. "1e3" and "0x1" are not circle ids, they are typos. */
function circleIdFromSegment(segment: string): number | null {
  if (!/^[0-9]+$/.test(segment)) return null;
  const value = Number(segment);
  return isCircleId(value) ? value : null;
}

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0);
}

/** The path that opens one circle. */
export function circlePath(circleId: number): string {
  if (!isCircleId(circleId)) throw new Error(`not a circle id: ${circleId}`);
  return `/app/circles/${circleId}`;
}

/** The path for a route, for links and for navigation. */
export function hrefFor(route: Route): string {
  switch (route.name) {
    case "landing":
      return "/";
    case "home":
      return "/app";
    case "explore":
      return "/app/explore";
    case "myCircles":
      return "/app/circles";
    case "invitations":
      return "/app/invitations";
    case "circle":
      return circlePath(route.circleId);
    case "standing":
      return "/app/standing";
    case "create":
      return "/app/create";
    case "invite":
      return `/invite/${encodeURIComponent(route.token)}`;
    case "console":
      return "/strk20";
    case "admin":
      return "/admin";
    case "notFound":
      return route.path;
  }
}

/**
 * The route for a location, and any replacement it should get first.
 *
 * Total: every input produces a route. Unrecognised paths and malformed
 * parameters both land on notFound, which the shell renders as a plain "not
 * found" with a way back, rather than substituting a default.
 */
export function resolve(pathname: string, search: string): Resolved {
  const parts = segmentsOf(pathname);
  const notFound: Resolved = { route: { name: "notFound", path: pathname }, redirectTo: null };

  if (parts.length === 0) return { route: { name: "landing" }, redirectTo: null };

  // Compatibility: the first phase reached the organizer flow at /start.
  if (parts.length === 1 && parts[0] === "start") {
    return { route: { name: "create" }, redirectTo: "/app/create" };
  }

  if (parts[0] === "admin") {
    return parts.length === 1 ? { route: { name: "admin" }, redirectTo: null } : notFound;
  }

  if (parts[0] === "strk20") {
    return parts.length === 1 ? { route: { name: "console" }, redirectTo: null } : notFound;
  }

  if (parts[0] === "invite") {
    if (parts.length !== 2) return notFound;
    let token: string;
    try {
      token = decodeURIComponent(parts[1]);
    } catch {
      return notFound;
    }
    return token.length === 0
      ? notFound
      : { route: { name: "invite", token }, redirectTo: null };
  }

  if (parts[0] !== "app") return notFound;

  if (parts.length === 1) {
    // Compatibility: the first phase carried the circle as /app?circle=<id>.
    const legacy = parseCircleId(search);
    if (legacy !== null) {
      return { route: { name: "circle", circleId: legacy }, redirectTo: circlePath(legacy) };
    }
    return { route: { name: "home" }, redirectTo: null };
  }

  if (parts.length === 2) {
    if (parts[1] === "explore") return { route: { name: "explore" }, redirectTo: null };
    if (parts[1] === "circles") return { route: { name: "myCircles" }, redirectTo: null };
    if (parts[1] === "invitations") return { route: { name: "invitations" }, redirectTo: null };
    if (parts[1] === "standing") return { route: { name: "standing" }, redirectTo: null };
    if (parts[1] === "create") return { route: { name: "create" }, redirectTo: null };
    return notFound;
  }

  if (parts.length === 3 && parts[1] === "circles") {
    const circleId = circleIdFromSegment(parts[2]);
    return circleId === null
      ? notFound
      : { route: { name: "circle", circleId }, redirectTo: null };
  }

  return notFound;
}

/** True when a route lives inside the application shell. */
export function isAppRoute(route: Route): boolean {
  return (
    route.name === "home" ||
    route.name === "explore" ||
    route.name === "myCircles" ||
    route.name === "invitations" ||
    route.name === "circle" ||
    route.name === "standing" ||
    route.name === "create" ||
    route.name === "admin" ||
    route.name === "notFound"
  );
}

function currentResolved(): Resolved {
  return resolve(window.location.pathname, window.location.search);
}

export interface Navigation {
  route: Route;
  /** Adds a history entry. Back returns to where the visitor was. */
  navigate: (to: string | Route) => void;
  /** Replaces the current entry. For redirects, which nobody should go back to. */
  replace: (to: string | Route) => void;
}

/**
 * The current route, kept in step with the address bar.
 *
 * Listens for popstate so back and forward work, and applies compatibility
 * redirects on arrival by replacement.
 */
export function useRoute(): Navigation {
  const [resolved, setResolved] = useState<Resolved>(currentResolved);

  useEffect(() => {
    const onPop = () => setResolved(currentResolved());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A compatibility path rewrites itself once, in place.
  useEffect(() => {
    if (resolved.redirectTo === null) return;
    window.history.replaceState(null, "", resolved.redirectTo);
    setResolved(currentResolved());
  }, [resolved.redirectTo]);

  const go = useCallback((to: string | Route, mode: "push" | "replace") => {
    const path = typeof to === "string" ? to : hrefFor(to);
    if (mode === "push") window.history.pushState(null, "", path);
    else window.history.replaceState(null, "", path);
    setResolved(currentResolved());
    // A new screen starts at its top, the way a page navigation would.
    window.scrollTo(0, 0);
  }, []);

  const navigate = useCallback((to: string | Route) => go(to, "push"), [go]);
  const replace = useCallback((to: string | Route) => go(to, "replace"), [go]);

  return { route: resolved.route, navigate, replace };
}
