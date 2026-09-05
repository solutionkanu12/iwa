import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import type { Signer } from "ethers";

/**
 * S1 spike: prove the full encrypted round-trip on the current Zama toolchain.
 *
 *   wallet A -> encrypted uint64 -> contract stores ciphertext
 *            -> ACL persists ACROSS TRANSACTIONS
 *            -> wallet A user-decrypts (EIP-712) and gets exactly 100
 *            -> wallet B is refused
 *
 * The separate-transaction step is mandatory: a same-transaction success would
 * not prove persistent ACL correctness (spec 5.1 / correction C3).
 */
describe("S1 - SpikeRoundTrip encrypted round-trip", function () {
  let walletA: Signer;
  let walletB: Signer;
  let addrA: string;
  let addrB: string;
  let contract: any;
  let contractAddress: string;

  beforeEach(async function () {
    [walletA, walletB] = await ethers.getSigners();
    addrA = await walletA.getAddress();
    addrB = await walletB.getAddress();

    const factory = await ethers.getContractFactory("SpikeRoundTrip");
    contract = await factory.deploy();
    await contract.waitForDeployment();
    contractAddress = await contract.getAddress();
  });

  async function storeAs(signer: Signer, signerAddress: string, value: bigint) {
    const encrypted = await fhevm
      .createEncryptedInput(contractAddress, signerAddress)
      .add64(value)
      .encrypt();

    const tx = await contract
      .connect(signer)
      .store(encrypted.handles[0], encrypted.inputProof);
    return tx.wait();
  }

  it("A-E: wallet A stores encrypted 100 and user-decrypts it to exactly 100", async function () {
    await storeAs(walletA, addrA, 100n);

    // Separate read cycle: fetch the stored handle, then user-decrypt it.
    const handle = await contract.getHandle(addrA);
    expect(handle).to.not.equal(ethers.ZeroHash);

    const clear = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      handle,
      contractAddress,
      walletA,
    );

    expect(clear).to.equal(100n);
  });

  it("ACL persists across transaction boundaries (contract reuses the handle in a LATER tx)", async function () {
    await storeAs(walletA, addrA, 100n);

    // Separate transaction. This only succeeds if FHE.allowThis persisted the
    // contract's own permission from the earlier store() transaction.
    const touchTx = await contract.connect(walletA).touch();
    await touchTx.wait();

    const handleAfter = await contract.getHandle(addrA);
    const clearAfter = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      handleAfter,
      contractAddress,
      walletA,
    );

    expect(clearAfter).to.equal(100n);
  });

  it("F: wallet B cannot decrypt wallet A's handle", async function () {
    await storeAs(walletA, addrA, 100n);
    const handle = await contract.getHandle(addrA);

    let message = "";
    try {
      await fhevm.userDecryptEuint(
        FhevmType.euint64,
        handle,
        contractAddress,
        walletB,
      );
    } catch (err: any) {
      message = String(err?.message ?? "");
    }

    // Must be a genuine ACL denial naming wallet B - not an incidental failure.
    expect(message, "wallet B must NOT decrypt wallet A's handle").to.not.equal(
      "",
    );
    expect(message).to.contain("not authorized");
    expect(message.toLowerCase()).to.contain(addrB.toLowerCase());
  });

  it("storing a second value behaves predictably (overwrites, stays decryptable)", async function () {
    await storeAs(walletA, addrA, 100n);
    await storeAs(walletA, addrA, 250n);

    const handle = await contract.getHandle(addrA);
    const clear = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      handle,
      contractAddress,
      walletA,
    );

    expect(clear).to.equal(250n);
  });

  it("wallets are isolated: B's own stored value does not disturb A's", async function () {
    await storeAs(walletA, addrA, 100n);
    await storeAs(walletB, addrB, 777n);

    const clearA = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await contract.getHandle(addrA),
      contractAddress,
      walletA,
    );
    const clearB = await fhevm.userDecryptEuint(
      FhevmType.euint64,
      await contract.getHandle(addrB),
      contractAddress,
      walletB,
    );

    expect(clearA).to.equal(100n);
    expect(clearB).to.equal(777n);
  });

  it("our contract emits no plaintext value, and stores a handle not a value", async function () {
    const receipt = await storeAs(walletA, addrA, 100n);
    const plaintextWord = ethers.zeroPadValue("0x64", 32).slice(2).toLowerCase();

    // Scope: logs emitted by OUR contract. In the local mock, the Zama
    // coprocessor computes over cleartext and its own events therefore do
    // contain the plaintext word - that is a mock artifact, not our leak, and
    // absence of coprocessor-side leakage can only be confirmed on Sepolia.
    const ourLogs = receipt.logs.filter(
      (l: any) => l.address.toLowerCase() === contractAddress.toLowerCase(),
    );
    expect(ourLogs.length, "expected our Stored event").to.be.greaterThan(0);

    for (const log of ourLogs) {
      const data = log.data.slice(2).toLowerCase();
      for (let p = 0; p + 64 <= data.length; p += 64) {
        expect(data.slice(p, p + 64)).to.not.equal(plaintextWord);
      }
      for (const topic of log.topics.slice(1)) {
        expect(topic.slice(2).toLowerCase()).to.not.equal(plaintextWord);
      }
    }

    // The stored slot is a ciphertext handle, not the value.
    const handle = await contract.getHandle(addrA);
    expect(handle).to.not.equal(ethers.zeroPadValue("0x64", 32));
  });
});
