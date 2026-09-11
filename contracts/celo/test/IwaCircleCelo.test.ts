import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const AMOUNT = 5_000_000n;
const CADENCE = 100n;
const GRACE = 50n;
const CNGN_MAINNET = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";

describe("IwaCircleCelo", function () {
  let a: HardhatEthersSigner;
  let b: HardhatEthersSigner;
  let c: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;
  let token: any;
  let circle: any;

  async function deployCircle(
    members: string[],
    tokenOverride?: any,
    amount = AMOUNT,
  ) {
    const tok = tokenOverride ?? token;
    const factory = await ethers.getContractFactory("IwaCircleCelo");
    const deployed = await factory.deploy(
      await tok.getAddress(),
      amount,
      CADENCE,
      GRACE,
      members,
    );
    await deployed.waitForDeployment();
    return deployed;
  }

  async function fundAndApprove(signer: HardhatEthersSigner, spend = AMOUNT) {
    await token.mint(signer.address, spend * 4n);
    await token.connect(signer).approve(await circle.getAddress(), spend * 4n);
  }

  beforeEach(async function () {
    [a, b, c, outsider] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    await token.waitForDeployment();
    circle = await deployCircle([a.address, b.address, c.address]);
    await fundAndApprove(a);
    await fundAndApprove(b);
    await fundAndApprove(c);
  });

  describe("creation and token binding", function () {
    it("binds the token, amount, members, and payout order immutably", async function () {
      expect(await circle.contributionAmount()).to.equal(AMOUNT);
      expect(await circle.memberCount()).to.equal(3);
      expect(await circle.currentRound()).to.equal(1);
      expect(await circle.memberAt(0)).to.equal(a.address);
      expect(await circle.scheduledMember(1)).to.equal(a.address);
      expect(await circle.scheduledMember(2)).to.equal(b.address);
      expect(await circle.token()).to.equal(await token.getAddress());
    });

    it("rejects invalid config", async function () {
      const factory = await ethers.getContractFactory("IwaCircleCelo");
      await expect(
        factory.deploy(await token.getAddress(), 0, CADENCE, GRACE, [a.address, b.address]),
      ).to.be.revertedWithCustomError(circle, "InvalidConfig");
      await expect(
        factory.deploy(await token.getAddress(), AMOUNT, CADENCE, GRACE, [a.address]),
      ).to.be.revertedWithCustomError(circle, "InvalidConfig");
      await expect(
        factory.deploy(await token.getAddress(), AMOUNT, CADENCE, GRACE, [
          a.address,
          a.address,
        ]),
      ).to.be.revertedWithCustomError(circle, "InvalidConfig");
    });

    it("pins canonical cNGN on Celo mainnet chain id", async function () {
      expect(await circle.CNGN_MAINNET()).to.equal(CNGN_MAINNET);
      expect(await circle.CELO_MAINNET_CHAIN_ID()).to.equal(42220);
    });

    it("rejects a zero-address token", async function () {
      const factory = await ethers.getContractFactory("IwaCircleCelo");
      await expect(
        factory.deploy(ethers.ZeroAddress, AMOUNT, CADENCE, GRACE, [a.address, b.address]),
      ).to.be.revertedWithCustomError(circle, "InvalidConfig");
    });

    it("rejects a zero-address member", async function () {
      const factory = await ethers.getContractFactory("IwaCircleCelo");
      await expect(
        factory.deploy(await token.getAddress(), AMOUNT, CADENCE, GRACE, [
          a.address,
          ethers.ZeroAddress,
        ]),
      ).to.be.revertedWithCustomError(circle, "InvalidConfig");
    });

    it("rejects zero cadence", async function () {
      const factory = await ethers.getContractFactory("IwaCircleCelo");
      await expect(
        factory.deploy(await token.getAddress(), AMOUNT, 0, GRACE, [a.address, b.address]),
      ).to.be.revertedWithCustomError(circle, "InvalidConfig");
    });

    it("rejects more than MAX_MEMBERS members", async function () {
      expect(await circle.MAX_MEMBERS()).to.equal(32);
      const tooMany = Array.from({ length: 33 }, () => ethers.Wallet.createRandom().address);
      const factory = await ethers.getContractFactory("IwaCircleCelo");
      await expect(
        factory.deploy(await token.getAddress(), AMOUNT, CADENCE, GRACE, tooMany),
      ).to.be.revertedWithCustomError(circle, "InvalidConfig");
    });

    it("accepts exactly MAX_MEMBERS members", async function () {
      const exactly = Array.from({ length: 32 }, () => ethers.Wallet.createRandom().address);
      const factory = await ethers.getContractFactory("IwaCircleCelo");
      const deployed = await factory.deploy(
        await token.getAddress(),
        AMOUNT,
        CADENCE,
        GRACE,
        exactly,
      );
      await deployed.waitForDeployment();
      expect(await deployed.memberCount()).to.equal(32);
    });
  });

  describe("contributions", function () {
    it("accepts only the fixed amount from members via contribute()", async function () {
      await expect(circle.connect(a).contribute()).to.emit(circle, "Contributed");
      expect(await circle.contributionStatus(1, a.address)).to.equal(1); // OnTime
      expect(await token.balanceOf(await circle.getAddress())).to.equal(AMOUNT);
    });

    it("rejects a non-member", async function () {
      await token.mint(outsider.address, AMOUNT);
      await token.connect(outsider).approve(await circle.getAddress(), AMOUNT);
      await expect(circle.connect(outsider).contribute()).to.be.revertedWithCustomError(
        circle,
        "NotMember",
      );
    });

    it("rejects a duplicate contribution", async function () {
      await circle.connect(a).contribute();
      await expect(circle.connect(a).contribute()).to.be.revertedWithCustomError(
        circle,
        "AlreadySatisfied",
      );
    });

    it("rejects contribution after the grace window", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await expect(circle.connect(a).contribute()).to.be.revertedWithCustomError(
        circle,
        "WindowClosed",
      );
    });

    it("records late-within-grace after the due time", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await circle.connect(a).contribute();
      expect(await circle.contributionStatus(1, a.address)).to.equal(2); // LateWithinGrace
    });

    it("does not mark paid when a fee-on-transfer token delivers less", async function () {
      const feeTok: any = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy();
      await feeTok.waitForDeployment();
      const feeCircle: any = await deployCircle([a.address, b.address], feeTok);
      await feeTok.mint(a.address, AMOUNT * 2n);
      await feeTok.connect(a).approve(await feeCircle.getAddress(), AMOUNT * 2n);
      await expect(feeCircle.connect(a).contribute()).to.be.revertedWithCustomError(
        feeCircle,
        "ShortTransfer",
      );
      expect(await feeCircle.contributionStatus(1, a.address)).to.equal(0);
    });

    it("rejects finalizeDefault before the grace window expires", async function () {
      await expect(circle.finalizeDefault(a.address)).to.be.revertedWithCustomError(
        circle,
        "GraceNotExpired",
      );
    });

    it("rejects finalizeDefault for a non-member", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await expect(circle.finalizeDefault(outsider.address)).to.be.revertedWithCustomError(
        circle,
        "NotMember",
      );
    });

    it("rejects finalizeDefault for a member who already contributed (history immutable)", async function () {
      await circle.connect(a).contribute();
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await expect(circle.finalizeDefault(a.address)).to.be.revertedWithCustomError(
        circle,
        "HistoryImmutable",
      );
    });

    it("is permissionless and callable by anyone, including a non-member", async function () {
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await expect(circle.connect(outsider).finalizeDefault(a.address))
        .to.emit(circle, "Defaulted")
        .withArgs(a.address, 1);
      expect(await circle.contributionStatus(1, a.address)).to.equal(3); // MissedDefault
    });
  });

  describe("payouts", function () {
    async function fundRound() {
      await circle.connect(a).contribute();
      await circle.connect(b).contribute();
      await circle.connect(c).contribute();
    }

    it("pays only the scheduled member the full pot", async function () {
      await fundRound();
      const before = await token.balanceOf(a.address);
      await expect(circle.connect(a).collect()).to.emit(circle, "Collected");
      expect(await token.balanceOf(a.address)).to.equal(before + AMOUNT * 3n);
      expect(await circle.payoutStatus(1)).to.equal(1); // Paid
      expect(await circle.currentRound()).to.equal(2);
      expect(await circle.scheduledMember(2)).to.equal(b.address);
    });

    it("lets anyone trigger collect(), but the pot always lands on the scheduled member", async function () {
      await fundRound();
      const beforeA = await token.balanceOf(a.address);
      const beforeB = await token.balanceOf(b.address);
      // b is not scheduled for round 1, yet may still call collect().
      await expect(circle.connect(b).collect())
        .to.emit(circle, "Collected")
        .withArgs(a.address, 1, AMOUNT * 3n);
      expect(await token.balanceOf(a.address)).to.equal(beforeA + AMOUNT * 3n);
      expect(await token.balanceOf(b.address)).to.equal(beforeB);
      expect(await circle.currentRound()).to.equal(2);
    });

    it("permissionless collect does not bypass the funding/default gates", async function () {
      await circle.connect(a).contribute();
      await expect(circle.connect(outsider).collect()).to.be.revertedWithCustomError(
        circle,
        "RoundNotFunded",
      );
    });

    it("does not let a member's refusal to call collect() freeze the circle", async function () {
      // This is the liveness scenario: every member pays, but the scheduled
      // recipient (a) never calls collect(). A third party can still trigger
      // the payout, and it still pays only a.
      await fundRound();
      const before = await token.balanceOf(a.address);
      await circle.connect(outsider).collect();
      expect(await token.balanceOf(a.address)).to.equal(before + AMOUNT * 3n);
      expect(await circle.payoutStatus(1)).to.equal(1); // Paid
      expect(await circle.currentRound()).to.equal(2);
    });

    it("has no recipient argument, so payout cannot be redirected", async function () {
      const fragment = circle.interface.getFunction("collect");
      expect(fragment.inputs.length).to.equal(0);
    });

    it("rejects collect before the round is fully funded", async function () {
      await circle.connect(a).contribute();
      await expect(circle.connect(a).collect()).to.be.revertedWithCustomError(
        circle,
        "RoundNotFunded",
      );
    });

    it("locks payout on deficit and never redirects it", async function () {
      await circle.connect(a).contribute();
      await circle.connect(b).contribute();
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await circle.finalizeDefault(c.address);
      await expect(circle.connect(a).collect()).to.be.revertedWithCustomError(
        circle,
        "PayoutLocked",
      );
      await circle.lockPayoutAndAdvance();
      expect(await circle.payoutStatus(1)).to.equal(2); // DeferredLocked
      expect(await circle.currentRound()).to.equal(2);
      const before = await token.balanceOf(a.address);
      await circle.connect(a).recover(1);
      expect(await token.balanceOf(a.address)).to.equal(before + AMOUNT);
      await expect(circle.connect(c).recover(1)).to.be.revertedWithCustomError(
        circle,
        "NotRecoverable",
      );
    });

    it("handles multiple defaults in the same round: only the payer recovers", async function () {
      await circle.connect(a).contribute();
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await circle.finalizeDefault(b.address);
      await circle.finalizeDefault(c.address);
      await circle.lockPayoutAndAdvance();
      expect(await circle.payoutStatus(1)).to.equal(2); // DeferredLocked
      const before = await token.balanceOf(a.address);
      await circle.connect(a).recover(1);
      expect(await token.balanceOf(a.address)).to.equal(before + AMOUNT);
      await expect(circle.connect(a).recover(1)).to.be.revertedWithCustomError(
        circle,
        "AlreadyRecovered",
      );
    });

    it("rejects lockPayoutAndAdvance while any obligation is still open", async function () {
      await circle.connect(a).contribute();
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await circle.finalizeDefault(b.address);
      // c's obligation for round 1 was never finalized as a default.
      await expect(circle.lockPayoutAndAdvance()).to.be.revertedWithCustomError(
        circle,
        "ObligationsOpen",
      );
    });

    it("rejects lockPayoutAndAdvance when there is no deficit", async function () {
      await fundRound();
      await expect(circle.lockPayoutAndAdvance()).to.be.revertedWithCustomError(
        circle,
        "NoDeficit",
      );
    });

    it("advances every round to Completed and rejects all further action", async function () {
      await fundRound();
      await circle.connect(outsider).collect(); // round 1 -> a
      await circle.connect(b).contribute();
      await circle.connect(c).contribute();
      await circle.connect(a).contribute();
      await circle.connect(outsider).collect(); // round 2 -> b
      await circle.connect(c).contribute();
      await circle.connect(a).contribute();
      await circle.connect(b).contribute();
      await circle.connect(outsider).collect(); // round 3 -> c
      expect(await circle.status()).to.equal(1); // Completed
      expect(await circle.currentRound()).to.equal(3);

      await expect(circle.connect(a).contribute()).to.be.revertedWithCustomError(
        circle,
        "Inactive",
      );
      await expect(circle.connect(a).collect()).to.be.revertedWithCustomError(
        circle,
        "Inactive",
      );
      await expect(circle.finalizeDefault(a.address)).to.be.revertedWithCustomError(
        circle,
        "Inactive",
      );
      await expect(circle.lockPayoutAndAdvance()).to.be.revertedWithCustomError(
        circle,
        "Inactive",
      );
    });
  });

  describe("recovery", function () {
    async function lockRoundOneWithDeficit() {
      await circle.connect(a).contribute();
      await circle.connect(b).contribute();
      await ethers.provider.send("evm_increaseTime", [Number(CADENCE + GRACE + 1n)]);
      await ethers.provider.send("evm_mine", []);
      await circle.finalizeDefault(c.address);
      await circle.lockPayoutAndAdvance();
    }

    it("rejects recover for a round that was never locked", async function () {
      await circle.connect(a).contribute();
      await expect(circle.connect(a).recover(1)).to.be.revertedWithCustomError(
        circle,
        "NotRecoverable",
      );
    });

    it("rejects recover from a non-member", async function () {
      await lockRoundOneWithDeficit();
      await expect(circle.connect(outsider).recover(1)).to.be.revertedWithCustomError(
        circle,
        "NotMember",
      );
    });

    it("rejects a second recover for the same member and round", async function () {
      await lockRoundOneWithDeficit();
      await circle.connect(a).recover(1);
      await expect(circle.connect(a).recover(1)).to.be.revertedWithCustomError(
        circle,
        "AlreadyRecovered",
      );
    });

    it("does not let the defaulting member recover a round they never paid", async function () {
      await lockRoundOneWithDeficit();
      await expect(circle.connect(c).recover(1)).to.be.revertedWithCustomError(
        circle,
        "NotRecoverable",
      );
    });
  });

  describe("stray tokens", function () {
    it("a direct donation to the contract cannot inflate the payout or block accounting", async function () {
      await circle.connect(a).contribute();
      await circle.connect(b).contribute();
      // Someone accidentally sends cNGN straight to the circle, outside contribute().
      await token.mint(await circle.getAddress(), AMOUNT * 10n);
      await circle.connect(c).contribute();
      const before = await token.balanceOf(a.address);
      await circle.connect(a).collect();
      // The pot paid out is exactly contributionAmount * memberCount, never the
      // inflated contract balance.
      expect(await token.balanceOf(a.address)).to.equal(before + AMOUNT * 3n);
      // The donated surplus remains in the contract, unattributed and stuck,
      // but it never affected round 1's payout or round 2's accounting.
      expect(await token.balanceOf(await circle.getAddress())).to.equal(AMOUNT * 10n);
    });
  });

  describe("custody and immutability", function () {
    it("has no owner, pause, upgrade, or privileged withdraw", async function () {
      const names = circle.interface.fragments
        .filter((f: { type: string }) => f.type === "function")
        .map((f: { name?: string }) => f.name);
      for (const banned of ["owner", "pause", "unpause", "upgradeTo", "withdraw", "rescue"]) {
        expect(names).to.not.include(banned);
      }
    });

    it("does not let the deployer drain member funds", async function () {
      await circle.connect(a).contribute();
      const held = await token.balanceOf(await circle.getAddress());
      expect(held).to.equal(AMOUNT);
      await expect(
        token.connect(a).transferFrom(await circle.getAddress(), a.address, AMOUNT),
      ).to.be.reverted;
    });

    it("cannot reorder members after activation", async function () {
      const names = circle.interface.fragments
        .filter((f: { type: string }) => f.type === "function")
        .map((f: { name?: string }) => f.name);
      expect(names).to.not.include("setPayoutOrder");
      expect(names).to.not.include("addMember");
      expect(await circle.memberAt(0)).to.equal(a.address);
      expect(await circle.memberAt(1)).to.equal(b.address);
    });
  });

  describe("source guards", function () {
    it("does not include privileged or upgradeable patterns", function () {
      const src = readFileSync(
        join(__dirname, "..", "contracts", "IwaCircleCelo.sol"),
        "utf8",
      );
      expect(src).to.not.match(/Ownable|onlyOwner|Pausable|UUPS|proxy|delegatecall|selfdestruct/i);
      expect(src).to.not.match(/function contribute\([^)]*uint256/);
      expect(src).to.not.match(/function collect\([^)]*address/);
    });
  });

  describe("reentrancy", function () {
    it("blocks a reentrant contribute during transferFrom", async function () {
      const reTok: any = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      await reTok.waitForDeployment();
      const reCircle: any = await deployCircle([a.address, b.address], reTok);
      await reTok.setCircle(await reCircle.getAddress());
      await reTok.mint(a.address, AMOUNT * 4n);
      await reTok.connect(a).approve(await reCircle.getAddress(), AMOUNT * 4n);
      await reTok.armContribute();
      await expect(reCircle.connect(a).contribute()).to.be.reverted;
    });

    it("blocks a reentrant collect during the payout transfer", async function () {
      const reTok: any = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      await reTok.waitForDeployment();
      const reCircle: any = await deployCircle([a.address, b.address], reTok);
      await reTok.setCircle(await reCircle.getAddress());
      await reTok.mint(a.address, AMOUNT * 4n);
      await reTok.mint(b.address, AMOUNT * 4n);
      await reTok.connect(a).approve(await reCircle.getAddress(), AMOUNT * 4n);
      await reTok.connect(b).approve(await reCircle.getAddress(), AMOUNT * 4n);
      await reCircle.connect(a).contribute();
      await reCircle.connect(b).contribute();
      await reTok.armCollect();
      // The malicious token tries to re-enter collect() from inside the
      // payout transfer. nonReentrant must block it regardless of the
      // permissionless caller change.
      await expect(reCircle.connect(a).collect()).to.be.reverted;
    });
  });
});
