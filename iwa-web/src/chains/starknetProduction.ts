// chains/starknetProduction.ts — the verified Starknet mainnet deployment.
//
// One place, for the whole frontend, where IWA's production addresses live.
// Every value here was verified read-only against SN_MAIN and is asserted by
// the demo tooling's preflight (scripts/demo/lib/preflight.mjs), which checks
// the class hash actually running at each address rather than trusting the
// address alone.
//
// starknetProduction.test.ts pins these against scripts/demo/demo.config.json,
// so the frontend and the settlement tooling cannot drift apart silently.
//
// This module is data only. It deliberately does not construct a provider,
// hold a key, or implement ChainAdapter: the Starknet adapter is a separate
// piece of work, and a stale address in a shipped UI is a correctness bug
// whether or not that adapter exists yet.

export interface StarknetDeployment {
  readonly network: "mainnet";
  readonly chainId: string;
  /** IWA Core. Chain-neutral accounting; holds no tokens. */
  readonly iwaCircle: string;
  readonly iwaCircleClass: string;
  /** The immutable STRK20 settlement helper. Wired once, permanently. */
  readonly iwaHelper: string;
  readonly iwaHelperClass: string;
  /** StarkWare's STRK20 privacy pool. IWA integrates with it and never deploys it. */
  readonly privacyPool: string;
  readonly privacyPoolClass: string;
  /** Circle native USDC (6 decimals) — NOT bridged USDC.e. */
  readonly usdcToken: string;
  readonly usdcDecimals: 6;
  /** STRK (18 decimals). Also the token the pool collects its fee in. */
  readonly strkToken: string;
  readonly strkDecimals: 18;
  /** Immutable surplus sink pinned in the helper constructor. */
  readonly surplusSink: string;
}

export const STARKNET_MAINNET: StarknetDeployment = {
  network: "mainnet",
  chainId: "0x534e5f4d41494e",

  iwaCircle: "0x01f81497b09aa702a38715c0ec149d7672cd557c0caea480714d4802ff6f81be",
  iwaCircleClass: "0x1848a8ffbf0465f3afa44e5db06f52ab2b6e8051e2e2367dd8539e5b7211d1e",

  iwaHelper: "0x04cac02dcc7ca8c46c0b6f32985f17bf24d99557222e60c6881d147e13fafbbb",
  iwaHelperClass: "0x56f037212521b23d072628bcccac937e8e5773dd99a0dab6859a7d0a55641cd",

  privacyPool: "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a",
  privacyPoolClass: "0x67dddd89d80fedadc06b6f160798f94800a4a70164e5a24301cd0d6076b554d",

  usdcToken: "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb",
  usdcDecimals: 6,

  strkToken: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  strkDecimals: 18,

  surplusSink: "0x043d08F5B0D621eF22f91B954e719d7C0a5a8c6ed89308bA05f36FAe42F2d804",
};

/**
 * Starknet addresses are felts, so `0x0abc` and `0xabc` are the same value.
 * Never compare the padded strings directly.
 */
export function sameAddress(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

/** Explorer link for a transaction, for the demo write-up and the UI. */
export function voyagerTxUrl(txHash: string): string {
  return `https://voyager.online/tx/${txHash}`;
}

/** Explorer link for a contract. */
export function voyagerContractUrl(address: string): string {
  return `https://voyager.online/contract/${address}`;
}

/**
 * What STRK20 does and does not hide, stated plainly for any UI that shows a
 * private transfer. The integration research requires IWA to document these
 * honestly rather than claim blanket privacy.
 */
export const STRK20_PUBLIC_SURFACE: readonly string[] = [
  "Shielding a deposit into the pool is a public edge.",
  "Withdrawing from the pool is a public edge.",
  "The helper contract invocation and its state changes are visible.",
  "An open note's token and filled amount are public; its owner is not.",
  "Transaction timing can enable correlation.",
];
