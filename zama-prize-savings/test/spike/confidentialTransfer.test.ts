import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * S3 spike: prove the confidential token path works end to end (spec
 * sections 2, 4, 6 and corrections B1, C1, C3).
 *
 *   MockUSD (plaintext ERC-20)
 *     -> ERC7984ERC20Wrapper (OpenZeppelin confidential-contracts) = cMockUSD
 *     -> user setOperator(pool, expiry)
 *     -> pool confidentialTransferFrom(user, pool, requested)
 *     -> pool credits the ACTUAL returned encrypted amount (never the
 *        requested amount) and re-grants ACL on every write (C3)
 *
 * Every step is executed as its own transaction. The mandatory exploit test
 * (C1): a user holding 50 requesting 100 must NEVER be credited 100 - the
 * pool only ever credits what the confidential token actually returned.
 *
 * Pinned API (verified from installed @openzeppelin/confidential-contracts
 * 0.5.3 source, peer-dep @fhevm/solidity 0.11.1 = our exact toolchain):
 *   - ERC7984 constructor: (name, symbol, contractURI)
 *   - ERC7984ERC20Wrapper constructor: (IERC20 underlying)
 *   - wrap(address to, uint256 amount) returns (euint64)
 *   - setOperator(address operator, uint48 until)   <- uint48, not uint256
 *   - confidentialTransferFrom(address from, address to, euint64 amount)
 *     returns (euint64 transferred)   <- the ACTUAL amount moved
 *   - FHESafeMath.tryDecrease: transferred = select(balance >= amount, amount, 0)
 *     -> ALL-OR-NOTHING semantics: full amount on success, 0 on shortfall,
 *        never reverts, never partial (pinned from source, not guessed)
 *   - callers must FHE.allowTransient(amount, token) before transferFrom
 *     (documented OZ/Zama operator pattern)
 */
