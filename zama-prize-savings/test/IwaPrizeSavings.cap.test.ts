import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P2 pool-cap tests for IwaPrizeSavings (approved spec sections 6.4, 7.1,
 * 7.3; MAX_POOL_TOTAL = 1024 = 2^10, the S2-measured bound).
 *
 * Rules under test:
 *   - Participant deposit weight (confidentialTotal) can never exceed
 *     MAX_POOL_TOTAL. Deposits clamp to headroom = MAX_POOL_TOTAL - total
 *     via encrypted FHE.min - no plaintext branch, no decryption.
 *   - The prize reserve is a SEPARATE encrypted value: funding a prize never
 *     consumes deposit headroom and never inflates draw weight.
 */
describe("P2 - IwaPrizeSavings pool cap", function () {
  const MAX_POOL_TOTAL = 1024n;

  let deployer: Signer;
  let walletA: Signer;
  let addrA: string;
  let addrOwner: string;

  let mock: any;
  let wrapper: any;
  let pool: any;
  let mockAddr: string;
  let wrapperAddr: string;
  let poolAddr: string;

  beforeEach(async function () {
    [deployer, walletA] = await ethers.getSigners();
    addrA = await walletA.getAddress();
    addrOwner = await deployer.getAddress();

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
      await wrapper
        .connect(signer)
        .setOperator(poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600)
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

  async function fundPrizeAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await pool.connect(signer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function decryptTotal(): Promise<bigint> {
    const handle = await pool.confidentialTotal();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptReserve(): Promise<bigint> {
    const handle = await pool.prizeReserve();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptUserCredited(addr: string): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptUserTokenBalance(addr: string): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptPoolTokenBalance(): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(poolAddr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  it("6: deposits remain below MAX_POOL_TOTAL", async function () {
    expect(await pool.MAX_POOL_TOTAL()).to.equal(MAX_POOL_TOTAL);
    await mintAndWrapAs(walletA, addrA, 2000n);
    await setOperatorAs(walletA);

    await depositAs(walletA, addrA, 1000n);
    expect(await decryptTotal()).to.equal(1000n);
    expect(await decryptUserCredited(addrA)).to.equal(1000n);
    expect(await decryptPoolTokenBalance()).to.equal(1000n);
    expect((await decryptTotal()) <= MAX_POOL_TOTAL).to.be.true;
  });

  it("7: a request above the remaining headroom clamps to the headroom (24 of 100)", async function () {
    await mintAndWrapAs(walletA, addrA, 2000n);
    await setOperatorAs(walletA);

    await depositAs(walletA, addrA, 1000n); // total 1000, headroom 24
    await depositAs(walletA, addrA, 100n); // request 100, holding 1000

    expect(await decryptUserCredited(addrA)).to.equal(1024n); // 1000 + clamped 24
    expect(await decryptTotal()).to.equal(MAX_POOL_TOTAL);
    expect(await decryptPoolTokenBalance()).to.equal(MAX_POOL_TOTAL);
  });

  it("8: headroom enforcement is pure FHE - no plaintext branch, no decryption", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );

    // The approved encrypted clamp form is present.
    expect(source).to.contain("FHE.min(requested, headroom)");
    expect(source).to.contain("trySub(FHE.asEuint64(uint64(MAX_POOL_TOTAL)), _confidentialTotal)");

    // No path to plaintext for the total or the request.
    expect(source).to.not.contain("makePubliclyDecryptable");
    expect(source).to.not.contain("allowForDecryption");
    expect(source).to.not.contain("checkSignatures");

    // The pool keeps no plaintext total state.
    expect(source).to.not.contain("uint256 public confidentialTotal");
    expect(source).to.not.contain("uint256 _confidentialTotal");
  });

  it("9: participant total never exceeds MAX_POOL_TOTAL, and headroom reopens after withdrawal", async function () {
    await mintAndWrapAs(walletA, addrA, 2000n);
    await setOperatorAs(walletA);

    await depositAs(walletA, addrA, 1000n);
    await depositAs(walletA, addrA, 100n); // clamps to 24 -> total 1024
    expect(await decryptTotal()).to.equal(MAX_POOL_TOTAL);

    // At the cap, further requests transfer and credit nothing.
    await depositAs(walletA, addrA, 100n);
    expect(await decryptTotal()).to.equal(MAX_POOL_TOTAL);
    expect(await decryptUserCredited(addrA)).to.equal(MAX_POOL_TOTAL);
    expect(await decryptPoolTokenBalance()).to.equal(MAX_POOL_TOTAL);

    // Withdrawal reopens headroom: 24 back out, then 24 back in.
    await withdrawAs(walletA, addrA, 24n);
    expect(await decryptTotal()).to.equal(1000n);
    await depositAs(walletA, addrA, 100n);
    expect(await decryptTotal()).to.equal(MAX_POOL_TOTAL);
  });

  it("10: the prize reserve never counts toward participant draw weight or headroom", async function () {
    await mintAndWrapAs(deployer, addrOwner, 300n);
    await setOperatorAs(deployer);
    await mintAndWrapAs(walletA, addrA, 1024n);
    await setOperatorAs(walletA);

    await fundPrizeAs(deployer, addrOwner, 300n);
    expect(await decryptReserve()).to.equal(300n);
    expect(await decryptTotal(), "prize must not create draw weight").to.equal(0n);

    // The participant can still deposit the FULL MAX_POOL_TOTAL: the prize
    // reserve did not consume any headroom.
    await depositAs(walletA, addrA, 1024n);
    expect(await decryptTotal()).to.equal(MAX_POOL_TOTAL);
    expect(await decryptReserve()).to.equal(300n);
    expect(await decryptPoolTokenBalance()).to.equal(1324n);

    // Participant weight and reserve are separate encrypted values.
    expect(await pool.confidentialTotal()).to.not.equal(await pool.prizeReserve());
  });
});