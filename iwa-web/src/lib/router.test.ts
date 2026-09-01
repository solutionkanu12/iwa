import { describe, expect, it } from "vitest";

import { circlePath, hrefFor, resolve, type Route } from "./router";

function routeOf(pathname: string, search = ""): Route {
  return resolve(pathname, search).route;
}

describe("resolve", () => {
  it("reads the landing page", () => {
    expect(routeOf("/")).toEqual({ name: "landing" });
  });

  it("reads the application entry", () => {
    expect(routeOf("/app")).toEqual({ name: "home" });
    expect(routeOf("/app/")).toEqual({ name: "home" });
  });

  it("reads the public directory", () => {
    expect(routeOf("/app/explore")).toEqual({ name: "explore" });
  });

  it("reads a circle and its id", () => {
    expect(routeOf("/app/circles/7")).toEqual({ name: "circle", circleId: 7 });
    expect(routeOf("/app/circles/1")).toEqual({ name: "circle", circleId: 1 });
  });

  it("reads standing and create", () => {
    expect(routeOf("/app/standing")).toEqual({ name: "standing" });
    expect(routeOf("/app/create")).toEqual({ name: "create" });
  });

  it("reads an invitation token", () => {
    expect(routeOf("/invite/abc123")).toEqual({ name: "invite", token: "abc123" });
  });

  it("decodes an invitation token that was percent-encoded", () => {
    expect(routeOf("/invite/a%2Bb")).toEqual({ name: "invite", token: "a+b" });
  });

  it("refuses an empty invitation token", () => {
    expect(routeOf("/invite/").name).toBe("notFound");
    expect(routeOf("/invite").name).toBe("notFound");
  });

  // A bad circle id must never resolve to some other circle. Every one of
  // these is "not a circle", which the app answers by saying so.
  it("refuses a circle id that is not a positive whole number", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "", "0x1", "1e3", "%20", "9".repeat(30)]) {
      expect(routeOf(`/app/circles/${bad}`).name).toBe("notFound");
    }
  });

  it("never falls back to a demo circle", () => {
    const route = routeOf("/app/circles/nonsense");
    expect(route).not.toMatchObject({ name: "circle", circleId: 1 });
  });

  it("reports an unknown path rather than guessing", () => {
    expect(routeOf("/nope")).toEqual({ name: "notFound", path: "/nope" });
    expect(routeOf("/app/nope").name).toBe("notFound");
    expect(routeOf("/app/circles/1/extra").name).toBe("notFound");
  });

  it("ignores a trailing slash", () => {
    expect(routeOf("/app/explore/")).toEqual({ name: "explore" });
    expect(routeOf("/app/circles/7/")).toEqual({ name: "circle", circleId: 7 });
  });
});

// The query bridge from the first phase still has links in the wild. They are
// migrated to the real route, by replacement so no dead entry is left in the
// history.
describe("legacy compatibility", () => {
  it("migrates /app?circle=5 to the circle route", () => {
    const { route, redirectTo } = resolve("/app", "?circle=5");
    expect(redirectTo).toBe("/app/circles/5");
    expect(route).toEqual({ name: "circle", circleId: 5 });
  });

  it("ignores a malformed legacy circle query", () => {
    const { route, redirectTo } = resolve("/app", "?circle=abc");
    expect(redirectTo).toBeNull();
    expect(route).toEqual({ name: "home" });
  });

  it("redirects /start to the create route", () => {
    const { route, redirectTo } = resolve("/start", "");
    expect(redirectTo).toBe("/app/create");
    expect(route).toEqual({ name: "create" });
  });

  it("leaves a real route alone", () => {
    expect(resolve("/app/circles/5", "").redirectTo).toBeNull();
    expect(resolve("/app/explore", "").redirectTo).toBeNull();
  });
});

describe("hrefFor", () => {
  it("builds the path for every navigable route", () => {
    expect(hrefFor({ name: "landing" })).toBe("/");
    expect(hrefFor({ name: "home" })).toBe("/app");
    expect(hrefFor({ name: "explore" })).toBe("/app/explore");
    expect(hrefFor({ name: "standing" })).toBe("/app/standing");
    expect(hrefFor({ name: "create" })).toBe("/app/create");
    expect(hrefFor({ name: "circle", circleId: 7 })).toBe("/app/circles/7");
  });

  it("round-trips through the parser", () => {
    const routes: Route[] = [
      { name: "home" },
      { name: "explore" },
      { name: "standing" },
      { name: "create" },
      { name: "circle", circleId: 42 },
    ];
    for (const route of routes) {
      expect(routeOf(hrefFor(route))).toEqual(route);
    }
  });
});

describe("circlePath", () => {
  it("builds a circle link", () => {
    expect(circlePath(7)).toBe("/app/circles/7");
  });

  it("refuses to build a link to an impossible circle", () => {
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      expect(() => circlePath(bad)).toThrow();
    }
  });
});
