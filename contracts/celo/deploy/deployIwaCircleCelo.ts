// deploy/deployIwaCircleCelo.ts — deploy IwaCircleCelo to Celo mainnet.
//
// Defaults to a dry run: every check below runs, the deployer address and
// constructor arguments are printed for review, and gas is estimated — but
// nothing is broadcast unless DEPLOY_CONFIRM=YES is set explicitly. This is
// the only way this script sends a transaction; there is no other flag or
// code path that broadcasts.
//
// Run (dry run, default):
//   npx hardhat run deploy/deployIwaCircleCelo.ts --network celo
//
// Run (actually broadcasts):
//   DEPLOY_CONFIRM=YES npx hardhat run deploy/deployIwaCircleCelo.ts --network celo
//
// Required environment variables (see hardhat.config.ts's `celo` network):
//   CELO_RPC_URL               — a Celo mainnet JSON-RPC endpoint
//   CELO_DEPLOYER_PRIVATE_KEY  — the deployer's private key (never committed;
//                                 read from the environment only)
//
// Optional:
//   CIRCLE_CONFIG_PATH  — path to the circle's real values (default:
//                          deploy/circle.local.json, gitignored). See
//                          deploy/circle.example.json for the shape.
//   CELOSCAN_API_KEY    — only needed for the separate verify step.

import { ethers } from "hardhat";
import {
  CELO_MAINNET_CHAIN_ID,
  loadCircleConfig,
  validateDeployConfig,
  type CircleDeployConfig,
} from "./circleConfig";
import { reportCircle } from "./reportCircle";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Missing required environment variable ${name}. This deploy script refuses to guess or ` +
        `default it — set it explicitly before running.`,
    );
  }
  return value;
}

export interface PreparedDeployment {
  config: CircleDeployConfig;
  deployerAddress: string;
  constructorArgs: [string, bigint, bigint, bigint, string[]];
  estimatedGas: bigint | null;
}

/**
 * Every check that must pass before a deployment transaction is ever built,
 * let alone sent. Throws (with every problem listed at once) rather than
 * proceeding with a partially-valid configuration.
 */
export async function prepareDeployment(): Promise<PreparedDeployment> {
  // Named, explicit checks so a missing variable says exactly which one —
  // never a generic "network not found" from Hardhat itself.
  requireEnv("CELO_RPC_URL");
  requireEnv("CELO_DEPLOYER_PRIVATE_KEY");

  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== CELO_MAINNET_CHAIN_ID) {
    throw new Error(
      `Refusing to deploy: connected chainId is ${network.chainId}, expected ${CELO_MAINNET_CHAIN_ID} ` +
        `(Celo mainnet). Run this script with --network celo.`,
    );
  }

  const configPath = process.env.CIRCLE_CONFIG_PATH ?? "deploy/circle.local.json";
  const config = loadCircleConfig(configPath);
  const errors = validateDeployConfig(config);
  if (errors.length > 0) {
    throw new Error(`Circle config at ${configPath} failed validation:\n- ${errors.join("\n- ")}`);
  }

  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) {
    throw new Error("No deployer signer available. Check CELO_DEPLOYER_PRIVATE_KEY.");
  }
  const deployerAddress = await deployer.getAddress();

  const constructorArgs: [string, bigint, bigint, bigint, string[]] = [
    config.token,
    BigInt(config.contributionAmount),
    BigInt(config.cadenceSeconds),
    BigInt(config.gracePeriodSeconds),
    config.members,
  ];

  let estimatedGas: bigint | null = null;
  try {
    const factory = await ethers.getContractFactory("IwaCircleCelo", deployer);
    const deployTx = await factory.getDeployTransaction(...constructorArgs);
    estimatedGas = await ethers.provider.estimateGas({ ...deployTx, from: deployerAddress });
  } catch (e) {
    // Estimation failing does not block the dry-run report — it is
    // informational. It is never used to decide whether to broadcast.
    console.warn(`Gas estimate unavailable: ${(e as Error).message}`);
  }

  return { config, deployerAddress, constructorArgs, estimatedGas };
}

function printPreparedDeployment(prepared: PreparedDeployment): void {
  const [token, contributionAmount, cadenceSeconds, gracePeriodSeconds, members] =
    prepared.constructorArgs;
  console.log("=== IwaCircleCelo deployment (Celo mainnet, chainId 42220) ===");
  console.log(`Deployer / organizer-to-be: ${prepared.deployerAddress}`);
  console.log("Constructor arguments:");
  console.log(`  token_               = ${token}`);
  console.log(`  contributionAmount_  = ${contributionAmount.toString()}`);
  console.log(`  cadenceSeconds_      = ${cadenceSeconds.toString()}`);
  console.log(`  gracePeriodSeconds_  = ${gracePeriodSeconds.toString()}`);
  console.log(`  members_ (${members.length}) =`);
  members.forEach((m, i) => console.log(`    [${i}] ${m}`));
  console.log(
    prepared.estimatedGas !== null
      ? `Estimated gas: ${prepared.estimatedGas.toString()}`
      : "Estimated gas: unavailable (see warning above)",
  );
}

async function main(): Promise<void> {
  const prepared = await prepareDeployment();
  printPreparedDeployment(prepared);

  if (process.env.DEPLOY_CONFIRM !== "YES") {
    console.log("");
    console.log("DRY RUN — nothing was broadcast. Set DEPLOY_CONFIRM=YES to actually deploy.");
    return;
  }

  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("IwaCircleCelo", deployer);
  const circle = await factory.deploy(...prepared.constructorArgs);
  const deployTx = circle.deploymentTransaction();
  await circle.waitForDeployment();
  const address = await circle.getAddress();
  console.log("=== Deployed ===");
  console.log(`Deployment tx hash: ${deployTx?.hash ?? "(unknown)"}`);
  await reportCircle(address);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
