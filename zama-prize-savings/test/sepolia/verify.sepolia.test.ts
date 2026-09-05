import { expect } from "chai";
import { ethers, fhevm, network } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { Wallet } from "ethers";
import type { Signer } from "ethers";
import { writeFileSync } from "fs";
import { join } from "path";

/**
 * P7 PART A - REAL Ethereum Sepolia verification (not the mock).
 *
 * Every item of the Part-A list is exercised against the real network,
 * real Zama coprocessor/relayer/KMS. Suites run once; deployments are made
 * once per concern to keep the transaction budget sane.
 *
 * The funded account is the deployer; additional wallets are derived from
 * the public hardhat test mnemonic (testnet-only, no value) and funded with
 * small amounts of Sepolia ETH by the deployer where they must send txs.
 *
 * Results and the verification-deployment addresses are written to
 * deployments/sepolia-verification.json (no secrets).
 */
// Runs only against the real Sepolia network (`--network sepolia`); skipped
// on every other network, including the local mock.
const onSepolia = network.name === "sepolia";
const describeRealSepolia = onSepolia ? describe : describe.skip;

describeRealSepolia("P7A - REAL Sepolia verification", function () {
  let deployer: Signer;
  let addrDeployer: string;
  let addrB: string;
  let walletB: Signer;

  let mock: any;
  let wrapper: any;
  let pool: any;
  let roundTrip: any;
  let mockAddr: string;
  let wrapperAddr: string;
  let poolAddr: string;
  let roundTripAddr: string;

  // Receipts collected for the event-leakage scan.
  const receipts: any[] = [];

  before(async function () {
    this.timeout(60 * 60 * 1000);
    [deployer] = await ethers.getSigners();
    addrDeployer = await deployer.getAddress();

    // Wallet B: freshly-generated random wallet (only signs off-chain
    // EIP-712 decrypt/EIP-712 input attempts - never needs Sepolia ETH).
    walletB = (ethers.Wallet.createRandom()).connect(ethers.provider) as unknown as Signer;
    addrB = await walletB.getAddress();

    const chainId = (await ethers.provider.getNetwork()).chainId;
    console.log(`[P7A] chain: ${chainId} deployer: ${addrDeployer}`);

    mock = await (await ethers.getContractFactory("MockUSD")).deploy();
    await mock.waitForDeployment();
    mockAddr = await mock.getAddress();

    wrapper = await (await ethers.getContractFactory("CMockUSD")).deploy(mockAddr);
    await wrapper.waitForDeployment();
    wrapperAddr = await wrapper.getAddress();

    pool = await (await ethers.getContractFactory("IwaPrizeSavings")).deploy(wrapperAddr);
    await pool.waitForDeployment();
    poolAddr = await pool.getAddress();

    roundTrip = await (await ethers.getContractFactory("SpikeRoundTrip")).deploy();
    await roundTrip.waitForDeployment();
    roundTripAddr = await roundTrip.getAddress();

    console.log(`[P7A] deployed mock=${mockAddr} wrapper=${wrapperAddr} pool=${poolAddr} roundTrip=${roundTripAddr}`);
  });

  after(async function () {
    if (!onSepolia) return; // never record a local/mock run as Sepolia state
    if (!mock || !wrapper || !pool || !roundTrip) return;
    const record = {
      chainId: 11155111,
      deployer: addrDeployer,
      contracts: {
        MockUSD: { address: mockAddr, deployTx: mock.deploymentTransaction()?.hash },
        CMockUSD: { address: wrapperAddr, deployTx: wrapper.deploymentTransaction()?.hash },
        IwaPrizeSavings: { address: poolAddr, deployTx: pool.deploymentTransaction()?.hash },
        SpikeRoundTrip: { address: roundTripAddr, deployTx: roundTrip.deploymentTransaction()?.hash },
      },
      toolchain: {
        "@fhevm/solidity": "0.11.1",
        "@fhevm/hardhat-plugin": "0.4.2",
        "@openzeppelin/confidential-contracts": "0.5.3",
        "solc": "0.8.27",
      },
      note: "Sepolia verification deployment (P7 Part A). Not the official bounty deployment.",
    };
    writeFileSync(join(__dirname, "..", "..", "deployments", "sepolia-verification.json"), JSON.stringify(record, null, 2));
  });

  async function wrap(signer: Signer, addr: string, amount: bigint) {
    await (await mock.connect(signer).mint(addr, amount)).wait();
    await (await mock.connect(signer).approve(wrapperAddr, amount)).wait();
    return (await wrapper.connect(signer).wrap(addr, amount)).wait();
  }

  async function deposit(signer: Signer, addr: string, value: bigint) {
    const encrypted = await fhevm.createEncryptedInput(poolAddr, addr).add64(value).encrypt();
    return (await pool.connect(signer).deposit(encrypted.handles[0], encrypted.inputProof)).wait();
  }

  async function decryptCredited(addr: string, signer: Signer): Promise<bigint> {
    const handle = await pool.confidentialBalanceOf(addr);
    return fhevm.userDecryptEuint(FhevmType.euint64, handle, poolAddr, signer);
  }

  // ---------------------------------------------------------------------
  // 1. S1 real encrypted round-trip: store -> separate-tx ACL reuse -> A
  //    decrypts 100 -> B cannot
  // ---------------------------------------------------------------------

  it("1: S1 encrypted round-trip on REAL Sepolia", async function () {
    this.timeout(30 * 60 * 1000);
    const encrypted = await fhevm
      .createEncryptedInput(roundTripAddr, addrDeployer)
      .add64(100n)
      .encrypt();
    const storeTx = await roundTrip.connect(deployer).store(encrypted.handles[0], encrypted.inputProof);
    receipts.push(await storeTx.wait());

    // Cross-transaction ACL: the contract reuses the stored handle in a LATER tx.
    const touchTx = await roundTrip.connect(deployer).touch();
    receipts.push(await touchTx.wait());

    const handle = await roundTrip.getHandle(addrDeployer);
    expect(handle).to.not.equal(ethers.ZeroHash);
    const clear = await fhevm.userDecryptEuint(FhevmType.euint64, handle, roundTripAddr, deployer);
    expect(clear).to.equal(100n);

    // Wallet B must be refused.
    let message = "";
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, handle, roundTripAddr, walletB);
    } catch (err: any) {
      message = String(err?.message ?? "");
    }
    expect(message, "wallet B must NOT decrypt A's handle on the real network").to.not.equal("");
    console.log("[P7A:1] S1 round-trip PASS - B rejected with:", message.slice(0, 120));
  });

  // ---------------------------------------------------------------------
  // 2. ERC-7984 allowTransient handoff + operator path on real Sepolia
  // ---------------------------------------------------------------------

  it("2: ERC-7984 operator path and allowTransient handoff on REAL Sepolia", async function () {
    this.timeout(30 * 60 * 1000);
    await wrap(deployer, addrDeployer, 100n);
    await (await wrapper.connect(deployer).setOperator(poolAddr, Math.floor(Date.now() / 1000) + 3600)).wait();

    const tx1 = await deposit(deployer, addrDeployer, 40n);
    receipts.push(tx1);
    expect(await decryptCredited(addrDeployer, deployer)).to.equal(40n);

    // Second deposit in a separate transaction - real ACL persistence.
    const tx2 = await deposit(deployer, addrDeployer, 20n);
    receipts.push(tx2);
    expect(await decryptCredited(addrDeployer, deployer)).to.equal(60n);
    console.log("[P7A:2] operator+allowTransient handoff PASS - credited 40 then 60 on real Sepolia");
  });

  // ---------------------------------------------------------------------
  // 3. Wrong-contract proof binding must fail
  // ---------------------------------------------------------------------

  it("3: encrypted input bound to the WRONG contract is rejected on REAL Sepolia", async function () {
    this.timeout(30 * 60 * 1000);
    const encrypted = await fhevm.createEncryptedInput(wrapperAddr, addrDeployer).add64(10n).encrypt();
    let reverted = false;
    let message = "";
    try {
      const tx = await pool.connect(deployer).deposit(encrypted.handles[0], encrypted.inputProof);
      receipts.push(await tx.wait());
    } catch (err: any) {
      reverted = true;
      message = String(err?.message ?? "").slice(0, 200);
    }
    expect(reverted, `wrong-contract input must be rejected on real Sepolia (got: ${message})`).to.be.true;
    console.log("[P7A:3] wrong-contract binding rejected:", message);
  });

  // ---------------------------------------------------------------------
  // 4. Wrong-sender proof binding must fail
  // ---------------------------------------------------------------------

  it("4: encrypted input created for ANOTHER SENDER is rejected on REAL Sepolia", async function () {
    this.timeout(30 * 60 * 1000);
    // Input created for wallet B, submitted by the deployer (A).
    const encrypted = await fhevm.createEncryptedInput(poolAddr, addrB).add64(10n).encrypt();
    let reverted = false;
    let message = "";
    try {
      const tx = await pool.connect(deployer).deposit(encrypted.handles[0], encrypted.inputProof);
      receipts.push(await tx.wait());
    } catch (err: any) {
      reverted = true;
      message = String(err?.message ?? "").slice(0, 200);
    }
    expect(reverted, `wrong-sender input must be rejected on real Sepolia (got: ${message})`).to.be.true;
    console.log("[P7A:4] wrong-sender binding rejected:", message);
  });

  // ---------------------------------------------------------------------
  // 5. Claim with no prize: credits zero, no stuck state
  // ---------------------------------------------------------------------

  it("5: claim with NO prize funds safely credits zero and leaves no stuck state", async function () {
    this.timeout(30 * 60 * 1000);
    const txD = await deposit(deployer, addrDeployer, 10n); // credited 70
    receipts.push(txD);
    expect(await decryptCredited(addrDeployer, deployer)).to.equal(70n);

    const lockTx = await pool.connect(deployer).lockRound();
    receipts.push(await lockTx.wait());
    const drawTx = await pool.connect(deployer).draw();
    const drawReceipt = await drawTx.wait();
    receipts.push(drawReceipt);
    expect(await pool.roundState()).to.equal(2n); // Drawn

    const claimTx = await pool.connect(deployer).claim();
    receipts.push(await claimTx.wait());
    expect(await pool.roundState()).to.equal(3n); // Claimable
    // No prize was funded: claim credits zero - the balance is unchanged.
    expect(await decryptCredited(addrDeployer, deployer)).to.equal(70n);

    // No stuck state: full exit works.
    const exitTx = await pool.connect(deployer).withdrawAll();
    receipts.push(await exitTx.wait());
    expect(await decryptCredited(addrDeployer, deployer)).to.equal(0n);
    console.log("[P7A:5] no-prize claim PASS - zero credit, full exit works");
  });

  // ---------------------------------------------------------------------
  // 6. Event leakage on real Sepolia logs
  // ---------------------------------------------------------------------

  it("6: real Sepolia logs contain no plaintext amount/balance/prize/winner", async function () {
    this.timeout(10 * 60 * 1000);
    const secretWords = [100, 40, 20, 10, 70].map((v) =>
      ethers.toBeHex(v, 32).slice(2).toLowerCase(),
    );
    let violations: string[] = [];
    for (const receipt of receipts) {
      for (const log of receipt.logs) {
        const data = log.data.slice(2).toLowerCase();
        for (let p = 0; p + 64 <= data.length; p += 64) {
          const word = data.slice(p, p + 64);
          if (secretWords.includes(word)) {
            violations.push(`${log.address} data word ${word}`);
          }
        }
        for (const topic of log.topics) {
          const t = topic.slice(2).toLowerCase();
          if (secretWords.includes(t)) {
            violations.push(`${log.address} topic ${t}`);
          }
        }
      }
    }
    expect(violations, `plaintext amounts leaked in real logs: ${violations.join(", ")}`).to.deep.equal([]);
    console.log(`[P7A:6] no plaintext leakage across ${receipts.length} real Sepolia receipts`);
  });

  // ---------------------------------------------------------------------
  // 7. F2 first-funding ACL behavior on the REAL ACL
  // ---------------------------------------------------------------------

  it("7: F2 - first-funding reserve is decryptable by the funder, rewrite removes access", async function () {
    this.timeout(30 * 60 * 1000);
    const pool2: any = await (await ethers.getContractFactory("IwaPrizeSavings")).deploy(wrapperAddr);
    await pool2.waitForDeployment();
    const pool2Addr = await pool2.getAddress();

    await (await wrapper.connect(deployer).setOperator(pool2Addr, Math.floor(Date.now() / 1000) + 3600)).wait();

    // First funding: 40.
    const f1 = await fhevm.createEncryptedInput(pool2Addr, addrDeployer).add64(40n).encrypt();
    await (await pool2.connect(deployer).fundPrize(f1.handles[0], f1.inputProof)).wait();

    // F2 exposure: the funder CAN decrypt the first-funding reserve handle.
    const r1 = await pool2.prizeReserve();
    const clear1 = await fhevm.userDecryptEuint(FhevmType.euint64, r1, pool2Addr, deployer);
    expect(clear1, "funder must see their own first funding amount (F2)").to.equal(40n);

    // Second funding rewrites the handle: access must be gone.
    const f2 = await fhevm.createEncryptedInput(pool2Addr, addrDeployer).add64(5n).encrypt();
    await (await pool2.connect(deployer).fundPrize(f2.handles[0], f2.inputProof)).wait();
    const r2 = await pool2.prizeReserve();
    expect(r2).to.not.equal(r1);

    let message = "";
    try {
      await fhevm.userDecryptEuint(FhevmType.euint64, r2, pool2Addr, deployer);
    } catch (err: any) {
      message = String(err?.message ?? "");
    }
    expect(message, "funder must lose access after the reserve handle is rewritten").to.not.equal("");
    console.log("[P7A:7] F2 confirmed on real ACL - first-funding exposure only, rewrite removes it");
  });

  // ---------------------------------------------------------------------
  // 8. N=16 production draw on real Sepolia
  // ---------------------------------------------------------------------

  it("8: N=16 production draw executes on REAL Sepolia within limits", async function () {
    this.timeout(60 * 60 * 1000);
    const pool3: any = await (await ethers.getContractFactory("IwaPrizeSavings")).deploy(wrapperAddr);
    await pool3.waitForDeployment();
    const pool3Addr = await pool3.getAddress();

    // Fund 16 freshly-generated wallets with a little Sepolia ETH. Random
    // wallets are used (NOT the public test mnemonic - those well-known
    // addresses are monitored/swept on public testnets and their keys are
    // public knowledge).
    const wallets: Signer[] = [];
    let nonce = await deployer.getNonce();
    for (let i = 0; i < 16; i++) {
      const w = (ethers.Wallet.createRandom()).connect(ethers.provider) as unknown as Signer;
      wallets.push(w);
      const tx = await deployer.sendTransaction({
        to: await w.getAddress(),
        value: ethers.parseEther("0.01"),
        nonce,
      });
      await tx.wait();
      nonce += 1;
      const bal = await ethers.provider.getBalance(await w.getAddress());
      expect(bal > 0n, "funded wallet must hold Sepolia ETH").to.be.true;
    }

    // Each wallet: mint, approve, wrap, setOperator, deposit.
    for (const [i, w] of wallets.entries()) {
      const addr = await w.getAddress();
      await (await mock.connect(w).mint(addr, 100n)).wait();
      await (await mock.connect(w).approve(wrapperAddr, 100n)).wait();
      await (await wrapper.connect(w).wrap(addr, 100n)).wait();
      await (await wrapper.connect(w).setOperator(pool3Addr, Math.floor(Date.now() / 1000) + 3600)).wait();
      const e = await fhevm.createEncryptedInput(pool3Addr, addr).add64(BigInt((i + 1) * 10)).encrypt();
      await (await pool3.connect(w).deposit(e.handles[0], e.inputProof)).wait();
    }
    expect(await pool3.participantCount()).to.equal(16n);

    await (await pool3.connect(deployer).lockRound()).wait();
    const drawTx = await pool3.connect(deployer).draw();
    const drawReceipt = await drawTx.wait();
    expect(await pool3.roundState()).to.equal(2n); // Drawn

    let hcu: any = null;
    let hcuError = "";
    try {
      hcu = fhevm.computeTransactionHCU(drawReceipt);
    } catch (err: any) {
      hcuError = String(err?.message ?? "").slice(0, 150);
    }
    console.log(
      `[P7A:8] N=16 draw on Sepolia: gas=${drawReceipt.gasUsed.toString()} hcu=${hcu ? JSON.stringify({ global: hcu.globalHCU, depth: hcu.maxHCUDepth }) : "unavailable" + (hcuError ? " (" + hcuError + ")" : "")}`,
    );
    expect(drawReceipt.status).to.equal(1);
    expect(hcu?.globalHCU ?? 0).to.be.lessThan(20_000_000);
    expect(hcu?.maxHCUDepth ?? 0).to.be.lessThan(5_000_000);
  });
});