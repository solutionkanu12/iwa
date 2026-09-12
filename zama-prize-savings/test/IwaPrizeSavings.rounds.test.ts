import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P8 - multi-round lifecycle tests for IwaPrizeSavings.
 *
 * Turns the single-round bounty MVP (Open -> Locked -> Drawn -> Claimable,
 * terminal) into a recurring pool: Round 1 -> Round 2 -> Round 3 -> ...,
 * indefinitely, with NO permanent terminal state.
 *
 * Core redesign under test:
 *   - roundId starts at 1 and increases by exactly one, automatically, the
 *     instant draw() runs (in the SAME transaction as Locked -> Drawn).
 *   - Participants, claim flags, winner index, draw ticket and prize
 *     reserve are all PER-ROUND storage - a round's own history stays
 *     addressable by its roundId forever, independent of currentRoundId.
 *   - deposit() (save principal) and joinRound() (opt into the CURRENT
 *     round) are separate, explicit actions. Principal is lifetime and
 *     survives every round transition untouched.
 *   - claim(roundId) identifies which round's prize is being claimed, so a
 *     Round 1 winner can still claim Round 1 after Round 2 (or later) has
 *     opened.
 *   - An unclaimed/no-winner reserve rolls forward into a later round only
 *     once every one of that round's participants has claimed (the point at
 *     which, by construction, the reserve is provably either fully paid or
 *     fully intact) - never before, so it can never race an outstanding
 *     winner claim.
 */
