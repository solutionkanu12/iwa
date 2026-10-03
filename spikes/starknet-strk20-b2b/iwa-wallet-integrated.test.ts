/*
 * CI-only B2-B-R2 proof. The workflow copies this into the exact upstream
 * privacy E2E suite. It uses real Iwa vault encryption/recovery plus a
 * runtime-only WebAuthn PRF adapter and isolated-devnet authorities only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Account, CairoOption, CairoOptionVariant, CallData, RpcProvider, constants, ec, hash } from "starknet";
import { createPrivateTransfers, type PrivateTransfersInterface } from "@starkware-libs/starknet-privacy-sdk";
import { Devnet, IndexerDiscoveryProvider, ScreeningCallMockProofProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";

import { PrivacyPoolABI } from "./iwa-wallet-vault/../../../../scripts/demo/vendor/starknet-privacy-sdk/dist/internal/abi.js";
import { type WalletPasskeyMetadata } from "./iwa-wallet-vault/vaultCrypto.ts";
import { isStarknetVaultAuthority, isStrk20ViewingVaultAuthority, openRecoveryPackage, wipeVaultAuthorities } from "./iwa-wallet-vault/recoveryPackage.ts";
import { IwaStrk20PrivacyRuntime, type IwaHelperPrivateInvoke, type Strk20PrivacyBuilder, type Strk20PrivacySdkFactory } from "./iwa-wallet-vault/strk20PrivacyRuntime.ts";
import { InMemoryVaultStore } from "./iwa-wallet-vault/vaultStore.ts";
import { WalletVault } from "./iwa-wallet-vault/walletVault.ts";

const TEST_TIMEOUT_MS = 360_000;
const WALLET_ID = "00000000-0000-4000-8000-000000000722";
const INITIAL_PASSWORD = "Iwa B2BR2 isolated vault password";
const RECOVERED_PASSWORD = "Iwa B2BR2 restored vault password";
const CONTRIBUTION_AMOUNT = 100n;
const PRIVATE_TEST_AMOUNT = 200n;
const TEST_FUNDING_AMOUNT = 1_000n;
const ROUND = 1n;
const SRC6_VALIDATED = 0x56414c4944n;
const DEVNET_DEPLOYMENT_FUNDING_FRI = "1000000000000000000000";
const VIEWING_KEY_MAX = ec.starkCurve.CURVE.n / 2n;
const poolActionDecoder = new CallData(PrivacyPoolABI);

type SettlementIdentity = { inviteSecret: bigint; privateKey: bigint; publicKeyX: bigint; memberRef: bigint };
type DeployedIwa = { circle: string; helper: string };

function hexFromBytes(value: Uint8Array): string { return `0x${Buffer.from(value).toString("hex")}`; }
function bytesToBigInt(bytes: Uint8Array): bigint { let value = 0n; for (const byte of bytes) value = (value << 8n) | BigInt(byte); return value; }
function randomScalar(maximum: bigint): bigint { return (BigInt(hexFromBytes(ec.starkCurve.utils.randomPrivateKey())) % maximum) + 1n; }
function padded(value: bigint): string { return `0x${value.toString(16).padStart(64, "0")}`; }
function iwaHash(...values: bigint[]): bigint { return ec.starkCurve.poseidonHashMany(values); }
function shortStringToFelt(value: string): bigint {
  if (value.length > 31 || /[^\x00-\x7f]/.test(value)) throw new Error("invalid Iwa domain tag");
  return BigInt(`0x${Buffer.from(value, "ascii").toString("hex")}`);
}
function publicKeyX(privateKey: bigint): bigint {
  const point = ec.starkCurve.getPublicKey(padded(privateKey), false);
  return BigInt(`0x${Buffer.from(point.slice(1, 33)).toString("hex")}`);
}
function signIwa(privateKey: bigint, messageHash: bigint): { r: bigint; s: bigint } {
  const { r, s } = ec.starkCurve.sign(padded(messageHash), padded(privateKey));
  const order = ec.starkCurve.CURVE.n;
  return { r, s: s > order / 2n ? order - s : s };
}
function digestOf(parts: string[]): bigint { return BigInt(`0x${createHash("sha256").update(parts.join("|"), "utf8").digest("hex")}`); }
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
function identityTypedData(address: string) {
  return {
    domain: { name: "Iwa", version: "1", chainId: "SN_MAIN" },
    types: { StarkNetDomain: [{ name: "name", type: "felt" }, { name: "version", type: "felt" }, { name: "chainId", type: "felt" }], Identity: [{ name: "purpose", type: "felt" }, { name: "account", type: "felt" }] },
    primaryType: "Identity", message: { purpose: "Iwa member identity v1", account: address },
  };
}
async function deriveIwaSettlementIdentity(account: Account): Promise<SettlementIdentity> {
  const signature = await account.signMessage(identityTypedData(account.address));
  const signatureParts = Array.isArray(signature) ? signature.map(String) : [String(signature)];
  const base = digestOf(["Iwa member identity v1", account.address, ...signatureParts]);
  const prime = (1n << 251n) + 17n * (1n << 192n) + 1n;
  const inviteSecret = (digestOf(["invite", base.toString(16)]) % (prime - 1n)) + 1n;
  const privateKey = (digestOf(["auth", base.toString(16)]) % (ec.starkCurve.CURVE.n - 1n)) + 1n;
  const settlementPublicKey = publicKeyX(privateKey);
  return { inviteSecret, privateKey, publicKeyX: settlementPublicKey, memberRef: iwaHash(shortStringToFelt("IWA_INVITE_V1"), inviteSecret, settlementPublicKey) };
}
function contributionHash(args: { circleId: bigint; memberRef: bigint; helper: string; pool: string; token: string; nonce: bigint }): bigint {
  return iwaHash(shortStringToFelt("IWA_CONTRIBUTION_SETTLEMENT_V1"), args.circleId, ROUND, args.memberRef, BigInt(args.helper), BigInt(args.pool), BigInt(args.token), CONTRIBUTION_AMOUNT, args.nonce);
}
function readIwaArtifact(contractName: "IwaCircle" | "IwaStrk20Helper") {
  const artifactDir = process.env.IWA_ARTIFACT_DIR;
  if (!artifactDir) throw new Error("integrated Iwa artifact directory is not configured");
  const base = `iwa_${contractName}`;
  return { contract: JSON.parse(readFileSync(join(artifactDir, `${base}.contract_class.json`), "utf8")), casm: JSON.parse(readFileSync(join(artifactDir, `${base}.compiled_contract_class.json`), "utf8")) };
}
async function deployIwaContract(account: Account, contractName: "IwaCircle" | "IwaStrk20Helper", constructorCalldata: Array<string | bigint>, salt: string, node: E2eTestEnv["env"]["node"]): Promise<string> {
  const artifact = readIwaArtifact(contractName);
  const declaration = await account.declare({ contract: artifact.contract, casm: artifact.casm, compiledClassHash: hash.computeCompiledClassHash(artifact.casm) });
  if (!(await node.waitForTransaction(declaration.transaction_hash)).isSuccess()) throw new Error("Iwa test contract declaration failed");
  const deployment = await account.deployContract({ classHash: declaration.class_hash, constructorCalldata, salt });
  if (!(await node.waitForTransaction(deployment.transaction_hash)).isSuccess()) throw new Error("Iwa test contract deployment failed");
  return deployment.contract_address;
}
async function mintTestFunding(address: string, rpcUrl: string): Promise<void> {
  const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: `{"jsonrpc":"2.0","id":1,"method":"devnet_mint","params":{"address":${JSON.stringify(address)},"amount":${DEVNET_DEPLOYMENT_FUNDING_FRI},"unit":"FRI"}}` });
  const payload = (await response.json()) as { result?: unknown; error?: unknown };
  if (!response.ok || payload.result === undefined || payload.error !== undefined) throw new Error("isolated deployment funding failed");
}
function makePasskey(credentialId: string, prfInputStart: number): WalletPasskeyMetadata {
  return { credentialId, rpId: "wallet.example.test", prfInput: Uint8Array.from({ length: 32 }, (_, index) => prfInputStart + index) };
}
function createVault(store: InMemoryVaultStore) {
  return new WalletVault({
    store,
    // Browser authenticator behavior is the sole adapter here. The production
    // 600,000-iteration PBKDF2/HKDF/AES-GCM vault and recovery code execute
    // unchanged, including their runtime-generated salts and IVs.
    passkey: { assertPrf: async (binding) => Uint8Array.from({ length: 32 }, (_, index) => (binding.credentialId === "b2br2-initial-passkey" ? index * 17 + 3 : index * 19 + 5) % 256) },
    timeout: { set: () => 1, clear: () => undefined },
  });
}
function transfersFor(account: { address: string; signer: Account["signer"] }, viewingKey: bigint, env: E2eTestEnv): PrivateTransfersInterface {
  return createPrivateTransfers({ account: { address: account.address, signer: account.signer }, viewingKeyProvider: { getViewingKey: async () => viewingKey }, provingProvider: new ScreeningCallMockProofProvider(env.env.node, constants.StarknetChainId.SN_SEPOLIA), discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address), poolContractAddress: env.env.privacy.address });
}
function sameSummary(left: { noteCount: number; balances: readonly { token: string; amount: string }[] }, right: { noteCount: number; balances: readonly { token: string; amount: string }[] }): boolean {
  return left.noteCount === right.noteCount && left.balances.length === right.balances.length && left.balances.every((entry, index) => entry.token === right.balances[index]?.token && entry.amount === right.balances[index]?.amount);
}
function privacySdkFactory(): Strk20PrivacySdkFactory {
  return { createPrivateTransfers: (input) => createPrivateTransfers({ account: input.account, viewingKeyProvider: input.viewingKeyProvider, provingProvider: input.provingProvider, discoveryProvider: input.discoveryProvider, poolContractAddress: input.poolContractAddress } as never) as never };
}

/**
 * CI-only adversarial mutation. It begins with a genuine SDK result, decodes
 * the proof-bound action span with the same pinned ABI used by the production
 * validator, then substitutes only the inner Invoke target. The validator must
 * reject it before submission. This is deliberately not a positional parser.
 */
