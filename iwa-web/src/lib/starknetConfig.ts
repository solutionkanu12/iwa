// lib/starknetConfig.ts — production Starknet configuration for the app.
//
// Replaces stellarConfig.ts as the UI's source of network truth. Addresses are
// re-exported from chains/starknetProduction.ts so there is exactly one place
// they are defined, and that module's test pins them to the settlement
// tooling's config.

import { STARKNET_MAINNET } from "../chains/starknetProduction";

export const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";

export const CHAIN_ID = STARKNET_MAINNET.chainId;
export const IWA_CIRCLE = STARKNET_MAINNET.iwaCircle;
export const IWA_HELPER = STARKNET_MAINNET.iwaHelper;
export const PRIVACY_POOL = STARKNET_MAINNET.privacyPool;
export const USDC_TOKEN = STARKNET_MAINNET.usdcToken;
export const STRK_TOKEN = STARKNET_MAINNET.strkToken;

/** Native USDC has six decimals. Nothing here may assume eighteen. */
export const USDC_DECIMALS = 6;
export const STRK_DECIMALS = 18;

/** The only asset the app offers today. */
export const TOKEN_SYMBOL = "USDC";

export function tokenSymbol(token?: string): string {
  if (token === undefined) return TOKEN_SYMBOL;
  try {
    return BigInt(token) === BigInt(STRK_TOKEN) ? "STRK" : TOKEN_SYMBOL;
  } catch {
    return TOKEN_SYMBOL;
  }
}

export function tokenDecimals(token?: string): number {
  return tokenSymbol(token) === "STRK" ? STRK_DECIMALS : USDC_DECIMALS;
}

/**
 * The circle a first-time visitor lands on. Circle 1 is the live mainnet
 * circle; users never type or see an id, they just land here or follow a join
 * link.
 */
export const DEMO_CIRCLE_ID = 1;

/** Contract rule from create_circle: a circle needs at least two members. */
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 32;

/**
 * Assets a circle can be denominated in. Shape matches what the create form
 * already renders. STRK is listed but disabled: the deployed helper supports
 * it, but the app offers only USDC circles today.
 */
export interface TokenOption {
  id: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
}

export const TOKEN_OPTIONS: TokenOption[] = [
  { id: USDC_TOKEN, symbol: "USDC", decimals: USDC_DECIMALS, enabled: true },
  { id: STRK_TOKEN, symbol: "STRK", decimals: STRK_DECIMALS, enabled: false },
];
