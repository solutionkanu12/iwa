// Navigation wiring for Iwa Prize Savings.

import { describe, expect, it } from "vitest";

import { ACCOUNT_NAV, PRIMARY_NAV, screenFor, isActive } from "./navigation";

describe("prize-savings navigation", () => {
  it("appears in the sidebar destinations", () => {
    const entry = PRIMARY_NAV.find((e) => e.route.name === "prizeSavings");
    expect(entry).toBeDefined();
    expect(entry!.label).toBe("Prize savings");
  });

  it("is reachable from the account control, like Standing", () => {
    expect(ACCOUNT_NAV.some((e) => e.route.name === "prizeSavings")).toBe(true);
  });

  it("is not squeezed onto the phone bar (five tabs would crowd a 320px row)", () => {
    expect(PRIMARY_NAV.find((e) => e.route.name === "prizeSavings")!.onMobile).toBe(false);
  });

  it("lights up when its route is open", () => {
    const entry = PRIMARY_NAV.find((e) => e.route.name === "prizeSavings")!;
    expect(isActive(entry, { name: "prizeSavings" })).toBe(true);
  });

  it("maps to its own screen", () => {
    expect(screenFor({ name: "prizeSavings" })).toBe("prizeSavings");
  });
});
