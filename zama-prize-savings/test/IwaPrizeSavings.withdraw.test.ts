import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P1 withdrawal-side tests for IwaPrizeSavings (approved spec section 10 and
 * correction C5).
 *
 * - withdraw(requested): encrypted amount, FHE.min-clamped to the credited
 *   balance (approved design - a valid <= balance encrypted transfer, so no
 *   plaintext branch and no negative accounting), debits only the ACTUAL
 *   returned transfer.
 * - withdrawAll(): liveness hatch with NO encrypted input and NO input proof.
 * - Withdrawal is available in every round state (Open/Locked/Drawn/Claimable).
 * - ACL re-granted on every write, proven by withdrawing across separate
 *   transactions (C3).
 */
describe("P1 - IwaPrizeSavings withdraw", function () {
  let deployer: Signer;
  let walletA: Signer;
  let walletB: Signer;
  let addrA: string;
  let addrB: string;

  let mock: any;
  let wrapper: any;
  let pool: any;
  let mockAddr: string;
  let wrapperAddr: string;
  let poolAddr: string;

  beforeEach(async function () {
    [deployer, walletA, walletB] = await ethers.getSigners();
    addrA = await walletA.getAddress();
    addrB = await walletB.getAddress();

    mock = await (await ethers.getContractFactory("MockUSD")).deploy();
    await mock.waitForDeployment();
    mockAddr = await mock.getAddress();

    wrapper = await (await ethers.getContractFactory("CMockUSD")).deploy(mockAddr);
    await wrapper.waitForDeployment();
    wrapperAddr = await wrapper.getAddress();

    pool = await (await ethers.getContractFactory("IwaPrizeSavings")).deploy(wrapperAddr);
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();
  });

  async function mintAndWrapAs(signer: Signer, addr: string, amount: bigint) {
    await (await mock.connect(signer).mint(addr, amount)).wait();
    await (await mock.connect(signer).approve(wrapperAddr, amount)).wait();
    return (await wrapper.connect(signer).wrap(addr, amount)).wait();
  }

  async function setOperatorAs(signer: Signer) {
    return (
      await wrapper.connect(signer).setOperator(poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600)
    ).wait();
  }

  async function depositAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await pool.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function withdrawAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await pool.connect(signer).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function decryptUserCredited(addr: string, signer: Signer): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, signer);
  }

  async function decryptUserTokenBalance(addr: string, signer: Signer): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, wrapperAddr, signer);
  }

  async function decryptPoolTokenBalance(): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(poolAddr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptTotal(): Promise<bigint> {
    const handle = await pool.confidentialTotal();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  it("A: withdraw requested amount (40 of 100) - user receives 40, accounting drops by 40", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await depositAs(walletA, addrA, 100n);

    await withdrawAs(walletA, addrA, 40n);

    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(40n);
    expect(await decryptUserCredited(addrA, walletA)).to.equal(60n);
    expect(await decryptTotal()).to.equal(60n);
    expect(await decryptPoolTokenBalance()).to.equal(60n);
  });

  it("B: over-withdraw (200 requested, 100 credited) clamps via FHE.min - sends exactly 100, never negative", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await depositAs(walletA, addrA, 100n);

    await withdrawAs(walletA, addrA, 200n);

    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(100n);
    expect(await decryptUserCredited(addrA, walletA)).to.equal(0n);
    expect(await decryptTotal()).to.equal(0n);
    expect(await decryptPoolTokenBalance()).to.equal(0n);
  });

  it("C: withdrawAll exits fully - no encrypted input, no input proof", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await depositAs(walletA, addrA, 100n);

    await (await pool.connect(walletA).withdrawAll()).wait();

    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(100n);
    expect(await decryptUserCredited(addrA, walletA)).to.equal(0n);
    expect(await decryptTotal()).to.equal(0n);
    expect(await decryptPoolTokenBalance()).to.equal(0n);
  });

  it("D: withdrawAll after multiple deposits in separate transactions proves ACL persistence", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await depositAs(walletA, addrA, 40n);
    await depositAs(walletA, addrA, 20n);
    await depositAs(walletA, addrA, 40n);

    // Separate transaction, reusing the stored encrypted balance written by
    // the third deposit. Only succeeds if allowThis persisted (C3).
    await (await pool.connect(walletA).withdrawAll()).wait();

    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(100n);
    expect(await decryptUserCredited(addrA, walletA)).to.equal(0n);
    expect(await decryptTotal()).to.equal(0n);
  });

  it("E: withdraw remains available after the round is Locked", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await depositAs(walletA, addrA, 100n);

    await pool.connect(deployer).lockRound();

    await withdrawAs(walletA, addrA, 40n);
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(40n);
    expect(await decryptUserCredited(addrA, walletA)).to.equal(60n);

    // withdrawAll also works in Locked.
    await (await pool.connect(walletA).withdrawAll()).wait();
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(100n);
    expect(await decryptUserCredited(addrA, walletA)).to.equal(0n);
  });

  it("F: a wallet cannot withdraw another wallet's balance - B's attempts touch nothing", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await depositAs(walletA, addrA, 100n);

    // B never deposited: withdrawAll must be a harmless no-op (liveness hatch
    // does not revert), and withdraw must not move A's balance.
    await (await pool.connect(walletB).withdrawAll()).wait();
    expect(await decryptUserCredited(addrB, walletB)).to.equal(0n);

    await withdrawAs(walletB, addrB, 50n);
    expect(await decryptUserCredited(addrB, walletB)).to.equal(0n);

    // A's accounting is untouched by B's attempts.
    expect(await decryptUserCredited(addrA, walletA)).to.equal(100n);
    expect(await decryptPoolTokenBalance()).to.equal(100n);
  });

  it("G: solvency holds after deposits + withdrawals - claims always equal tokens actually held", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await mintAndWrapAs(walletB, addrB, 50n);
    await setOperatorAs(walletB);

    await depositAs(walletA, addrA, 40n);
    await depositAs(walletA, addrA, 40n); // A: 80
    await depositAs(walletB, addrB, 30n); // B: 30

    await withdrawAs(walletA, addrA, 50n); // A: 30
    await withdrawAs(walletA, addrA, 10n); // A: 20
    await (await pool.connect(walletB).withdrawAll()).wait(); // B: 0

    const creditedA = await decryptUserCredited(addrA, walletA);
    const creditedB = await decryptUserCredited(addrB, walletB);
    const poolHeld = await decryptPoolTokenBalance();
    const total = await decryptTotal();

    expect(creditedA).to.equal(20n);
    expect(creditedB).to.equal(0n);
    expect(creditedA + creditedB, "claims must equal tokens actually held").to.equal(poolHeld);
    expect(total, "encrypted total must reconcile too").to.equal(poolHeld);
  });

  it("H: withdrawing an already-emptied balance is a zero no-op, never a revert or negative balance", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);
    await depositAs(walletA, addrA, 100n);
    await (await pool.connect(walletA).withdrawAll()).wait();

    // Second withdrawAll and an over-withdraw on the empty balance.
    await (await pool.connect(walletA).withdrawAll()).wait();
    await withdrawAs(walletA, addrA, 50n);

    expect(await decryptUserCredited(addrA, walletA)).to.equal(0n);
    expect(await decryptPoolTokenBalance()).to.equal(0n);
  });
});