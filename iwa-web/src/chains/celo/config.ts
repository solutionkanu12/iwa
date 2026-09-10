// chains/celo/config.ts — Celo adapter configuration.
//
// Celo is another chain adapter for the same IWA product. Chain ids and
// the registered attribution tag live here, not in IWA Core.

/** Registered Celo Builders attribution tag for this repository. */
export const IWA_CELO_ATTRIBUTION_TAG = "celo_448874a99d90" as const;

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
