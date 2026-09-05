import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * P6 red-team suite (plan Phase 2 P6; release gate 3 of spec section 16).
 *
 * Every attack row below is one test or a grouped battery. Rows already
 * proven by P1-P5 are re-attacked here in adversarial combinations; rows not
 * previously covered (zero-transfer slot DoS, input-binding behavior, owner
 * token-interface attacks, state matrix, adversarial lifecycle) are new.
 *
 * Mock caveat (documented per task): the local mock does not enforce
 * operation-level ACL, so rows marked [SEPOLIA] verify behavior that the
 * mock cannot distinguish from a bug; they are listed in the report as
 * Sepolia-only verification items. User-decrypt ACL IS enforced by the mock.
 */
describe("P6 - red team", function () {
  let deployer: Signer; // owner
  let alice: Signer;
  let bob: Signer;
  let addrAlice: string;
  let addrBob: string;
  let addrOwner: string;

  let mock: any;
  let wrapper: any;
  let pool: any;
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

    pool = await (await ethers.getContractFactory("IwaPrizeSavings")).deploy(wrapperAddr);
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();
  });

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
    return (await pool.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function withdrawAs(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(poolAddr, addr)
      .add64(value)
      .encrypt();
    return (await pool.connect(signer).withdraw(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function credited(addr: string, signer: Signer): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(addr);
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, signer);
  }

  async function reserve(): Promise<bigint> {
    const handle = await pool.prizeReserve();
    if (handle === ethers.ZeroHash) return 0n;
    return fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
  }

  async function total(): Promise<bigint> {
    const handle = await pool.confidentialTotal();
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

  async function assertSolvency() {
    const sum = (await credited(addrAlice, alice)) + (await credited(addrBob, bob));
    const r = await reserve();
    const h = await holdings();
    expect(sum + r <= h, `solvency violated: ${sum}+${r} > ${h}`).to.be.true;
    return { sum, r, h };
  }

  // =====================================================================
  // A. ACCOUNTING / SOLVENCY ATTACKS
  // =====================================================================

  it("A1: replaying the SAME encrypted input for a second deposit cannot double-credit", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    const encrypted = await fhevm.createEncryptedInput(poolAddr, addrAlice).add64(60n).encrypt();

    await (await pool.connect(alice).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
    expect(await credited(addrAlice, alice)).to.equal(60n);
    expect(await holdings()).to.equal(60n);

    // Same handle + proof replayed: second pull moves 0 (nothing left),
    // credits 0. No double credit, no unbacked share.
    await (await pool.connect(alice).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
    expect(await credited(addrAlice, alice)).to.equal(60n);
    expect(await holdings()).to.equal(60n);
    await assertSolvency();
  });

  it("A2: double-debit is impossible - withdrawing an emptied balance twice moves nothing", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 100n);
    await (await pool.connect(alice).withdrawAll()).wait();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect(await holdings()).to.equal(0n);

    await withdrawAs(alice, addrAlice, 50n);
    await (await pool.connect(alice).withdrawAll()).wait();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect(await holdings()).to.equal(0n);
    await assertSolvency();
  });

  it("A3: over-withdraw and withdraw-after-claim stay backed (hostile order)", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 100n);
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);

    // Fund 50, then draw-with-ticket is not available here (production pool)
    // - use a full state walk with the real random draw; the accounting rows
    // below must hold regardless of who wins.
    const encrypted = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(50n).encrypt();
    await (await pool.connect(deployer).fundPrize(encrypted.handles[0], encrypted.inputProof)).wait();
    expect(await reserve()).to.equal(50n);

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    await (await pool.connect(alice).claim()).wait();
    const claimed = await credited(addrAlice, alice);
    expect(claimed === 100n || claimed === 150n).to.be.true; // principal, or principal+prize
    await assertSolvency();

    // Over-withdraw far beyond the balance.
    await withdrawAs(alice, addrAlice, 10_000n);
    await assertSolvency();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect((await holdings()) <= 50n).to.be.true; // only the reserve (or part) remains
  });

  it("A4: zero-value deposit and zero-value funding create zero liability", async function () {
    await wrapAs(alice, addrAlice, 1n);
    await setOperatorAs(alice);
    const zero = await fhevm.createEncryptedInput(poolAddr, addrAlice).add64(0n).encrypt();
    await (await pool.connect(alice).deposit(zero.handles[0], zero.inputProof)).wait();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect(await total()).to.equal(0n);
    expect(await holdings()).to.equal(0n);

    await wrapAs(deployer, addrOwner, 1n);
    await setOperatorAs(deployer);
    const zeroFund = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(0n).encrypt();
    await (await pool.connect(deployer).fundPrize(zeroFund.handles[0], zeroFund.inputProof)).wait();
    expect(await reserve()).to.equal(0n);
    expect(await holdings()).to.equal(0n);
    await assertSolvency();
  });

  it("A5: prize can never be credited twice and reserve can never underflow", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 100n);
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    const f = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(40n).encrypt();
    await (await pool.connect(deployer).fundPrize(f.handles[0], f.inputProof)).wait();

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    // Claim twice (second reverts), claim from unregistered (reverts), then
    // verify the reserve never went negative and never double-paid.
    let reverted = false;
    try {
      await pool.connect(alice).claim();
      await pool.connect(alice).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "second claim must revert").to.be.true;
    const r = await reserve();
    expect(r === 40n || r === 0n).to.be.true; // either untouched or fully paid - never negative, never partial-double
    await assertSolvency();
  });

  it("A6: confidentialTotal never drifts - total == sum(credited) after chaotic deposits/withdrawals/claims", async function () {
    await wrapAs(alice, addrAlice, 300n);
    await setOperatorAs(alice);
    await wrapAs(bob, addrBob, 300n);
    await setOperatorAs(bob);
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);

    await depositAs(alice, addrAlice, 40n);
    await depositAs(bob, addrBob, 70n);
    await depositAs(alice, addrAlice, 30n);
    await withdrawAs(alice, addrAlice, 15n);
    await depositAs(bob, addrBob, 5n);
    await withdrawAs(alice, addrAlice, 200n); // clamps to balance

    const f = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(25n).encrypt();
    await (await pool.connect(deployer).fundPrize(f.handles[0], f.inputProof)).wait();

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    await (await pool.connect(alice).claim()).wait();
    await (await pool.connect(bob).claim()).wait();
    await withdrawAs(alice, addrAlice, 5n);
    await (await pool.connect(bob).withdrawAll()).wait();

    const sum = (await credited(addrAlice, alice)) + (await credited(addrBob, bob));
    expect(await total(), "total must equal sum(credited) (option-A rule)").to.equal(sum);
    await assertSolvency();
  });

  it("A7: owner funding edge cases - exact-balance funding and repeated funding stay backed", async function () {
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    const exact = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(100n).encrypt();
    await (await pool.connect(deployer).fundPrize(exact.handles[0], exact.inputProof)).wait();
    expect(await reserve()).to.equal(100n);
    expect(await holdings()).to.equal(100n);
    await assertSolvency();

    // Second funding with nothing left: 0 credit.
    const again = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(50n).encrypt();
    await (await pool.connect(deployer).fundPrize(again.handles[0], again.inputProof)).wait();
    expect(await reserve()).to.equal(100n);
    await assertSolvency();
  });

  // =====================================================================
  // B. CLAIM ATTACKS
  // =====================================================================

  async function twoParticipantWorld() {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 60n);
    await wrapAs(bob, addrBob, 100n);
    await setOperatorAs(bob);
    await depositAs(bob, addrBob, 40n);
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    const f = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(20n).encrypt();
    await (await pool.connect(deployer).fundPrize(f.handles[0], f.inputProof)).wait();
  }

  it("B1: winner substitution is impossible - winnerIndex has no setter and survives claims untouched", async function () {
    await twoParticipantWorld();
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    const winnerBefore = await pool.winnerIndex();

    await (await pool.connect(alice).claim()).wait();
    await (await pool.connect(bob).claim()).wait();

    expect(await pool.winnerIndex()).to.equal(winnerBefore);
    const abi = JSON.parse(pool.interface.formatJson());
    const names = abi.filter((e: any) => e.type === "function").map((e: any) => e.name);
    expect(names).to.not.include("setWinner");
    expect(names).to.not.include("forceWinner");
  });

  it("B2: participant-index confusion - each claim compares against the caller's OWN index only", async function () {
    const factory = await ethers.getContractFactory("TestDrawHarness");
    const h: any = await factory.deploy(wrapperAddr);
    await h.waitForDeployment();
    const hAddr = await h.getAddress();
    const signers = await ethers.getSigners();
    const wallets = [alice, bob, signers[3]];
    const amounts = [10n, 20n, 30n];
    for (const [i, w] of wallets.entries()) {
      const addr = await w.getAddress();
      await wrapAs(w, addr, 100n);
      await (await wrapper.connect(w).setOperator(hAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600)).wait();
      const e = await fhevm.createEncryptedInput(hAddr, addr).add64(amounts[i]).encrypt();
      await (await h.connect(w).deposit(e.handles[0], e.inputProof)).wait();
    }
    await wrapAs(deployer, addrOwner, 100n);
    await (await wrapper.connect(deployer).setOperator(hAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600)).wait();
    const fp = await fhevm.createEncryptedInput(hAddr, addrOwner).add64(60n).encrypt();
    await (await h.connect(deployer).fundPrize(fp.handles[0], fp.inputProof)).wait();

    await (await h.connect(deployer).lockRound()).wait();
    const t = await fhevm.createEncryptedInput(hAddr, addrOwner).add64(15n).encrypt(); // interval [10,30) = index 1 = Bob
    await (await h.connect(deployer).drawWithTicket(t.handles[0], t.inputProof)).wait();

    await (await h.connect(bob).claim()).wait();
    await (await h.connect(alice).claim()).wait();
    await (await h.connect(signers[3]).claim()).wait();

    const bobCred = await (async () => {
      const hh = await h.confidentialBalanceOf(addrBob);
      return fhevm.userDecryptEuint(FhevmType.euint64, hh, hAddr, bob);
    })();
    expect(bobCred).to.equal(80n); // 20 + 60 prize
    const expectUnchanged = [
      [alice, 10n],
      [signers[3], 30n],
    ] as const;
    for (const [w, expected] of expectUnchanged) {
      const addr = await w.getAddress();
      const hh = await h.confidentialBalanceOf(addr);
      const c = await fhevm.userDecryptEuint(FhevmType.euint64, hh, hAddr, w);
      expect(c).to.equal(expected);
    }
  });

  it("B3: NO_WINNER sentinel does not collide with the last valid index (15)", async function () {
    const factory = await ethers.getContractFactory("TestDrawHarness");
    const h: any = await factory.deploy(wrapperAddr);
    await h.waitForDeployment();
    const hAddr = await h.getAddress();
    const signers = await ethers.getSigners();

    for (let i = 0; i < 16; i++) {
      const w = signers[i + 3];
      const addr = await w.getAddress();
      await wrapAs(w, addr, 100n);
      await (await wrapper.connect(w).setOperator(hAddr, (await ethers.provider.getBlock("latest"))!.timestamp + 3600)).wait();
      const e = await fhevm.createEncryptedInput(hAddr, addr).add64(64n).encrypt();
      await (await h.connect(w).deposit(e.handles[0], e.inputProof)).wait();
    }
    await (await h.connect(deployer).lockRound()).wait();

    // Ticket 1023 lands in the last interval [960,1024) -> index 15.
    const t = await fhevm.createEncryptedInput(hAddr, addrOwner).add64(1023n).encrypt();
    await (await h.connect(deployer).drawWithTicket(t.handles[0], t.inputProof)).wait();
    const wHandle = await h.winnerIndex();
    const wIdx = await fhevm.debugger.decryptEuint(FhevmType.euint16, wHandle);
    expect(wIdx).to.equal(15n); // a valid winner index, NOT the 65535 sentinel
  });

  it("B4a: an unregistered owner cannot claim", async function () {
    await twoParticipantWorld();
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();

    let reverted = false;
    try {
      await pool.connect(deployer).claim(); // owner is not a participant
    } catch {
      reverted = true;
    }
    expect(reverted, "unregistered owner claim must revert").to.be.true;
  });

  it("B4b: the owner can claim only as THEMSELVES once registered - no other participant is affected", async function () {
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    await depositAs(deployer, addrOwner, 10n);
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 40n);

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    await (await pool.connect(deployer).claim()).wait();

    expect(await pool.hasClaimed(addrOwner)).to.equal(true);
    expect(await pool.hasClaimed(addrAlice)).to.equal(false);
    expect(await credited(addrAlice, alice)).to.equal(40n); // untouched
  });

  // =====================================================================
  // C. DRAW ATTACKS
  // =====================================================================

  it("C1: participant ordering is immutable - no function can reorder or remove entries", async function () {
    await twoParticipantWorld();
    const before = [await pool.participants(0), await pool.participants(1)];
    expect(before[0].toLowerCase()).to.equal(addrAlice.toLowerCase());
    expect(before[1].toLowerCase()).to.equal(addrBob.toLowerCase());

    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    await (await pool.connect(alice).claim()).wait();
    await (await pool.connect(bob).claim()).wait();

    expect(await pool.participants(0)).to.equal(before[0]);
    expect(await pool.participants(1)).to.equal(before[1]);
    expect(await pool.participantCount()).to.equal(2n);
  });

  it("C2: randomness is single-source and unbounded-only - no rem, no rebias, no second draw", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );
    expect(source).to.not.contain("FHE.rem");
    expect(source).to.not.contain("FHE.div");
    expect((source.match(/FHE\.randEuint64/g) ?? []).length).to.equal(1);
    expect(source).to.not.contain("FHE.randEuint8");
    expect(source).to.not.contain("FHE.randEbool");
  });

  it("C3: draw in Claimable reverts (no second draw through the claim transition)", async function () {
    await twoParticipantWorld();
    await pool.connect(deployer).lockRound();
    await (await pool.connect(deployer).draw()).wait();
    await (await pool.connect(alice).claim()).wait(); // -> Claimable

    let reverted = false;
    try {
      await pool.connect(deployer).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "draw in Claimable must revert").to.be.true;
  });

  it("C4: zero-weight and all-zero pools still draw safely (no HCU surprise, NO_WINNER)", async function () {
    // 16 registered zero-weight participants (0-value deposits).
    const signers = await ethers.getSigners();
    for (let i = 0; i < 16; i++) {
      const w = signers[i + 3];
      const addr = await w.getAddress();
      await setOperatorAs(w);
      const e = await fhevm.createEncryptedInput(poolAddr, addr).add64(0n).encrypt();
      await (await pool.connect(w).deposit(e.handles[0], e.inputProof)).wait();
    }
    expect(await pool.participantCount()).to.equal(16n);
    await pool.connect(deployer).lockRound();
    const tx = await pool.connect(deployer).draw();
    const receipt = await tx.wait();
    const hcu = fhevm.computeTransactionHCU(receipt);
    expect(hcu.maxHCUDepth).to.be.lessThan(5_000_000);
    const w = await pool.winnerIndex();
    expect(await fhevm.debugger.decryptEuint(FhevmType.euint16, w)).to.equal(65535n);
  });

  // =====================================================================
  // D. ZERO-TRANSFER SLOT DoS (the known carried risk, red-teamed)
  // =====================================================================

  it("D: 16 zero-transfer wallets permanently fill the pool - real users can never join", async function () {
    // 1. 16 distinct wallets attempt zero-transfer deposits (operator granted,
    //    zero balance): each is registered and each registers exactly once.
    const signers = await ethers.getSigners();
    for (let i = 0; i < 16; i++) {
      const w = signers[i + 3];
      const addr = await w.getAddress();
      await setOperatorAs(w);
      const e = await fhevm.createEncryptedInput(poolAddr, addr).add64(100n).encrypt();
      await (await pool.connect(w).deposit(e.handles[0], e.inputProof)).wait();
    }
    expect(await pool.participantCount()).to.equal(16n);
    expect(await total()).to.equal(0n);
    expect(await holdings()).to.equal(0n);

    // 2. A real funded wallet tries to join: permanently rejected.
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    let reverted = false;
    let message = "";
    try {
      await depositAs(alice, addrAlice, 60n);
    } catch (err: any) {
      reverted = true;
      message = String(err?.message ?? "");
    }
    expect(reverted, "funded real user must be rejected").to.be.true;
    expect(message).to.contain("pool full");
    expect(await pool.isParticipant(addrAlice)).to.equal(false);

    // 3. Permanence: no function removes a participant; owner cannot help.
    const abi = JSON.parse(pool.interface.formatJson());
    const names = abi.filter((e: any) => e.type === "function").map((e: any) => e.name);
    expect(names).to.not.include("removeParticipant");
    expect(names).to.not.include("kickParticipant");
    expect(await pool.participantCount()).to.equal(16n);

    // 4. Existing participants remain fully usable (they can deposit for real).
    await wrapAs(signers[3], await signers[3].getAddress(), 50n);
    const e = await fhevm.createEncryptedInput(poolAddr, await signers[3].getAddress()).add64(40n).encrypt();
    await (await pool.connect(signers[3]).deposit(e.handles[0], e.inputProof)).wait();
    expect(await total()).to.equal(40n);

    // 5. The draw still works at the filled cap (weighted by the 40 real).
    await pool.connect(deployer).lockRound();
    const tx = await pool.connect(deployer).draw();
    const receipt = await tx.wait();
    const hcu = fhevm.computeTransactionHCU(receipt);
    expect(hcu.maxHCUDepth).to.be.lessThan(5_000_000);

    // 6. The prize cannot be stolen: fund, then NO-WINNER-or-valid draw, and
    //    no unregistered wallet can claim.
    const f = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(100n).encrypt();
    let fundReverted = false;
    try {
      await (await pool.connect(deployer).fundPrize(f.handles[0], f.inputProof)).wait();
    } catch {
      fundReverted = true; // round already Drawn - funding closed, reserve untouched
    }
    expect(fundReverted).to.be.true;
    expect(await reserve()).to.equal(0n);
    let claimReverted = false;
    try {
      await pool.connect(alice).claim(); // unregistered
    } catch {
      claimReverted = true;
    }
    expect(claimReverted).to.be.true;
    await assertSolvency();
  });

  // =====================================================================
  // E. ACL / PRIVACY ATTACKS
  // =====================================================================

  it("E1: cross-user decryption is impossible - Alice cannot decrypt Bob's credited balance", async function () {
    await twoParticipantWorld();
    const handle = await pool.confidentialBalanceOf(addrBob);
    let message = "";
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, alice);
    } catch (err: any) {
      message = String(err?.message ?? "");
    }
    expect(message).to.not.equal("");
    expect(message.toLowerCase()).to.contain("not authorized");
  });

  it("E2: the owner cannot decrypt participant balances, and loses reserve access once the reserve handle is rewritten", async function () {
    await twoParticipantWorld();

    // Participant balances: never decryptable by the owner.
    const aHandle = await pool.confidentialBalanceOf(addrAlice);
    let message = "";
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, aHandle, poolAddr, deployer);
    } catch (err: any) {
      message = String(err?.message ?? "");
    }
    expect(message).to.not.equal("");
    expect(message.toLowerCase()).to.contain("not authorized");

    // The FIRST funding stores the token's transferred handle directly
    // (tryAdd short-circuit), and the OZ token grants the FUNDER persistent
    // access to the transferred handle. That exposes only the amount the
    // owner themselves just funded - information already known. The real
    // check: once the reserve handle is REWRITTEN (second funding), the owner
    // must lose access.
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    const f2 = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(7n).encrypt();
    await (await pool.connect(deployer).fundPrize(f2.handles[0], f2.inputProof)).wait();
    expect(await reserve()).to.equal(27n);

    const rHandle = await pool.prizeReserve();
    message = "";
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, rHandle, poolAddr, deployer);
    } catch (err: any) {
      message = String(err?.message ?? "");
    }
    expect(message, "owner must not decrypt a rewritten reserve handle").to.not.equal("");
    expect(message.toLowerCase()).to.contain("not authorized");
  });

  it("E3 [SEPOLIA]: wrong-contract input binding - deposit input bound to another contract", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    // Input created for the WRAPPER, submitted to the POOL.
    const encrypted = await fhevm.createEncryptedInput(wrapperAddr, addrAlice).add64(60n).encrypt();
    let reverted = false;
    try {
      await (await pool.connect(alice).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
    } catch {
      reverted = true;
    }
    // Observed local behavior (mock). On Sepolia the proof verification is
    // strict; this documents the mock's behavior for the Sepolia check.
    if (reverted) {
      expect(await credited(addrAlice, alice)).to.equal(0n);
    } else {
      expect(await credited(addrAlice, alice)).to.equal(60n); // mock accepted - SEPOLIA-VERIFY
    }
    await assertSolvency();
  });

  it("E4 [SEPOLIA]: wrong-sender input - Alice submits an input created by Bob", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    const encrypted = await fhevm.createEncryptedInput(poolAddr, addrBob).add64(60n).encrypt();
    let reverted = false;
    try {
      await (await pool.connect(alice).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
    } catch {
      reverted = true;
    }
    // Either way no cross-user theft: the transfer source is always
    // msg.sender (Alice), who must have granted the pool operator rights.
    expect(await userTokens(addrBob)).to.equal(0n);
    expect(await holdings()).to.equal(await credited(addrAlice, alice));
    await assertSolvency();
  });

  it("E5: malformed input - zero handle with empty proof is a zero-value no-op, never a revert or credit", async function () {
    await wrapAs(alice, addrAlice, 1n);
    await setOperatorAs(alice);
    await (await pool.connect(alice).deposit(ethers.ZeroHash, "0x")).wait();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect(await holdings()).to.equal(0n);
    await assertSolvency();
  });

  it("E6: alternating deposit/withdraw across many transactions - no ACL freeze, handles stay operable", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    for (let i = 0; i < 3; i++) {
      await depositAs(alice, addrAlice, 10n);
      await withdrawAs(alice, addrAlice, 10n);
    }
    await depositAs(alice, addrAlice, 10n);
    expect(await credited(addrAlice, alice)).to.equal(10n);
    await (await pool.connect(alice).withdrawAll()).wait();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect(await holdings()).to.equal(0n);
  });

  // =====================================================================
  // F. AUTHORITY / ADMIN ATTACKS
  // =====================================================================

  it("F1: no setters or upgrade paths - MAX_* are immutable/constant, no proxy, no delegatecall, no selfdestruct", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "contracts", "IwaPrizeSavings.sol"),
      "utf8",
    );
    expect(source).to.not.contain("delegatecall");
    expect(source).to.not.contain("selfdestruct");
    expect(source).to.not.contain("setMAX_PARTICIPANTS");
    expect(source).to.not.contain("setMAX_POOL_TOTAL");
    expect(source).to.not.contain("setDRAW_TIMEOUT");
    expect(source).to.not.contain("address(0)).call");
    expect(source).to.not.contain("function setWinner");
    // MAX_* are written exactly once, in the constructor.
    expect((source.match(/MAX_PARTICIPANTS = /g) ?? []).length).to.equal(1);
    expect((source.match(/MAX_POOL_TOTAL = /g) ?? []).length).to.equal(1);
  });

  it("F2: the owner cannot move pool tokens through the token contract (no unwrap, no transferFrom of the pool)", async function () {
    await twoParticipantWorld();
    await pool.connect(deployer).lockRound();

    // Unwrap attack: unwrap the POOL's confidential tokens.
    let reverted = false;
    try {
      const e = await fhevm.createEncryptedInput(wrapperAddr, addrOwner).add64(120n).encrypt();
      await (await wrapper.connect(deployer).unwrap(poolAddr, addrOwner, e.handles[0], e.inputProof)).wait();
    } catch {
      reverted = true;
    }
    expect(reverted, "owner must not unwrap the pool's tokens").to.be.true;

    // transferFrom attack: move the pool's confidential tokens out.
    reverted = false;
    try {
      const e = await fhevm.createEncryptedInput(wrapperAddr, addrOwner).add64(120n).encrypt();
      await (await wrapper.connect(deployer).confidentialTransferFrom(poolAddr, addrOwner, e.handles[0], e.inputProof)).wait();
    } catch {
      reverted = true;
    }
    expect(reverted, "owner must not transferFrom the pool's tokens").to.be.true;

    expect(await holdings()).to.equal(120n);
    expect(await reserve()).to.equal(20n);
  });

  // =====================================================================
  // G. ERC-7984 SPECIFIC ATTACKS
  // =====================================================================

  it("G1: operator expiry and missing-operator attacks fail safely (asserted at the token level)", async function () {
    await wrapAs(alice, addrAlice, 100n);
    // No setOperator at all.
    let reverted = false;
    try {
      await depositAs(alice, addrAlice, 10n);
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;

    // Expired operator.
    await (await wrapper.connect(alice).setOperator(poolAddr, (await ethers.provider.getBlock("latest"))!.timestamp - 60)).wait();
    reverted = false;
    try {
      await depositAs(alice, addrAlice, 10n);
    } catch {
      reverted = true;
    }
    expect(reverted).to.be.true;
    expect(await holdings()).to.equal(0n);
    expect(await pool.isParticipant(addrAlice)).to.equal(false);
  });

  it("G2: donation to the pool cannot be withdrawn, cannot break claims, and stays surplus", async function () {
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 50n);

    // Bob donates 30 cMockUSD directly to the pool (confidentialTransfer to pool).
    await wrapAs(bob, addrBob, 100n);
    const e = await fhevm.createEncryptedInput(wrapperAddr, addrBob).add64(30n).encrypt();
    await (
      await wrapper
        .connect(bob)
        ["confidentialTransfer(address,bytes32,bytes)"](poolAddr, e.handles[0], e.inputProof)
    ).wait();

    // Surplus: holdings (80) exceed liabilities (50); the ≤ invariant holds.
    expect(await holdings()).to.equal(80n);
    expect(await credited(addrAlice, alice)).to.equal(50n);
    await assertSolvency();

    // Alice can still withdraw fully - the donation never unbacks her claim.
    await (await pool.connect(alice).withdrawAll()).wait();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    expect(await holdings()).to.equal(30n); // the untouchable donation remains
  });

  // =====================================================================
  // H. STATE MACHINE ATTACKS
  // =====================================================================

  it("H1: illegal transitions all revert (full matrix)", async function () {
    // Open: deposit/fund OK, claim/draw/lockRound-twice blocked.
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 10n);
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    const f = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(5n).encrypt();
    await (await pool.connect(deployer).fundPrize(f.handles[0], f.inputProof)).wait();

    let reverted = false;
    try {
      await pool.connect(alice).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "Open->claim must revert").to.be.true;
    reverted = false;
    try {
      await pool.connect(deployer).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "Open->draw must revert").to.be.true;

    // Locked: deposit/fundPrize/claim blocked; withdraw allowed.
    await pool.connect(deployer).lockRound();
    reverted = false;
    try {
      await depositAs(alice, addrAlice, 10n);
    } catch {
      reverted = true;
    }
    expect(reverted, "Locked->deposit must revert").to.be.true;
    reverted = false;
    try {
      await (await pool.connect(deployer).fundPrize(f.handles[0], f.inputProof)).wait();
    } catch {
      reverted = true;
    }
    expect(reverted, "Locked->fundPrize must revert").to.be.true;
    reverted = false;
    try {
      await pool.connect(alice).claim();
    } catch {
      reverted = true;
    }
    expect(reverted, "Locked->claim must revert").to.be.true;
    await withdrawAs(alice, addrAlice, 5n); // withdrawal is allowed in Locked

    // Drawn: second draw blocked; claim allowed.
    await (await pool.connect(deployer).draw()).wait();
    reverted = false;
    try {
      await pool.connect(deployer).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "Drawn->draw must revert").to.be.true;

    // Claimable: deposit/fundPrize blocked; withdraw/withdrawAll allowed.
    await (await pool.connect(alice).claim()).wait();
    reverted = false;
    try {
      await depositAs(alice, addrAlice, 10n);
    } catch {
      reverted = true;
    }
    expect(reverted, "Claimable->deposit must revert").to.be.true;
    await (await pool.connect(alice).withdrawAll()).wait();
    expect(await credited(addrAlice, alice)).to.equal(0n);
    await assertSolvency();
  });

  // =====================================================================
  // I. FULL ADVERSARIAL LIFECYCLE (separate transactions)
  // =====================================================================

  it("I: adversarial lifecycle - attacker zero-registers, real users flow, timeout draw, claims, exits", async function () {
    // Attacker zero-registers one wallet (one slot only).
    const attacker = (await ethers.getSigners())[3];
    const addrAttacker = await attacker.getAddress();
    await setOperatorAs(attacker);
    const z = await fhevm.createEncryptedInput(poolAddr, addrAttacker).add64(100n).encrypt();
    await (await pool.connect(attacker).deposit(z.handles[0], z.inputProof)).wait();
    expect(await pool.participantCount()).to.equal(1n);

    // Real users deposit.
    await wrapAs(alice, addrAlice, 100n);
    await setOperatorAs(alice);
    await depositAs(alice, addrAlice, 60n);
    await wrapAs(bob, addrBob, 100n);
    await setOperatorAs(bob);
    await depositAs(bob, addrBob, 40n);
    expect(await total()).to.equal(100n);

    // Users withdraw/redeposit around the lock.
    await withdrawAs(alice, addrAlice, 10n);
    await depositAs(alice, addrAlice, 10n);
    expect(await total()).to.equal(100n);

    // Owner funds, locks. Owner refuses to draw - after the timeout anyone can.
    await wrapAs(deployer, addrOwner, 100n);
    await setOperatorAs(deployer);
    const f = await fhevm.createEncryptedInput(poolAddr, addrOwner).add64(20n).encrypt();
    await (await pool.connect(deployer).fundPrize(f.handles[0], f.inputProof)).wait();
    await (await pool.connect(deployer).lockRound()).wait();

    let reverted = false;
    try {
      await pool.connect(alice).draw();
    } catch {
      reverted = true;
    }
    expect(reverted, "pre-timeout non-owner draw must revert").to.be.true;

    await ethers.provider.send("evm_increaseTime", [900]);
    await (await pool.connect(alice).draw()).wait(); // permissionless after timeout
    expect(await pool.roundState()).to.equal(2n);

    // Non-winner claims first, winner claims later - per-user flags hold.
    await (await pool.connect(bob).claim()).wait();
    await (await pool.connect(alice).claim()).wait();
    await assertSolvency();

    // Winner/partial/full exits.
    await withdrawAs(alice, addrAlice, 30n);
    await (await pool.connect(alice).withdrawAll()).wait();
    await (await pool.connect(bob).withdrawAll()).wait();
    await (await pool.connect(attacker).withdrawAll()).wait(); // zero-weight exit is a no-op

    // The real random draw decides the winner (or rolls over); no principal
    // is ever lost: each of Alice/Bob ends with 100-120 tokens, and the 20
    // prize stays within the participant set (or remains as a backed reserve).
    const aliceEnd = await userTokens(addrAlice);
    const bobEnd = await userTokens(addrBob);
    expect(aliceEnd >= 100n && aliceEnd <= 120n).to.be.true;
    expect(bobEnd >= 100n && bobEnd <= 120n).to.be.true;
    expect(aliceEnd + bobEnd).to.equal(200n + (20n - (await reserve())));
    expect(await userTokens(addrAttacker)).to.equal(0n);
    const final = await assertSolvency();
    expect(final.sum + final.r).to.equal(final.h);
    expect(final.sum).to.equal(0n);
  });
});