function substituteSdkHelperTarget(
  result: { readonly callAndProof: { readonly call: { readonly calldata: readonly string[] }; readonly proof: { readonly output: readonly string[] } } },
  replacementHelper: string,
) {
  const actionSpan = result.callAndProof.proof.output.slice(1);
  const decoded = poolActionDecoder.decodeParameters("core::array::Span::<privacy::actions::ServerAction>", actionSpan) as Array<{ variant?: Record<string, unknown> }>;
  const invokes = decoded.filter((action) => action.variant?.Invoke !== undefined);
  if (invokes.length !== 1) throw new Error("expected exactly one SDK Invoke action");
  const invoke = invokes[0]?.variant?.Invoke;
  if (typeof invoke !== "object" || invoke === null || Array.isArray(invoke)) throw new Error("SDK Invoke action was malformed");
  const mutated = invoke as Record<string, unknown>;
  if (!("contract_address" in mutated)) throw new Error("SDK Invoke action lacked a target");
  mutated.contract_address = BigInt(replacementHelper);
  const replacementSpan = poolActionDecoder.compile("apply_actions", [decoded, new CairoOption(CairoOptionVariant.None)])
    .slice(0, -1)
    .map((felt) => `0x${BigInt(felt).toString(16)}`);
  return {
    callAndProof: {
      ...result.callAndProof,
      call: {
        ...result.callAndProof.call,
        calldata: [...replacementSpan, ...result.callAndProof.call.calldata.slice(actionSpan.length)],
      },
      proof: {
        ...result.callAndProof.proof,
        output: [result.callAndProof.proof.output[0]!, ...replacementSpan],
      },
    },
  };
}

