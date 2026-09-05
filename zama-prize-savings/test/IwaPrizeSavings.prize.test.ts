import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P2 prize-funding tests for IwaPrizeSavings (approved spec section 8,
 * corrections C1 actual-returned crediting, C2 confidential prize funding,
 * C3 ACL re-grant).
 *
 * Rules under test:
 *   - fundPrize pulls cMockUSD and credits ONLY the actual returned amount.
 *   - Shortfall funding (50 held, 100 requested) transfers 0, credits 0.
 *   - Owner-only, allowed only while the round is Open; the owner can NEVER
 *     recover, sweep, redirect or reduce the funded prize.
 *   - The prize reserve is a separate encrypted value from the participant
 *     deposit total and never counts as participant draw weight.
 *   - Solvency: sum(credited) + prizeReserve <= pool's confidential token
 *     holdings, at every step.
 */
describe("P2 - IwaPrizeSavings prize funding", function () {
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

  async function fundPrizeAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await pool.connect(signer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
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

  async function decryptReserve(): Promise<bigint> {
    const handle = await pool.prizeReserve();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptTotal(): Promise<bigint> {
    const handle = await pool.confidentialTotal();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptUserCredited(addr: string, signer: Signer): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, signer);
  }

  async function decryptPoolTokenBalance(): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(poolAddr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  const UNAUTHORIZED_SPENDER_SELECTOR = ethers
    .id("ERC7984UnauthorizedSpender(address,address)")
    .slice(0, 10);

  function extractRevertSelector(err: any): string {
    const data =
      err?.info?.error?.data ??
      err?.info?.data ??
      err?.data ??
      (typeof err?.message === "string" && err.message.match(/0x[0-9a-fA-F]{8}/)?.[0]) ??
      "";
    return String(data).toLowerCase();
  }

  // ---------------------------------------------------------------------
  // Prize funding happy path
  // ---------------------------------------------------------------------

  it("1: fund 40 cMockUSD -> prize reserve decrypts to 40", async function () {
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);

    await fundPrizeAs(deployer, addrOwner, 40n);

    expect(await decryptReserve()).to.equal(40n);
    expect(await decryptPoolTokenBalance()).to.equal(40n);
    // Participant draw weight is untouched by prize funding.
    expect(await decryptTotal()).to.equal(0n);
  });

  it("2: funding another 20 in a separate transaction accumulates (40 + 20 = 60) - reserve ACL persists", async function () {
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);

    await fundPrizeAs(deployer, addrOwner, 40n);
    expect(await decryptReserve()).to.equal(40n);

    await fundPrizeAs(deployer, addrOwner, 20n);

    expect(await decryptReserve()).to.equal(60n);
    expect(await decryptPoolTokenBalance()).to.equal(60n);
  });

  // ---------------------------------------------------------------------
  // Shortfall funding (C1)
  // ---------------------------------------------------------------------

  it("3: holder has 50, requests 100 -> actual transfer 0, reserve unchanged at 0", async function () {
    await mintAndWrapAs(deployer, addrOwner, 50n);
    await setOperatorAs(deployer);

    await fundPrizeAs(deployer, addrOwner, 100n);

    expect(await decryptReserve()).to.equal(0n);
    expect(await decryptPoolTokenBalance()).to.equal(0n);
    expect(await decryptUserCredited(addrOwner, deployer)).to.equal(0n);
  });

  it("3b: a failed funding attempt never reduces an existing reserve", async function () {
    await mintAndWrapAs(deployer, addrOwner, 200n);
    await setOperatorAs(deployer);

    await fundPrizeAs(deployer, addrOwner, 100n);
    expect(await decryptReserve()).to.equal(100n);

    // Second request exceeds what remains (100) -> transfers 0.
    await fundPrizeAs(deployer, addrOwner, 200n);
    expect(await decryptReserve()).to.equal(100n);
    expect(await decryptPoolTokenBalance()).to.equal(100n);
  });

  // ---------------------------------------------------------------------
  // Funding authority
  // ---------------------------------------------------------------------

  it("4a: non-owner cannot fund the prize", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA);

    let reverted = false;
    try {
      await fundPrizeAs(walletA, addrA, 40n);
    } catch {
      reverted = true;
    }
    expect(reverted, "non-owner fundPrize must revert").to.be.true;
    expect(await decryptReserve()).to.equal(0n);
  });

  it("4b: owner funding without operator permission fails safely (reserve untouched)", async function () {
    await mintAndWrapAs(deployer, addrOwner, 100n);
    // Deliberately no setOperator for the pool.

    let reverted = false;
    let selector = "";
    try {
      await fundPrizeAs(deployer, addrOwner, 40n);
    } catch (err: any) {
      reverted = true;
      selector = extractRevertSelector(err);
    }
    expect(reverted, "funding without operator grant must revert").to.be.true;
    expect(selector).to.contain(UNAUTHORIZED_SPENDER_SELECTOR);
    expect(await decryptReserve()).to.equal(0n);
    expect(await decryptPoolTokenBalance()).to.equal(0n);
  });

  it("4c: prize funding is only possible while the round is Open", async function () {
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    await pool.connect(deployer).lockRound();

    let reverted = false;
    try {
      await fundPrizeAs(deployer, addrOwner, 40n);
    } catch {
      reverted = true;
    }
    expect(reverted, "fundPrize after Locked must revert").to.be.true;
    expect(await decryptReserve()).to.equal(0n);
  });

  // ---------------------------------------------------------------------
  // Solvency
  // ---------------------------------------------------------------------

  it("5: solvency - deposits + prize reserve always equal the pool's actual holdings, through mixed flows", async function () {
    await mintAndWrapAs(walletA, addrA, 200n);
    await setOperatorAs(walletA);
    await mintAndWrapAs(deployer, addrOwner, 200n);
    await setOperatorAs(deployer);

    // Deposit 100, fund 60.
    await depositAs(walletA, addrA, 100n);
    await fundPrizeAs(deployer, addrOwner, 60n);
    let claims = (await decryptUserCredited(addrA, walletA)) + (await decryptReserve());
    expect(claims).to.equal(await decryptPoolTokenBalance()); // 160

    // Withdraw 40: participant accounting and holdings drop together.
    await withdrawAs(walletA, addrA, 40n);
    claims = (await decryptUserCredited(addrA, walletA)) + (await decryptReserve());
    expect(await decryptUserCredited(addrA, walletA)).to.equal(60n);
    expect(claims).to.equal(await decryptPoolTokenBalance()); // 120

    // Failed prize funding (request 200, holding 40 left) creates zero liability.
    await fundPrizeAs(deployer, addrOwner, 200n);
    claims = (await decryptUserCredited(addrA, walletA)) + (await decryptReserve());
    expect(await decryptReserve()).to.equal(60n);
    expect(claims).to.equal(await decryptPoolTokenBalance()); // 120

    // Failed deposit (request 200, holding 140) creates zero liability.
    await depositAs(walletA, addrA, 200n);
    claims = (await decryptUserCredited(addrA, walletA)) + (await decryptReserve());
    expect(await decryptUserCredited(addrA, walletA)).to.equal(60n);
    expect(claims).to.equal(await decryptPoolTokenBalance()); // 120
  });

  it("6: participant draw weight is never inflated by the prize reserve", async function () {
    await mintAndWrapAs(deployer, addrOwner, 300n);
    await setOperatorAs(deployer);
    await mintAndWrapAs(walletA, addrA, 200n);
    await setOperatorAs(walletA);

    await fundPrizeAs(deployer, addrOwner, 300n);
    expect(await decryptReserve()).to.equal(300n);
    expect(await decryptTotal(), "prize must not count as participant weight").to.equal(0n);

    await depositAs(walletA, addrA, 100n);
    expect(await decryptTotal()).to.equal(100n);
    expect(await decryptReserve()).to.equal(300n);
    expect(await decryptPoolTokenBalance()).to.equal(400n);
  });

  // ---------------------------------------------------------------------
  // Irrevocability
  // ---------------------------------------------------------------------

  it("7: ABI contains no sweep/rescue/admin-withdrawal/arbitrary-transfer path", async function () {
    const abi = JSON.parse(pool.interface.formatJson());
    const names = abi
      .filter((e: any) => e.type === "function")
      .map((e: any) => e.name)
      .sort();

    expect(names).to.deep.equal([
      "DRAW_TIMEOUT",
      "MAX_PARTICIPANTS",
      "MAX_POOL_TOTAL",
      "claim",
      "confidentialBalanceOf",
      "confidentialProtocolId",
      "confidentialTotal",
      "deposit",
      "draw",
      "drawTicket",
      "fundPrize",
      "hasClaimed",
      "isParticipant",
      "lockRound",
      "lockTimestamp",
      "owner",
      "participantCount",
      "participantIndex",
      "participants",
      "prizeReserve",
      "renounceOwnership",
      "roundState",
      "token",
      "transferOwnership",
      "winnerIndex",
      "withdraw",
      "withdrawAll",
    ]);

    for (const n of names) {
      expect(n.toLowerCase(), `no sweep-like surface: ${n}`).to.not.match(
        /sweep|rescue|emergency|skim|seize|recover|drain|adminWithdraw|steal|arbitrary/,
      );
    }
  });

  it("8: the owner cannot recover, redirect or reduce a funded prize", async function () {
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    await fundPrizeAs(deployer, addrOwner, 100n);

    // Owner's only token-out surface is the user-scoped withdraw/withdrawAll,
    // which act on the OWNER's credited balance (zero here), never the prize.
    await (await pool.connect(deployer).withdrawAll()).wait();
    await withdrawAs(deployer, addrOwner, 100n);

    expect(await decryptReserve(), "prize reserve must remain intact").to.equal(100n);
    expect(await decryptPoolTokenBalance()).to.equal(100n);

    // And the prize funding path closes once the round leaves Open.
    await pool.connect(deployer).lockRound();
    let reverted = false;
    try {
      await fundPrizeAs(deployer, addrOwner, 1n);
    } catch {
      reverted = true;
    }
    expect(reverted, "fundPrize after Locked must revert").to.be.true;
  });

  // ---------------------------------------------------------------------
  // Leakage
  // ---------------------------------------------------------------------

  it("9: no plaintext prize amount appears in events or state", async function () {
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);

    const receipt = await fundPrizeAs(deployer, addrOwner, 40n);
    const plaintextWord = ethers.zeroPadValue("0x28", 32).slice(2).toLowerCase(); // 40

    const ourLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === poolAddr.toLowerCase(),
    );
    expect(ourLogs.length, "expected our PrizeFunded event").to.be.greaterThan(0);
    for (const log of ourLogs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        expect(data.slice(p, p + 64)).to.not.equal(plaintextWord);
      }
      for (const topic of log.topics) {
        expect(topic.slice(2).toLowerCase()).to.not.equal(plaintextWord);
      }
    }

    const prizeTopic = ethers.id("PrizeFunded(address)");
    const prizeLog = ourLogs.find((l: any) => l.topics[0] === prizeTopic);
    expect(prizeLog, "expected a PrizeFunded event").to.not.be.undefined;
    expect(prizeLog!.data).to.equal("0x");

    // Stored handles are ciphertexts, never the plaintext word.
    expect(await pool.prizeReserve()).to.not.equal(ethers.zeroPadValue("0x28", 32));
    expect(await pool.confidentialTotal()).to.not.equal(ethers.zeroPadValue("0x28", 32));
  });

  it("10: P2 source has no public decryption primitive", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );
    expect(source).to.not.contain("makePubliclyDecryptable");
    expect(source).to.not.contain("allowForDecryption");
    expect(source).to.not.contain("checkSignatures");
  });
});