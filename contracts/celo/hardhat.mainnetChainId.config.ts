// hardhat.mainnetChainId.config.ts — dedicated profile for exercising
// IwaCircleCelo's constructor with the real EVM chain id (42220, Celo
// mainnet). Separate from hardhat.config.ts on purpose: the default in-
// process network is fixed at chain id 31337 for the rest of the suite
// (Hardhat's `hardhat_reset` cannot retarget an in-process network's chain
// id, and flipping the default network to 42220 would break every existing
// test that deploys with a non-canonical mock token). This profile changes
// no contract and no compiler setting — only which chain id the in-process
// EVM reports to `block.chainid`.
//
// Run with:
//   npx hardhat test test-mainnet-chainid/IwaCircleCelo.mainnetChainId.test.ts --config hardhat.mainnetChainId.config.ts
// or:
//   npm run test:mainnet-chainid

import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 800 },
    },
  },
  networks: {
    hardhat: { chainId: 42220 },
  },
  mocha: { timeout: 60000 },
};

export default config;
