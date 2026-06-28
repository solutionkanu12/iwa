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
  "CCP7O24JQ6FUJP5BC6P22M35YXK2B3Q7IRL4VHQBBCB5VNC55L32GYNQ";

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
