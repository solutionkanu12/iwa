import { CairoOption, CairoOptionVariant, CallData, CairoCustomEnum } from "starknet";
import { describe, expect, it, vi } from "vitest";

import { PrivacyPoolABI } from "../../../../scripts/demo/vendor/starknet-privacy-sdk/dist/internal/abi.js";
import { isStarknetVaultAuthority, isStrk20ViewingVaultAuthority, openRecoveryPackage, wipeVaultAuthorities } from "./recoveryPackage";
import { IwaStrk20PrivacyRuntime, type Strk20PrivacySdkFactory } from "./strk20PrivacyRuntime";
import { InMemoryVaultStore } from "./vaultStore";
import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { WalletVault } from "./walletVault";

const walletId = "wallet-strk20-invoke-recovery";
const password = "Iwa STRK20 private invoke recovery vault password";
const recoveryPassword = "Iwa STRK20 recovered private invoke vault password";
const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 71);
const passkey: WalletPasskeyMetadata = {
  credentialId: "strk20-invoke-recovery-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 3),
};
const accountClass = {
  networkId: "SN_IWA_DEVNET",
  accountClassId: "openzeppelin-account-component-devnet",
  accountClassHash: "0x1234",
  descriptorVersion: 1 as const,
};
const helperCalldata = ["0x0", "0x1", "0x2", "0x3", "0x7777", "0x0", "0x6", "0x7", "0x8"];
const CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS = 20_000;

