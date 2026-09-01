import { describe, expect, it } from "vitest";

import {
  ACCOUNT_NAV,
  ACTION_NAV,
  MOBILE_NAV,
  PRIMARY_NAV,
  isActive,
  labelFor,
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

  // These are backed by real coordination reads now, so they are offered.
  it("offers the places a wallet returns to", () => {
    const labels = ALL.map((e) => e.label);
    expect(labels).toContain("My circles");
    expect(labels).toContain("Invitations");
  });

  // Four destinations divide the narrowest supported screen, 320px, into 80px
  // columns. A fifth makes every column cramped, so the bar holds four.
  it("puts exactly four destinations on the phone bar", () => {
    expect(MOBILE_NAV).toHaveLength(4);
  });

  it("puts exactly these four, in this order", () => {
    expect(MOBILE_NAV.map((e) => labelFor(e, true))).toEqual([
      "Home",
      "Explore",
      "Circles",
      "Invites",
    ]);
  });

  it("gives the phone bar one short word per destination", () => {
    for (const entry of MOBILE_NAV) {
      const shown = labelFor(entry, true);
      expect(shown.split(" ")).toHaveLength(1);
      // Eight characters at 12px sits well inside an 80px column.
      expect(shown.length).toBeLessThanOrEqual(8);
    }
  });

  it("keeps My standing off the phone bar", () => {
    expect(MOBILE_NAV.some((e) => e.route.name === "standing")).toBe(false);
  });

  // Off the bar is not out of reach. One tap on the wallet chip, one tap here.
  it("keeps My standing reachable from the account control", () => {
    expect(ACCOUNT_NAV.map((e) => e.label)).toContain("My standing");
    expect(ACCOUNT_NAV.every((e) => resolve(hrefFor(e.route), "").route.name !== "notFound")).toBe(
      true,
    );
  });

  it("keeps My standing in the desktop navigation", () => {
    expect(PRIMARY_NAV.map((e) => e.label)).toContain("My standing");
    const standing = PRIMARY_NAV.find((e) => e.route.name === "standing") as NavEntry;
    expect(labelFor(standing, false)).toBe("My standing");
  });

  it("still has a standing route to reach", () => {
    expect(resolve("/app/standing", "").route).toEqual({ name: "standing" });
  });

  // Nothing on the bar should look active while standing is open, since
  // standing is not one of its four destinations.
  it("lights no phone tab while My standing is open", () => {
    expect(MOBILE_NAV.some((e) => isActive(e, { name: "standing" }))).toBe(false);
  });

  it("keeps the full wording in the sidebar", () => {
    const circles = PRIMARY_NAV.find((e) => e.route.name === "myCircles");
    expect(circles).toBeDefined();
    expect(labelFor(circles as NavEntry, false)).toBe("My circles");
    expect(labelFor(circles as NavEntry, true)).toBe("Circles");
  });

  // Starting a circle is a deliberate act reached from the sidebar and from
  // Home. A sixth item would make every phone tab too narrow to read.
  it("leaves starting a circle out of the phone bar", () => {
    expect(MOBILE_NAV.some((e) => e.route.name === "create")).toBe(false);
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
      { name: "myCircles" },
      { name: "invitations" },
      { name: "standing" },
      { name: "create" },
      { name: "circle", circleId: 3 },
    ] as const;
    for (const route of routes) {
      expect(ALL.filter((e) => isActive(e, route))).toHaveLength(1);
    }
  });

  // A circle opened on a phone must still light Circles, which is the tab it
  // sits under.
  it("lights the Circles tab on the phone bar while a circle is open", () => {
    const tab = MOBILE_NAV.find((e) => e.route.name === "myCircles") as NavEntry;
    expect(isActive(tab, { name: "circle", circleId: 4 })).toBe(true);
    expect(MOBILE_NAV.filter((e) => isActive(e, { name: "circle", circleId: 4 }))).toHaveLength(1);
  });

  // A circle lives at /app/circles/:id, under My circles. Following the path
  // gives the same answer however the visitor arrived at it.
  it("lights My circles while a circle is open", () => {
    const circles = PRIMARY_NAV.find((e) => e.route.name === "myCircles") as NavEntry;
    const explore = PRIMARY_NAV.find((e) => e.route.name === "explore") as NavEntry;
    expect(isActive(circles, { name: "circle", circleId: 9 })).toBe(true);
    expect(isActive(explore, { name: "circle", circleId: 9 })).toBe(false);
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

  // Which circles are yours, and which invitations you accepted, are answers
  // about one wallet. There is nothing to show without knowing which.
  it("requires one for anything belonging to a wallet", () => {
    for (const screen of ["standing", "myCircles", "invitations"] as const) {
      expect(needsWallet(screen)).toBe(true);
    }
  });

  // Creating a circle needs a wallet to sign, but the screen itself explains
  // itself first and asks for the connection when the organizer proceeds.
  it("lets the create screen render before a wallet is connected", () => {
    expect(needsWallet("create")).toBe(false);
  });
});
