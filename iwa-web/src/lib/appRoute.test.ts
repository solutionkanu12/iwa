import { describe, expect, it } from "vitest";

import { circleHref, parseCircleId } from "./appRoute";

// The circle being viewed belongs in the URL, not in React state. Until the
// router lands, `/app?circle=<id>` carries it: a reload, a shared link and the
// hand-off from circle creation all resolve to the same circle.
describe("parseCircleId", () => {
  it("reads a circle id from the query string", () => {
    expect(parseCircleId("?circle=7")).toBe(7);
    expect(parseCircleId("?circle=1")).toBe(1);
    expect(parseCircleId("?foo=bar&circle=42")).toBe(42);
  });

  it("returns null when no circle is named", () => {
    expect(parseCircleId("")).toBeNull();
    expect(parseCircleId("?")).toBeNull();
    expect(parseCircleId("?other=3")).toBeNull();
  });

  // A bad id must not silently become some other circle. Every one of these
  // resolves to "no circle chosen", which the app answers by asking.
  it("refuses anything that is not a positive whole circle id", () => {
    for (const bad of [
      "?circle=0",
      "?circle=-1",
      "?circle=1.5",
      "?circle=abc",
      "?circle=",
      "?circle=1e3",
      "?circle=0x1",
      "?circle=%20",
      "?circle=999999999999999999999999",
      "?circle=1&circle=2",
    ]) {
      expect(parseCircleId(bad)).toBeNull();
    }
  });

  it("never falls back to a demo circle", () => {
    expect(parseCircleId("?circle=nonsense")).not.toBe(1);
  });
});

describe("circleHref", () => {
  it("builds the link a circle is reached by", () => {
    expect(circleHref(7)).toBe("/app?circle=7");
  });

  it("round-trips through the parser", () => {
    for (const id of [1, 2, 31, 4096]) {
      const href = circleHref(id);
      expect(parseCircleId(href.slice(href.indexOf("?")))).toBe(id);
    }
  });

  it("refuses to build a link to an impossible circle", () => {
    expect(() => circleHref(0)).toThrow();
    expect(() => circleHref(-3)).toThrow();
    expect(() => circleHref(2.5)).toThrow();
  });
});
