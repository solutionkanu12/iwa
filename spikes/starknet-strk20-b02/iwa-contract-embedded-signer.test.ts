/*
 * Temporary B0.2 test copied into the exact Iwa-pinned starknet-privacy e2e
 * suite by the disposable CI workflow. It deploys only ephemeral devnet
 * contracts. No browser wallet, public network, filesystem secret storage, or
 * production configuration is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Account, constants, ec, hash } from "starknet";
import {
  createPrivateTransfers,
  Open,
  type PrivateTransfersInterface,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  Devnet,
  IndexerDiscoveryProvider,
  ScreeningCallMockProofProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";

const TEST_TIMEOUT_MS = 300_000;
const CIRCLE_ID = 1n;
const ROUND = 1n;
const CONTRIBUTION_AMOUNT = 100n;
const POT_AMOUNT = CONTRIBUTION_AMOUNT * 2n;
const VIEWING_KEY_MAX = ec.starkCurve.CURVE.n / 2n;
const RECOVERY_AAD = Buffer.from("iwa-b02-recovery-v1", "utf8");

type SettlementIdentity = {
  inviteSecret: bigint;
  privateKey: bigint;
  publicKeyX: bigint;
  memberRef: bigint;
};

type EncryptedRecoveryEnvelope = {
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

type RecoveryPayload = {
  starknet: { accountAddress: string; spendingKey: string };
  strk20: { viewingKey: string };
  iwa: {
    inviteSecret: string;
    settlementKey: string;
    settlementPublicKeyX: string;
    memberRef: string;
  };
};

type DeployedIwa = {
  circle: string;
  helper: string;
  circleClassHash: string;
  helperClassHash: string;
};

function bytesFromHex(value: string): Uint8Array {
  const normalized = value.replace(/^0x/, "");
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("invalid local test key encoding");
  }
  return new Uint8Array(Buffer.from(normalized, "hex"));
}

function hexFromBytes(value: Uint8Array): string {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function padded(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function randomScalar(maximum: bigint): bigint {
  const candidate = BigInt(hexFromBytes(ec.starkCurve.utils.randomPrivateKey()));
  return (candidate % maximum) + 1n;
}

function shortStringToFelt(value: string): bigint {
  if (value.length > 31 || /[^\x00-\x7f]/.test(value)) {
    throw new Error("invalid Iwa domain tag");
  }
  return BigInt(`0x${Buffer.from(value, "ascii").toString("hex")}`);
}

function iwaHash(...values: bigint[]): bigint {
  return ec.starkCurve.poseidonHashMany(values);
}

function settlementPublicKeyX(privateKey: bigint): bigint {
  const point = ec.starkCurve.getPublicKey(padded(privateKey), false);
  return BigInt(`0x${Buffer.from(point.slice(1, 33)).toString("hex")}`);
}

function signIwa(privateKey: bigint, messageHash: bigint): { r: bigint; s: bigint } {
  const { r, s } = ec.starkCurve.sign(padded(messageHash), padded(privateKey));
  const order = ec.starkCurve.CURVE.n;
  return { r, s: s > order / 2n ? order - s : s };
}

function digestOf(parts: string[]): bigint {
  return BigInt(`0x${createHash("sha256").update(parts.join("|"), "utf8").digest("hex")}`);
}

function identityTypedData(address: string) {
  return {
    domain: { name: "Iwa", version: "1", chainId: "SN_MAIN" },
    types: {
      StarkNetDomain: [
        { name: "name", type: "felt" },
        { name: "version", type: "felt" },
        { name: "chainId", type: "felt" },
      ],
      Identity: [
        { name: "purpose", type: "felt" },
        { name: "account", type: "felt" },
      ],
    },
    primaryType: "Identity",
    message: { purpose: "Iwa member identity v1", account: address },
  };
}

async function deriveIwaSettlementIdentity(account: Account): Promise<SettlementIdentity> {
  const signature = await account.signMessage(identityTypedData(account.address));
  const signatureParts = Array.isArray(signature) ? signature.map(String) : [String(signature)];
  const base = digestOf(["Iwa member identity v1", account.address, ...signatureParts]);
  const starkPrime = (1n << 251n) + 17n * (1n << 192n) + 1n;
  const inviteSecret = (digestOf(["invite", base.toString(16)]) % (starkPrime - 1n)) + 1n;
  const privateKey =
    (digestOf(["auth", base.toString(16)]) % (ec.starkCurve.CURVE.n - 1n)) + 1n;
  const publicKeyX = settlementPublicKeyX(privateKey);
  return {
    inviteSecret,
    privateKey,
    publicKeyX,
    memberRef: iwaHash(shortStringToFelt("IWA_INVITE_V1"), inviteSecret, publicKeyX),
  };
}

function contributionHash(args: {
  circleId?: bigint;
  memberRef: bigint;
  helper: string;
  pool: string;
  token: string;
  nonce: bigint;
}): bigint {
  return iwaHash(
    shortStringToFelt("IWA_CONTRIBUTION_SETTLEMENT_V1"),
    args.circleId ?? CIRCLE_ID,
    ROUND,
    args.memberRef,
    BigInt(args.helper),
    BigInt(args.pool),
    BigInt(args.token),
    CONTRIBUTION_AMOUNT,
    args.nonce,
  );
}

function payoutAuthorizationHash(memberRef: bigint, nonce: bigint): bigint {
  return iwaHash(
    shortStringToFelt("IWA_PAYOUT_V1"),
    CIRCLE_ID,
    ROUND,
    memberRef,
    POT_AMOUNT,
    nonce,
  );
}

function payoutSettlementHash(args: {
  memberRef: bigint;
  helper: string;
  pool: string;
  token: string;
  openNoteId: bigint;
  nonce: bigint;
}): bigint {
  return iwaHash(
    shortStringToFelt("IWA_PAYOUT_SETTLEMENT_V1"),
    CIRCLE_ID,
    ROUND,
    args.memberRef,
    BigInt(args.helper),
    BigInt(args.pool),
    BigInt(args.token),
    POT_AMOUNT,
    args.openNoteId,
    args.nonce,
  );
}

function encryptRecovery(payload: RecoveryPayload, passphrase: Buffer): EncryptedRecoveryEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derivedKey = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
  cipher.setAAD(RECOVERY_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptRecovery(envelope: EncryptedRecoveryEnvelope, passphrase: Buffer): RecoveryPayload {
  const derivedKey = scryptSync(passphrase, Buffer.from(envelope.salt, "base64"), 32);
  const decipher = createDecipheriv("aes-256-gcm", derivedKey, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(RECOVERY_AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as RecoveryPayload;
}

async function predeployedKeyForLocalAccount(
  rpcUrl: string,
  expectedAddress: string,
): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_getPredeployedAccounts" }),
  });
  if (!response.ok) throw new Error("local devnet account lookup failed");
  const payload = (await response.json()) as {
    result?: Array<{ address: string; private_key: string }>;
  };
  const account = payload.result?.find(
    (candidate) => BigInt(candidate.address) === BigInt(expectedAddress),
  );
  if (!account?.private_key) throw new Error("local devnet account was not available");
  return account.private_key;
}

function assertExpectedChain(observed: string, expected: string): void {
  if (observed !== expected) throw new Error("wrong Starknet network");
}

function readIwaArtifact(contractName: "IwaCircle" | "IwaStrk20Helper") {
  const artifactDir = process.env.IWA_ARTIFACT_DIR;
  if (!artifactDir) throw new Error("B0.2 artifact directory is not configured");
  const base = `iwa_${contractName}`;
  return {
    contract: JSON.parse(readFileSync(join(artifactDir, `${base}.contract_class.json`), "utf8")),
    casm: JSON.parse(readFileSync(join(artifactDir, `${base}.compiled_contract_class.json`), "utf8")),
  };
}

async function deployIwaContract(
  account: Account,
  contractName: "IwaCircle" | "IwaStrk20Helper",
  constructorCalldata: Array<string | bigint>,
  salt: string,
  node: E2eTestEnv["env"]["node"],
): Promise<{ address: string; classHash: string }> {
  const artifact = readIwaArtifact(contractName);
  const response = await account.declare({
    contract: artifact.contract,
    casm: artifact.casm,
    compiledClassHash: hash.computeCompiledClassHash(artifact.casm),
  });
  const declareReceipt = await node.waitForTransaction(response.transaction_hash);
  if (!declareReceipt.isSuccess()) throw new Error(`${contractName} declaration failed`);
  const deployment = await account.deployContract({
    classHash: response.class_hash,
    constructorCalldata,
    salt,
  });
  const deploymentReceipt = await node.waitForTransaction(deployment.transaction_hash);
  if (!deploymentReceipt.isSuccess()) throw new Error(`${contractName} deployment failed`);
  return { address: deployment.contract_address, classHash: response.class_hash };
}

function transfersFor(
  account: { address: string; signer: Account["signer"] },
  viewingKey: bigint,
  env: E2eTestEnv,
): PrivateTransfersInterface {
  return createPrivateTransfers({
    // This is the SDK's direct `{ address, signer }` path: no injected wallet
    // wrapper, browser extension, or wallet protocol enters the signing route.
    account: { address: account.address, signer: account.signer },
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: new ScreeningCallMockProofProvider(
      env.env.node,
      constants.StarknetChainId.SN_SEPOLIA,
    ),
    discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address),
    poolContractAddress: env.env.privacy.address,
  });
}

describe("Iwa B0.2 current-contract embedded-signer devnet proof", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let aliceSpendingKey: string;
  let bobSpendingKey: string;
  let embeddedAlice: Account;
  let embeddedBob: Account;
  let aliceViewingKey: bigint;
  let bobViewingKey: bigint;
  let aliceSettlement: SettlementIdentity;
  let bobSettlement: SettlementIdentity;
  let aliceTransfers: PrivateTransfersInterface;
  let bobTransfers: PrivateTransfersInterface;
  let iwa: DeployedIwa;

  async function execute(account: Account, call: { contractAddress: string; entrypoint: string; calldata: Array<string | bigint> }) {
    const response = await account.execute(call);
    const receipt = await env.env.node.waitForTransaction(response.transaction_hash);
    if (!receipt.isSuccess()) throw new Error("devnet account invoke failed");
    return response;
  }

  async function buildContribution(args: {
    transfers: PrivateTransfersInterface;
    settlement: SettlementIdentity;
    circleId?: bigint;
    memberRef?: bigint;
    nonce: bigint;
  }) {
    const circleId = args.circleId ?? CIRCLE_ID;
    const memberRef = args.memberRef ?? args.settlement.memberRef;
    const signature = signIwa(
      args.settlement.privateKey,
      contributionHash({
        circleId,
        memberRef,
        helper: iwa.helper,
        pool: env.env.privacy.address,
        token: env.env.strk,
        nonce: args.nonce,
      }),
    );
    return args.transfers
      .build({ autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } })
      .with(env.env.strk, (token) =>
        token
          .deposit({ amount: CONTRIBUTION_AMOUNT })
          .withdraw({ recipient: iwa.helper, amount: CONTRIBUTION_AMOUNT }),
      )
      .invoke(() => ({
        contractAddress: iwa.helper,
        entrypoint: "privacy_invoke",
        calldata: [
          0n,
          circleId,
          ROUND,
          memberRef,
          BigInt(env.env.strk),
          0n,
          args.nonce,
          signature.r,
          signature.s,
        ],
      }))
      .execute();
  }

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet);
    aliceSpendingKey = await predeployedKeyForLocalAccount(devnet.url, env.env.alice.address);
    bobSpendingKey = await predeployedKeyForLocalAccount(devnet.url, env.env.bob.address);
    embeddedAlice = new Account({
      provider: env.env.node,
      address: env.env.alice.address,
      signer: bytesFromHex(aliceSpendingKey),
    });
    embeddedBob = new Account({
      provider: env.env.node,
      address: env.env.bob.address,
      signer: bytesFromHex(bobSpendingKey),
    });
    aliceViewingKey = randomScalar(VIEWING_KEY_MAX);
    bobViewingKey = randomScalar(VIEWING_KEY_MAX);
    aliceSettlement = await deriveIwaSettlementIdentity(embeddedAlice);
    bobSettlement = await deriveIwaSettlementIdentity(embeddedBob);
    aliceTransfers = transfersFor(embeddedAlice, aliceViewingKey, env);
    bobTransfers = transfersFor(embeddedBob, bobViewingKey, env);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("deploys and permanently wires the current IwaCircle and IwaStrk20Helper classes", async () => {
    const chainId = await env.env.node.getChainId();
    assertExpectedChain(chainId, constants.StarknetChainId.SN_SEPOLIA);
    expect(() => assertExpectedChain(chainId, "SN_WRONG_NETWORK")).toThrow("wrong Starknet network");
    expect(await env.env.node.getClassHashAt(embeddedAlice.address)).not.toBe("0x0");
    expect(await deriveIwaSettlementIdentity(embeddedAlice)).toEqual(aliceSettlement);

    const circle = await deployIwaContract(
      env.env.admin,
      "IwaCircle",
      [env.env.strk, env.env.eth, env.env.privacy.address, env.env.admin.address],
      "0x101",
      env.env.node,
    );
    const helper = await deployIwaContract(
      env.env.admin,
      "IwaStrk20Helper",
      [circle.address, env.env.privacy.address, env.env.strk, env.env.eth, embeddedBob.address],
      "0x102",
      env.env.node,
    );
    iwa = {
      circle: circle.address,
      helper: helper.address,
      circleClassHash: circle.classHash,
      helperClassHash: helper.classHash,
    };

    expect(BigInt(await env.env.node.getClassHashAt(iwa.circle))).toBe(BigInt(iwa.circleClassHash));
    expect(BigInt(await env.env.node.getClassHashAt(iwa.helper))).toBe(BigInt(iwa.helperClassHash));
    await execute(env.env.admin, {
      contractAddress: iwa.circle,
      entrypoint: "initialize_settlement_helper",
      calldata: [iwa.helper],
    });

    const settlementConfig = await env.env.node.callContract({
      contractAddress: iwa.circle,
      entrypoint: "get_settlement_config",
      calldata: [],
    });
    expect(BigInt(settlementConfig[0])).toBe(BigInt(iwa.helper));
    expect(BigInt(settlementConfig[1])).toBe(BigInt(env.env.privacy.address));
    expect(BigInt(settlementConfig[2])).toBe(0n);
    expect(BigInt(settlementConfig[3])).toBe(1n);

    await execute(embeddedAlice, {
      contractAddress: iwa.circle,
      entrypoint: "create_circle",
      calldata: [
        env.env.strk,
        CONTRIBUTION_AMOUNT,
        100n,
        50n,
        2n,
        2n,
        aliceSettlement.memberRef,
        bobSettlement.memberRef,
      ],
    });
    await execute(embeddedAlice, {
      contractAddress: iwa.circle,
      entrypoint: "join_circle",
      calldata: [CIRCLE_ID, aliceSettlement.inviteSecret, aliceSettlement.publicKeyX],
    });
    await execute(embeddedBob, {
      contractAddress: iwa.circle,
      entrypoint: "join_circle",
      calldata: [CIRCLE_ID, bobSettlement.inviteSecret, bobSettlement.publicKeyX],
    });
    const activeMember = await env.env.node.callContract({
      contractAddress: iwa.circle,
      entrypoint: "is_member",
      calldata: [CIRCLE_ID, aliceSettlement.memberRef],
    });
    expect(BigInt(activeMember[0])).toBe(1n);
  }, TEST_TIMEOUT_MS);

  it("rejects a substituted local signer and registers runtime-only viewing keys", async () => {
    const substituted = new Account({
      provider: env.env.node,
      address: embeddedAlice.address,
      signer: embeddedBob.signer,
    });
    await expect(
      transfersFor(substituted, randomScalar(VIEWING_KEY_MAX), env).build().register().execute(),
    ).rejects.toThrow();

    const aliceRegistration = await aliceTransfers.build().register().execute();
    await devnet.executeOutside(aliceRegistration.callAndProof);
    await expect(devnet.executeOutside(aliceRegistration.callAndProof)).rejects.toThrow();
    const bobRegistration = await bobTransfers.build().register().execute();
    await devnet.executeOutside(bobRegistration.callAndProof);
  }, TEST_TIMEOUT_MS);

  it("rejects tampered or misauthorized intent and settles two private contributions through Iwa", async () => {
    await execute(embeddedAlice, {
      contractAddress: env.env.strk,
      entrypoint: "approve",
      calldata: [env.env.privacy.address, CONTRIBUTION_AMOUNT * 3n, 0n],
    });
    await execute(embeddedBob, {
      contractAddress: env.env.strk,
      entrypoint: "approve",
      calldata: [env.env.privacy.address, CONTRIBUTION_AMOUNT, 0n],
    });

    const wrongAuthority = await buildContribution({
      transfers: aliceTransfers,
      settlement: bobSettlement,
      memberRef: aliceSettlement.memberRef,
      nonce: 11n,
    });
    await expect(devnet.executeOutside(wrongAuthority.callAndProof)).rejects.toThrow();

    const wrongMember = await buildContribution({
      transfers: aliceTransfers,
      settlement: aliceSettlement,
      memberRef: bobSettlement.memberRef,
      nonce: 12n,
    });
    await expect(devnet.executeOutside(wrongMember.callAndProof)).rejects.toThrow();

    const wrongCircle = await buildContribution({
      transfers: aliceTransfers,
      settlement: aliceSettlement,
      circleId: CIRCLE_ID + 1n,
      nonce: 13n,
    });
    await expect(devnet.executeOutside(wrongCircle.callAndProof)).rejects.toThrow();

    const aliceContribution = await buildContribution({
      transfers: aliceTransfers,
      settlement: aliceSettlement,
      nonce: 14n,
    });
    const tampered = {
      ...aliceContribution.callAndProof,
      call: {
        ...aliceContribution.callAndProof.call,
        calldata: [...aliceContribution.callAndProof.call.calldata, "0x1"],
      },
    };
    await expect(devnet.executeOutside(tampered)).rejects.toThrow();
    await devnet.executeOutside(aliceContribution.callAndProof);

    const bobContribution = await buildContribution({
      transfers: bobTransfers,
      settlement: bobSettlement,
      nonce: 15n,
    });
    await devnet.executeOutside(bobContribution.callAndProof);

    const liability = await env.env.node.callContract({
      contractAddress: iwa.helper,
      entrypoint: "get_token_liability",
      calldata: [env.env.strk],
    });
    expect(BigInt(liability[0])).toBe(POT_AMOUNT);
    expect(BigInt(liability[1])).toBe(0n);
  }, TEST_TIMEOUT_MS);

  it("creates a discoverable private payout note through the real helper and rejects replay", async () => {
    await execute(env.env.admin, {
      contractAddress: iwa.circle,
      entrypoint: "finalize_round_payout_accounting",
      calldata: [CIRCLE_ID, ROUND],
    });
    const authorization = signIwa(
      aliceSettlement.privateKey,
      payoutAuthorizationHash(aliceSettlement.memberRef, 21n),
    );
    await execute(embeddedAlice, {
      contractAddress: iwa.circle,
      entrypoint: "authorize_payout_settlement",
      calldata: [CIRCLE_ID, ROUND, 21n, authorization.r, authorization.s],
    });

    const payout = await aliceTransfers
      .build({ autoDiscover: { notes: "refresh", channels: "refresh" } })
      .with(env.env.strk)
      .transfer({ recipient: embeddedAlice.address, amount: Open })
      .done()
      .invoke(({ openNotes }) => {
        if (openNotes.length !== 1) throw new Error("expected exactly one payout open note");
        const openNoteId = BigInt(openNotes[0].noteId);
        const signature = signIwa(
          aliceSettlement.privateKey,
          payoutSettlementHash({
            memberRef: aliceSettlement.memberRef,
            helper: iwa.helper,
            pool: env.env.privacy.address,
            token: env.env.strk,
            openNoteId,
            nonce: 22n,
          }),
        );
        return {
          contractAddress: iwa.helper,
          entrypoint: "privacy_invoke",
          calldata: [
            2n,
            CIRCLE_ID,
            ROUND,
            aliceSettlement.memberRef,
            BigInt(env.env.strk),
            openNoteId,
            22n,
            signature.r,
            signature.s,
          ],
        };
      })
      .execute();
    await devnet.executeOutside(payout.callAndProof);
    await env.indexer.waitForBlock(devnet.url);

    const discovered = await aliceTransfers.discoverNotes({ tokens: [BigInt(env.env.strk)] });
    const notes = discovered.notes.get(BigInt(env.env.strk)) ?? [];
    expect(notes.some((note) => note.amount === POT_AMOUNT)).toBe(true);
    const wrongViewingKeyTransfers = transfersFor(embeddedAlice, randomScalar(VIEWING_KEY_MAX), env);
    const wrongViewingKeyNotes = await wrongViewingKeyTransfers.discoverNotes({
      tokens: [BigInt(env.env.strk)],
    });
    expect(
      (wrongViewingKeyNotes.notes.get(BigInt(env.env.strk)) ?? []).some(
        (note) => note.amount === POT_AMOUNT,
      ),
    ).toBe(false);
    await expect(devnet.executeOutside(payout.callAndProof)).rejects.toThrow();

    const liability = await env.env.node.callContract({
      contractAddress: iwa.helper,
      entrypoint: "get_token_liability",
      calldata: [env.env.strk],
    });
    expect(BigInt(liability[0])).toBe(0n);
    expect(BigInt(liability[1])).toBe(0n);
  }, TEST_TIMEOUT_MS);

  it("restores encrypted test recovery material to the same public identities and rejects corruption", () => {
    const passphrase = randomBytes(32);
    const payload: RecoveryPayload = {
      starknet: { accountAddress: embeddedAlice.address, spendingKey: aliceSpendingKey },
      strk20: { viewingKey: `0x${aliceViewingKey.toString(16)}` },
      iwa: {
        inviteSecret: `0x${aliceSettlement.inviteSecret.toString(16)}`,
        settlementKey: `0x${aliceSettlement.privateKey.toString(16)}`,
        settlementPublicKeyX: `0x${aliceSettlement.publicKeyX.toString(16)}`,
        memberRef: `0x${aliceSettlement.memberRef.toString(16)}`,
      },
    };
    const envelope = encryptRecovery(payload, passphrase);
    const exported = JSON.stringify(envelope);
    expect(exported).not.toContain(aliceSpendingKey);
    expect(exported).not.toContain(payload.strk20.viewingKey);
    expect(exported).not.toContain(payload.iwa.settlementKey);
    expect(exported).not.toContain(payload.iwa.inviteSecret);

    const restored = decryptRecovery(envelope, passphrase);
    const restoredAccount = new Account({
      provider: env.env.node,
      address: restored.starknet.accountAddress,
      signer: bytesFromHex(restored.starknet.spendingKey),
    });
    expect(restoredAccount.address).toBe(embeddedAlice.address);
    expect(restored.strk20.viewingKey).toBe(payload.strk20.viewingKey);
    expect(settlementPublicKeyX(BigInt(restored.iwa.settlementKey))).toBe(
      BigInt(restored.iwa.settlementPublicKeyX),
    );
    expect(
      iwaHash(
        shortStringToFelt("IWA_INVITE_V1"),
        BigInt(restored.iwa.inviteSecret),
        BigInt(restored.iwa.settlementPublicKeyX),
      ),
    ).toBe(BigInt(restored.iwa.memberRef));

    const alteredCiphertext = Buffer.from(envelope.ciphertext, "base64");
    alteredCiphertext[0] ^= 1;
    expect(() =>
      decryptRecovery(
        { ...envelope, ciphertext: alteredCiphertext.toString("base64") },
        passphrase,
      ),
    ).toThrow();
  });
});
