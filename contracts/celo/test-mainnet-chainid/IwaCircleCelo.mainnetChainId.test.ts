// test-mainnet-chainid/IwaCircleCelo.mainnetChainId.test.ts — real chain-id
// coverage for the mainnet token-pinning branch in IwaCircleCelo's
// constructor. Deliberately kept OUTSIDE test/ so the default
// `npx hardhat test` (chain id 31337) never picks this file up: it must
// only run under hardhat.mainnetChainId.config.ts, where block.chainid is
// genuinely 42220. This proves the branch by actually deploying under that
// chain id, not by asserting on the contract's source text.

import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const AMOUNT = 5_000_000n;
const CADENCE = 100n;
const GRACE = 50n;
const CNGN_MAINNET = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
const OTHER_TOKEN = "0x000000000000000000000000000000000000dEaD";

describe("IwaCircleCelo constructor on Celo mainnet chain id (42220)", function () {
  let a: HardhatEthersSigner;
  let b: HardhatEthersSigner;

  before(async function () {
    const network = await ethers.provider.getNetwork();
    expect(network.chainId).to.equal(
      42220n,
      "this suite must run under hardhat.mainnetChainId.config.ts",
    );
  });

  beforeEach(async function () {
    [a, b] = await ethers.getSigners();
  });

  it("accepts the canonical cNGN address on mainnet chain id", async function () {
    const factory = await ethers.getContractFactory("IwaCircleCelo");
    const circle = await factory.deploy(CNGN_MAINNET, AMOUNT, CADENCE, GRACE, [
      a.address,
      b.address,
    ]);
    await circle.waitForDeployment();
    expect(await circle.token()).to.equal(CNGN_MAINNET);
  });

  it("rejects any non-canonical token address on mainnet chain id", async function () {
    const factory = await ethers.getContractFactory("IwaCircleCelo");
    await expect(
      factory.deploy(OTHER_TOKEN, AMOUNT, CADENCE, GRACE, [a.address, b.address]),
    ).to.be.revertedWithCustomError(factory, "UnsupportedToken");
  });

  it("rejects the zero-address token on mainnet chain id (fails closed as UnsupportedToken, checked before InvalidConfig)", async function () {
    const factory = await ethers.getContractFactory("IwaCircleCelo");
    await expect(
      factory.deploy(ethers.ZeroAddress, AMOUNT, CADENCE, GRACE, [a.address, b.address]),
    ).to.be.revertedWithCustomError(factory, "UnsupportedToken");
  });

  it("still enforces normal constructor invariants on the canonical token under mainnet chain id", async function () {
    const factory = await ethers.getContractFactory("IwaCircleCelo");
    await expect(
      factory.deploy(CNGN_MAINNET, 0, CADENCE, GRACE, [a.address, b.address]),
    ).to.be.revertedWithCustomError(factory, "InvalidConfig");
    await expect(
      factory.deploy(CNGN_MAINNET, AMOUNT, CADENCE, GRACE, [a.address, a.address]),
    ).to.be.revertedWithCustomError(factory, "InvalidConfig");
    await expect(
      factory.deploy(CNGN_MAINNET, AMOUNT, CADENCE, GRACE, [a.address]),
    ).to.be.revertedWithCustomError(factory, "InvalidConfig");

    const circle = await factory.deploy(CNGN_MAINNET, AMOUNT, CADENCE, GRACE, [
      a.address,
      b.address,
    ]);
    await circle.waitForDeployment();
    expect(await circle.memberCount()).to.equal(2);
    expect(await circle.currentRound()).to.equal(1);
    expect(await circle.contributionAmount()).to.equal(AMOUNT);
    expect(await circle.CELO_MAINNET_CHAIN_ID()).to.equal(42220);
  });
});
