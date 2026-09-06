// Navigation wiring for Iwa Prize Savings.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ACCOUNT_NAV, MOBILE_NAV, PRIMARY_NAV, screenFor, isActive } from "./navigation";
import { hrefFor, resolve } from "../lib/router";

describe("prize-savings navigation", () => {
  it("appears as a first-class item in the desktop sidebar destinations", () => {
    const entry = PRIMARY_NAV.find((e) => e.route.name === "prizeSavings");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Prize Savings");
    expect(hrefFor(entry!.route)).toBe("/app/prize-savings");
  });

  it("is reachable from the account control, like Standing", () => {
    const entry = ACCOUNT_NAV.find((e) => e.route.name === "prizeSavings");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Prize Savings");
    expect(hrefFor(entry!.route)).toBe("/app/prize-savings");
  });

  it("is not squeezed onto the phone bar (five tabs would crowd a 320px row)", () => {
    expect(PRIMARY_NAV.find((e) => e.route.name === "prizeSavings")!.onMobile).toBe(false);
    expect(MOBILE_NAV.some((e) => e.route.name === "prizeSavings")).toBe(false);
    expect(MOBILE_NAV).toHaveLength(4);
  });

  it("lights up when its route is open", () => {
    const entry = PRIMARY_NAV.find((e) => e.route.name === "prizeSavings")!;
    expect(isActive(entry, { name: "prizeSavings" })).toBe(true);
  });

  it("maps to its own screen", () => {
    expect(screenFor({ name: "prizeSavings" })).toBe("prizeSavings");
  });

  it("resolves the internal feature route /app/prize-savings cleanly", () => {
    expect(resolve("/app/prize-savings", "")).toEqual({
      route: { name: "prizeSavings" },
      redirectTo: null,
    });
  });

  it("preserves root / and /app routes", () => {
    expect(resolve("/", "")).toEqual({
      route: { name: "landing" },
      redirectTo: null,
    });
    expect(resolve("/app", "")).toEqual({
      route: { name: "home" },
      redirectTo: null,
    });
  });

  it("provides a discoverable entry point in HomeView", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../screens/HomeView.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('navigate({ name: "prizeSavings" })');
    expect(source).toContain("Prize Savings");
  });
});
