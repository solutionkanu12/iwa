import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * S2 spike: GO/NO-GO on the confidential deposit-weighted winner-selection
 * algorithm (spec section 7 / plan Phase 0).
 *
 * Architecture under test:
 *   plaintext power-of-two MAX_POOL_TOTAL
 *   -> FHE.randEuint64(MAX_POOL_TOTAL)          (production path, drawRandom)
 *   -> encrypted cumulative sum of participant weights
 *   -> compare ticket against encrypted cumulative ranges
 *   -> encrypted euint16 winner index, or a NO_WINNER sentinel
 *
 * Two contract entry points are exercised:
 *   - drawRandom(bound): the real production-shaped path, used ONLY to
 *     measure HCU cost of the actual randomness primitive.
 *   - drawWithTicket(ticket, proof): a TEST-ONLY deterministic path that lets
 *     us supply the encrypted ticket directly, so the cumulative-selection
 *     algorithm's structural correctness can be verified without depending
 *     on non-deterministic on-chain randomness. This must never be carried
 *     into the production pool contract.
 */
describe("S2 - SpikeWeightedDraw GO/NO-GO", function () {
  const NO_WINNER = 65535; // type(uint16).max sentinel - cannot collide with any real index (< MAX_N)
  const MAX_POOL_TOTAL = 1024n; // plaintext power-of-two bound for drawRandom HCU runs

  let deployer: Signer;
  let deployerAddr: string;

  beforeEach(async function () {
    [deployer] = await ethers.getSigners();
    deployerAddr = await deployer.getAddress();
  });

  async function deploy(): Promise<{ contract: any; address: string }> {
    const factory = await ethers.getContractFactory("SpikeWeightedDraw");
    const contract: any = await factory.deploy();
    await contract.waitForDeployment();
    return { contract, address: await contract.getAddress() };
  }

  async function setWeight(contract: any, address: string, value: bigint) {
    const enc = await fhevm
      .createEncryptedInput(address, deployerAddr)
      .add64(value)
      .encrypt();
    await (
      await contract.connect(deployer).setWeight(enc.handles[0], enc.inputProof)
    ).wait();
  }

  async function drawWithTicket(contract: any, address: string, ticket: bigint) {
    const enc = await fhevm
      .createEncryptedInput(address, deployerAddr)
      .add64(ticket)
      .encrypt();
    const tx = await contract
      .connect(deployer)
      .drawWithTicket(enc.handles[0], enc.inputProof);
    return tx.wait();
  }

  async function decryptWinner(contract: any, address: string) {
    const handle = await contract.getWinnerIndex();
    const clear = await fhevm.userDecryptEuint(
      FhevmType.euint16,
      handle,
      address,
      deployer,
    );
    return Number(clear);
  }

  // ---------------------------------------------------------------------
  // Structural correctness (deterministic, via drawWithTicket)
  // ---------------------------------------------------------------------

  it("selects the correct participant for a ticket at the exact lower bound of an interval", async function () {
    const { contract, address } = await deploy();
    // weights: [10, 20, 30] -> intervals [0,10) [10,30) [30,60)
    await setWeight(contract, address, 10n);
    await setWeight(contract, address, 20n);
    await setWeight(contract, address, 30n);

    await drawWithTicket(contract, address, 10n); // exact lower bound of participant 1
    expect(await decryptWinner(contract, address)).to.equal(1);
  });

  it("selects the correct participant for a ticket at the exact upper bound minus one", async function () {
    const { contract, address } = await deploy();
    await setWeight(contract, address, 10n);
    await setWeight(contract, address, 20n);
    await setWeight(contract, address, 30n);

    await drawWithTicket(contract, address, 29n); // last value still inside participant 1's [10,30)
    expect(await decryptWinner(contract, address)).to.equal(1);
  });

  it("selects the LAST participant when the ticket lands in the final interval, proving later loop iterations don't overwrite an earlier true match incorrectly and vice versa", async function () {
    const { contract, address } = await deploy();
    await setWeight(contract, address, 10n);
    await setWeight(contract, address, 20n);
    await setWeight(contract, address, 30n);

    await drawWithTicket(contract, address, 59n); // last index of participant 2's [30,60)
    expect(await decryptWinner(contract, address)).to.equal(2);
  });

  it("an early match (index 0) survives unmodified through all later loop iterations", async function () {
    const { contract, address } = await deploy();
    // weights: [10, 20, 30, 40] -> intervals [0,10) [10,30) [30,60) [60,100)
    await setWeight(contract, address, 10n);
    await setWeight(contract, address, 20n);
    await setWeight(contract, address, 30n);
    await setWeight(contract, address, 40n);

    await drawWithTicket(contract, address, 5n); // matches index 0; 3 more iterations run afterward
    expect(await decryptWinner(contract, address)).to.equal(0);
  });

  it("rejects a participant beyond the configured cap (no unbounded participant loop)", async function () {
    const { contract, address } = await deploy();
    for (let i = 0; i < 16; i++) {
      await setWeight(contract, address, 1n);
    }
    expect(await contract.participantCount()).to.equal(16n);

    const enc = await fhevm
      .createEncryptedInput(address, deployerAddr)
      .add64(1n)
      .encrypt();
    let reverted = false;
    try {
      await (
        await contract
          .connect(deployer)
          .setWeight(enc.handles[0], enc.inputProof)
      ).wait();
    } catch {
      reverted = true;
    }
    expect(reverted, "17th participant must be rejected").to.be.true;
  });

  it("the contract source never calls a public/broadcast decryption primitive (no accidental winner disclosure)", async function () {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "contracts", "spike", "SpikeWeightedDraw.sol"),
      "utf8",
    );
    expect(source).to.not.contain("makePubliclyDecryptable");
    expect(source).to.not.contain("allowForDecryption");
  });

  it("a ticket exactly at the encrypted total (out of range) yields NO_WINNER, not a wraparound", async function () {
    const { contract, address } = await deploy();
    await setWeight(contract, address, 10n);
    await setWeight(contract, address, 20n);
    await setWeight(contract, address, 30n); // total = 60

    await drawWithTicket(contract, address, 60n); // == total, must NOT select participant 0 or anyone
    expect(await decryptWinner(contract, address)).to.equal(NO_WINNER);
  });

  it("a ticket far beyond the encrypted total (MAX_POOL_TOTAL headroom) yields NO_WINNER - the rollover case, with no silent re-biasing back into range", async function () {
    const { contract, address } = await deploy();
    await setWeight(contract, address, 10n);
    await setWeight(contract, address, 20n); // total = 30, MAX_POOL_TOTAL is much larger in production

    await drawWithTicket(contract, address, 999n); // far outside the real total
    expect(await decryptWinner(contract, address)).to.equal(NO_WINNER);
  });

  it("a zero-weight participant can never be selected, and the ticket at its degenerate interval falls through to the next participant", async function () {
    const { contract, address } = await deploy();
    // weights: [10, 0, 20] -> intervals [0,10) [10,10) [10,30)
    // participant 1's interval has zero width and can never contain a ticket.
    await setWeight(contract, address, 10n);
    await setWeight(contract, address, 0n);
    await setWeight(contract, address, 20n);

    await drawWithTicket(contract, address, 10n); // would-be lower bound of the zero-weight participant
    expect(await decryptWinner(contract, address)).to.equal(2);
  });

  it("all-zero weights (degenerate pool) always yields NO_WINNER", async function () {
    const { contract, address } = await deploy();
    await setWeight(contract, address, 0n);
    await setWeight(contract, address, 0n);

    await drawWithTicket(contract, address, 0n);
    expect(await decryptWinner(contract, address)).to.equal(NO_WINNER);
  });

  it("a single participant with the ticket at 0 selects index 0", async function () {
    const { contract, address } = await deploy();
    await setWeight(contract, address, 5n);

    await drawWithTicket(contract, address, 0n);
    expect(await decryptWinner(contract, address)).to.equal(0);
  });

  it("winner is stored as euint16 (not eaddress/euint160) - type check via successful euint16 user-decrypt", async function () {
    const { contract, address } = await deploy();
    await setWeight(contract, address, 5n);
    await drawWithTicket(contract, address, 0n);

    // If getWinnerIndex() were not actually a euint16 handle, decrypting it as
    // FhevmType.euint16 would fail with a type-mismatch error.
    const handle = await contract.getWinnerIndex();
    const clear = await fhevm.userDecryptEuint(
      FhevmType.euint16,
      handle,
      address,
      deployer,
    );
    expect(clear).to.equal(0n);
  });

  it("no plaintext weight or winner index appears in emitted event data", async function () {
    const { contract, address } = await deploy();
    const receipt1 = await (async () => {
      const enc = await fhevm
        .createEncryptedInput(address, deployerAddr)
        .add64(42n)
        .encrypt();
      const tx = await contract
        .connect(deployer)
        .setWeight(enc.handles[0], enc.inputProof);
      return tx.wait();
    })();

    const plaintextWord = ethers.zeroPadValue("0x2a", 32).slice(2).toLowerCase(); // 42
    const ourLogs1 = receipt1.logs.filter(
      (l: any) => l.address.toLowerCase() === address.toLowerCase(),
    );
    for (const log of ourLogs1) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        expect(data.slice(p, p + 64)).to.not.equal(plaintextWord);
      }
    }

    const receipt2 = await drawWithTicket(contract, address, 0n);
    const winnerWord = ethers.zeroPadValue("0x00", 32).slice(2).toLowerCase(); // index 0
    const ourLogs2 = receipt2.logs.filter(
      (l: any) => l.address.toLowerCase() === address.toLowerCase(),
    );
    // Only assert on OUR emitted event topics (indexed winner would be a
    // property/security bug); the Drawn event here carries no data at all.
    for (const log of ourLogs2) {
      expect(log.data).to.equal("0x");
    }
  });

  // ---------------------------------------------------------------------
  // HCU measurement (production-shaped path via FHE.randEuint64)
  // ---------------------------------------------------------------------

  const GLOBAL_LIMIT = 20_000_000;
  const SEQUENTIAL_DEPTH_LIMIT = 5_000_000;

  const results: Array<{
    n: number;
    globalHCU: number;
    maxHCUDepth: number;
    gasUsed: string;
    succeeded: boolean;
  }> = [];

  after(function () {
    console.log("\n=== S2 HCU measurement summary (LOCAL MOCK - indicative only) ===");
    console.log("N\tglobalHCU\tmaxHCUDepth\tgasUsed\t\tsucceeded");
    for (const r of results) {
      console.log(
        `${r.n}\t${r.globalHCU}\t\t${r.maxHCUDepth}\t\t${r.gasUsed}\t${r.succeeded}`,
      );
    }
    console.log(`(global limit: ${GLOBAL_LIMIT}, sequential-depth limit: ${SEQUENTIAL_DEPTH_LIMIT})`);
  });

  for (const n of [2, 4, 8, 16]) {
    it(`measures HCU for N=${n} weighted draw using the real FHE.randEuint64 path`, async function () {
      const { contract, address } = await deploy();

      for (let i = 0; i < n; i++) {
        await setWeight(contract, address, BigInt((i + 1) * 10));
      }

      let succeeded = true;
      let receipt;
      try {
        const tx = await contract.connect(deployer).drawRandom(MAX_POOL_TOTAL);
        receipt = await tx.wait();
      } catch (err) {
        succeeded = false;
        results.push({ n, globalHCU: -1, maxHCUDepth: -1, gasUsed: "N/A", succeeded });
        // Re-throw only if this is the N=8 mandatory floor - handled by the
        // NO-GO assertion below, not here. We still record the failure.
        if (n <= 8) {
          throw err;
        }
        return;
      }

      const hcu = fhevm.computeTransactionHCU(receipt);
      results.push({
        n,
        globalHCU: hcu.globalHCU,
        maxHCUDepth: hcu.maxHCUDepth,
        gasUsed: receipt.gasUsed.toString(),
        succeeded,
      });

      // Mandatory floor: N=8 MUST fit safely, or S2 is NO-GO per instructions.
      if (n === 8) {
        expect(hcu.maxHCUDepth, "N=8 sequential depth must fit under the limit").to.be.lessThan(
          SEQUENTIAL_DEPTH_LIMIT,
        );
        expect(hcu.globalHCU, "N=8 global HCU must fit under the limit").to.be.lessThan(
          GLOBAL_LIMIT,
        );
      }
    });
  }
});
