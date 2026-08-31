import { describe, expect, it } from "vitest";

import {
  REQUIRED_CHAIN_ID,
  REQUIRED_WALLET_API_VERSION,
  UNSUPPORTED_MESSAGES,
  compareVersions,
  supportsStrk20,
} from "./walletConnect";

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    // "0.10.3" < "0.9.9" as strings; the whole point is that it is not.
    expect(compareVersions("0.10.3", "0.9.9")).toBe(1);
    expect(compareVersions("0.10.3", "0.10.3")).toBe(0);
    expect(compareVersions("0.10.2", "0.10.3")).toBe(-1);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("1.1", "1.0.9")).toBe(1);
  });
});

describe("supportsStrk20", () => {
  it("accepts a wallet advertising the required version", () => {
    expect(supportsStrk20([REQUIRED_WALLET_API_VERSION])).toBe(true);
    expect(supportsStrk20(["0.8.0", "0.11.0"])).toBe(true);
  });

  it("rejects a wallet below it, and one that answered nothing", () => {
    expect(supportsStrk20(["0.9.9"])).toBe(false);
    expect(supportsStrk20([])).toBe(false);
  });
});

describe("network guard", () => {
  it("pins mainnet", () => {
    expect(REQUIRED_CHAIN_ID).toBe("0x534e5f4d41494e");
  });

  it("names Ready in the unsupported-wallet copy so the user knows what to install", () => {
    expect(UNSUPPORTED_MESSAGES.NO_STRK20_SUPPORT).toMatch(/Ready/);
    expect(UNSUPPORTED_MESSAGES.WRONG_NETWORK).toMatch(/mainnet/);
  });
});
