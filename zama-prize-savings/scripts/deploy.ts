import { ethers, run } from "hardhat";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * P7 Part B - official Sepolia deployment of the Iwa Prize Savings contracts.
 *
 * Deploys: MockUSD, CMockUSD (ERC-7984 wrapper), IwaPrizeSavings.
 * Records everything (no secrets) in deployments/sepolia.json.
 *
 * Usage: npx hardhat run scripts/deploy.ts --network sepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`Deploying Iwa Prize Savings to chain ${chainId} from ${deployerAddress}`);

  const mock = await (await ethers.getContractFactory("MockUSD")).deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log(`MockUSD: ${mockAddr}`);

  const wrapper = await (await ethers.getContractFactory("CMockUSD")).deploy(mockAddr);
  await wrapper.waitForDeployment();
  const wrapperAddr = await wrapper.getAddress();
  console.log(`CMockUSD (ERC-7984 wrapper): ${wrapperAddr}`);

  const pool = await (await ethers.getContractFactory("IwaPrizeSavings")).deploy(wrapperAddr);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log(`IwaPrizeSavings: ${poolAddr}`);

  const record = {
    chainId: Number(chainId),
    deployer: deployerAddress,
    contracts: {
      MockUSD: {
        address: mockAddr,
        deployTx: mock.deploymentTransaction()?.hash,
        constructorParams: [],
      },
      CMockUSD: {
        address: wrapperAddr,
        deployTx: wrapper.deploymentTransaction()?.hash,
        constructorParams: [mockAddr],
        description: "ERC7984ERC20Wrapper over MockUSD (rate 1, 6 decimals)",
      },
      IwaPrizeSavings: {
        address: poolAddr,
        deployTx: pool.deploymentTransaction()?.hash,
        constructorParams: [wrapperAddr],
        constants: {
          MAX_PARTICIPANTS: Number(await pool.MAX_PARTICIPANTS()),
          MAX_POOL_TOTAL: Number(await pool.MAX_POOL_TOTAL()),
          DRAW_TIMEOUT: Number(await pool.DRAW_TIMEOUT()),
        },
      },
    },
    toolchain: {
      "@fhevm/solidity": "0.11.1",
      "@fhevm/hardhat-plugin": "0.4.2",
      "@fhevm/mock-utils": "0.4.2",
      "@zama-fhe/relayer-sdk": "0.4.1",
      "@openzeppelin/confidential-contracts": "0.5.3",
      "@openzeppelin/contracts": "5.6.1",
      "solc": "0.8.27",
      "evmVersion": "cancun",
    },
    acceptedRisk: {
      F1: "zero-transfer participant-slot DoS - ACCEPTED FOR SEPOLIA BOUNTY MVP ONLY; blocks any production/mainnet deployment",
    },
    deployedAt: new Date().toISOString(),
  };

  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  const out = join(__dirname, "..", "deployments", "sepolia.json");
  writeFileSync(out, JSON.stringify(record, null, 2));
  console.log(`Recorded to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});