// chains/celo/config.ts — Celo adapter configuration.
//
// Celo is another chain adapter for the same IWA product. Chain ids and
// the registered attribution tag live here, not in IWA Core.

/** Registered Celo Builders attribution tag for this repository. */
export const IWA_CELO_ATTRIBUTION_TAG = "celo_448874a99d90" as const;

/**
 * Canonical cNGN on Celo Mainnet (Africa Stablecoin Consortium).
 *
 * Verified 2026-09-10 against:
 * - Celo docs Token/Stablecoin contracts (issuer: Africa Stablecoin Consortium / cngn.co)
 * - Issuer deployments table: wrappedcbdc/stablecoin-cngn README (network CELO)
 * - Live `eth_call` on https://forno.celo.org: decimals=6, symbol=cNGN, name=cNGN
 *
 * Not Mento NGNm (`0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71`).
 */
export const CNGN_MAINNET = {
  address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
  decimals: 6,
  symbol: "cNGN",
  name: "cNGN",
  chainId: 42220,
} as const;

export const CELO_MAINNET = {
  chainId: "0xa4ec",
  chainIdNumber: 42220,
  name: "Celo",
  rpcUrl: "https://forno.celo.org",
  explorerUrl: "https://celoscan.io",
};

export const CELO_SEPOLIA = {
  chainId: "0xaa044c",
  chainIdNumber: 11142220,
  name: "Celo Sepolia",
  rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
  explorerUrl: "https://sepolia.celoscan.io",
};