describe("P8 - IwaPrizeSavings multi-round lifecycle", function () {
  const NO_WINNER = 65535n;
  const Open = 0n, Locked = 1n, Drawn = 2n, Claimable = 3n;

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
  let harness: any;
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

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

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

  async function withdrawFrom(target: any, signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await target.getAddress(), addr)
      .add64(value)
      .encrypt();
    return (await target.connect(signer).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();
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

  async function total(target: any): Promise<bigint> {
    const handle = await target.confidentialTotal();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function holdingsOf(target: any): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(await target.getAddress());
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
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
  // ROUND CREATION / ADVANCE
  // =======================================================================

  it("R1: initial roundId is 1 and Round 1 is Open", async function () {
    expect(await pool.currentRoundId()).to.equal(1n);
    expect(await pool.roundState()).to.equal(Open);
  });

  it("R2: completing Round 1's draw opens Round 2 automatically, in the same transaction", async function () {
    await saveAndJoin(pool, alice, addrAlice, 50n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    expect(await pool.currentRoundId()).to.equal(2n);
    expect(await pool.roundState()).to.equal(Open); // Round 2 is open
    expect(await pool.roundStateOf(1n)).to.equal(Drawn); // Round 1 is historical
  });

  it("R3: roundId increments by exactly one per draw, never skips, never rewinds", async function () {
    for (let i = 0; i < 3; i++) {
      const before = await pool.currentRoundId();
      await pool.connect(deployer).lockRound();
      await (await pool.connect(deployer).draw()).wait();
      expect(await pool.currentRoundId()).to.equal(before + 1n);
    }
    expect(await pool.currentRoundId()).to.equal(4n);
    // No function can rewind or set roundId directly.
    const abi = JSON.parse(pool.interface.formatJson());
    const names = abi.filter((e: any) => e.type === "function").map((e: any) => e.name);
    expect(names).to.not.include("setRoundId");
    expect(names).to.not.include("rewindRound");
  });

  it("R4: a new round's participant count starts at zero", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    expect(await pool.participantCount()).to.equal(1n);

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    expect(await pool.currentRoundId()).to.equal(2n);
    expect(await pool.participantCount()).to.equal(0n); // fresh round
    expect(await pool.roundParticipantCount(1n)).to.equal(1n); // history intact
  });

  it("R5: there is no permanent terminal state for the whole pool - deposits and joins reopen every round", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    await (await pool.connect(alice).claim(1n)).wait();

    // Round 1 is fully settled (Claimable), yet the pool is open again.
    expect(await pool.roundStateOf(1n)).to.equal(Claimable);
    expect(await pool.roundState()).to.equal(Open);
    // A brand new user can deposit and join right now.
    await saveAndJoin(pool, bob, addrBob, 20n);
    expect(await pool.isParticipant(addrBob)).to.equal(true);
  });

  // =======================================================================
  // PARTICIPANTS
  // =======================================================================

  it("P1: a user must explicitly join - depositing alone does not enter the round", async function () {
    await mintAndWrapAs(alice, addrAlice, 50n);
    await setOperatorAs(alice, poolAddr);
    await depositTo(pool, alice, addrAlice, 50n);

    expect(await pool.isParticipant(addrAlice)).to.equal(false);
    expect(await pool.participantCount()).to.equal(0n);

    await (await pool.connect(alice).joinRound()).wait();
    expect(await pool.isParticipant(addrAlice)).to.equal(true);
    expect(await pool.participantCount()).to.equal(1n);
  });

  it("P2: a user cannot join twice in the same round", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    let reverted = false;
    try {
      await pool.connect(alice).joinRound();
    } catch {
      reverted = true;
    }
    expect(reverted, "second join in the same round must revert").to.be.true;
    expect(await pool.participantCount()).to.equal(1n);
  });

  it("P3: the same user may join the next round again after re-opting-in", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    expect(await pool.isParticipant(addrAlice), "not auto-entered into round 2").to.equal(false);
    await (await pool.connect(alice).joinRound()).wait();
    expect(await pool.isParticipant(addrAlice)).to.equal(true);
    expect(await pool.isParticipantInRound(1n, addrAlice)).to.equal(true); // history intact
  });

  it("P4: a brand new user may join a later round without ever touching round 1", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    await saveAndJoin(pool, bob, addrBob, 5n);
    expect(await pool.isParticipant(addrBob)).to.equal(true);
    expect(await pool.isParticipantInRound(1n, addrBob)).to.equal(false);
  });

  it("P5 + P6: 16 participants accepted per round, the 17th rejected, and the NEXT round again allows 16", async function () {
    const signers = await ethers.getSigners();
    for (let i = 0; i < 16; i++) {
      const w = signers[i + 4];
      await saveAndJoin(pool, w, await w.getAddress(), 5n);
    }
    expect(await pool.participantCount()).to.equal(16n);

    const wallet17 = bob; // never used in the fill loop above (indices 4..19)
    await mintAndWrapAs(wallet17, addrBob, 5n);
    await setOperatorAs(wallet17, poolAddr);
    await depositTo(pool, wallet17, addrBob, 5n);
    let reverted = false;
    try {
      await pool.connect(wallet17).joinRound();
    } catch {
      reverted = true;
    }
    expect(reverted, "17th joiner in one round must revert").to.be.true;
    expect(await pool.participantCount()).to.equal(16n);

    // Next round again allows up to 16 fresh slots - the cap resets per
    // round, it is not a lifetime allowance. Fill it with 15 of the
    // original wallets plus wallet17 (who was rejected ONLY from round 1),
    // proving round 2's cap is independent of round 1's history.
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    for (let i = 0; i < 15; i++) {
      const w = signers[i + 4];
      await (await pool.connect(w).joinRound()).wait();
    }
    await (await pool.connect(wallet17).joinRound()).wait();
    expect(await pool.participantCount()).to.equal(16n); // fresh 16-slot cap, not 17

    // The cap still binds within round 2 itself.
    const lastOriginal = signers[19];
    let reverted2 = false;
    try {
      await pool.connect(lastOriginal).joinRound();
    } catch {
      reverted2 = true;
    }
    expect(reverted2, "round 2's own 16-slot cap must still bind").to.be.true;
  });

  it("P7: lifetime unique-user count no longer bricks the pool (the old F1 permanent-slot DoS is bounded per round)", async function () {
    // 16 distinct zero-transfer wallets fill round 1 - the old contract
    // would brick the pool forever. Here, round 2 starts with an empty set.
    const signers = await ethers.getSigners();
    for (let i = 0; i < 16; i++) {
      const w = signers[i + 4];
      const addr = await w.getAddress();
      await setOperatorAs(w, poolAddr);
      const e = await fhevm.createEncryptedInput(poolAddr, addr).add64(100n).encrypt(); // no balance to actually pull
      await (await pool.connect(w).deposit(e.handles[0], e.inputProof)).wait();
      await (await pool.connect(w).joinRound()).wait();
    }
    expect(await pool.participantCount()).to.equal(16n);

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    // A brand new, never-before-seen wallet (never used in the fill loop
    // above, which only touched indices 4..19) joins round 2 without issue.
    await saveAndJoin(pool, alice, addrAlice, 10n);
    expect(await pool.isParticipant(addrAlice)).to.equal(true);
    expect(await pool.participantCount()).to.equal(1n);
  });

  // =======================================================================
  // PRINCIPAL
  // =======================================================================

  it("PR1: principal survives a round transition untouched", async function () {
    await saveAndJoin(pool, alice, addrAlice, 40n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    expect(await credited(pool, addrAlice, alice)).to.equal(40n);
  });

  it("PR2: principal remains withdrawable across round advances", async function () {
    await saveAndJoin(pool, alice, addrAlice, 40n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    await withdrawFrom(pool, alice, addrAlice, 40n);
    expect(await credited(pool, addrAlice, alice)).to.equal(0n);
  });

  it("PR3: starting a new round does not reset any user's credited balance", async function () {
    await saveAndJoin(pool, alice, addrAlice, 40n);
    await saveAndJoin(pool, bob, addrBob, 25n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    expect(await credited(pool, addrAlice, alice)).to.equal(40n);
    expect(await credited(pool, addrBob, bob)).to.equal(25n);
    expect(await total(pool)).to.equal(65n);
  });

  it("PR4: losing a round does not consume principal", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await saveAndJoin(h, bob, addrBob, 20n);
    await drawWithTicketOn(h, 15n); // interval [10,30) -> bob wins

    await (await h.connect(alice).claim(1n)).wait(); // alice loses
    expect(await credited(h, addrAlice, alice)).to.equal(10n); // untouched
  });

  it("PR5: winning credits exactly the prize on top of untouched principal", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await saveAndJoin(h, bob, addrBob, 20n);
    await mintAndWrapAs(deployer, addrOwner, 60n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 60n);
    await drawWithTicketOn(h, 15n); // bob wins

    await (await h.connect(bob).claim(1n)).wait();
    expect(await credited(h, addrBob, bob)).to.equal(80n); // 20 principal + 60 prize
  });

  // =======================================================================
  // CLAIMS ACROSS ROUNDS
  // =======================================================================

  it("C1: a Round 1 claimant can claim after Round 2 has opened", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n); // alice (only participant) wins her own weight
    expect(await h.currentRoundId()).to.equal(2n);

    await (await h.connect(alice).claim(1n)).wait(); // claiming round 1 after round 2 opened
    expect(await h.hasClaimedRound(1n, addrAlice)).to.equal(true);
  });

  it("C2: a Round 1 claim does not mark Round 2 claimed for the same user", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);
    await (await h.connect(alice).claim(1n)).wait();

    expect(await h.hasClaimedRound(1n, addrAlice)).to.equal(true);
    expect(await h.hasClaimedRound(2n, addrAlice)).to.equal(false);
  });

  it("C3: a Round 2 winner can claim independently of Round 1's claim state", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n); // round 1 drawn, round 2 open
    // Deliberately do NOT claim round 1 yet.

    await (await h.connect(alice).joinRound()).wait(); // opt into round 2
    await mintAndWrapAs(deployer, addrOwner, 40n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 40n);
    await drawWithTicketOn(h, 0n); // round 2 drawn (alice sole participant, wins)

    await (await h.connect(alice).claim(2n)).wait();
    expect(await h.hasClaimedRound(2n, addrAlice)).to.equal(true);
    expect(await h.hasClaimedRound(1n, addrAlice), "round 1 claim untouched").to.equal(false);

    // The still-outstanding round 1 claim remains fully valid.
    await (await h.connect(alice).claim(1n)).wait();
    expect(await h.hasClaimedRound(1n, addrAlice)).to.equal(true);
  });

  it("C4: double claim on the same round is rejected", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);
    await (await h.connect(alice).claim(1n)).wait();

    let reverted = false;
    try {
      await h.connect(alice).claim(1n);
    } catch {
      reverted = true;
    }
    expect(reverted, "double claim on the same round must revert").to.be.true;
  });

  it("C5: a wrong user (never a participant in that round) is rejected", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);

    let reverted = false;
    try {
      await h.connect(bob).claim(1n); // bob never joined round 1
    } catch {
      reverted = true;
    }
    expect(reverted, "non-participant claim must revert").to.be.true;
  });

  it("C6: claiming a round id that does not exist yet is rejected", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    let reverted = false;
    try {
      await pool.connect(alice).claim(99n);
    } catch {
      reverted = true;
    }
    expect(reverted, "claiming a future/nonexistent round must revert").to.be.true;
  });

  it("C7: claiming a round still Open or Locked is rejected (wrong-state round)", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    let reverted = false;
    try {
      await pool.connect(alice).claim(1n); // round 1 still Open
    } catch {
      reverted = true;
    }
    expect(reverted, "claim on an Open round must revert").to.be.true;

    await pool.connect(deployer).lockRound();
    reverted = false;
    try {
      await pool.connect(alice).claim(1n); // round 1 Locked, not yet drawn
    } catch {
      reverted = true;
    }
    expect(reverted, "claim on a Locked round must revert").to.be.true;
  });

  it("C8: historical claim state is preserved across many subsequent rounds", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);
    await (await h.connect(alice).claim(1n)).wait();

    // Advance several more empty rounds.
    for (let i = 0; i < 3; i++) {
      await (await h.connect(deployer).lockRound()).wait();
      await (await h.connect(deployer).draw()).wait();
    }
    expect(await h.currentRoundId()).to.equal(5n);
    expect(await h.hasClaimedRound(1n, addrAlice)).to.equal(true);
  });

  // =======================================================================
  // DRAW independence
  // =======================================================================

  it("D1: each round draws independently - different winners across rounds", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await saveAndJoin(h, bob, addrBob, 20n);
    await drawWithTicketOn(h, 5n); // [0,10) -> alice (index 0)
    expect(await winnerOf(h, 1n)).to.equal(0n);

    await (await h.connect(alice).joinRound()).wait();
    await (await h.connect(bob).joinRound()).wait();
    await drawWithTicketOn(h, 15n); // [10,30) -> bob (index 1)
    expect(await winnerOf(h, 2n)).to.equal(1n);
  });

  it("D2: winner state from a prior round does not leak into the next round's fresh winner slot", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);
    expect(await winnerOf(h, 1n)).to.equal(0n);

    // Round 2 has zero participants and is drawn with an out-of-range ticket.
    await (await h.connect(deployer).lockRound()).wait();
    const encrypted = await fhevm.createEncryptedInput(await h.getAddress(), addrOwner).add64(0n).encrypt();
    await (await h.connect(deployer).drawWithTicket(encrypted.handles[0], encrypted.inputProof)).wait();
    expect(await winnerOf(h, 2n)).to.equal(NO_WINNER); // NOT round 1's winner
  });

  it("D3: the weighted selection uses ONLY the current round's participants", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 100n); // huge weight, round 1 only
    await drawWithTicketOn(h, 0n);

    await saveAndJoin(h, bob, addrBob, 10n); // round 2: only bob joins
    await drawWithTicketOn(h, 5n); // must resolve against bob alone
    expect(await winnerOf(h, 2n)).to.equal(0n); // bob is index 0 of round 2
  });

  it("D4: round 1 participants are not automatically entered into round 2's draw", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);

    // Round 2: alice does NOT rejoin. Only bob joins.
    await saveAndJoin(h, bob, addrBob, 10n);
    await drawWithTicketOn(h, 5n);
    expect(await h.roundParticipantCount(2n)).to.equal(1n);
    expect(await h.isParticipantInRound(2n, addrAlice)).to.equal(false);
  });

  // =======================================================================
  // ROLLOVER
  // =======================================================================

  it("RO1: a no-winner round's reserve rolls over once fully claimed, and is available to a later round's winner", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await saveAndJoin(h, bob, addrBob, 20n);
    await mintAndWrapAs(deployer, addrOwner, 50n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 50n);
    await drawWithTicketOn(h, 999n); // beyond total(30) -> NO_WINNER
    expect(await winnerOf(h, 1n)).to.equal(NO_WINNER);

    // Nobody has claimed yet: reserve must NOT have rolled over prematurely.
    expect(await reserveOf(h, 1n)).to.equal(50n);
    expect(await reserveOf(h, 2n)).to.equal(0n);

    await (await h.connect(alice).claim(1n)).wait();
    expect(await reserveOf(h, 1n), "not yet fully claimed").to.equal(50n);
    await (await h.connect(bob).claim(1n)).wait(); // last claimant -> triggers rollover

    expect(await reserveOf(h, 1n)).to.equal(0n);
    expect(await reserveOf(h, 2n), "rolled forward intact").to.equal(50n);

    // A round-2 winner can receive the rolled-over reserve.
    await (await h.connect(alice).joinRound()).wait();
    await drawWithTicketOn(h, 0n); // alice sole participant, wins
    await (await h.connect(alice).claim(2n)).wait();
    expect(await credited(h, addrAlice, alice)).to.equal(60n); // 10 principal + 50 rolled prize
  });

  it("RO2: the reserve is never duplicated across the transition", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await mintAndWrapAs(deployer, addrOwner, 30n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 30n);
    await drawWithTicketOn(h, 999n); // NO_WINNER (only participant weight 10)
    await (await h.connect(alice).claim(1n)).wait(); // fully claimed -> rolls over

    expect(await reserveOf(h, 1n)).to.equal(0n);
    expect(await reserveOf(h, 2n)).to.equal(30n);
    // Total pool holdings still reconcile: 10 principal + 30 reserve.
    expect(await holdingsOf(h)).to.equal(40n);
  });

  it("RO3: a zero-participant round rolls its reserve over immediately (nobody could ever claim it)", async function () {
    const h = await deployHarness();
    await mintAndWrapAs(deployer, addrOwner, 15n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 15n); // funded, but nobody joins
    await drawWithTicketOn(h, 0n); // 0 participants

    expect(await h.roundParticipantCount(1n)).to.equal(0n);
    expect(await reserveOf(h, 1n)).to.equal(0n); // rolled immediately
    expect(await reserveOf(h, 2n)).to.equal(15n);
  });

  it("RO4: a winner's claim does not over-pay from a reserve inflated by a later round's funding", async function () {
    // Round 1 has an outstanding winner (not yet claimed). Round 2 opens and
    // is funded with its OWN prize. Round 1's winner must receive exactly
    // round 1's reserve, never round 2's.
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeOn(h, deployer, addrOwner, 40n); // round 1 prize = 40
    await drawWithTicketOn(h, 0n); // alice (sole participant) wins round 1

    // Round 2 opens; fund it separately with 25, distinct from round 1's 40.
    await fundPrizeOn(h, deployer, addrOwner, 25n);
    expect(await reserveOf(h, 1n)).to.equal(40n);
    expect(await reserveOf(h, 2n)).to.equal(25n);

    // Round 1's winner claims now, after round 2 was already funded.
    await (await h.connect(alice).claim(1n)).wait();
    expect(await credited(h, addrAlice, alice)).to.equal(50n); // 10 + 40, NOT 10+65
    expect(await reserveOf(h, 2n), "round 2's own funding must be untouched").to.equal(25n);
  });

  // =======================================================================
  // WITHDRAWAL
  // =======================================================================

  it("W1: withdrawal remains possible in every round state, including across a round transition", async function () {
    await saveAndJoin(pool, alice, addrAlice, 40n);
    await pool.connect(deployer).lockRound();
    await withdrawFrom(pool, alice, addrAlice, 10n); // Locked
    await (await pool.connect(deployer).draw()).wait(); // -> round 2 opens
    await withdrawFrom(pool, alice, addrAlice, 10n); // still fine, round 2 Open

    expect(await credited(pool, addrAlice, alice)).to.equal(20n);
  });

  it("W2: withdrawal does not corrupt historical round state", async function () {
    await saveAndJoin(pool, alice, addrAlice, 40n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    await withdrawFrom(pool, alice, addrAlice, 40n);
    expect(await pool.isParticipantInRound(1n, addrAlice), "withdrawal must not unregister participation").to.equal(true);
    expect(await pool.roundParticipantCount(1n)).to.equal(1n);
  });

  it("W3: withdrawing everything does not falsely unregister historical participation", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);
    await (await h.connect(alice).withdrawAll()).wait();

    // Alice can still claim round 1 even with zero current principal.
    await (await h.connect(alice).claim(1n)).wait();
    expect(await h.hasClaimedRound(1n, addrAlice)).to.equal(true);
  });

  // =======================================================================
  // SECURITY-adjacent
  // =======================================================================

  it("S1: the owner cannot seize or redirect principal via any round-transition path", async function () {
    await saveAndJoin(pool, alice, addrAlice, 40n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    const abi = JSON.parse(pool.interface.formatJson());
    const names = abi.filter((e: any) => e.type === "function").map((e: any) => e.name);
    for (const n of names) {
      expect(n.toLowerCase(), `no forbidden surface: ${n}`).to.not.match(
        /sweep|rescue|emergency|skim|seize|recover|drain|adminwithdraw|steal|setwinner|forceclaim|adminclaim|setroundid|rewindround/,
      );
    }
    expect(await credited(pool, addrAlice, alice)).to.equal(40n);
  });

  it("S2: a participant cannot manipulate NEXT round membership from the current round", async function () {
    await saveAndJoin(pool, alice, addrAlice, 10n);
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    // Alice is NOT auto-joined into round 2 just because she was in round 1.
    expect(await pool.isParticipant(addrAlice)).to.equal(false);
  });

  it("S3: historical round data cannot mutate the current round's state", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);
    await (await h.connect(alice).claim(1n)).wait(); // touches round 1 only

    expect(await h.roundState()).to.equal(Open); // round 2 untouched
    expect(await h.participantCount()).to.equal(0n);
  });

  it("S4: the current round cannot overwrite a prior round's claim entitlement", async function () {
    const h = await deployHarness();
    await saveAndJoin(h, alice, addrAlice, 10n);
    await drawWithTicketOn(h, 5n);
    // Round 2 activity happens before round 1 is claimed.
    await (await h.connect(alice).joinRound()).wait();
    await drawWithTicketOn(h, 0n);

    // Round 1's claim is still exactly as it was.
    expect(await winnerOf(h, 1n)).to.equal(0n);
    await (await h.connect(alice).claim(1n)).wait();
    expect(await h.hasClaimedRound(1n, addrAlice)).to.equal(true);
  });

  // =======================================================================
  // Randomized multi-round property-style sequence (see report: no new fuzz
  // framework added - this drives the same deposit/join/lock/draw/claim/
  // withdraw surface through many pseudo-random sequences and re-checks the
  // stated invariants after every step).
  // =======================================================================

  it("PROP: randomized multi-round sequences preserve conservation and per-round isolation invariants", async function () {
    // Deterministic PRNG (mulberry32) so failures are reproducible.
    function prng(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rand = prng(42);

    const h = await deployHarness();
    const signers = (await ethers.getSigners()).slice(4, 8); // 4 actors
    const addrs = await Promise.all(signers.map((s) => s.getAddress()));

    let seenRoundIds: bigint[] = [1n];

    for (let round = 0; round < 4; round++) {
      const currentRoundId: bigint = await h.currentRoundId();
      expect(
        currentRoundId > seenRoundIds[seenRoundIds.length - 1] - 1n,
        "roundId strictly increases",
      ).to.be.true;
      seenRoundIds.push(currentRoundId);

      // Random subset deposits + joins this round.
      const joiners: number[] = [];
      for (let i = 0; i < signers.length; i++) {
        if (rand() < 0.6) {
          const amount = BigInt(1 + Math.floor(rand() * 30));
          await mintAndWrapAs(signers[i], addrs[i], amount);
          await setOperatorAs(signers[i], await h.getAddress());
          await depositTo(h, signers[i], addrs[i], amount);
          await (await h.connect(signers[i]).joinRound()).wait();
          joiners.push(i);
        }
      }
      expect(await h.roundParticipantCount(currentRoundId)).to.equal(BigInt(joiners.length));
      expect(
        (await h.roundParticipantCount(currentRoundId)) <= 16n,
        "per-round cap holds",
      ).to.be.true;

      // Optional prize funding.
      if (rand() < 0.5) {
        const prize = BigInt(1 + Math.floor(rand() * 20));
        await mintAndWrapAs(deployer, addrOwner, prize);
        await setOperatorAs(deployer, await h.getAddress());
        await fundPrizeOn(h, deployer, addrOwner, prize);
      }

      // Draw with a pseudo-random ticket.
      const ticket = BigInt(Math.floor(rand() * 200));
      await drawWithTicketOn(h, ticket);
      expect(await h.currentRoundId()).to.equal(currentRoundId + 1n);

      // Everyone who joined claims (in random order) at most once.
      const order = [...joiners].sort(() => rand() - 0.5);
      for (const i of order) {
        await (await h.connect(signers[i]).claim(currentRoundId)).wait();
        expect(await h.hasClaimedRound(currentRoundId, addrs[i])).to.equal(true);
        // At most once per round: a second claim call reverts.
        let reverted = false;
        try {
          await h.connect(signers[i]).claim(currentRoundId);
        } catch {
          reverted = true;
        }
        expect(reverted, "claim at most once per round").to.be.true;
      }

      // Random withdrawals never touch historical participation records.
      if (joiners.length > 0 && rand() < 0.5) {
        const i = joiners[0];
        await withdrawFrom(h, signers[i], addrs[i], 5n);
        expect(await h.isParticipantInRound(currentRoundId, addrs[i])).to.equal(true);
      }
    }

    // Final global invariants.
    let sumCredited = 0n;
    for (let i = 0; i < signers.length; i++) {
      sumCredited += await credited(h, addrs[i], signers[i]);
    }
    expect(await total(h), "total == sum(credited) (option-A rule) holds after a randomized multi-round run")
      .to.equal(sumCredited);

    let sumReserves = 0n;
    for (const r of seenRoundIds) {
      sumReserves += await reserveOf(h, r);
    }
    const finalRoundId: bigint = await h.currentRoundId();
    sumReserves += await reserveOf(h, finalRoundId);
    // Every credited unit plus every still-held reserve must be backed by
    // real holdings (no unbacked credit, no duplicated reserve).
    expect(sumCredited + sumReserves <= (await holdingsOf(h)), "solvency holds after randomized sequence").to.be
      .true;
  });
});
