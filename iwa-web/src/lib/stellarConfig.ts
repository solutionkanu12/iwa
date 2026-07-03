// Stellar testnet configuration for the deployed Iwa contracts.
//
// These match the Stellar CLI `testnet` network alias the contracts were
// deployed against (confirmed via `stellar network ls`): the deploy scripts use
// `--network testnet`, which resolves to the RPC and passphrase below.
//
// Everything that talks to Soroban or the wallet imports from here. Do not
// hardcode these values anywhere else.

/** Soroban RPC endpoint (Stellar testnet). */
export const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

/** Network passphrase for Stellar testnet. */
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Savings + reputation contract (Rust / Soroban), deployed on testnet. */
export const SAVINGS_CONTRACT_ID =
  "CDTHKKLZZ7PYDKZ3GVEVGPLP4F5UTWKTDJQ3SMCE4EZ74JONFFTXMSOM";

/**
 * The token (Soroban SAC) the demo circle moves for contributions and payouts.
 * This is native XLM on testnet. The savings contract stores the token per
 * circle, so the write flows (pay_contribution, collect_pot) will pass this
 * when they go real.
 */
export const NATIVE_XLM_TOKEN_ID =
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/**
 * Known token (SAC) address to asset symbol. Add stablecoin SACs here as they
 * are supported; an unknown address never resolves to a guessed symbol.
 */
export const TOKEN_SYMBOLS: Record<string, string> = {
  [NATIVE_XLM_TOKEN_ID]: "XLM",
  // e.g. [USDC_TOKEN_ID]: "USDC", [USDT_TOKEN_ID]: "USDT",
};

/**
 * Resolve a token address to its display symbol. Falls back to a short
 * truncated address (or "token" when unset) rather than guessing, so the UI
 * never mislabels an unknown asset. Never defaults to a stablecoin.
 */
export function tokenSymbol(address: string): string {
  const known = TOKEN_SYMBOLS[address];
  if (known) return known;
  if (!address) return "token";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Known token (SAC) address to its decimals. Native XLM is 7; stablecoins may
 * differ, so add them here. Unknown tokens default to 7 (the Stellar default).
 */
export const TOKEN_DECIMALS: Record<string, number> = {
  [NATIVE_XLM_TOKEN_ID]: 7,
};

/** Resolve a token address to its decimals, defaulting to 7. */
export function tokenDecimals(address: string): number {
  return TOKEN_DECIMALS[address] ?? 7;
}

/**
 * The circle the app reads by default. Circle ids are u32, assigned in creation
 * order. Circle 1 is the correctly denominated demo (amount in base units:
 * 500000000 stroops = 50 XLM); circle 0 was an early circle with amount in
 * stroops that read as a negligible 0.000005 XLM. If it does not exist yet the
 * read seam falls back to an empty circle.
 */
export const DEMO_CIRCLE_ID = 1;

/** Groth16 BN254 verifier contract, deployed on testnet. */
export const VERIFIER_CONTRACT_ID =
  "CBEUUHRLMSBAOX2NTNZFKKP2FBN3XMNTY6JCIOGBKYHMC5AEQTI3ZKDS";

/**
 * Runtime locations of the prover artifacts copied into `public/zk`. They are
 * served at these absolute paths and fetched in the browser when proving.
 */
export const ZK_ARTIFACTS = {
  circuitWasm: "/zk/reputation.wasm",
  provingKey: "/zk/rep_final.zkey",
  verificationKey: "/zk/verification_key.json",
} as const;