function newVault(store = new InMemoryVaultStore()) {
  return {
    store,
    vault: new WalletVault({
      store,
      passkey: { assertPrf: async () => Uint8Array.from({ length: 32 }, (_, index) => (index * 23 + 5) % 256) },
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
      timeout: { set: () => 1, clear: () => undefined },
    }),
  };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function helperProof() {
  const decoder = new CallData(PrivacyPoolABI);
  const invoke = new CairoCustomEnum({
    WriteOnce: undefined,
    Append: undefined,
    TransferFrom: undefined,
    TransferTo: undefined,
    EmitViewingKeySet: undefined,
    EmitWithdrawal: undefined,
    EmitDeposit: undefined,
    EmitOpenNoteCreated: undefined,
    EmitEncNoteCreated: undefined,
    EmitNoteUsed: undefined,
    Invoke: { contract_address: 0x9876n, calldata: helperCalldata.map(BigInt) },
    InvokeWithComputation: undefined,
  });
  const transferTo = new CairoCustomEnum({
    WriteOnce: undefined,
    Append: undefined,
    TransferFrom: undefined,
    TransferTo: { to_addr: 0x9876n, token: 0x7777n, amount: 9n },
    EmitViewingKeySet: undefined,
    EmitWithdrawal: undefined,
    EmitDeposit: undefined,
    EmitOpenNoteCreated: undefined,
    EmitEncNoteCreated: undefined,
    EmitNoteUsed: undefined,
    Invoke: undefined,
    InvokeWithComputation: undefined,
  });
  const calldata = decoder.compile("apply_actions", [
    [transferTo, invoke],
    new CairoOption(CairoOptionVariant.None),
  ]).map((felt) => `0x${BigInt(felt).toString(16)}`);
  return {
    callAndProof: {
      call: { contractAddress: "0x9998", entrypoint: "apply_actions", calldata },
      proof: { data: "proof", proofFacts: ["fact"], output: ["0xc1a55", ...calldata.slice(0, -1)] },
    },
  };
}

function runtime(proof = helperProof()) {
  const builder = {
    register: vi.fn(function register() { return builder; }),
    invoke: vi.fn(function invoke() { return builder; }),
    execute: vi.fn(async () => proof),
  };
  const submit = vi.fn(async () => undefined);
  const createPrivateTransfers = vi.fn((_: Parameters<Strk20PrivacySdkFactory["createPrivateTransfers"]>[0]) => ({
    build: vi.fn(() => builder),
    discoverNotes: vi.fn(async () => ({ notes: new Map() })),
  }));
  return {
    submit,
    runtime: new IwaStrk20PrivacyRuntime({
      sdk: { createPrivateTransfers },
      provingProvider: { testOnly: true },
      discoveryProvider: { testOnly: true },
      probeRegistration: async () => true,
      submit,
      buildIwaHelperOperation: (transfers) => transfers.build().invoke(() => ({
        contractAddress: "0x9876",
        entrypoint: "privacy_invoke",
        calldata: helperCalldata,
      })),
    }),
  };
}

describe("STRK20 helper proof after portable recovery", () => {
  it("accepts the same canonical helper proof only with the restored spending and viewing authorities", async () => {
    const original = newVault();
    let initialPayload: Awaited<ReturnType<typeof openRecoveryPackage>> | undefined;
    let replacementPayload: Awaited<ReturnType<typeof openRecoveryPackage>> | undefined;
    let originalViewing: Uint8Array | undefined;
    let restoredViewing: Uint8Array | undefined;
    let originalSpending: Uint8Array | undefined;
    let restoredSpending: Uint8Array | undefined;
    try {
      await original.vault.create({ walletId, password, passkey, authorities: [] });
      const session = await original.vault.unlock({ walletId, password });
      const account = await original.vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
      await original.vault.markStarknetAccountDeployed(session, {
        walletId,
        password,
        networkId: account.networkId,
        accountAddress: account.accountAddress,
      });
      await original.vault.provisionStrk20ViewingAuthority(session, {
        walletId,
        password,
        networkId: account.networkId,
        poolAddress: "0x9998",
        accountAddress: account.accountAddress,
      });

      const recovery = await original.vault.exportRecovery(session, walletId, recoveryKey, "invoke-recovery-one");
      initialPayload = await openRecoveryPackage(recovery, recoveryKey, walletId);
      const initialViewing = initialPayload.authorities.find(isStrk20ViewingVaultAuthority);
      const initialSpending = initialPayload.authorities.find(isStarknetVaultAuthority);
      if (initialViewing === undefined || initialSpending === undefined) throw new Error("test setup failed");
      originalViewing = new Uint8Array(initialViewing.privateKey);
      originalSpending = new Uint8Array(initialSpending.privateKey);
      await original.vault.destroy(walletId);

      const recovered = newVault(original.store);
      const replacement = await recovered.vault.importRecovery({
        recovery,
        recoveryKey,
        password: recoveryPassword,
        passkey,
        replacementPackageId: "invoke-recovery-two",
      });
      replacementPayload = await openRecoveryPackage(replacement, recoveryKey, walletId);
      const recoveredViewing = replacementPayload.authorities.find(isStrk20ViewingVaultAuthority);
      const recoveredSpending = replacementPayload.authorities.find(isStarknetVaultAuthority);
      if (recoveredViewing === undefined || recoveredSpending === undefined) throw new Error("test setup failed");
      restoredViewing = new Uint8Array(recoveredViewing.privateKey);
      restoredSpending = new Uint8Array(recoveredSpending.privateKey);

      expect(restoredViewing).toEqual(originalViewing);
      expect(restoredSpending).toEqual(originalSpending);
      expect(replacement.generation).toBe(2);

      const harness = runtime();
      await expect(harness.runtime.invokeIwaHelper({
        walletId,
        networkId: account.networkId,
        poolAddress: "0x9998",
        accountAddress: account.accountAddress,
        account: { address: account.accountAddress, signer: {} as never },
        viewingKey: bytesToBigInt(restoredViewing),
      }, {
        walletId,
        networkId: account.networkId,
        poolAddress: "0x9998",
        accountAddress: account.accountAddress,
        helperAddress: "0x9876",
        helperEntrypoint: "privacy_invoke",
        operation: 0,
        helperCalldata,
        nonce: "0x6",
        expectedWithdrawal: { token: "0x7777", amount: "0x9" },
        expectedServerActionTypes: ["TransferTo", "Invoke"],
      })).resolves.toBeUndefined();
      expect(harness.submit).toHaveBeenCalledTimes(1);
    } finally {
      originalViewing?.fill(0);
      restoredViewing?.fill(0);
      originalSpending?.fill(0);
      restoredSpending?.fill(0);
      initialPayload?.rootSecret.fill(0);
      replacementPayload?.rootSecret.fill(0);
      if (initialPayload !== undefined) wipeVaultAuthorities(initialPayload.authorities);
      if (replacementPayload !== undefined) wipeVaultAuthorities(replacementPayload.authorities);
      recoveryKey.fill(0);
    }
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);
});
