// chains/ethereum/config.ts — Ethereum Sepolia configuration for Iwa Prize
// Savings.
//
// The contract addresses match the official Sepolia deployment recorded in
// ../zama-prize-savings/deployments/sepolia.json. Zama protocol addresses are
// the pinned ones from @fhevm/solidity 0.11.1's Sepolia config and the
// @zama-fhe/relayer-sdk 0.4.1 constants.
//
// Sepolia is a testnet: MockUSD has an open mint and holds no value. This
// feature is the Iwa Prize Savings product surface, not a mainnet financial
// service.

export const SEPOLIA_CHAIN_ID = "0xaa36a7"; // 11155111

export const SEPOLIA_CHAIN = {
  chainId: SEPOLIA_CHAIN_ID,
  chainIdNumber: 11155111,
  name: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorerUrl: "https://sepolia.etherscan.io",
};

/** Iwa Prize Savings contracts, deployed 2026-09-05 (see deployments/sepolia.json). */
export const IWA_PRIZE_SAVINGS = {
  MockUSD: "0x0041A7b8Bb29cA5D6b1Cb6eFBcaBAc8519075392",
  CMockUSD: "0xB87CE72B9083488977372507efD4127e157510c2",
  IwaPrizeSavings: "0x2d1b97F7e1E4845260aBd23017686fBa38006037",
};

/** Zama fhEVM Sepolia protocol addresses (pinned toolchain). */
export const ZAMA_SEPOLIA = {
  relayerUrl: "https://relayer.testnet.zama.org",
  gatewayChainId: 10901,
  ACLAddress: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
  KMSVerifierAddress: "0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A",
  InputVerifierAddress: "0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0",
};