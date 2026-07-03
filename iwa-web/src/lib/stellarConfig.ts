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
  "CBLSFOP3YFRYR6MVZFVDHD6F7UBJKIMXPJKZAR2IYLHTX4NJUS4JKM6U";

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
 * A token the circle-creation picker offers. Only enabled tokens can be
 * selected; disabled ones are placeholders (their SAC address and trustline
 * handling land later). Each carries its own decimals so amounts convert
 * correctly per token.
 */
export interface TokenOption {
  id: string; // Soroban SAC address; empty until the token is enabled
  symbol: string;
  decimals: number;
  enabled: boolean;
}

export const TOKEN_OPTIONS: TokenOption[] = [
  { id: NATIVE_XLM_TOKEN_ID, symbol: "XLM", decimals: 7, enabled: true },
  // Placeholders: set the testnet SAC address and flip enabled to true to
  // support these once trustline handling is in place.
  { id: "", symbol: "USDC", decimals: 7, enabled: false },
  { id: "", symbol: "USDT", decimals: 7, enabled: false },
];

/**
 * The circle the app reads by default. Circle ids are u32, assigned in creation
 * order per contract. On the trust-gated savings contract, circle 0 is the
 * open demo (trust_required: false, 5 XLM/round, size 3); circle 1 is the
 * trust-gated demo (trust_required: true, same terms) for testing the proof
 * gate. If the default circle does not exist yet, the read seam falls back to
 * an empty circle.
 */
export const DEMO_CIRCLE_ID = 0;

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
