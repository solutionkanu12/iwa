import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P4 claim tests for IwaPrizeSavings (approved spec section 9, corrections
 * B3 encrypted claim credit and C3 ACL re-grant).
 *
 * Multi-round redesign note: claim() now takes an explicit roundId and
 * resolves entirely against THAT round's own permanent participant/claim/
 * winner/reserve storage - never against currentRoundId. Joining a round is
 * a separate joinRound() call after deposit(). hasClaimed(address) was
 * replaced by hasClaimedRound(roundId, address) (see contract doc comment:
 * a bare "current round" reading would always be trivially false, since the
 * current round can never itself be in a claimable state - see
 * IwaPrizeSavings.rounds.test.ts for the dedicated cross-round claim suite).
 *
 * claim(roundId) is a pull action:
 *   - caller must be a registered participant OF THAT ROUND; per-round,
 *     per-user replay protection
 *   - isWinner = FHE.eq(round.winnerIndex, asEuint16(index)) - scalar,
 *     encrypted, scoped to that round
 *   - payout = FHE.select(isWinner, round.prizeReserve, 0) - no ebool branch
 *   - winner balance += payout; round.prizeReserve -= payout; non-winners
 *     credit exactly zero and never revert
 *   - state: claim() runs in that round's Drawn or Claimable and performs
 *     the one-time Drawn -> Claimable transition FOR THAT ROUND on the
 *     first claim
 *   - accounting (option A, decision.md): confidentialTotal (lifetime,
 *     global) increases by the payout, so total == sum(credited) always;
 *     the prize never retroactively affects the completed draw
 *
 * Deterministic winner selection uses TestDrawHarness (test-only, NEVER part
 * of the production ABI) with a known ticket; production ABI exposes no
 * setWinner / drawWithTicket / forceClaim / adminClaim / decryptWinner.
 */
