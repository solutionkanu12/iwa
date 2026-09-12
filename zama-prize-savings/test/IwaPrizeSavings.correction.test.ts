import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P9 - correction pass on the multi-round redesign (fix/prize-savings-multiround).
 *
 * ISSUE 1 (liveness): the original multi-round rollover trigger was
 * `claimedCount == participants.length` inside claim() - every participant,
 * including every LOSER, had to submit a transaction before an old round's
 * leftover reserve could roll forward. Fixed by settling the reserve
 * ENTIRELY AT DRAW TIME, entitlement-based rather than participation-based:
 * `_advanceRound` now computes, in encrypted space only (FHE.eq + FHE.select,
 * never decrypted, never branched on in plaintext), whether the round had a
 * winner. If it did, the amount rolled forward is an encrypted zero (the
 * round's own reserve is left completely untouched, forever claimable by
 * that winner via claim(roundId)). If it did not, the FULL reserve rolls
 * forward immediately, automatically, requiring nobody's participation.
 * This happens exactly once, deterministically, inside the same transaction
 * that opens the next round - no separate flag, no replay path.
 *
 * ISSUE 2 (join eligibility): joinRound() checked `FHE.isInitialized`,
 * i.e. "has this wallet EVER had a credited-balance handle written" - which
 * stays true forever after a single deposit, even across a full
 * withdrawAll(). Fixed with a plaintext, non-decrypting eligibility flag
 * (`_hasSavings`) set true on any deposit() and explicitly cleared on
 * withdrawAll() (a self-asserted, function-identity signal - never derived
 * from decrypting an amount).
 */