describe("S3 - ERC7984 wrapper flow + actual-returned-amount accounting", function () {
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

    pool = await (await ethers.getContractFactory("SpikeConfidentialPool")).deploy(wrapperAddr);
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();
  });

  // ---------------------------------------------------------------------
  // Helpers - every step is a separate transaction on purpose (C3)
  // ---------------------------------------------------------------------

  async function mintAndWrapAs(signer: Signer, addr: string, amount: bigint) {
    await (await mock.connect(signer).mint(addr, amount)).wait();
    await (await mock.connect(signer).approve(wrapperAddr, amount)).wait();
    return (await wrapper.connect(signer).wrap(addr, amount)).wait();
  }

  async function setOperatorAs(signer: Signer, operator: string, untilSec: number) {
    return (await wrapper.connect(signer).setOperator(operator, untilSec)).wait();
  }

  async function pullAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    const tx = await pool.connect(signer).pullFrom(encrypted.handles[0], encrypted.inputProof);
    return tx.wait();
  }

  async function decryptUserCredited(addr: string, signer: Signer): Promise<bigint> {
    const handle = await pool.creditedBalanceOf(addr);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, signer);
  }

  async function decryptUserTokenBalance(addr: string, signer: Signer): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(addr);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, wrapperAddr, signer);
  }

  async function decryptPoolTokenBalance(): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(poolAddr);
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }


  // The custom error is raised by the TOKEN contract, which is not part of the
  // pool's ABI, so ethers cannot decode its name. Match the raw revert data
  // against the ERC7984UnauthorizedSpender selector instead.
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
  // Required happy path (spec 6) - across separate transactions
  // ---------------------------------------------------------------------

  it("A: wrap 100 -> setOperator(pool) -> deposit request 40 -> pool credits the ACTUAL returned 40, and A decrypts 40", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await pullAs(walletA, addrA, 40n);

    // User-side decrypt of the credited pool balance (separate read cycle).
    expect(await decryptUserCredited(addrA, walletA)).to.equal(40n);

    // Pool actually controls 40 confidential tokens.
    expect(await decryptPoolTokenBalance()).to.equal(40n);
  });

  it("B: exact-balance transfer - requesting exactly the held amount credits the full amount", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await pullAs(walletA, addrA, 100n);

    expect(await decryptUserCredited(addrA, walletA)).to.equal(100n);
    expect(await decryptPoolTokenBalance()).to.equal(100n);
    // Wallet A no longer holds any confidential token.
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(0n);
  });

  // ---------------------------------------------------------------------
  // Mandatory exploit test (C1): request 100 while holding only 50
  // ---------------------------------------------------------------------

  it("C1 EXPLOIT: holding 50, requesting 100 credits the ACTUAL returned amount - NEVER 100 (no unbacked pool shares)", async function () {
    await mintAndWrapAs(walletA, addrA, 50n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await pullAs(walletA, addrA, 100n);

    const credited = await decryptUserCredited(addrA, walletA);

    // The pinned OZ ERC7984 transfer is all-or-nothing (select(balance>=amt,
    // amt, 0)): a 50-holding request of 100 moves and returns 0.
    // The pool credits the ACTUAL returned value, so it credits 0.
    expect(credited, "must credit the ACTUAL returned amount").to.equal(0n);
    expect(credited, "MUST NOT credit the requested 100").to.not.equal(100n);
    expect(credited <= 50n, "must never exceed what the user held (50)").to.be.true;

    // Nothing was drained from wallet A, nothing entered the pool.
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(50n);
    expect(await decryptPoolTokenBalance()).to.equal(0n);
  });

  // ---------------------------------------------------------------------
  // Operator authorization (ACL on spending)
  // ---------------------------------------------------------------------

  it("C: operator not granted -> confidentialTransferFrom reverts (ERC7984UnauthorizedSpender)", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    // NOTE: deliberately no setOperator call.

    let reverted = false;
    let selector = "";
    try {
      await pullAs(walletA, addrA, 10n);
    } catch (err: any) {
      reverted = true;
      selector = extractRevertSelector(err);
    }
    expect(reverted, "pull without operator grant must revert").to.be.true;
    expect(selector, "must revert with ERC7984UnauthorizedSpender").to.contain(
      UNAUTHORIZED_SPENDER_SELECTOR,
    );

    // A's tokens untouched, pool credits nothing.
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(100n);
    expect(await pool.creditedBalanceOf(addrA)).to.equal(ethers.ZeroHash);
  });

  it("D: expired operator permission -> confidentialTransferFrom reverts", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp - 60); // expired

    let reverted = false;
    let selector = "";
    try {
      await pullAs(walletA, addrA, 10n);
    } catch (err: any) {
      reverted = true;
      selector = extractRevertSelector(err);
    }
    expect(reverted, "pull with expired operator permission must revert").to.be.true;
    expect(selector, "must revert with ERC7984UnauthorizedSpender").to.contain(
      UNAUTHORIZED_SPENDER_SELECTOR,
    );

    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(100n);
  });

  it("E: wallet B cannot spend wallet A's confidential tokens", async function () {
    await mintAndWrapAs(walletA, addrA, 50n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    // Operator model: only the pool is an operator for A; B has no power.
    expect(await wrapper.isOperator(addrA, poolAddr)).to.equal(true);
    expect(await wrapper.isOperator(addrA, addrB)).to.equal(false);

    // B attempts a pull (from B, since pulls are msg.sender-bound): reverts
    // because B never granted the pool operator rights.
    let reverted = false;
    try {
      await pullAs(walletB, addrB, 10n);
    } catch {
      reverted = true;
    }
    expect(reverted, "B's pull must revert (pool is not B's operator)").to.be.true;

    // A's tokens and A's credited balance are untouched by B's attempt.
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(50n);
    expect(await pool.creditedBalanceOf(addrA)).to.equal(ethers.ZeroHash);
    expect(await pool.creditedBalanceOf(addrB)).to.equal(ethers.ZeroHash);
  });

  // ---------------------------------------------------------------------
  // ACL persistence across transactions (C3)
  // ---------------------------------------------------------------------

  it("F: ACL persists - a SECOND deposit reuses the stored encrypted balance, and the user still decrypts the sum (60)", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    // Deposit 1 (transaction 1).
    await pullAs(walletA, addrA, 40n);
    expect(await decryptUserCredited(addrA, walletA)).to.equal(40n);

    // Deposit 2 (transaction 2) - only succeeds if the pool's allowThis on
    // the stored credited balance persisted across the transaction boundary.
    await pullAs(walletA, addrA, 20n);

    expect(await decryptUserCredited(addrA, walletA)).to.equal(60n);
    expect(await decryptPoolTokenBalance()).to.equal(60n);
  });

  it("G: a third deposit after an unrelated intermediate transaction still works (ACL re-granted on every write)", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await pullAs(walletA, addrA, 10n);
    await pullAs(walletA, addrA, 10n);
    // Unrelated transaction between deposits.
    await mintAndWrapAs(walletB, addrB, 5n);
    await setOperatorAs(walletB, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    await pullAs(walletB, addrB, 5n);

    await pullAs(walletA, addrA, 10n);

    expect(await decryptUserCredited(addrA, walletA)).to.equal(30n);
    expect(await decryptUserCredited(addrB, walletB)).to.equal(5n);
  });

  // ---------------------------------------------------------------------
  // Solvency invariant (spec 8): encrypted claims never exceed the
  // confidential tokens the pool actually controls
  // ---------------------------------------------------------------------

  it("H: solvency - sum of credited balances equals the pool's actual confidential token balance", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    await mintAndWrapAs(walletB, addrB, 40n);
    await setOperatorAs(walletB, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await pullAs(walletA, addrA, 40n);
    await pullAs(walletA, addrA, 25n);
    await pullAs(walletB, addrB, 15n);

    const creditedA = await decryptUserCredited(addrA, walletA);
    const creditedB = await decryptUserCredited(addrB, walletB);
    const poolHeld = await decryptPoolTokenBalance();

    expect(creditedA).to.equal(65n);
    expect(creditedB).to.equal(15n);
    expect(creditedA + creditedB, "claims must equal tokens actually held by the pool").to.equal(poolHeld);
  });

  // ---------------------------------------------------------------------
  // Leakage and surface checks
  // ---------------------------------------------------------------------

  it("I: our pool emits no plaintext confidential amount in any event", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    const receipt = await pullAs(walletA, addrA, 40n);
    const plaintextWord = ethers.zeroPadValue("0x28", 32).slice(2).toLowerCase(); // 40

    // Scope: logs emitted by OUR pool contract. In the local mock the Zama
    // coprocessor computes over cleartext and its own logs may contain the
    // plaintext word - a mock artifact, not our leak (same caveat as S1).
    const ourLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === poolAddr.toLowerCase(),
    );
    expect(ourLogs.length, "expected our Pulled event").to.be.greaterThan(0);
    for (const log of ourLogs) {
      expect(log.data, "our event must carry no data at all").to.equal("0x");
      for (const topic of log.topics) {
        expect(topic.slice(2).toLowerCase()).to.not.equal(plaintextWord);
      }
    }

    // The token's ConfidentialTransfer event carries an encrypted handle
    // (mock ciphertext), never the cleartext word.
    const tokenLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === wrapperAddr.toLowerCase(),
    );
    for (const log of tokenLogs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        expect(data.slice(p, p + 64)).to.not.equal(plaintextWord);
      }
      for (const topic of log.topics.slice(1)) {
        expect(topic.slice(2).toLowerCase()).to.not.equal(plaintextWord);
      }
    }
  });

  it("J: no arbitrary sweep/rescue/withdraw function exists in the pool ABI", async function () {
    const abi = JSON.parse(pool.interface.formatJson());
    const names = abi
      .filter((e: any) => e.type === "function")
      .map((e: any) => e.name)
      .sort();

    expect(names, "pool surface must be exactly pullFrom + creditedBalanceOf").to.deep.equal([
      "confidentialProtocolId",
      "creditedBalanceOf",
      "pullFrom",
      "token",
    ]);

    for (const n of names) {
      expect(n.toLowerCase(), `no sweep-like surface: ${n}`).to.not.match(/sweep|rescue|withdraw|emergency|skim|transfer|recover/);
    }
  });

  it("K: our pool source never calls a public/broadcast decryption primitive", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "contracts", "spike", "SpikeConfidentialPool.sol"),
      "utf8",
    );
    expect(source).to.not.contain("makePubliclyDecryptable");
    expect(source).to.not.contain("allowForDecryption");
    expect(source).to.not.contain("checkSignatures");
  });

  it("L: the one-time wrap amount IS public (documented honestly) - the plaintext Transfer on MockUSD proves it", async function () {
    const receipt = await mintAndWrapAs(walletA, addrA, 100n);

    // The wrap moves plaintext ERC-20, so the amount appears in the
    // underlying's Transfer event. This is the ONLY amount a user reveals:
    // privacy begins after the user holds the confidential token. The test
    // documents that honestly instead of calling this a confidential wrap.
    const plaintextWord = ethers.zeroPadValue("0x64", 32).slice(2).toLowerCase(); // 100
    const mockLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === mockAddr.toLowerCase(),
    );
    let sawPublicAmount = false;
    for (const log of mockLogs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        if (data.slice(p, p + 64) === plaintextWord) sawPublicAmount = true;
      }
    }
    expect(sawPublicAmount, "MockUSD Transfer event must carry the public wrap amount").to.be.true;
  });
});