describe("P4 - IwaPrizeSavings claim", function () {
  const NO_WINNER = 65535;

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

  async function depositAs(target: any, signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await target.getAddress(), addr)
      .add64(value)
      .encrypt();
    return (await target.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function saveAndJoin(target: any, signer: Signer, addr: string, value: bigint) {
    await mintAndWrapAs(signer, addr, 100n > value ? 100n : value);
    await setOperatorAs(signer, await target.getAddress());
    await depositAs(target, signer, addr, value);
    return (await target.connect(signer).joinRound()).wait();
  }

  async function fundPrizeAs(target: any, signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await target.getAddress(), addr)
      .add64(value)
      .encrypt();
    return (await target.connect(signer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function decryptUserCredited(target: any, addr: string, signer: Signer): Promise<bigint> {
    const handle = await target.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(
      FhevmType.euint64,
      handle,
      await target.getAddress(),
      signer,
    );
  }

  async function decryptReserveOf(target: any, roundId: bigint): Promise<bigint> {
    const handle = await target.prizeReserveOf(roundId);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptTotal(target: any): Promise<bigint> {
    const handle = await target.confidentialTotal();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptPoolTokenBalance(target: any): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(await target.getAddress());
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptUserTokenBalance(addr: string): Promise<bigint> {
    const handle = await wrapper.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function decryptWinnerOf(target: any, roundId: bigint): Promise<bigint> {
    const handle = await target.winnerIndexOf(roundId);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint16, handle);
  }

  // Deterministic world: weights [10, 20, 30] (A, B, C), prize 60, ticket 15
  // selects participant index 1 = wallet B. Returns the harness. Round 1.
  async function deployDeterministicWorld(): Promise<any> {
    const factory = await ethers.getContractFactory("TestDrawHarness");
    const h: any = await factory.deploy(wrapperAddr);
    await h.waitForDeployment();

    await saveAndJoin(h, walletA, addrA, 10n);
    await saveAndJoin(h, walletB, addrB, 20n);
    const walletC = (await ethers.getSigners())[3];
    const addrC = await walletC.getAddress();
    await saveAndJoin(h, walletC, addrC, 30n);

    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer, await h.getAddress());
    await fundPrizeAs(h, deployer, addrOwner, 60n);
    return h;
  }

  async function drawWithTicket(h: any, ticket: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await h.getAddress(), addrOwner)
      .add64(ticket)
      .encrypt();
    await (await h.connect(deployer).lockRound()).wait();
    return (await h.connect(deployer).drawWithTicket(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function withdrawAs(target: any, signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(await target.getAddress(), addr)
      .add64(value)
      .encrypt();
    return (await target.connect(signer).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  it("1: claim while the round is Open reverts", async function () {
    let reverted = false;
    try {
      await pool.connect(walletA).claim(1n);
    } catch {
      reverted = true;
    }
    expect(reverted, "claim in Open must revert").to.be.true;
  });

  it("2: claim while the round is Locked reverts", async function () {
    await pool.connect(deployer).lockRound();
    let reverted = false;
    try {
      await pool.connect(walletA).claim(1n);
    } catch {
      reverted = true;
    }
    expect(reverted, "claim in Locked must revert").to.be.true;
  });

  it("3: claim runs in the approved post-draw state and the first claim performs Drawn -> Claimable for that round", async function () {
    await saveAndJoin(pool, walletA, addrA, 50n);

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    expect(await pool.roundStateOf(1n)).to.equal(2n); // Drawn

    await (await pool.connect(walletA).claim(1n)).wait();
    expect(await pool.roundStateOf(1n)).to.equal(3n); // Claimable

    // Round 1 stays Claimable forever; round 2 (current) is untouched.
    expect(await pool.roundState()).to.equal(0n); // round 2 is Open
  });

  it("4: an unregistered wallet cannot claim", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    const walletE = (await ethers.getSigners())[5];
    let reverted = false;
    try {
      await h.connect(walletE).claim(1n);
    } catch {
      reverted = true;
    }
    expect(reverted, "unregistered wallet claim must revert").to.be.true;
  });

  // ---------------------------------------------------------------------
  // Winner / non-winner
  // ---------------------------------------------------------------------

  it("5: winner claim credits the full encrypted prize (20 + 60 = 80)", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n); // selects index 1 = wallet B

    await (await h.connect(walletB).claim(1n)).wait();

    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
    expect(await decryptWinnerOf(h, 1n)).to.equal(1n);
  });

  it("6 + 7: non-winner claim credits exactly zero and does not revert", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n); // winner is B

    await (await h.connect(walletA).claim(1n)).wait();
    expect(await decryptUserCredited(h, addrA, walletA)).to.equal(10n); // unchanged
  });

  it("8: winner identity stays encrypted - the winner is an opaque euint16 handle", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    const handle = await h.winnerIndexOf(1n);
    // The plaintext index 1 and wallet B's address must not appear anywhere.
    const oneWord = ethers.zeroPadValue("0x01", 32).slice(2).toLowerCase();
    expect(handle.slice(2).toLowerCase()).to.not.equal(oneWord);
    expect(handle.slice(2).toLowerCase()).to.not.contain(addrB.slice(2).toLowerCase());
  });

  it("9: a NO_WINNER round credits zero to every participant", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 999n); // ticket > total -> NO_WINNER

    await (await h.connect(walletA).claim(1n)).wait();
    await (await h.connect(walletB).claim(1n)).wait();

    expect(await decryptUserCredited(h, addrA, walletA)).to.equal(10n);
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(20n);
    expect(await decryptWinnerOf(h, 1n)).to.equal(BigInt(NO_WINNER));
  });

  it("10: a NO_WINNER round leaves the prize reserve fully intact until every participant has claimed", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 999n);

    await (await h.connect(walletA).claim(1n)).wait();
    await (await h.connect(walletB).claim(1n)).wait();
    // The third participant (walletC) has not claimed yet - the round is
    // not fully settled, so the reserve has not rolled over.
    expect(await decryptReserveOf(h, 1n)).to.equal(60n);
  });

  // ---------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------

  it("11: the same user cannot claim the same round twice", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletB).claim(1n)).wait();
    let reverted = false;
    try {
      await h.connect(walletB).claim(1n);
    } catch {
      reverted = true;
    }
    expect(reverted, "second claim on the same round must revert").to.be.true;
    expect(await h.hasClaimedRound(1n, addrB)).to.equal(true);
  });

  it("12: one user's claim never blocks another user's claim", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletA).claim(1n)).wait();
    await (await h.connect(walletB).claim(1n)).wait();
    await (await h.connect((await ethers.getSigners())[3]).claim(1n)).wait();

    expect(await h.hasClaimedRound(1n, addrA)).to.equal(true);
    expect(await h.hasClaimedRound(1n, addrB)).to.equal(true);
    expect(await h.hasClaimedRound(1n, await (await ethers.getSigners())[3].getAddress())).to.equal(true);
    // All three (the round's full participant set) have now claimed, so the
    // reserve has safely rolled forward into round 2.
    expect(await decryptReserveOf(h, 1n)).to.equal(0n);
  });

  it("13: per-user claimed state is correct - non-claimers are unmarked", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletA).claim(1n)).wait();
    expect(await h.hasClaimedRound(1n, addrA)).to.equal(true);
    expect(await h.hasClaimedRound(1n, addrB)).to.equal(false);
  });

  // ---------------------------------------------------------------------
  // Accounting
  // ---------------------------------------------------------------------

  it("14: the winner's balance increases by exactly the encrypted prize", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim(1n)).wait();
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
  });

  it("15: prizeReserve decreases by exactly the winner payout (60 -> 0)", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    expect(await decryptReserveOf(h, 1n)).to.equal(60n);
    await (await h.connect(walletB).claim(1n)).wait();
    expect(await decryptReserveOf(h, 1n)).to.equal(0n);
  });

  it("16: a non-winner's claim leaves the reserve unchanged", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletA).claim(1n)).wait();
    expect(await decryptReserveOf(h, 1n)).to.equal(60n);
  });

  it("17: solvency holds before and after claims (sum(credited) + reserve == holdings)", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    let claims = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3])) +
      (await decryptReserveOf(h, 1n));
    expect(claims).to.equal(await decryptPoolTokenBalance(h)); // 120

    await (await h.connect(walletB).claim(1n)).wait();
    await (await h.connect(walletA).claim(1n)).wait();

    claims = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3])) +
      (await decryptReserveOf(h, 1n));
    expect(claims).to.equal(await decryptPoolTokenBalance(h)); // still 120
  });

  it("18: confidentialTotal follows the approved rule - total equals sum(credited) after claims (option A)", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletB).claim(1n)).wait();
    const sumCredited = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3]));
    expect(await decryptTotal(h)).to.equal(sumCredited);
    expect(await decryptTotal(h)).to.equal(120n); // 60 principal + 60 prize
  });

  it("19: no unbacked credit - every credited unit is matched by real holdings", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim(1n)).wait();
    await (await h.connect(walletA).claim(1n)).wait();

    const totalCredited = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3]));
    const holdings = await decryptPoolTokenBalance(h);
    expect(totalCredited <= holdings).to.be.true;
  });

  // ---------------------------------------------------------------------
  // ACL
  // ---------------------------------------------------------------------

  it("20: the claimed winner balance remains decryptable and usable in a LATER transaction", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim(1n)).wait();

    // Separate transaction: read + user-decrypt the credited handle.
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
  });

  it("21: the winner can withdraw the claimed prize later through the normal confidential withdrawal", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim(1n)).wait();

    await withdrawAs(h, walletB, addrB, 60n);

    // B held 80 wrapped tokens (100 wrapped - 20 deposited) + 60 back = 140.
    expect(await decryptUserTokenBalance(addrB)).to.equal(140n);
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(20n);
  });

  it("22: the prize reserve handle remains operable across transactions - non-winner claims first, winner claims later", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletA).claim(1n)).wait(); // non-winner, tx 1
    expect(await decryptReserveOf(h, 1n)).to.equal(60n);

    await (await h.connect(walletB).claim(1n)).wait(); // winner, tx 2 - reuses the reserve handle
    expect(await decryptReserveOf(h, 1n)).to.equal(0n);
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
  });

  // ---------------------------------------------------------------------
  // Privacy
  // ---------------------------------------------------------------------

  it("23 + 24: claim emits no plaintext winner, payout or balance data", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    const receipt = await (await h.connect(walletB).claim(1n)).wait();
    const hAddr = await h.getAddress();
    const ourLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === hAddr.toLowerCase(),
    );

    const claimedLog = ourLogs.find((l: any) => l.topics[0] === ethers.id("Claimed(address,uint256)"));
    expect(claimedLog, "expected a Claimed event").to.not.be.undefined;
    expect(claimedLog!.data, "Claimed must carry no non-indexed data").to.equal("0x");

    for (const v of [10, 20, 30, 60, 80]) {
      const word = ethers.toBeHex(v, 32).slice(2).toLowerCase();
      for (const log of ourLogs) {
        const data = log.data.slice(2).toLowerCase();
        for (let p = 0; p + 64 <= data.length; p += 64) {
          expect(data.slice(p, p + 64)).to.not.equal(word);
        }
      }
    }
  });

  it("25 + 26: no public decryption and no checkSignatures path anywhere", async function () {
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

  it("27: nobody - not the owner, not a participant - can user-decrypt the winner index handle", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    const handle = await h.winnerIndexOf(1n);
    for (const [signer, label] of [
      [walletA, "participant"],
      [deployer, "owner"],
    ] as const) {
      let message = "";
      try {
        await fhevm.userDecryptEuint(
          FhevmType.euint16,
          handle,
          await h.getAddress(),
          signer,
        );
      } catch (err: any) {
        message = String(err?.message ?? "");
      }
      expect(message, `${label} must not decrypt the winner index`).to.not.equal("");
      expect(message.toLowerCase()).to.contain("not authorized");
    }
  });

  // ---------------------------------------------------------------------
  // ABI / authority
  // ---------------------------------------------------------------------

  it("28 + 29 + 30: no prize-redirect, no forced winner, no sweep/rescue surface", async function () {
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
      expect(n.toLowerCase(), `no forbidden surface: ${n}`).to.not.match(
        /sweep|rescue|emergency|skim|seize|recover|drain|adminWithdraw|steal|setWinner|forceClaim|adminClaim|decryptWinner|drawWithTicket/,
      );
    }

    // Owner cannot redirect the funded prize even after the draw.
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(deployer).withdrawAll()).wait();
    await withdrawAs(h, deployer, addrOwner, 50n);
    expect(await decryptReserveOf(h, 1n)).to.equal(60n);
  });
});