describe("P9 - liveness and eligibility corrections", function () {
  const NO_WINNER = 65535n;

  let deployer: Signer;
  let alice: Signer;
  let bob: Signer;
  let carol: Signer;
  let addrAlice: string;
  let addrBob: string;
  let addrCarol: string;
  let addrOwner: string;

  let mock: any;
  let wrapper: any;
  let pool: any;
  let wrapperAddr: string;
  let poolAddr: string;

  beforeEach(async function () {
    [deployer, alice, bob, carol] = await ethers.getSigners();
    addrAlice = await alice.getAddress();
    addrBob = await bob.getAddress();
    addrCarol = await carol.getAddress();
    addrOwner = await deployer.getAddress();

    mock = await (await ethers.getContractFactory("MockUSD")).deploy();
    await mock.waitForDeployment();
    const mockAddr = await mock.getAddress();

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

  async function depositTo(target: any, signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await target.getAddress(), addr)
      .add64(value)
      .encrypt();
    return (await target.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function saveAndJoin(target: any, signer: Signer, addr: string, value: bigint) {
    await mintAndWrapAs(signer, addr, value);
    await setOperatorAs(signer, await target.getAddress());
    await depositTo(target, signer, addr, value);
    return (await target.connect(signer).joinRound()).wait();
  }

  async function fundPrizeOn(target: any, signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await target.getAddress(), addr)
      .add64(value)
      .encrypt();
    return (await target.connect(signer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function credited(target: any, addr: string, signer: Signer): Promise<bigint> {
    const handle = await target.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, await target.getAddress(), signer);
  }

  async function reserveOf(target: any, roundId: bigint): Promise<bigint> {
    const handle = await target.prizeReserveOf(roundId);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function winnerOf(target: any, roundId: bigint): Promise<bigint> {
    const handle = await target.winnerIndexOf(roundId);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint16, handle);
  }

  async function deployHarness() {
    const h: any = await (await ethers.getContractFactory("TestDrawHarness")).deploy(wrapperAddr);
    await h.waitForDeployment();
    return h;
  }

  async function drawWithTicketOn(h: any, ticket: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await h.getAddress(), addrOwner)
      .add64(ticket)
      .encrypt();
    await (await h.connect(deployer).lockRound()).wait();
    return (await h.connect(deployer).drawWithTicket(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  // =======================================================================
  // ISSUE 1: LIVENESS
  // =======================================================================

  it("L1: non-winners never need to call claim - a no-winner round's reserve rolls over with zero claims submitted", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await saveAndJoin(h, bob, addrBob, 20n);
    await mintAndWrapAs(deployer, addrOwner, 50n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 50n);

    await drawWithTicketOn(h, 999n); // beyond total(30) -> NO_WINNER
    expect(await winnerOf(h, 1n)).to.equal(NO_WINNER);

    // Nobody has claimed anything at all, yet the reserve has already
    // rolled forward into round 2.
    expect(await reserveOf(h, 1n)).to.equal(0n);
    expect(await reserveOf(h, 2n)).to.equal(50n);
  });

  it("L2: one permanently inactive loser cannot block rollover or later rounds", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await saveAndJoin(h, bob, addrBob, 20n); // bob will NEVER claim, ever
    await mintAndWrapAs(deployer, addrOwner, 50n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 50n);

    await drawWithTicketOn(h, 999n); // NO_WINNER
    // Round 2, 3, 4 all proceed normally without bob ever touching claim().
    for (let i = 0; i < 3; i++) {
      await (await h.connect(deployer).lockRound()).wait();
      await (await h.connect(deployer).draw()).wait();
    }
    expect(await h.currentRoundId()).to.equal(5n);
    expect(await reserveOf(h, 1n)).to.equal(0n);
  });

  it("L3: the winner can still claim after several later rounds have opened, with no non-winner ever claiming", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n); // sole participant -> wins
    await drawWithTicketOn(h, 0n);
    expect(await winnerOf(h, 1n)).to.equal(0n);

    // Advance several more rounds without anyone claiming round 1.
    for (let i = 0; i < 3; i++) {
      await (await h.connect(deployer).lockRound()).wait();
      await (await h.connect(deployer).draw()).wait();
    }
    expect(await h.currentRoundId()).to.equal(5n);

    // The round 1 winner claims now, long after round 1 finished.
    await (await h.connect(alice).claim(1n)).wait();
    expect(await h.hasClaimedRound(1n, addrAlice)).to.equal(true);
  });

  it("L4: an unclaimed winning prize is never rolled away by later round transitions", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n); // sole participant -> wins
    await mintAndWrapAs(deployer, addrOwner, 40n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 40n);
    await drawWithTicketOn(h, 0n);
    expect(await winnerOf(h, 1n)).to.equal(0n);

    // Round 2 opens automatically. Round 1's reserve must be UNTOUCHED -
    // never rolled into round 2 - because a winner exists and has not
    // claimed. This is the core of issue 1: the OLD contract could not
    // distinguish "no winner" from "unclaimed winner" without a claim.
    expect(await reserveOf(h, 1n), "unclaimed winner's prize must stay put").to.equal(40n);
    expect(await reserveOf(h, 2n), "must not receive an unclaimed winner's prize").to.equal(0n);

    // Advance a few more rounds. Still untouched.
    await (await h.connect(deployer).lockRound()).wait();
    await (await h.connect(deployer).draw()).wait();
    expect(await reserveOf(h, 1n)).to.equal(40n);

    // The winner claims, finally, at round 3.
    await (await h.connect(alice).claim(1n)).wait();
    expect(await credited(h, addrAlice, alice)).to.equal(50n); // 10 principal + 40 prize
    expect(await reserveOf(h, 1n)).to.equal(0n);
  });

  it("L5: a no-winner round's reserve rolls over exactly once per transition, never duplicated across further rounds", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await mintAndWrapAs(deployer, addrOwner, 30n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 30n);
    await drawWithTicketOn(h, 999n); // NO_WINNER
    expect(await reserveOf(h, 2n)).to.equal(30n);
    expect(await reserveOf(h, 1n)).to.equal(0n);

    // Advance several more empty rounds (no funding, no participants). Each
    // one is ALSO a no-winner round by construction (nobody to select), so
    // the 30 legitimately keeps flowing forward one round at a time - it
    // must never appear in two rounds at once (duplication), and the sum
    // across every round must stay exactly 30 at every step.
    for (let i = 0; i < 3; i++) {
      await (await h.connect(deployer).lockRound()).wait();
      await (await h.connect(deployer).draw()).wait();
      const cur = await h.currentRoundId();
      let sum = 0n;
      for (let r = 1n; r <= cur; r++) sum += await reserveOf(h, r);
      expect(sum, `no duplication at round ${cur}`).to.equal(30n);
    }
    expect(await h.currentRoundId()).to.equal(5n);
    expect(await reserveOf(h, 5n), "settled in the final current round").to.equal(30n);
    expect(await reserveOf(h, 1n)).to.equal(0n);
    expect(await reserveOf(h, 2n)).to.equal(0n);
    expect(await reserveOf(h, 3n)).to.equal(0n);
    expect(await reserveOf(h, 4n)).to.equal(0n);
  });

  it("L6: rollover cannot be replayed - no externally callable rollover function exists to invoke twice", async function () {
    const abi = JSON.parse(pool.interface.formatJson());
    const names = abi.filter((e: any) => e.type === "function").map((e: any) => e.name);
    // Settlement is now fully automatic (inside draw()'s internal advance),
    // not a separately callable, and therefore not separately replayable,
    // function.
    expect(names).to.not.include("rollover");
    expect(names).to.not.include("settleReserve");
    expect(names).to.not.include("rolloverIfNoWinner");
  });

  it("L7: claim() remains fully optional for a non-winner and has no side effect on other rounds", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await saveAndJoin(h, bob, addrBob, 20n);
    await drawWithTicketOn(h, 5n); // alice (index 0) wins

    // Bob (non-winner) never claims. Nothing breaks; alice can still claim.
    await (await h.connect(alice).claim(1n)).wait();
    expect(await credited(h, addrAlice, alice)).to.equal(10n); // no prize funded
    expect(await h.hasClaimedRound(1n, addrBob)).to.equal(false);
  });

  // =======================================================================
  // ISSUE 2: JOIN ELIGIBILITY MUST USE CURRENT SAVINGS
  // =======================================================================

  it("E1: a user with current principal can join", async function () {
    await mintAndWrapAs(alice, addrAlice, 50n);
    await setOperatorAs(alice, poolAddr);
    await depositTo(pool, alice, addrAlice, 50n);

    await (await pool.connect(alice).joinRound()).wait();
    expect(await pool.isParticipant(addrAlice)).to.equal(true);
  });

  it("E2: deposit then withdrawAll then join is REJECTED - historical deposit activity alone is insufficient", async function () {
    await mintAndWrapAs(alice, addrAlice, 50n);
    await setOperatorAs(alice, poolAddr);
    await depositTo(pool, alice, addrAlice, 50n);
    await (await pool.connect(alice).withdrawAll()).wait();
    expect(await credited(pool, addrAlice, alice)).to.equal(0n);

    let reverted = false;
    try {
      await pool.connect(alice).joinRound();
    } catch {
      reverted = true;
    }
    expect(reverted, "a fully withdrawn wallet must not be able to join").to.be.true;
    expect(await pool.isParticipant(addrAlice)).to.equal(false);
  });

  it("E3: re-depositing after a full withdrawal restores eligibility", async function () {
    await mintAndWrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice, poolAddr);
    await depositTo(pool, alice, addrAlice, 50n);
    await (await pool.connect(alice).withdrawAll()).wait();

    await depositTo(pool, alice, addrAlice, 20n);
    await (await pool.connect(alice).joinRound()).wait();
    expect(await pool.isParticipant(addrAlice)).to.equal(true);
  });

  it("E4: next-round eligibility is recalculated from current state, not carried over", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 0n); // round 2 opens

    // Alice withdraws everything AFTER round 1, before round 2 rejoin.
    await (await h.connect(alice).withdrawAll()).wait();
    let reverted = false;
    try {
      await h.connect(alice).joinRound();
    } catch {
      reverted = true;
    }
    expect(reverted, "round 2 eligibility must reflect current (zero) savings").to.be.true;
  });

  it("E5: the participant cap remains per-round after the eligibility fix", async function () {
    const signers = await ethers.getSigners();
    for (let i = 0; i < 16; i++) {
      const w = signers[i + 4];
      await saveAndJoin(pool, w, await w.getAddress(), 5n);
    }
    expect(await pool.participantCount()).to.equal(16n);

    // A 17th wallet WITH genuine current savings is still rejected - the
    // cap, not eligibility, is what blocks them.
    await mintAndWrapAs(alice, addrAlice, 50n);
    await setOperatorAs(alice, poolAddr);
    await depositTo(pool, alice, addrAlice, 50n);
    let reverted = false;
    let message = "";
    try {
      await pool.connect(alice).joinRound();
    } catch (err: any) {
      reverted = true;
      message = String(err?.message ?? "");
    }
    expect(reverted).to.be.true;
    expect(message).to.contain("round full");
  });

  it("E6: no privacy-revealing public balance amount is introduced - eligibility is a plain boolean, never an amount", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );
    expect(source).to.not.contain("makePubliclyDecryptable");
    expect(source).to.not.contain("allowForDecryption");
    expect(source).to.not.contain("checkSignatures");

    // The eligibility view, if present, must return a bool, never a euint*.
    const abi = JSON.parse(pool.interface.formatJson());
    const eligibilityFn = abi.find(
      (e: any) => e.type === "function" && /savings|eligib/i.test(e.name),
    );
    if (eligibilityFn !== undefined) {
      expect(eligibilityFn.outputs[0].type).to.equal("bool");
    }
  });

  it("E7: withdrawing after joining still follows the existing live-balance weighting model (unchanged)", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 100n);
    const encrypted = await fhevm
      .createEncryptedInput(await h.getAddress(), addrAlice)
      .add64(40n)
      .encrypt();
    await (await h.connect(alice).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();

    await drawWithTicketOn(h, 60n); // == reduced weight (60) -> NO_WINNER, no wraparound
    expect(await winnerOf(h, 1n)).to.equal(NO_WINNER);
    // Alice is still a participant of round 1 even though she partially
    // withdrew after joining - eligibility is checked only at join time.
    expect(await h.isParticipantInRound(1n, addrAlice)).to.equal(true);
  });
});
