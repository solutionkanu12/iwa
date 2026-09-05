// Route wiring for Iwa Prize Savings.

import { describe, expect, it } from "vitest";

import { hrefFor, isAppRoute, resolve } from "./router";

describe("prize-savings route", () => {
  it("resolves /app/prize-savings", () => {
    const resolved = resolve("/app/prize-savings", "");
    expect(resolved.route).toEqual({ name: "prizeSavings" });
    expect(resolved.redirectTo).toBeNull();
  });

  it("rejects a longer path under prize-savings", () => {
    const resolved = resolve("/app/prize-savings/x", "");
    expect(resolved.route.name).toBe("notFound");
  });

  it("renders the right href", () => {
    expect(hrefFor({ name: "prizeSavings" })).toBe("/app/prize-savings");
  });

  it("lives inside the app shell", () => {
    expect(isAppRoute({ name: "prizeSavings" })).toBe(true);
  });
});
