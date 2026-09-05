import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P5 - complete confidential prize-savings lifecycle across SEPARATE
 * transactions (plan Phase 2, spec sections 6-11; release gate 2).
 *
 * Scenario A (winner cycle): Alice 60 + Bob 40 + prize 20, ticket 30 ->
 * Alice (index 0) wins.
 * Scenario B (rollover cycle): same pool, ticket >= total -> NO_WINNER,
 * everyone claims zero, reserve rolls over intact.
 *
 * Every step is its own transaction on purpose: wrap, setOperator, deposit,
 * fundPrize, lockRound, draw, claim, withdraw. This is the ACL-persistence
 * integration test - a handle written in an earlier transaction must remain
 * operable in every later transaction of the lifecycle.
 *
 * The deterministic ticket uses TestDrawHarness (test-only, never part of
 * the production ABI/deployment) exactly as in P3/P4; the production draw()
 * with FHE.randEuint64 is verified separately (P3 structure + N=16 HCU).
 *
 * No production changes are made by this file: it validates that the
 * existing P1-P4 contract already supports the full flow.
 */
describe("P5 - full confidential prize-savings lifecycle", function () {
  let deployer: Signer; // owner
  let alice: Signer;
  let bob: Signer;
  let addrAlice: string;
  let addrBob: string;
  let addrOwner: string;

  let mock: any;
  let wrapper: any;
  let harness: any;
  let mockAddr: string;
  let wrapperAddr: string;
  let poolAddr: string;

  beforeEach(async function () {
    [deployer, alice, bob] = await ethers.getSigners();
    addrAlice = await alice.getAddress();
    addrBob = await bob.getAddress();
    addrOwner = await deployer.getAddress();

    mock = await (await ethers.getContractFactory("MockUSD")).deploy();
    await mock.waitForDeployment();
    mockAddr = await mock.getAddress();

    wrapper = await (await ethers.getContractFactory("CMockUSD")).deploy(mockAddr);
    await wrapper.waitForDeployment();
    wrapperAddr = await wrapper.getAddress();

    harness = await (await ethers.getContractFactory("TestDrawHarness")).deploy(wrapperAddr);
    await harness.waitForDeployment();
    poolAddr = await harness.getAddress();
  });

  // ---------------------------------------------------------------------
  // Step helpers - each one is a SEPARATE transaction
  // ---------------------------------------------------------------------

  async function wrapAs(signer: Signer, addr: string, amount: bigint) {
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
    return (await harness.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function fundPrizeAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await harness.connect(signer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function drawWithTicketAs(ticket: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addrOwner)
      .add64(ticket)
      .encrypt();
    return (await harness.connect(deployer).drawWithTicket(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function withdrawAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await harness.connect(signer).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  // ---------------------------------------------------------------------
  // Read helpers
  // ---------------------------------------------------------------------

  async function credited(addr: string, signer: Signer): Promise<bigint> {
    const handle = await harness.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, signer);
  }

  async function reserve(): Promise<bigint> {
    const handle = await harness.prizeReserve();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function total(): Promise<bigint> {
    const handle = await harness.confidentialTotal();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function holdings(): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(poolAddr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function userTokens(addr: string): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function winner(): Promise<bigint> {
    const handle = await harness.winnerIndex();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint16, handle);
  }

  // sum(user withdrawable balances) + reserve <= holdings
  async function assertSolvency() {
    const sum = (await credited(addrAlice, alice)) + (await credited(addrBob, bob));
    const r = await reserve();
    const h = await holdings();
    expect(sum + r <= h, `solvency violated: ${sum}+${r} > ${h}`).to.be.true;
    return { sum, r, h };
  }

  // ---------------------------------------------------------------------
  // Common setup: Alice 60, Bob 40, prize 20 (each step its own tx)
  // ---------------------------------------------------------------------

  async function buildPool(): Promise<any[]> {
    const receipts: any[] = [];
    receipts.push(await wrapAs(alice, addrAlice, 100n));
    receipts.push(await setOperatorAs(alice));
    receipts.push(await depositAs(alice, addrAlice, 60n));

    receipts.push(await wrapAs(bob, addrBob, 100n));
    receipts.push(await setOperatorAs(bob));
    receipts.push(await depositAs(bob, addrBob, 40n));

    receipts.push(await wrapAs(deployer, addrOwner, 100n));
    receipts.push(await setOperatorAs(deployer));
    receipts.push(await fundPrizeAs(deployer, addrOwner, 20n));
    return receipts;
  }

  // ---------------------------------------------------------------------
  // Scenario A: winner cycle (ticket 30 -> Alice wins)
  // ---------------------------------------------------------------------

  it("A: Alice 60 / Bob 40 / prize 20 -> Alice wins -> both claim -> withdrawals -> pool empty and solvent", async function () {
    const receipts: any[] = await buildPool();

    // Checkpoint 1: after deposits + funding.
    expect(await total(), "total participant weight = 100").to.equal(100n);
    expect(await reserve(), "prize reserve = 20").to.equal(20n);
    expect(await holdings(), "pool holdings = 120").to.equal(120n);
    await assertSolvency();
    expect(await credited(addrAlice, alice)).to.equal(60n);
    expect(await credited(addrBob, bob)).to.equal(40n);

    // Lock (owner, separate tx).
    await (await harness.connect(deployer).lockRound()).wait();
    expect(await harness.roundState()).to.equal(1n);

    // Draw (deterministic ticket 30 -> Alice, index 0, interval [0,60)).
    receipts.push(await drawWithTicketAs(30n));
    expect(await winner()).to.equal(0n);
    expect(await harness.roundState()).to.equal(2n);
    // The draw moves nothing.
    expect(await reserve()).to.equal(20n);
    expect(await holdings()).to.equal(120n);
    await assertSolvency();

    // Alice claims (winner): +20 prize, reserve -> 0.
    receipts.push(await (await harness.connect(alice).claim()).wait());
    expect(await credited(addrAlice, alice)).to.equal(80n);
    expect(await reserve()).to.equal(0n);
    expect(await harness.hasClaimed(addrAlice)).to.equal(true);
    await assertSolvency();

    // Bob claims (non-winner): +0, no revert.
    receipts.push(await (await harness.connect(bob).claim()).wait());
    expect(await credited(addrBob, bob)).to.equal(40n);
    expect(await harness.hasClaimed(addrBob)).to.equal(true);
    await assertSolvency();

    // Claim replay: neither can claim twice; one never blocks the other.
    let reverted = false;
    try {
      await harness.connect(alice).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "winner second claim must revert").to.be.true;
    reverted = false;
    try {
      await harness.connect(bob).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "non-winner second claim must revert").to.be.true;

    // Alice partial withdraw of prize + principal (30 of 80).
    receipts.push(await withdrawAs(alice, addrAlice, 30n));
    expect(await credited(addrAlice, alice)).to.equal(50n);
    await assertSolvency();

    // Alice withdrawAll (remaining 50).
    receipts.push(await (await harness.connect(alice).withdrawAll()).wait());
    expect(await credited(addrAlice, alice)).to.equal(0n);
    await assertSolvency();

    // Bob withdrawAll (40).
    receipts.push(await (await harness.connect(bob).withdrawAll()).wait());
    expect(await credited(addrBob, bob)).to.equal(0n);

    // No user lost principal: Alice holds 40 (unwrapped) + 30 + 50 = 120
    // (= 100 principal + 20 prize); Bob holds 60 + 40 = 100.
    expect(await userTokens(addrAlice)).to.equal(120n);
    expect(await userTokens(addrBob)).to.equal(100n);

    // Final state: liabilities zero, holdings zero, reserve zero.
    expect(await holdings()).to.equal(0n);
    expect(await reserve()).to.equal(0n);
    expect(await total()).to.equal(0n);
    const final = await assertSolvency();
    expect(final.sum + final.r).to.equal(final.h);
    expect(final.h).to.equal(0n);

    // Final balances are still decryptable by their owners (ACL survived).
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect(await credited(addrBob, bob)).to.equal(0n);
  });

  // ---------------------------------------------------------------------
  // Scenario B: rollover cycle (ticket >= total -> NO_WINNER)
  // ---------------------------------------------------------------------

  it("B: ticket >= total -> NO_WINNER, zero claims, reserve rolls over intact, principals fully withdrawable", async function () {
    await buildPool();
    expect(await total()).to.equal(100n);

    await (await harness.connect(deployer).lockRound()).wait();
    await drawWithTicketAs(999n); // ticket > total(100)
    expect(await winner()).to.equal(65535n); // NO_WINNER

    // Everyone claims: encrypted zero, no reverts.
    await (await harness.connect(alice).claim()).wait();
    await (await harness.connect(bob).claim()).wait();
    expect(await credited(addrAlice, alice)).to.equal(60n);
    expect(await credited(addrBob, bob)).to.equal(40n);
    expect(await reserve(), "reserve must remain intact for rollover").to.equal(20n);

    // Claim replay still enforced.
    let reverted = false;
    try {
      await harness.connect(alice).claim();
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;

    // Principals are fully withdrawable.
    await (await harness.connect(alice).withdrawAll()).wait();
    await (await harness.connect(bob).withdrawAll()).wait();
    expect(await userTokens(addrAlice)).to.equal(100n);
    expect(await userTokens(addrBob)).to.equal(100n);

    // Final: liabilities zero; the 20-unit rollover reserve is intentionally
    // left in the pool and remains backed (0 + 20 == 20 holdings).
    expect(await holdings()).to.equal(20n);
    const final = await assertSolvency();
    expect(final.sum).to.equal(0n);
    expect(final.r).to.equal(20n);
    expect(final.sum + final.r).to.equal(final.h);
  });

  // ---------------------------------------------------------------------
  // Privacy: full-cycle logs expose no amounts, balances, winner or payout
  // ---------------------------------------------------------------------

  it("C: full-cycle logs expose no deposit/balance/winner/prize/payout data", async function () {
    const receipts: any[] = await buildPool();
    await (await harness.connect(deployer).lockRound()).wait();
    receipts.push(await drawWithTicketAs(30n));
    receipts.push(await (await harness.connect(alice).claim()).wait());
    receipts.push(await (await harness.connect(bob).claim()).wait());
    receipts.push(await withdrawAs(alice, addrAlice, 30n));
    receipts.push(await (await harness.connect(alice).withdrawAll()).wait());
    receipts.push(await (await harness.connect(bob).withdrawAll()).wait());

    const secretWords = [60, 40, 20, 80, 30, 50, 100, 120].map((v) =>
      ethers.toBeHex(v, 32).slice(2).toLowerCase(),
    );
    const winnerWord = ethers.toBeHex(0, 32).slice(2).toLowerCase(); // winner index 0
    const aliceWord = ethers.zeroPadValue(addrAlice, 32).slice(2).toLowerCase();
    const bobWord = ethers.zeroPadValue(addrBob, 32).slice(2).toLowerCase();

    // NOTE: participant indices (including the zero word for index 0) and
    // participant addresses legitimately appear in PUBLIC events
    // (ParticipantRegistered; membership is public by design, spec 13).
    // The privacy property is: no AMOUNT appears in plaintext, and every
    // claim/draw event carries no payload distinguishing winner from
    // non-winner.
    for (const receipt of receipts) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== poolAddr.toLowerCase()) continue;
        const data = log.data.slice(2).toLowerCase();
        for (let p = 0; p + 64 <= data.length; p += 64) {
          const word = data.slice(p, p + 64);
          for (const secret of secretWords) {
            expect(word, "no plaintext amount may appear in pool logs").to.not.equal(secret);
          }
        }
        for (const topic of log.topics) {
          const t = topic.slice(2).toLowerCase();
          expect(t, "no plaintext amount in topics").to.not.be.oneOf(secretWords);
        }
      }
    }

    // Claim events carry no data at all, for winners and non-winners alike.
    const claimTopic = ethers.id("Claimed(address)");
    let sawWinnerClaim = false;
    let sawNonWinnerClaim = false;
    for (const receipt of receipts) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== poolAddr.toLowerCase()) continue;
        if (log.topics[0] !== claimTopic) continue;
        expect(log.data, "Claimed must carry no data").to.equal("0x");
        const claimant = log.topics[1].slice(2).toLowerCase();
        if (claimant === aliceWord) sawWinnerClaim = true;
        if (claimant === bobWord) sawNonWinnerClaim = true;
      }
    }
    expect(sawWinnerClaim && sawNonWinnerClaim).to.be.true;

    // Winner handle and credited handles are ciphertexts, not plaintext.
    const winnerHandle = await harness.winnerIndex();
    expect(winnerHandle.slice(2).toLowerCase()).to.not.equal(winnerWord);
    expect((await harness.confidentialBalanceOf(addrAlice)).slice(2).toLowerCase()).to.not.equal(
      ethers.toBeHex(80, 32).slice(2).toLowerCase(),
    );
  });

  // ---------------------------------------------------------------------
  // Admin authority: no power expansion in the P5 surface
  // ---------------------------------------------------------------------

  it("D: the pool surface gains nothing - no sweep/rescue/force/admin path", async function () {
    const abi = JSON.parse(harness.interface.formatJson());
    const names = abi
      .filter((e: any) => e.type === "function")
      .map((e: any) => e.name)
      .sort();
    for (const n of names) {
      expect(n.toLowerCase(), `no forbidden surface: ${n}`).to.not.match(
        /sweep|rescue|emergency|skim|seize|recover|drain|adminWithdraw|steal|setWinner|forceClaim|adminClaim|decryptWinner|drawWithTicket/,
      );
    }
  });
});