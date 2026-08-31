// Pins the frontend's production Starknet addresses to the settlement
// tooling's config. The demo scripts and the UI must never disagree about
// which contracts IWA is: a mismatch would show users one deployment while
// settling against another.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { STARKNET_MAINNET, sameAddress, voyagerTxUrl } from "./starknetProduction";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_CONFIG = resolve(HERE, "../../../scripts/demo/demo.config.json");

interface DemoConfig {
  network: string;
  iwa_circle: string;
  iwa_circle_class: string;
  iwa_helper: string;
  iwa_helper_class: string;
  privacy_pool: string;
  privacy_pool_class: string;
  usdc_token: string;
  strk_token: string;
  surplus_sink: string;
}

const demo = JSON.parse(readFileSync(DEMO_CONFIG, "utf8")) as DemoConfig;

describe("STARKNET_MAINNET", () => {
  it("targets mainnet", () => {
    expect(STARKNET_MAINNET.network).toBe("mainnet");
    expect(demo.network).toBe("mainnet");
  });

  it.each([
    ["iwaCircle", "iwa_circle"],
    ["iwaCircleClass", "iwa_circle_class"],
    ["iwaHelper", "iwa_helper"],
    ["iwaHelperClass", "iwa_helper_class"],
    ["privacyPool", "privacy_pool"],
    ["privacyPoolClass", "privacy_pool_class"],
    ["usdcToken", "usdc_token"],
    ["strkToken", "strk_token"],
    ["surplusSink", "surplus_sink"],
  ] as const)("%s matches the demo tooling config", (uiKey, cfgKey) => {
    expect(sameAddress(STARKNET_MAINNET[uiKey], demo[cfgKey])).toBe(true);
  });

  it("uses native USDC with six decimals, not the bridged token", () => {
    expect(STARKNET_MAINNET.usdcDecimals).toBe(6);
    // Bridged USDC.e — a different contract IWA must never use.
    expect(
      sameAddress(
        STARKNET_MAINNET.usdcToken,
        "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
      ),
    ).toBe(false);
  });

  it("keeps the surplus sink distinct from every contract it could collide with", () => {
    const { surplusSink, privacyPool, usdcToken, strkToken, iwaCircle, iwaHelper } =
      STARKNET_MAINNET;
    for (const other of [privacyPool, usdcToken, strkToken, iwaCircle, iwaHelper]) {
      expect(sameAddress(surplusSink, other)).toBe(false);
    }
  });
});

describe("sameAddress", () => {
  it("compares felts, not padded strings", () => {
    expect(sameAddress("0x0abc", "0xabc")).toBe(true);
    expect(sameAddress("0xabc", "0xabd")).toBe(false);
  });

  it("rejects non-felt input instead of throwing", () => {
    expect(sameAddress("not-an-address", "0x1")).toBe(false);
  });
});

describe("voyagerTxUrl", () => {
  it("builds a mainnet explorer link", () => {
    expect(voyagerTxUrl("0xdead")).toBe("https://voyager.online/tx/0xdead");
  });
});
