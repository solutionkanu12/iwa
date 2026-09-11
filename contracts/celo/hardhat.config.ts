import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// The `celo` network reads its RPC URL and deployer key from the
// environment, never from a tracked file. Both are optional here on
// purpose: `hardhat compile`/`hardhat test` must keep working with neither
// set. The deploy script (deploy/deployIwaCircleCelo.ts) does its own
// explicit, named check for each variable before it does anything
// network-related, so a missing var fails with a clear message there
// rather than a generic "network not found" from Hardhat itself.
const CELO_RPC_URL = process.env.CELO_RPC_URL ?? "";
const CELO_DEPLOYER_PRIVATE_KEY = process.env.CELO_DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      // Matches contracts/celo/foundry.toml's explicit pin: Celo's EVM
      // compatibility historically lagged past Paris (no PUSH0), so the
      // deployed bytecode must not silently target a newer EVM version than
      // the production chain supports. Made explicit here rather than
      // relying on solc 0.8.27's current default, which is not guaranteed
      // to stay "paris" across a future compiler/Hardhat upgrade.
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    celo: {
      url: CELO_RPC_URL,
      chainId: 42220,
      accounts: CELO_DEPLOYER_PRIVATE_KEY ? [CELO_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Celoscan is Etherscan-compatible; it is not one of hardhat-verify's
    // natively-known chains, so it must be listed explicitly. Reads the API
    // key from the environment, defaulting to empty so nothing crashes
    // (and no secret sits in this tracked file) until verification is
    // actually run.
    apiKey: {
      celo: process.env.CELOSCAN_API_KEY ?? "",
    },
    customChains: [
      {
        network: "celo",
        chainId: 42220,
        urls: {
          apiURL: "https://api.celoscan.io/api",
          browserURL: "https://celoscan.io",
        },
      },
    ],
  },
  mocha: { timeout: 60000 },
};

export default config;
