/*
 * Temporary B0.1 test copied into the pinned upstream e2e suite by the
 * disposable GitHub Actions workflow. It deliberately uses no browser wallet
 * API, no remote network, no filesystem persistence, and no console output.
 *
 * The upstream Devnet creates deterministic, test-only predeployed accounts at
 * process start. This harness obtains that key only from the local devnet RPC,
 * keeps it in process memory, and never prints or writes it. Viewing and Iwa
 * settlement authorities are fresh runtime-only values.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Account,
  constants,
  ec,
} from "starknet";
import {
  createPrivateTransfers,
  type PrivateTransfersInterface,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  Devnet,
  IndexerDiscoveryProvider,
  ScreeningCallMockProofProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";

const TEST_TIMEOUT_MS = 240_000;
const RECOVERY_AAD = Buffer.from("iwa-b01-recovery-v1", "utf8");
const VIEWING_KEY_MAX = ec.starkCurve.CURVE.n / 2n;

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

type SettlementIdentity = {
  inviteSecret: bigint;
  privateKey: bigint;
  publicKeyX: bigint;
  memberRef: bigint;
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

function randomScalar(maximum: bigint): bigint {
  const candidate = BigInt(hexFromBytes(ec.starkCurve.utils.randomPrivateKey()));
  return (candidate % maximum) + 1n;
}

function keyBytes(value: bigint): Uint8Array {
  return bytesFromHex(`0x${value.toString(16).padStart(64, "0")}`);
}

function padded(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
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

function assertExpectedChain(
  observed: constants.StarknetChainId,
  expected: constants.StarknetChainId,
): void {
  if (observed !== expected) throw new Error("wrong Starknet network");
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

function transfersFor(
  account: { address: string; signer: Account["signer"] },
  viewingKey: bigint,
  env: E2eTestEnv,
): PrivateTransfersInterface {
  return createPrivateTransfers({
    // Intentionally the SDK's minimal direct signer shape, with no browser
    // extension or wallet-adapter dependency.
    account: { address: account.address, signer: account.signer },
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    provingProvider: new ScreeningCallMockProofProvider(env.env.node, env.env.chainId),
    discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address),
    poolContractAddress: env.env.privacy.address,
  });
}

describe("Iwa B0.1 embedded signer compatibility", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  let localSpendingKey: string;
  let embeddedAccount: Account;
  let aliceTransfers: PrivateTransfersInterface;
  let bobTransfers: PrivateTransfersInterface;
  let aliceViewingKey: bigint;
  let bobViewingKey: bigint;
  let settlementIdentity: SettlementIdentity;
  let recoveryPassphrase: Buffer;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet);
    localSpendingKey = await predeployedKeyForLocalAccount(devnet.url, env.env.alice.address);
    embeddedAccount = new Account({
      provider: env.env.node,
      address: env.env.alice.address,
      signer: bytesFromHex(localSpendingKey),
    });
    aliceViewingKey = randomScalar(VIEWING_KEY_MAX);
    bobViewingKey = randomScalar(VIEWING_KEY_MAX);
    settlementIdentity = await deriveIwaSettlementIdentity(embeddedAccount);
    recoveryPassphrase = randomBytes(32);
    aliceTransfers = transfersFor(embeddedAccount, aliceViewingKey, env);
    bobTransfers = transfersFor(env.env.bob, bobViewingKey, env);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("uses a local Starknet account and the privacy SDK minimal signer shape", async () => {
    expect(embeddedAccount.address).toBe(env.env.alice.address);
    expect(BigInt(await env.env.node.getClassHashAt(embeddedAccount.address))).not.toBe(0n);
    assertExpectedChain(await env.env.node.getChainId(), env.env.chainId);
    // The existing Iwa settlement-authority path is derived from a deterministic
    // account signature. A local account signer must reproduce it exactly.
    const derivedAgain = await deriveIwaSettlementIdentity(embeddedAccount);
    expect(derivedAgain).toEqual(settlementIdentity);

    // A wrong signer or substituted signer cannot authorize Alice's account.
    const wrongKeyAccount = new Account({
      provider: env.env.node,
      address: env.env.alice.address,
      signer: keyBytes(randomScalar(ec.starkCurve.CURVE.n - 1n)),
    });
    await expect(
      transfersFor(wrongKeyAccount, randomScalar(VIEWING_KEY_MAX), env)
        .build()
        .register()
        .execute(),
    ).rejects.toThrow();
    await expect(
      transfersFor(
        { address: env.env.alice.address, signer: env.env.bob.signer },
        randomScalar(VIEWING_KEY_MAX),
        env,
      )
        .build()
        .register()
        .execute(),
    ).rejects.toThrow();
    await expect(
      transfersFor(
        { address: env.env.bob.address, signer: embeddedAccount.signer },
        randomScalar(VIEWING_KEY_MAX),
        env,
      )
        .build()
        .register()
        .execute(),
    ).rejects.toThrow();

    // The test-only devnet must never be treated as a different network.
    expect(() =>
      assertExpectedChain(env.env.chainId, "SN_WRONG_NETWORK" as constants.StarknetChainId),
    ).toThrow("wrong Starknet network");
  }, TEST_TIMEOUT_MS);

  it("registers runtime viewing keys, proves a private transfer, and discovers private state", async () => {
    await embeddedAccount.execute({
      contractAddress: env.env.strk,
      entrypoint: "approve",
      calldata: [env.env.privacy.address, 100n, 0n],
    });

    const { callAndProof: aliceRegistration } = await aliceTransfers.build().register().execute();
    // A proof is bound to its intent: altered calldata must not be accepted.
    const tamperedRegistration = {
      ...aliceRegistration,
      call: {
        ...aliceRegistration.call,
        calldata: [...aliceRegistration.call.calldata, "0x1"],
      },
    };
    await expect(devnet.executeOutside(tamperedRegistration)).rejects.toThrow();
    await devnet.executeOutside(aliceRegistration);
    // Immutable viewing-key registration also prevents a replay.
    await expect(devnet.executeOutside(aliceRegistration)).rejects.toThrow();

    const { callAndProof: bobRegistration } = await bobTransfers.build().register().execute();
    await devnet.executeOutside(bobRegistration);

    const { callAndProof } = await aliceTransfers
      .build({ autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } })
      .with(env.env.strk)
      .deposit({ amount: 100n })
      .transfer({ recipient: env.env.bob.address, amount: 40n })
      .surplusTo(embeddedAccount.address)
      .execute();
    await devnet.executeOutside(callAndProof);
    await env.indexer.waitForBlock(devnet.url);

    const discovered = await bobTransfers.discoverNotes();
    const bobStrkNotes = discovered.notes.get(BigInt(env.env.strk));
    expect(bobStrkNotes).toBeDefined();
    expect(bobStrkNotes!.some((note) => note.amount === 40n)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("rejects malformed viewing-key and SDK inputs before a private operation", async () => {
    await expect(
      transfersFor(embeddedAccount, 0n, env).build().register().execute(),
    ).rejects.toThrow();
    await expect(
      createPrivateTransfers({
        account: { address: embeddedAccount.address, signer: undefined as never },
        viewingKeyProvider: { getViewingKey: async () => aliceViewingKey },
        provingProvider: new ScreeningCallMockProofProvider(env.env.node, env.env.chainId),
        discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address),
        poolContractAddress: env.env.privacy.address,
      })
        .build()
        .register()
        .execute(),
    ).rejects.toThrow();
  }, TEST_TIMEOUT_MS);

  it("round-trips encrypted in-memory recovery material without serializing secrets", () => {
    const payload: RecoveryPayload = {
      starknet: { accountAddress: embeddedAccount.address, spendingKey: localSpendingKey },
      strk20: { viewingKey: `0x${aliceViewingKey.toString(16)}` },
      iwa: {
        inviteSecret: `0x${settlementIdentity.inviteSecret.toString(16)}`,
        settlementKey: `0x${settlementIdentity.privateKey.toString(16)}`,
        settlementPublicKeyX: `0x${settlementIdentity.publicKeyX.toString(16)}`,
        memberRef: `0x${settlementIdentity.memberRef.toString(16)}`,
      },
    };
    const envelope = encryptRecovery(payload, recoveryPassphrase);
    const exported = JSON.stringify(envelope);
    expect(exported).not.toContain(localSpendingKey);
    expect(exported).not.toContain(payload.strk20.viewingKey);
    expect(exported).not.toContain(payload.iwa.settlementKey);
    expect(exported).not.toContain(payload.iwa.inviteSecret);

    const restored = decryptRecovery(envelope, recoveryPassphrase);
    const restoredAccount = new Account({
      provider: env.env.node,
      address: restored.starknet.accountAddress,
      signer: bytesFromHex(restored.starknet.spendingKey),
    });
    expect(restoredAccount.address).toBe(embeddedAccount.address);
    expect(restored.strk20.viewingKey).toBe(payload.strk20.viewingKey);
    expect(settlementPublicKeyX(BigInt(restored.iwa.settlementKey))).toBe(
      BigInt(payload.iwa.settlementPublicKeyX),
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
        recoveryPassphrase,
      ),
    ).toThrow();
  });
});
