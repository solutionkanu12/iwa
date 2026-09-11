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
    hardhat: { chainId: 31337 },
  },
  mocha: { timeout: 60000 },
};

export default config;
