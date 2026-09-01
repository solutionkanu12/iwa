import { describe, expect, it } from "vitest";

import { parseCircleId } from "./appRoute";

// Links in the first phase's query shape are still in the wild. The router
// reads them and replaces them with the real route, so they must keep parsing
// exactly as strictly as they did.
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

