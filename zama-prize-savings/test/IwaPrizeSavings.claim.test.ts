import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P4 claim tests for IwaPrizeSavings (approved spec section 9, corrections
 * B3 encrypted claim credit and C3 ACL re-grant).
 *
 * claim() is a pull action:
 *   - caller must be a registered participant; per-user replay protection
 *   - isWinner = FHE.eq(winnerIndex, asEuint16(index))  - scalar, encrypted
 *   - payout = FHE.select(isWinner, prizeReserve, 0)    - no ebool branch
 *   - winner balance += payout; prizeReserve -= payout; non-winners credit
 *     exactly zero and never revert
 *   - state: claim() runs in Drawn or Claimable and performs the one-time
 *     Drawn -> Claimable transition on the first claim (spec 9 requires
 *     Claimable; the spec lists no separate transition function and the demo
 *     calls claim() directly after draw)
 *   - accounting (option A, decision.md): confidentialTotal increases by the
 *     payout, so total == sum(credited) always; the prize never retroactively
 *     affects the completed draw (claim is only reachable after Drawn)
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

  async function decryptReserve(target: any): Promise<bigint> {
    const handle = await target.prizeReserve();
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

  async function decryptWinner(target: any): Promise<bigint> {
    const handle = await target.winnerIndex();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint16, handle);
  }

  // Deterministic world: weights [10, 20, 30] (A, B, C), prize 60, ticket 15
  // selects participant index 1 = wallet B. Returns the harness.
  async function deployDeterministicWorld(): Promise<any> {
    const factory = await ethers.getContractFactory("TestDrawHarness");
    const h: any = await factory.deploy(wrapperAddr);
    await h.waitForDeployment();
    const hAddr = await h.getAddress();

    for (const [signer, addr, v] of [
      [walletA, addrA, 10n],
      [walletB, addrB, 20n],
    ] as const) {
      await mintAndWrapAs(signer, addr, 100n);
      await setOperatorAs(signer, hAddr);
      await depositAs(h, signer, addr, v);
    }
    const walletC = (await ethers.getSigners())[3];
    const addrC = await walletC.getAddress();
    await mintAndWrapAs(walletC, addrC, 100n);
    await setOperatorAs(walletC, hAddr);
    await depositAs(h, walletC, addrC, 30n);

    await mintAndWrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer, hAddr);
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

  it("1: claim while Open reverts", async function () {
    let reverted = false;
    try {
      await pool.connect(walletA).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "claim in Open must revert").to.be.true;
  });

  it("2: claim while Locked reverts", async function () {
    await pool.connect(deployer).lockRound();
    let reverted = false;
    try {
      await pool.connect(walletA).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "claim in Locked must revert").to.be.true;
  });

  it("3: claim runs in the approved post-draw state and the first claim performs Drawn -> Claimable", async function () {
    await mintAndWrapAs(walletA, addrA, 100n);
    await setOperatorAs(walletA, poolAddr);
    await depositAs(pool, walletA, addrA, 50n);

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    expect(await pool.roundState()).to.equal(2n); // Drawn

    await (await pool.connect(walletA).claim()).wait();
    expect(await pool.roundState()).to.equal(3n); // Claimable

    // The state stays Claimable; no other state is invented.
    let reverted = false;
    try {
      await pool.connect(deployer).lockRound();
    } catch {
      reverted = true;
    }
    expect(reverted, "lockRound after draw must revert").to.be.true;
    expect(await pool.roundState()).to.equal(3n);
  });

  it("4: an unregistered wallet cannot claim", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    const walletE = (await ethers.getSigners())[5];
    let reverted = false;
    try {
      await h.connect(walletE).claim();
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

    await (await h.connect(walletB).claim()).wait();

    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
    expect(await decryptWinner(h)).to.equal(1n);
  });

  it("6 + 7: non-winner claim credits exactly zero and does not revert", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n); // winner is B

    await (await h.connect(walletA).claim()).wait();
    expect(await decryptUserCredited(h, addrA, walletA)).to.equal(10n); // unchanged
  });

  it("8: winner identity stays encrypted - the winner is an opaque euint16 handle", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    const handle = await h.winnerIndex();
    // The plaintext index 1 and wallet B's address must not appear anywhere.
    const oneWord = ethers.zeroPadValue("0x01", 32).slice(2).toLowerCase();
    expect(handle.slice(2).toLowerCase()).to.not.equal(oneWord);
    expect(handle.slice(2).toLowerCase()).to.not.contain(addrB.slice(2).toLowerCase());
  });

  it("9: a NO_WINNER round credits zero to every participant", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 999n); // ticket > total -> NO_WINNER

    await (await h.connect(walletA).claim()).wait();
    await (await h.connect(walletB).claim()).wait();

    expect(await decryptUserCredited(h, addrA, walletA)).to.equal(10n);
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(20n);
    expect(await decryptWinner(h)).to.equal(BigInt(NO_WINNER));
  });

  it("10: a NO_WINNER round leaves the prize reserve fully intact", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 999n);

    await (await h.connect(walletA).claim()).wait();
    await (await h.connect(walletB).claim()).wait();

    expect(await decryptReserve(h)).to.equal(60n);
  });

  // ---------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------

  it("11: the same user cannot claim twice", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletB).claim()).wait();
    let reverted = false;
    try {
      await h.connect(walletB).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "second claim must revert").to.be.true;
    expect(await h.hasClaimed(addrB)).to.equal(true);
  });

  it("12: one user's claim never blocks another user's claim", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletA).claim()).wait();
    await (await h.connect(walletB).claim()).wait();
    await (await h.connect((await ethers.getSigners())[3]).claim()).wait();

    expect(await h.hasClaimed(addrA)).to.equal(true);
    expect(await h.hasClaimed(addrB)).to.equal(true);
    expect(await h.hasClaimed(await (await ethers.getSigners())[3].getAddress())).to.equal(true);
    expect(await decryptReserve(h)).to.equal(0n);
  });

  it("13: per-user claimed state is correct - non-claimers are unmarked", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletA).claim()).wait();
    expect(await h.hasClaimed(addrA)).to.equal(true);
    expect(await h.hasClaimed(addrB)).to.equal(false);
  });

  // ---------------------------------------------------------------------
  // Accounting
  // ---------------------------------------------------------------------

  it("14: the winner's balance increases by exactly the encrypted prize", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim()).wait();
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
  });

  it("15: prizeReserve decreases by exactly the winner payout (60 -> 0)", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    expect(await decryptReserve(h)).to.equal(60n);
    await (await h.connect(walletB).claim()).wait();
    expect(await decryptReserve(h)).to.equal(0n);
  });

  it("16: a non-winner's claim leaves the reserve unchanged", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletA).claim()).wait();
    expect(await decryptReserve(h)).to.equal(60n);
  });

  it("17: solvency holds before and after claims (sum(credited) + reserve == holdings)", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    let claims = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3])) +
      (await decryptReserve(h));
    expect(claims).to.equal(await decryptPoolTokenBalance(h)); // 120

    await (await h.connect(walletB).claim()).wait();
    await (await h.connect(walletA).claim()).wait();

    claims = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3])) +
      (await decryptReserve(h));
    expect(claims).to.equal(await decryptPoolTokenBalance(h)); // still 120
  });

  it("18: confidentialTotal follows the approved rule - total equals sum(credited) after claims (option A)", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletB).claim()).wait();
    const sumCredited = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3]));
    expect(await decryptTotal(h)).to.equal(sumCredited);
    expect(await decryptTotal(h)).to.equal(120n); // 60 principal + 60 prize
  });

  it("19: no unbacked credit - every credited unit is matched by real holdings", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim()).wait();
    await (await h.connect(walletA).claim()).wait();

    const totalCredited = (await decryptUserCredited(h, addrA, walletA)) +
      (await decryptUserCredited(h, addrB, walletB)) +
      (await decryptUserCredited(h, await (await ethers.getSigners())[3].getAddress(), (await ethers.getSigners())[3]));
    const holdings = await decryptPoolTokenBalance(h);
    expect(totalCredited <= holdings).to.be.true;
    expect(totalCredited).to.equal(holdings); // reserve fully paid, nothing unbacked
  });

  // ---------------------------------------------------------------------
  // ACL
  // ---------------------------------------------------------------------

  it("20: the claimed winner balance remains decryptable and usable in a LATER transaction", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim()).wait();

    // Separate transaction: read + user-decrypt the credited handle.
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
  });

  it("21: the winner can withdraw the claimed prize later through the normal confidential withdrawal", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(walletB).claim()).wait();

    await withdrawAs(h, walletB, addrB, 60n);

    // B held 80 wrapped tokens (100 wrapped - 20 deposited) + 60 back = 140.
    expect(await decryptUserTokenBalance(addrB)).to.equal(140n);
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(20n);
    // Holdings reconcile: 60 principal + 60 prize - 60 withdrawn = 60.
    expect(await decryptPoolTokenBalance(h)).to.equal(60n);
    expect(await decryptTotal(h)).to.equal(60n);
  });

  it("22: the prize reserve handle remains operable across transactions - non-winner claims first, winner claims later", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    await (await h.connect(walletA).claim()).wait(); // non-winner, tx 1
    expect(await decryptReserve(h)).to.equal(60n);

    await (await h.connect(walletB).claim()).wait(); // winner, tx 2 - reuses the reserve handle
    expect(await decryptReserve(h)).to.equal(0n);
    expect(await decryptUserCredited(h, addrB, walletB)).to.equal(80n);
  });

  // ---------------------------------------------------------------------
  // Privacy
  // ---------------------------------------------------------------------

  it("23 + 24: claim emits no plaintext winner, payout or balance data", async function () {
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);

    const receipt = await (await h.connect(walletB).claim()).wait();
    const hAddr = await h.getAddress();
    const ourLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === hAddr.toLowerCase(),
    );

    const claimedLog = ourLogs.find((l: any) => l.topics[0] === ethers.id("Claimed(address)"));
    expect(claimedLog, "expected a Claimed event").to.not.be.undefined;
    expect(claimedLog!.data, "Claimed must carry no data").to.equal("0x");

    for (const v of [10, 20, 30, 60, 80]) {
      const word = ethers.toBeHex(v, 32).slice(2).toLowerCase();
      for (const log of ourLogs) {
        const data = log.data.slice(2).toLowerCase();
        for (let p = 0; p + 64 <= data.length; p += 64) {
          expect(data.slice(p, p + 64)).to.not.equal(word);
        }
        for (const topic of log.topics) {
          expect(topic.slice(2).toLowerCase()).to.not.equal(word);
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

    const handle = await h.winnerIndex();
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
      expect(n.toLowerCase(), `no forbidden surface: ${n}`).to.not.match(
        /sweep|rescue|emergency|skim|seize|recover|drain|adminWithdraw|steal|setWinner|forceClaim|adminClaim|decryptWinner|drawWithTicket/,
      );
    }

    // Owner cannot redirect the funded prize even after the draw.
    const h = await deployDeterministicWorld();
    await drawWithTicket(h, 15n);
    await (await h.connect(deployer).withdrawAll()).wait();
    await withdrawAs(h, deployer, addrOwner, 50n);
    expect(await decryptReserve(h)).to.equal(60n);
  });
});