describe("Iwa B2-B-R2 integrated vault and STRK20 proof", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;
  async function execute(account: Account, call: { contractAddress: string; entrypoint: string; calldata: Array<string | bigint> }) {
    const transaction = await account.execute(call);
    if (!(await env.env.node.waitForTransaction(transaction.transaction_hash)).isSuccess()) throw new Error("isolated test account invocation failed");
  }
  beforeAll(async () => { devnet = new Devnet(); env = await createE2eTestEnv(devnet); expect(await env.env.node.getChainId()).toBe(constants.StarknetChainId.SN_SEPOLIA); }, TEST_TIMEOUT_MS);
  afterAll(async () => { await env?.indexer.shutdown(); await devnet?.cleanup(); });

  it("proves one encrypted vault identity through deploy, canonical helper invocation, and same-authority recovery", async () => {
    let phase = "initialize";
    const store = new InMemoryVaultStore();
    const recoveryKey = crypto.getRandomValues(new Uint8Array(32));
    const initialPasskey = makePasskey("b2br2-initial-passkey", 1);
    const recoveredPasskey = makePasskey("b2br2-recovered-passkey", 41);
    let initialVault: WalletVault | undefined;
    let inspectionPayload: Awaited<ReturnType<typeof openRecoveryPackage>> | undefined;
    let replacementPayload: Awaited<ReturnType<typeof openRecoveryPackage>> | undefined;
    let rawSpending: Uint8Array | undefined;
    let rawViewing: Uint8Array | undefined;
    let restoredSpending: Uint8Array | undefined;
    let restoredViewing: Uint8Array | undefined;
    try {
      phase = "discover-account-class";
      const provider = new RpcProvider({ nodeUrl: devnet.url });
      const networkId = await provider.getChainId();
      const accountClassHash = await provider.getClassHashAt(env.env.alice.address);

      phase = "create-real-encrypted-vault";
      initialVault = createVault(store);
      await initialVault.create({ walletId: WALLET_ID, password: INITIAL_PASSWORD, passkey: initialPasskey, authorities: [] });
      const initialSession = await initialVault.unlock({ walletId: WALLET_ID, password: INITIAL_PASSWORD });

      phase = "provision-and-deploy-fresh-starknet-authority";
      const account = await initialVault.provisionStarknetAuthority(initialSession, { walletId: WALLET_ID, password: INITIAL_PASSWORD, accountClass: { networkId, accountClassId: "b2br2-devnet-verified-account", accountClassHash, descriptorVersion: 1 } });
      await mintTestFunding(account.accountAddress, devnet.url);
      const deployment = await initialVault.deployStarknetAccount(initialSession, { walletId: WALLET_ID, password: INITIAL_PASSWORD, provider });
      expect(deployment.accountAddress).toBe(account.accountAddress);
      expect(deployment.resumed).toBe(false);
      expect(BigInt(await provider.getClassHashAt(account.accountAddress))).toBe(BigInt(accountClassHash));

      phase = "provision-encrypted-viewing-authority";
      const viewing = await initialVault.provisionStrk20ViewingAuthority(initialSession, { walletId: WALLET_ID, password: INITIAL_PASSWORD, networkId, poolAddress: env.env.privacy.address, accountAddress: account.accountAddress });
      expect(viewing.registrationState).toBe("unregistered");
      const registrationProbe = async (context: { accountAddress: string; viewingKey: bigint }) => {
        const stored = await env.env.node.callContract({ contractAddress: env.env.privacy.address, entrypoint: "get_public_key", calldata: [context.accountAddress] });
        return BigInt(stored[0] ?? "0x0") === publicKeyX(context.viewingKey);
      };
      const runtime = new IwaStrk20PrivacyRuntime({
        sdk: privacySdkFactory(),
        provingProvider: new ScreeningCallMockProofProvider(env.env.node, constants.StarknetChainId.SN_SEPOLIA),
        discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address),
        probeRegistration: registrationProbe,
        submit: async ({ callAndProof }) => { await devnet.executeOutside(callAndProof as never); await env.indexer.waitForBlock(devnet.url); },
      });
      phase = "register-viewing-key-through-vault";
      await initialVault.registerStrk20ViewingAuthority(initialSession, { walletId: WALLET_ID, password: INITIAL_PASSWORD, provider, runtime });
      await expect(initialVault.registerStrk20ViewingAuthority(initialSession, { walletId: WALLET_ID, password: INITIAL_PASSWORD, provider, runtime })).resolves.toMatchObject({ registrationState: "registered" });

      phase = "extract-test-only-authorities-from-genuine-encrypted-package";
      const inspectionPackage = await initialVault.exportRecovery(initialSession, WALLET_ID, recoveryKey, "b2br2-inspection-g1");
      inspectionPayload = await openRecoveryPackage(inspectionPackage, recoveryKey, WALLET_ID);
      const inspectionAccount = inspectionPayload.authorities.find(isStarknetVaultAuthority);
      const inspectionViewing = inspectionPayload.authorities.find(isStrk20ViewingVaultAuthority);
      if (inspectionAccount === undefined || inspectionViewing === undefined) throw new Error("integrated authority set was incomplete");
      rawSpending = new Uint8Array(inspectionAccount.privateKey);
      rawViewing = new Uint8Array(inspectionViewing.privateKey);
      const rawAccount = new Account({ provider: env.env.node, address: account.accountAddress, signer: rawSpending });
      const rawContext = { walletId: WALLET_ID, networkId, poolAddress: env.env.privacy.address, accountAddress: account.accountAddress, account: { address: account.accountAddress, signer: rawAccount.signer }, viewingKey: bytesToBigInt(rawViewing) };

      phase = "fund-and-create-private-test-state";
      await execute(env.env.alice, { contractAddress: env.env.strk, entrypoint: "transfer", calldata: [account.accountAddress, TEST_FUNDING_AMOUNT, 0n] });
      await execute(rawAccount, { contractAddress: env.env.strk, entrypoint: "approve", calldata: [env.env.privacy.address, PRIVATE_TEST_AMOUNT + CONTRIBUTION_AMOUNT * 2n, 0n] });
      const privateDeposit = await transfersFor(rawAccount, rawContext.viewingKey, env).build({ autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } }).with(env.env.strk, (token) => token.deposit({ amount: PRIVATE_TEST_AMOUNT })).surplusTo(account.accountAddress).execute();
      await devnet.executeOutside(privateDeposit.callAndProof);
      await env.indexer.waitForBlock(devnet.url);
      phase = "discover-private-state-through-vault";
      const initialState = await initialVault.discoverStrk20PrivateState(initialSession, { walletId: WALLET_ID, provider, runtime });
      expect(initialState.noteCount).toBeGreaterThan(0);
      expect(initialState.balances.some((entry) => BigInt(entry.token) === BigInt(env.env.strk) && BigInt(entry.amount) > 0n)).toBe(true);
      await expect(transfersFor(rawAccount, randomScalar(VIEWING_KEY_MAX), env).discoverNotes({ tokens: [BigInt(env.env.strk)] })).rejects.toThrow("viewing_key does not match the registered public key");

      phase = "deploy-temporary-iwa-helper-and-membership";
      const iwa: DeployedIwa = { circle: await deployIwaContract(env.env.admin, "IwaCircle", [env.env.strk, env.env.eth, env.env.privacy.address, env.env.admin.address], "0xb2b701", env.env.node), helper: "" };
      iwa.helper = await deployIwaContract(env.env.admin, "IwaStrk20Helper", [iwa.circle, env.env.privacy.address, env.env.strk, env.env.eth, env.env.bob.address], "0xb2b702", env.env.node);
      await execute(env.env.admin, { contractAddress: iwa.circle, entrypoint: "initialize_settlement_helper", calldata: [iwa.helper] });
      // Test-only compatibility witness. It is never written to the vault,
      // package, backend, or retained CI state; B2-C remains out of scope.
      const walletSettlement = await deriveIwaSettlementIdentity(rawAccount);
      const bobSettlement = await deriveIwaSettlementIdentity(env.env.bob);
      await execute(env.env.alice, { contractAddress: iwa.circle, entrypoint: "create_circle", calldata: [env.env.strk, CONTRIBUTION_AMOUNT, 100n, 50n, 2n, 2n, walletSettlement.memberRef, bobSettlement.memberRef] });
      await execute(rawAccount, { contractAddress: iwa.circle, entrypoint: "join_circle", calldata: [1n, walletSettlement.inviteSecret, walletSettlement.publicKeyX] });
      await execute(env.env.bob, { contractAddress: iwa.circle, entrypoint: "join_circle", calldata: [1n, bobSettlement.inviteSecret, bobSettlement.publicKeyX] });
      const helperIntent = (circleId: bigint, nonce: bigint): IwaHelperPrivateInvoke => {
        const signature = signIwa(walletSettlement.privateKey, contributionHash({ circleId, memberRef: walletSettlement.memberRef, helper: iwa.helper, pool: env.env.privacy.address, token: env.env.strk, nonce }));
        return {
          walletId: WALLET_ID, networkId, poolAddress: env.env.privacy.address, accountAddress: account.accountAddress,
          helperAddress: iwa.helper, helperEntrypoint: "privacy_invoke", operation: 0,
          helperCalldata: ["0x0", `0x${circleId.toString(16)}`, "0x1", `0x${walletSettlement.memberRef.toString(16)}`, `0x${BigInt(env.env.strk).toString(16)}`, "0x0", `0x${nonce.toString(16)}`, `0x${signature.r.toString(16)}`, `0x${signature.s.toString(16)}`],
          nonce: `0x${nonce.toString(16)}`,
          expectedFunding: { token: env.env.strk, amount: `0x${CONTRIBUTION_AMOUNT.toString(16)}` },
          expectedWithdrawal: { token: env.env.strk, amount: `0x${CONTRIBUTION_AMOUNT.toString(16)}` },
          // Exact pinned privacy::deposit, withdraw and invoke_external result
          // after the preceding self-channel setup.
          expectedServerActionTypes: ["TransferFrom", "EmitDeposit", "TransferTo", "EmitWithdrawal", "Invoke"],
        };
      };
      const buildHelper = (transfers: unknown, intent: IwaHelperPrivateInvoke): Strk20PrivacyBuilder => (
        (transfers as PrivateTransfersInterface).build({ autoSetup: true, autoDiscover: { notes: "refresh", channels: "refresh" } }).with(env.env.strk, (token) => token.deposit({ amount: CONTRIBUTION_AMOUNT }).withdraw({ recipient: intent.helperAddress, amount: CONTRIBUTION_AMOUNT })).invoke(() => ({ contractAddress: intent.helperAddress, entrypoint: intent.helperEntrypoint, calldata: intent.helperCalldata.map(BigInt) })) as unknown as Strk20PrivacyBuilder
      );
      const boundRuntime = new IwaStrk20PrivacyRuntime({
        sdk: privacySdkFactory(), provingProvider: new ScreeningCallMockProofProvider(env.env.node, constants.StarknetChainId.SN_SEPOLIA), discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address), probeRegistration: registrationProbe,
        submit: async ({ callAndProof }) => { await devnet.executeOutside(callAndProof as never); await env.indexer.waitForBlock(devnet.url); }, buildIwaHelperOperation: buildHelper,
      });
      phase = "validate-and-submit-genuine-sdk-helper-intent";
      await boundRuntime.invokeIwaHelper(rawContext, helperIntent(1n, 0x701n));
      const liability = await env.env.node.callContract({ contractAddress: iwa.helper, entrypoint: "get_token_liability", calldata: [env.env.strk] });
      expect(BigInt(liability[0] ?? "0x0")).toBe(CONTRIBUTION_AMOUNT);

      phase = "reject-tampered-and-substituted-sdk-actions-and-wrong-signer";
      const rejectionRuntime = new IwaStrk20PrivacyRuntime({
        sdk: privacySdkFactory(), provingProvider: new ScreeningCallMockProofProvider(env.env.node, constants.StarknetChainId.SN_SEPOLIA), discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address), probeRegistration: registrationProbe,
        submit: async () => { throw new Error("tampered proof must not submit"); },
        buildIwaHelperOperation: (transfers, intent) => {
          const genuine = buildHelper(transfers, intent);
          return { register: () => genuine, invoke: () => genuine, execute: async () => {
            const result = await genuine.execute();
            return { callAndProof: { ...result.callAndProof, call: { ...result.callAndProof.call, calldata: [...result.callAndProof.call.calldata.slice(0, -1), "0x0"] } } };
          } } as Strk20PrivacyBuilder;
        },
      });
      await expect(rejectionRuntime.invokeIwaHelper(rawContext, helperIntent(1n, 0x702n))).rejects.toThrow("Iwa STRK20 private-state operation rejected");
      const substitutedHelperRuntime = new IwaStrk20PrivacyRuntime({
        sdk: privacySdkFactory(), provingProvider: new ScreeningCallMockProofProvider(env.env.node, constants.StarknetChainId.SN_SEPOLIA), discoveryProvider: new IndexerDiscoveryProvider(env.indexer.apiUrl, env.env.privacy.address), probeRegistration: registrationProbe,
        submit: async () => { throw new Error("substituted helper proof must not submit"); },
        buildIwaHelperOperation: (transfers, intent) => {
          const genuine = buildHelper(transfers, intent);
          return { register: () => genuine, invoke: () => genuine, execute: async () => substituteSdkHelperTarget(await genuine.execute(), env.env.bob.address) } as Strk20PrivacyBuilder;
        },
      });
      await expect(substitutedHelperRuntime.invokeIwaHelper(rawContext, helperIntent(1n, 0x703n))).rejects.toThrow("Iwa STRK20 private-state operation rejected");
      await expect(boundRuntime.invokeIwaHelper({ ...rawContext, account: { address: account.accountAddress, signer: env.env.bob.signer } }, helperIntent(1n, 0x703n))).rejects.toThrow();

      phase = "export-final-real-recovery-package-and-destroy-original";
      const finalRecovery = await initialVault.exportRecovery(initialSession, WALLET_ID, recoveryKey, "b2br2-final-g1");
      expect(finalRecovery.generation).toBe(1);
      await initialVault.destroy(WALLET_ID);
      rawSpending.fill(0); rawViewing.fill(0); rawSpending = undefined; rawViewing = undefined;
      inspectionPayload.rootSecret.fill(0); wipeVaultAuthorities(inspectionPayload.authorities); inspectionPayload = undefined;

      phase = "recover-same-vault-under-fresh-passkey-context";
      const restoredVault = createVault(store);
      const replacementRecovery = await restoredVault.importRecovery({ recovery: finalRecovery, recoveryKey, password: RECOVERED_PASSWORD, passkey: recoveredPasskey, replacementPackageId: "b2br2-replacement-g2" });
      expect(replacementRecovery.generation).toBe(2);
      const restoredSession = await restoredVault.unlock({ walletId: WALLET_ID, password: RECOVERED_PASSWORD });
      const restoredAccount = restoredVault.starknetAccountDescriptor(restoredSession, WALLET_ID);
      const restoredViewingDescriptor = restoredVault.strk20ViewingAuthorityDescriptor(restoredSession, WALLET_ID);
      if (restoredAccount === null || restoredViewingDescriptor === null) throw new Error("restored descriptors were unavailable");
      expect(restoredAccount.accountAddress).toBe(account.accountAddress);
      expect(restoredAccount.publicKey).toBe(account.publicKey);
      expect(restoredViewingDescriptor.accountAddress).toBe(account.accountAddress);
      const proofHash = "0xb2b702";
      const recoveredSignature = restoredVault.signStarknetAuthorityProof(restoredSession, { walletId: WALLET_ID, networkId, accountAddress: account.accountAddress, proofHash });
      const signatureResult = await provider.callContract({ contractAddress: account.accountAddress, entrypoint: "is_valid_signature", calldata: [proofHash, "2", recoveredSignature.r, recoveredSignature.s] });
      expect(BigInt(signatureResult[0] ?? "0x0")).toBe(SRC6_VALIDATED);
      phase = "rediscover-private-state-through-recovered-vault";
      const restoredState = await restoredVault.discoverStrk20PrivateState(restoredSession, { walletId: WALLET_ID, provider, runtime });
      expect(sameSummary(initialState, restoredState)).toBe(true);

      phase = "recover-same-authority-and-invoke-again";
      replacementPayload = await openRecoveryPackage(replacementRecovery, recoveryKey, WALLET_ID);
      const replacementAccount = replacementPayload.authorities.find(isStarknetVaultAuthority);
      const replacementViewing = replacementPayload.authorities.find(isStrk20ViewingVaultAuthority);
      if (replacementAccount === undefined || replacementViewing === undefined) throw new Error("replacement authority set was incomplete");
      restoredSpending = new Uint8Array(replacementAccount.privateKey);
      restoredViewing = new Uint8Array(replacementViewing.privateKey);
      const recoveredAccount = new Account({ provider: env.env.node, address: account.accountAddress, signer: restoredSpending });
      expect(sameBytes(restoredSpending, replacementAccount.privateKey)).toBe(true);
      expect(sameBytes(restoredViewing, replacementViewing.privateKey)).toBe(true);
      const restoredContext = { walletId: WALLET_ID, networkId, poolAddress: env.env.privacy.address, accountAddress: account.accountAddress, account: { address: account.accountAddress, signer: recoveredAccount.signer }, viewingKey: bytesToBigInt(restoredViewing) };
      await execute(env.env.alice, { contractAddress: iwa.circle, entrypoint: "create_circle", calldata: [env.env.strk, CONTRIBUTION_AMOUNT, 100n, 50n, 2n, 2n, walletSettlement.memberRef, bobSettlement.memberRef] });
      await execute(recoveredAccount, { contractAddress: iwa.circle, entrypoint: "join_circle", calldata: [2n, walletSettlement.inviteSecret, walletSettlement.publicKeyX] });
      await execute(env.env.bob, { contractAddress: iwa.circle, entrypoint: "join_circle", calldata: [2n, bobSettlement.inviteSecret, bobSettlement.publicKeyX] });
      await boundRuntime.invokeIwaHelper(restoredContext, helperIntent(2n, 0x704n));
      expect(restoredVault.recoveryGeneration(restoredSession, WALLET_ID)).toBe(2);
      restoredVault.lock();
    } catch {
      throw new Error(`B2BR2_PHASE_FAILED:${phase}`);
    } finally {
      initialVault?.lock(); recoveryKey.fill(0); rawSpending?.fill(0); rawViewing?.fill(0); restoredSpending?.fill(0); restoredViewing?.fill(0);
      if (inspectionPayload !== undefined) { inspectionPayload.rootSecret.fill(0); wipeVaultAuthorities(inspectionPayload.authorities); }
      if (replacementPayload !== undefined) { replacementPayload.rootSecret.fill(0); wipeVaultAuthorities(replacementPayload.authorities); }
    }
  }, TEST_TIMEOUT_MS);
});
