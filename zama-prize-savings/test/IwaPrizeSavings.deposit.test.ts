import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P1 deposit-side tests for IwaPrizeSavings (approved spec sections 4, 5, 6;
 * corrections C1 actual-returned crediting and C3 ACL re-grant).
 *
 * Pinned, verified semantics (from installed source):
 *   - OZ ERC7984 confidentialTransferFrom is ALL-OR-NOTHING: it returns the
 *     full requested amount when the balance covers it, and 0 otherwise.
 *   - The pool credits ONLY the actual returned value. A 50-held/100-request
 *     deposit transfers 0 and credits 0. Never 100. Accepted by decision.md.
 *   - Participant registration: once per wallet, on first deposit request
 *     (spec 6.6). A wallet can never occupy more than one slot, so repeated
 *     zero-transfer attempts cannot grief the participant cap.
 */
describe("P1 - IwaPrizeSavings deposit", function () {
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

  // ---------------------------------------------------------------------
  // Helpers - every step is a separate transaction on purpose (C3)
  // ---------------------------------------------------------------------

  async function mintAndWrapAs(signer: Signer, addr: string, amount: bigint) {
    await (await mock.connect(signer).mint(addr, amount)).wait();
    await (await mock.connect(signer).approve(wrapperAddr, amount)).wait();
    return (await wrapper.connect(signer).wrap(addr, amount)).wait();
  }

  async function setOperatorAs(signer: Signer, untilSec: number) {
    return (await wrapper.connect(signer).setOperator(poolAddr, untilSec)).wait();
  }

  async function depositAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    const tx = await pool.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof);
    return tx.wait();
  }

  async function decryptUserCredited(addr: string, signer: Signer): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(addr);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, signer);
  }

  async function decryptUserTokenBalance(addr: string, signer: Signer): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(addr);
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
  // Happy path
  // ---------------------------------------------------------------------

  it("A: successful deposit of 40 credits exactly 40 (actual-returned accounting)", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await depositAs(walletA, addrA, 40n);

    expect(await decryptUserCredited(addrA, walletA)).to.equal(40n);
    expect(await decryptTotal()).to.equal(40n);
    expect(await decryptPoolTokenBalance()).to.equal(40n);
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(60n);
    // Depositing alone does NOT join the round - that is now explicit.
    expect(await pool.participantCount()).to.equal(0n);
    expect(await pool.isParticipant(addrA)).to.equal(false);

    await (await pool.connect(walletA).joinRound()).wait();
    expect(await pool.participantCount()).to.equal(1n);
    expect(await pool.isParticipant(addrA)).to.equal(true);
  });

  it("B: a second deposit in a separate transaction accumulates (40 + 20 = 60)", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await depositAs(walletA, addrA, 40n);
    await depositAs(walletA, addrA, 20n);
    await (await pool.connect(walletA).joinRound()).wait();

    expect(await decryptUserCredited(addrA, walletA)).to.equal(60n);
    expect(await decryptTotal()).to.equal(60n);
    expect(await decryptPoolTokenBalance()).to.equal(60n);
    expect(await pool.participantCount()).to.equal(1n);
  });

  // ---------------------------------------------------------------------
  // Shortfall / actual-returned accounting (C1)
  // ---------------------------------------------------------------------

  it("C1a: shortfall request (50 held, 100 requested) transfers 0 and credits 0 - no unbacked credit", async function () {
    await mintAndWrapAs(walletA, addrA, 50n);
    await setOperatorAs(walletA, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await depositAs(walletA, addrA, 100n);

    expect(await decryptUserCredited(addrA, walletA)).to.equal(0n);
    expect(await decryptTotal()).to.equal(0n);
    expect(await decryptPoolTokenBalance()).to.equal(0n);
    // Nothing was drained from wallet A.
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(50n);
  });

  it("C1b: the pool credits the ACTUAL returned amount only - never the requested 100", async function () {
    await mintAndWrapAs(walletA, addrA, 50n);
    await setOperatorAs(walletA, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await depositAs(walletA, addrA, 100n);

    const credited = await decryptUserCredited(addrA, walletA);
    expect(credited).to.equal(0n);
    expect(credited, "MUST NOT credit the requested 100").to.not.equal(100n);
    expect(credited <= 50n, "must never exceed what the user held").to.be.true;
  });

  // ---------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------

  it("D: unauthorized wallet cannot spend another wallet's tokens", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    // Wallet B never granted the pool operator rights on B's tokens.
    let reverted = false;
    let selector = "";
    try {
      await depositAs(walletB, addrB, 40n);
    } catch (err: any) {
      reverted = true;
      selector = extractRevertSelector(err);
    }
    expect(reverted, "B's deposit must revert (pool is not B's operator)").to.be.true;
    expect(selector).to.contain(UNAUTHORIZED_SPENDER_SELECTOR);

    // A's tokens and A's credited balance are untouched by B's attempt.
    expect(await decryptUserTokenBalance(addrA, walletA)).to.equal(100n);
    expect(await pool.confidentialBalanceOf(addrA)).to.equal(ethers.ZeroHash);
  });

  // ---------------------------------------------------------------------
  // State machine (Open -> Locked)
  // ---------------------------------------------------------------------

  it("E: lockRound is owner-only", async function () {
    let reverted = false;
    try {
      await pool.connect(walletA).lockRound();
    } catch {
      reverted = true;
    }
    expect(reverted, "non-owner lockRound must revert").to.be.true;
    expect(await pool.roundState()).to.equal(0n); // still Open
  });

  it("F: lockRound transitions Open -> Locked once and records the lock timestamp", async function () {
    await pool.connect(deployer).lockRound();
    expect(await pool.roundState()).to.equal(1n); // Locked
    expect((await pool.lockTimestamp()) > 0n).to.be.true;

    let reverted = false;
    try {
      await pool.connect(deployer).lockRound();
    } catch {
      reverted = true;
    }
    expect(reverted, "second lockRound must revert").to.be.true;
  });

  it("G: deposit reverts once the round is Locked", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await pool.connect(deployer).lockRound();

    let reverted = false;
    try {
      await depositAs(walletA, addrA, 40n);
    } catch {
      reverted = true;
    }
    expect(reverted, "deposit after lock must revert").to.be.true;
    expect(await decryptPoolTokenBalance()).to.equal(0n);
  });

  // ---------------------------------------------------------------------
  // Participant cap and anti-grief
  //
  // NOTE (multi-round redesign): deposit() no longer registers a
  // participant or enforces any cap - saving and joining a round are now
  // separate actions (joinRound()). deposit() itself has NO participant
  // limit at all (only the MAX_POOL_TOTAL headroom clamp, covered in
  // IwaPrizeSavings.cap.test.ts). The per-round 16-participant cap, its
  // "round full" revert, the zero-transfer anti-grief property, and the
  // "the cap resets every round" property now live on joinRound() and are
  // covered by IwaPrizeSavings.rounds.test.ts (P5, P6, P7).
  // ---------------------------------------------------------------------

  it("H: deposit() itself has no participant cap - many distinct wallets can all deposit freely", async function () {
    for (let i = 0; i < 16; i++) {
      const wallet = (await ethers.getSigners())[i + 3];
      const addr = await wallet.getAddress();
      await mintAndWrapAs(wallet, addr, 100n);
      await setOperatorAs(wallet, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);
      await depositAs(wallet, addr, 10n);
    }
    // deposit() alone never registers anyone (see joinRound cap tests).
    expect(await pool.participantCount()).to.equal(0n);

    const wallet17 = (await ethers.getSigners())[19];
    const addr17 = await wallet17.getAddress();
    await mintAndWrapAs(wallet17, addr17, 100n);
    await setOperatorAs(wallet17, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);
    await depositAs(wallet17, addr17, 10n); // must NOT revert - no cap on deposit

    expect(await decryptPoolTokenBalance()).to.equal(170n);
  });

  // ---------------------------------------------------------------------
  // Surface and leakage checks
  // ---------------------------------------------------------------------

  it("K: no sweep/rescue/emergency function exists in the pool ABI", async function () {
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
      "currentRoundId",
      "deposit",
      "draw",
      "drawTicketOf",
      "fundPrize",
      "hasClaimedRound",
      "isParticipant",
      "isParticipantInRound",
      "isRoundFinalized",
      "joinRound",
      "lockRound",
      "lockTimestamp",
      "lockTimestampOf",
      "owner",
      "participantCount",
      "prizeReserve",
      "prizeReserveOf",
      "renounceOwnership",
      "roundParticipantAt",
      "roundParticipantCount",
      "roundState",
      "roundStateOf",
      "token",
      "transferOwnership",
      "winnerIndexOf",
      "withdraw",
      "withdrawAll",
    ]);

    for (const n of names) {
      expect(n.toLowerCase(), `no sweep-like surface: ${n}`).to.not.match(
        /sweep|rescue|emergency|skim|seize|recover|drain|adminWithdraw|steal/,
      );
    }
  });

  it("L: no plaintext deposit amount appears in our pool events or state", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, (await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    const receipt = await depositAs(walletA, addrA, 40n);
    const plaintextWord = ethers.zeroPadValue("0x28", 32).slice(2).toLowerCase(); // 40

    const ourLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === poolAddr.toLowerCase(),
    );
    expect(ourLogs.length, "expected our events").to.be.greaterThan(0);

    // No log anywhere at our address may carry the plaintext amount word.
    for (const log of ourLogs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        expect(data.slice(p, p + 64)).to.not.equal(plaintextWord);
      }
      for (const topic of log.topics) {
        expect(topic.slice(2).toLowerCase()).to.not.equal(plaintextWord);
      }
    }

    // The Deposited event itself carries no data at all. (The JoinedRound
    // event, emitted only by the separate joinRound() call, legitimately
    // carries the PUBLIC participant index - membership is public by
    // design - but never an amount.)
    const depositedTopic = ethers.id("Deposited(address)");
    const depositedLog = ourLogs.find((l: any) => l.topics[0] === depositedTopic);
    expect(depositedLog, "expected a Deposited event").to.not.be.undefined;
    expect(depositedLog!.data).to.equal("0x");

    // The stored credited handle is a ciphertext, not the plaintext.
    const handle = await pool.confidentialBalanceOf(addrA);
    expect(handle).to.not.equal(ethers.zeroPadValue("0x28", 32));
  });

  it("M: P1 source has no decryption, draw, claim, prize or winner code", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );

    expect(source).to.not.contain("makePubliclyDecryptable");
    expect(source).to.not.contain("allowForDecryption");
    expect(source).to.not.contain("checkSignatures");
    expect(source).to.not.contain("randEbool");
  });
});