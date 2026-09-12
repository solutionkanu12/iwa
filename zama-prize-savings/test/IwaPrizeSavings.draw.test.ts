import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P3 draw tests for IwaPrizeSavings (approved spec section 7, corrections
 * B4 euint16 winner index and C6 permissionless timeout).
 *
 * Multi-round redesign note: draw() now advances currentRoundId
 * automatically, in the SAME transaction, the instant it draws round N -
 * round N becomes historical (state Drawn, read via roundStateOf(N) /
 * winnerIndexOf(N)) and round N+1 opens immediately. Joining a round is now
 * a separate, explicit joinRound() call after deposit(). See
 * IwaPrizeSavings.rounds.test.ts for the dedicated multi-round lifecycle
 * suite; this file re-verifies that the single-round draw mechanics
 * (weighted walk, timeout authorization, HCU bound, privacy) still hold
 * exactly as before within one round.
 *
 * DRAW_TIMEOUT = 900 seconds (approved 2026-09-05, Sepolia bounty-MVP only):
 *   - owner may draw immediately after lockRound()
 *   - non-owner must revert before lockTimestamp + 900
 *   - non-owner may draw at or after lockTimestamp + 900
 *
 * The production draw() uses FHE.randEuint64(MAX_POOL_TOTAL) and the
 * S2-proven cumulative weighted walk over LIVE participant balances. For
 * deterministic interval tests, TestDrawHarness (contracts/test/, NEVER part
 * of the production ABI/deployment) drives the SAME internal _runDraw walk
 * with an encrypted supplied ticket.
 */
