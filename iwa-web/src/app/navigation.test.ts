import { describe, expect, it } from "vitest";

import {
  ACTION_NAV,
  MOBILE_NAV,
  PRIMARY_NAV,
  isActive,
  needsWallet,
  screenFor,
  type NavEntry,
} from "./navigation";
import { hrefFor, resolve } from "../lib/router";

const ALL: NavEntry[] = [...PRIMARY_NAV, ...ACTION_NAV];

describe("the navigation model", () => {
  it("offers only destinations that exist", () => {
    for (const entry of ALL) {
      const href = hrefFor(entry.route);
      expect(resolve(href, "").route.name).not.toBe("notFound");
    }
  });

  // My circles and Invitations need a coordination read that is not built.
  // They are absent rather than present and empty.
  it("does not offer anything that is not built yet", () => {
    const labels = ALL.map((e) => e.label);
    expect(labels).not.toContain("My circles");
    expect(labels).not.toContain("Invitations");
  });

  it("keeps the phone bar small enough for each item to stay tappable", () => {
    expect(MOBILE_NAV.length).toBeGreaterThan(1);
    expect(MOBILE_NAV.length).toBeLessThanOrEqual(4);
  });

  it("names every destination exactly once", () => {
    const names = ALL.map((e) => e.route.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("isActive", () => {
  it("lights the entry for the route that is open", () => {
    expect(isActive(PRIMARY_NAV[0], { name: "home" })).toBe(true);
    expect(isActive(PRIMARY_NAV[1], { name: "explore" })).toBe(true);
    expect(isActive(ACTION_NAV[0], { name: "create" })).toBe(true);
  });

  it("lights exactly one entry for any application route", () => {
    const routes = [
      { name: "home" },
      { name: "explore" },
      { name: "standing" },
      { name: "create" },
      { name: "circle", circleId: 3 },
    ] as const;
    for (const route of routes) {
      expect(ALL.filter((e) => isActive(e, route))).toHaveLength(1);
    }
  });

  it("keeps Explore lit while a circle from it is open", () => {
    expect(isActive(PRIMARY_NAV[1], { name: "circle", circleId: 9 })).toBe(true);
    expect(isActive(PRIMARY_NAV[0], { name: "circle", circleId: 9 })).toBe(false);
  });

  it("lights nothing for a page that is not found", () => {
    expect(ALL.some((e) => isActive(e, { name: "notFound", path: "/x" }))).toBe(false);
  });
});

describe("screenFor", () => {
  it("maps each route to its screen", () => {
    expect(screenFor({ name: "home" })).toBe("home");
    expect(screenFor({ name: "explore" })).toBe("explore");
    expect(screenFor({ name: "circle", circleId: 2 })).toBe("circle");
    expect(screenFor({ name: "standing" })).toBe("standing");
    expect(screenFor({ name: "create" })).toBe("create");
  });

  it("sends anything unrecognised to the not-found screen", () => {
    expect(screenFor({ name: "notFound", path: "/nope" })).toBe("notFound");
    expect(screenFor({ name: "landing" })).toBe("notFound");
  });

  it("opens the circle the route names, never another", () => {
    const route = resolve("/app/circles/12", "").route;
    expect(route).toEqual({ name: "circle", circleId: 12 });
    expect(screenFor(route)).toBe("circle");
  });
});

// The application is readable by anyone. A wallet is asked for by the action
// that needs it, never merely because the app rendered.
describe("what a wallet is needed for", () => {
  it("lets the public screens be read without one", () => {
    for (const screen of ["home", "explore", "circle", "notFound"] as const) {
      expect(needsWallet(screen)).toBe(false);
    }
  });

  it("requires one for private standing", () => {
    expect(needsWallet("standing")).toBe(true);
  });

  // Creating a circle needs a wallet to sign, but the screen itself explains
  // itself first and asks for the connection when the organizer proceeds.
  it("lets the create screen render before a wallet is connected", () => {
    expect(needsWallet("create")).toBe(false);
  });
});