describe("P3 - IwaPrizeSavings draw", function () {
  const NO_WINNER = 65535; // type(uint16).max sentinel
  const DRAW_TIMEOUT = 900;
  const MAX_POOL_TOTAL = 1024n;

  let deployer: Signer;
  let walletA: Signer;
  let walletB: Signer;
  let addrA: string;
  let addrB: string;
  let addrOwner: string;

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

  async function setOperatorAs(signer: Signer, operator: string) {
    return (
      await wrapper
        .connect(signer)
        .setOperator(operator, (await ethers.provider.getBlock("latest"))!.timestamp + 3600)
    ).wait();
  }

  async function setOperatorAsH(signer: Signer, h: any) {
    return setOperatorAs(signer, await h.getAddress());
  }

  async function depositAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await pool.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function saveAndJoin(signer: Signer, addr: string, value: bigint) {
    await mintAndWrapAs(signer, addr, 100n > value ? 100n : value);
    await setOperatorAs(signer, poolAddr);
    await depositAs(signer, addr, value);
    return (await pool.connect(signer).joinRound()).wait();
  }

  async function fundPrizeAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await pool.connect(signer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function decryptWinnerOf(roundId: bigint): Promise<bigint> {
    const handle = await pool.winnerIndexOf(roundId);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint16, handle);
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

  async function decryptUserCredited(addr: string): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptPoolTokenBalance(): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(poolAddr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function increaseTime(seconds: number) {
    // evm_increaseTime shifts the timestamp of the NEXT mined block; do NOT
    // also mine here, or the boundary shifts one block forward.
    await ethers.provider.send("evm_increaseTime", [seconds]);
  }

  // ---------------------------------------------------------------------
  // State / authority
  // ---------------------------------------------------------------------

  it("1: draw while Open reverts", async function () {
    let reverted = false;
    try {
      await pool.connect(deployer).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "draw in Open must revert").to.be.true;
  });

  it("2: owner can draw immediately after lock (production randEuint64 path)", async function () {
    await saveAndJoin(walletA, addrA, 50n);

    await pool.connect(deployer).lockRound();
    const tx = await pool.connect(deployer).draw();
    await tx.wait();

    expect(await pool.currentRoundId(), "round advances automatically").to.equal(2n);
    expect(await pool.roundStateOf(1n)).to.equal(2n); // Drawn
    expect(await pool.roundState()).to.equal(0n); // round 2 is Open
    const winner = await decryptWinnerOf(1n);
    // Exactly one registered participant (index 0), so either 0 or NO_WINNER.
    expect(winner === 0n || winner === BigInt(NO_WINNER)).to.be.true;
  });

  it("3: non-owner cannot draw before lockTimestamp + 900", async function () {
    await saveAndJoin(walletA, addrA, 50n);
    await pool.connect(deployer).lockRound();

    let reverted = false;
    try {
      await pool.connect(walletB).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "non-owner draw before timeout must revert").to.be.true;
  });

  it("4: non-owner can draw at lockTimestamp + 900 (and not before)", async function () {
    await saveAndJoin(walletA, addrA, 50n);
    await pool.connect(deployer).lockRound();
    const lockTs = Number(await pool.lockTimestamp());

    // 899 seconds after lock: still reverted.
    await increaseTime(DRAW_TIMEOUT - 1);
    let reverted = false;
    try {
      await pool.connect(walletB).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "non-owner draw at lock+899 must revert").to.be.true;

    // One more second: exactly lockTimestamp + 900, draw succeeds.
    await increaseTime(1);
    const tx = await pool.connect(walletB).draw();
    const receipt = await tx.wait();
    const drawnBlock = await ethers.provider.getBlock(receipt.blockNumber);
    expect(drawnBlock!.timestamp >= lockTs + DRAW_TIMEOUT).to.be.true;
    expect(await pool.roundStateOf(1n)).to.equal(2n); // Drawn
  });

  it("5: draw cannot run twice for the same round", async function () {
    await saveAndJoin(walletA, addrA, 50n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    // The round already advanced to 2 (Open); draw() on round 2 (still
    // Open, never locked) must revert with "not locked" - there is no way
    // to re-run round 1's draw.
    let reverted = false;
    try {
      await pool.connect(deployer).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "draw on the fresh Open round must revert").to.be.true;
    expect(await pool.roundStateOf(1n)).to.equal(2n); // round 1 still Drawn
  });

  it("6: DRAW_TIMEOUT is a public plaintext constant of 900", async function () {
    expect(await pool.DRAW_TIMEOUT()).to.equal(BigInt(DRAW_TIMEOUT));
  });

  // ---------------------------------------------------------------------
  // Weighted-walk algorithm (deterministic via TestDrawHarness - the same
  // internal _runDraw the production draw() uses)
  // ---------------------------------------------------------------------

  async function deployHarness() {
    const factory = await ethers.getContractFactory("TestDrawHarness");
    const h: any = await factory.deploy(wrapperAddr);
    await h.waitForDeployment();
    return h;
  }

  async function harnessDrawWithTicket(h: any, signer: Signer, addr: string, ticket: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await h.getAddress(), addr)
      .add64(ticket)
      .encrypt();
    return (await h.connect(signer).drawWithTicket(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function decryptHarnessWinnerOf(h: any, roundId: bigint): Promise<bigint> {
    const handle = await h.winnerIndexOf(roundId);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint16, handle);
  }

  async function harnessSaveAndJoin(h: any, signer: Signer, addr: string, value: bigint) {
    await mintAndWrapAs(signer, addr, 100n > value ? 100n : value);
    await setOperatorAsH(signer, h);
    const encrypted = await fhevm
      .createEncryptedInput(await h.getAddress(), addr)
      .add64(value)
      .encrypt();
    await (await h.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
    return (await h.connect(signer).joinRound()).wait();
  }

  it("7: the production walk uses the S2-proven FHE operations (source structural match)", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );
    expect(source).to.contain("FHE.randEuint64(uint64(MAX_POOL_TOTAL))");
    expect(source).to.contain("FHE.and(FHE.le(lower, ticket), FHE.lt(ticket, running))");
    expect(source).to.contain("FHE.select(inRange, FHE.asEuint16(i), selected)");
    expect(source).to.contain("FHE.add(running, _credited[r.participants[i]])");
  });

  it("8: the stored winner is a euint16 handle (type-checked via euint16 decrypt)", async function () {
    await saveAndJoin(walletA, addrA, 50n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    const handle = await pool.winnerIndexOf(1n);
    // A type mismatch would fail this decrypt (FhevmType.euint16).
    const clear = await fhevm.debugger.decryptEuint(FhevmType.euint16, handle);
    expect(clear === 0n || clear === BigInt(NO_WINNER)).to.be.true;
  });

  it("9: an early-interval participant can win (ticket 5 of weights [10,20,30] -> index 0)", async function () {
    const h = await deployHarness();
    await harnessSaveAndJoin(h, walletA, addrA, 10n);
    await harnessSaveAndJoin(h, walletB, addrB, 20n);
    const walletC = (await ethers.getSigners())[3];
    const addrC = await walletC.getAddress();
    await harnessSaveAndJoin(h, walletC, addrC, 30n);

    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 5n);
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(0n);
  });

  it("10: a middle participant can win (ticket 15 of weights [10,20,30] -> index 1)", async function () {
    const h = await deployHarness();
    await harnessSaveAndJoin(h, walletA, addrA, 10n);
    await harnessSaveAndJoin(h, walletB, addrB, 20n);
    const walletC = (await ethers.getSigners())[3];
    const addrC = await walletC.getAddress();
    await harnessSaveAndJoin(h, walletC, addrC, 30n);

    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 15n);
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(1n);
  });

  it("11: the last participant can win (ticket 55 of weights [10,20,30] -> index 2)", async function () {
    const h = await deployHarness();
    await harnessSaveAndJoin(h, walletA, addrA, 10n);
    await harnessSaveAndJoin(h, walletB, addrB, 20n);
    const walletC = (await ethers.getSigners())[3];
    const addrC = await walletC.getAddress();
    await harnessSaveAndJoin(h, walletC, addrC, 30n);

    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 55n);
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(2n);
  });

  it("12: a zero-weight participant can never win (weights [10,0,20], ticket 10 -> index 2)", async function () {
    const h = await deployHarness();
    const wallets = [(await ethers.getSigners())[3], walletA, walletB];
    const values = [10n, 0n, 20n];
    for (const [i, w] of wallets.entries()) {
      const addr = await w.getAddress();
      await mintAndWrapAs(w, addr, 100n);
      await setOperatorAsH(w, h);
      const encrypted = await fhevm.createEncryptedInput(await h.getAddress(), addr).add64(values[i]).encrypt();
      await (await h.connect(w).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
      await (await h.connect(w).joinRound()).wait();
    }
    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 10n);
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(2n);
  });

  it("13: an all-zero pool yields NO_WINNER", async function () {
    const h = await deployHarness();
    for (const w of [walletA, walletB]) {
      const addr = await w.getAddress();
      await mintAndWrapAs(w, addr, 100n);
      await setOperatorAsH(w, h);
      const encrypted = await fhevm.createEncryptedInput(await h.getAddress(), addr).add64(0n).encrypt();
      await (await h.connect(w).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
      await (await h.connect(w).joinRound()).wait();
    }
    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 0n);
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(BigInt(NO_WINNER));
  });

  it("14: a ticket exactly at the confidential total yields NO_WINNER (no wraparound)", async function () {
    const h = await deployHarness();
    await harnessSaveAndJoin(h, walletA, addrA, 10n);
    await harnessSaveAndJoin(h, walletB, addrB, 20n);
    const walletC = (await ethers.getSigners())[3];
    const addrC = await walletC.getAddress();
    await harnessSaveAndJoin(h, walletC, addrC, 30n); // total 60

    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 60n); // == total
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(BigInt(NO_WINNER));
  });

  it("15: a ticket beyond the confidential total yields NO_WINNER (rollover case)", async function () {
    const h = await deployHarness();
    await harnessSaveAndJoin(h, walletA, addrA, 10n);
    await harnessSaveAndJoin(h, walletB, addrB, 20n);
    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 999n);
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(BigInt(NO_WINNER));
  });

  it("16: prizeReserve does not affect weighting (fund 300, weights [10,20] unchanged)", async function () {
    const h = await deployHarness();
    await mintAndWrapAs(deployer, addrOwner, 300n);
    await setOperatorAsH(deployer, h);
    await harnessFundPrize(h, 300n);
    await harnessSaveAndJoin(h, walletA, addrA, 10n);
    await harnessSaveAndJoin(h, walletB, addrB, 20n);
    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 5n); // [0,10) -> index 0
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(0n);
  });

  async function harnessFundPrize(h: any, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await h.getAddress(), addrOwner)
      .add64(value)
      .encrypt();
    return (await h.connect(deployer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  it("17: a withdrawn balance reduces weight naturally (weight 60 after 100-40)", async function () {
    const h = await deployHarness();
    await harnessSaveAndJoin(h, walletA, addrA, 100n);
    const encrypted = await fhevm
      .createEncryptedInput(await h.getAddress(), addrA)
      .add64(40n)
      .encrypt();
    await (await h.connect(walletA).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();

    await h.connect(deployer).lockRound();
    await harnessDrawWithTicket(h, deployer, addrOwner, 60n); // == reduced total
    expect(await decryptHarnessWinnerOf(h, 1n)).to.equal(BigInt(NO_WINNER));
  });

  // ---------------------------------------------------------------------
  // Bounds
  // ---------------------------------------------------------------------

  it("18 + 19 + 20: draw at the full 16-participant cap runs inside the loop bound (HCU measured below)", async function () {
    for (let i = 0; i < 16; i++) {
      const w = (await ethers.getSigners())[i + 3];
      await saveAndJoin(w, await w.getAddress(), 10n);
    }
    expect(await pool.participantCount()).to.equal(16n);

    await pool.connect(deployer).lockRound();
    const tx = await pool.connect(deployer).draw();
    const receipt = await tx.wait();
    expect(await pool.roundStateOf(1n)).to.equal(2n);

    const winner = await decryptWinnerOf(1n);
    expect(winner === BigInt(NO_WINNER) || winner < 16n).to.be.true;
    return receipt;
  });

  it("19b: the draw loop source is bounded by the round's own participant array, capped at 16", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );
    expect(source).to.contain("uint256 n = r.participants.length;");
    expect(source).to.contain("for (uint16 i = 0; i < n; i++)");
  });

  // ---------------------------------------------------------------------
  // Privacy
  // ---------------------------------------------------------------------

  it("21 + 25: the Drawn event carries no winner, ticket, balance or prize data", async function () {
    await saveAndJoin(walletA, addrA, 50n);
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer, poolAddr);
    await fundPrizeAs(deployer, addrOwner, 100n);

    await pool.connect(deployer).lockRound();
    const receipt = await (await pool.connect(deployer).draw()).wait();

    const ourLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === poolAddr.toLowerCase(),
    );
    const drawnLog = ourLogs.find((l: any) => l.topics[0] === ethers.id("Drawn(uint256)"));
    expect(drawnLog, "expected a Drawn event").to.not.be.undefined;
    expect(drawnLog!.data, "Drawn must carry no data (roundId is indexed, not a value)").to.equal("0x");

    for (const log of ourLogs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        // No 32-byte word may be a balance/winner/prize value used in this test.
        const word = data.slice(p, p + 64);
        for (const v of [50, 100]) {
          expect(word).to.not.equal(ethers.zeroPadValue("0x" + v.toString(16), 32).slice(2).toLowerCase());
        }
      }
    }
  });

  it("22: no plaintext participant balances anywhere in draw state or logs", async function () {
    await saveAndJoin(walletA, addrA, 42n);
    await pool.connect(deployer).lockRound();
    const receipt = await (await pool.connect(deployer).draw()).wait();

    const plaintextWord = ethers.zeroPadValue("0x2a", 32).slice(2).toLowerCase(); // 42
    for (const log of receipt.logs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        expect(data.slice(p, p + 64)).to.not.equal(plaintextWord);
      }
    }
    expect(await pool.confidentialBalanceOf(addrA)).to.not.equal(
      ethers.zeroPadValue("0x2a", 32),
    );
  });

  it("23: no public decryption primitive anywhere in the pool source", async function () {
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

  it("24: no winner address in logs or state - the winner is an encrypted euint16 index handle", async function () {
    await saveAndJoin(walletA, addrA, 50n);
    await pool.connect(deployer).lockRound();
    const receipt = await (await pool.connect(deployer).draw()).wait();

    const addrWord = ethers.zeroPadValue(addrA, 32).slice(2).toLowerCase();
    for (const log of receipt.logs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        expect(data.slice(p, p + 64)).to.not.equal(addrWord);
      }
    }
    const winnerHandle = await pool.winnerIndexOf(1n);
    expect(winnerHandle).to.not.equal(addrWord);
  });

  // ---------------------------------------------------------------------
  // Prize safety
  // ---------------------------------------------------------------------

  it("26 + 27 + 28: draw moves no tokens, leaves the prize reserve and all balances untouched", async function () {
    await saveAndJoin(walletA, addrA, 50n);
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer, poolAddr);
    await fundPrizeAs(deployer, addrOwner, 100n);

    const holdingsBefore = await decryptPoolTokenBalance();
    const reserveBefore = await decryptReserve();
    const creditedBefore = await decryptUserCredited(addrA);
    const totalBefore = await decryptTotal();

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    expect(await decryptPoolTokenBalance()).to.equal(holdingsBefore);
    expect(await decryptUserCredited(addrA)).to.equal(creditedBefore);
    expect(await decryptTotal()).to.equal(totalBefore);
    // The reserve that mattered (round 1's) is unchanged; it now lives under
    // roundId 1 since round 2 (the new "current" round) starts unfunded.
    const round1Reserve = await fhevm.debugger.decryptEuint(
      FhevmType.euint64,
      await pool.prizeReserveOf(1n),
    );
    expect(round1Reserve).to.equal(reserveBefore);
  });

  // ---------------------------------------------------------------------
  // Production N=16 HCU measurement (real FHE.randEuint64 path)
  // ---------------------------------------------------------------------

  const GLOBAL_LIMIT = 20_000_000;
  const SEQUENTIAL_DEPTH_LIMIT = 5_000_000;

  it("HCU: production draw() at N=16 stays within limits (measured, not assumed)", async function () {
    for (let i = 0; i < 16; i++) {
      const w = (await ethers.getSigners())[i + 3];
      await saveAndJoin(w, await w.getAddress(), BigInt((i + 1) * 10));
    }
    await pool.connect(deployer).lockRound();

    const tx = await pool.connect(deployer).draw();
    const receipt = await tx.wait();
    const hcu = fhevm.computeTransactionHCU(receipt);

    console.log(
      `\n=== P3 production draw N=16: globalHCU=${hcu.globalHCU} maxHCUDepth=${hcu.maxHCUDepth} gas=${receipt.gasUsed.toString()} ===`,
    );

    expect(hcu.maxHCUDepth, "N=16 sequential depth must fit").to.be.lessThan(
      SEQUENTIAL_DEPTH_LIMIT,
    );
    expect(hcu.globalHCU, "N=16 global HCU must fit").to.be.lessThan(GLOBAL_LIMIT);
  });
});
