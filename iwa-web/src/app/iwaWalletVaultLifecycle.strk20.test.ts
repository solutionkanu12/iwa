import { describe, expect, it, vi } from "vitest";

import { IwaWalletVaultLifecycle } from "./iwaWalletVaultLifecycle";
import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "../lib/walletVault/vaultCrypto";
import { isStrk20ViewingVaultAuthority, openRecoveryPackage, wipeVaultAuthorities } from "../lib/walletVault/recoveryPackage";
import { IwaStrk20PrivacyRuntime, type Strk20PrivacySdkFactory } from "../lib/walletVault/strk20PrivacyRuntime";
import { InMemoryVaultStore } from "../lib/walletVault/vaultStore";

const walletId = "00000000-0000-4000-8000-000000000411";
const password = "Iwa lifecycle STRK20 local vault password";
const recoveryPassword = "Iwa lifecycle STRK20 recovered vault password";
const pin = "123456";
const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 113);
const accountClass = {
  networkId: "SN_IWA_DEVNET",
  accountClassId: "openzeppelin-account-component-devnet",
  accountClassHash: "0x1234",
  descriptorVersion: 1 as const,
};
const CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS = 20_000;

class TestWalletPasskey {
  async enroll(rpId: string): Promise<WalletPasskeyMetadata> {
    return {
      credentialId: "lifecycle-strk20-wallet-passkey",
      rpId,
      prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    };
  }

  async assertPrf(): Promise<Uint8Array> {
    return Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 7) % 256);
  }
}

function lifecycle(store = new InMemoryVaultStore()) {
  return {
    store,
    controller: new IwaWalletVaultLifecycle({
      openStore: async () => store,
      createPasskey: () => new TestWalletPasskey(),
      rpId: () => "wallet.example.test",
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 17)),
      timeout: { set: () => 1, clear: () => undefined },
    }),
  };
}

function privateRuntime() {
  let registered = false;
  const register = vi.fn(function register() { return builder; });
  const invoke = vi.fn(function invoke() { return builder; });
  const execute = vi.fn(async () => ({
    callAndProof: {
      call: { contractAddress: "0x9876", entrypoint: "privacy_invoke", calldata: [] },
      proof: { data: "test-proof", proofFacts: ["test-fact"], output: [] },
    },
  }));
  const builder = { register, invoke, execute };
  const createPrivateTransfers = vi.fn((_: Parameters<Strk20PrivacySdkFactory["createPrivateTransfers"]>[0]) => ({
    build: vi.fn(() => builder),
    discoverNotes: vi.fn(async () => ({ notes: new Map([[0x1n, [{ amount: 5n }]]]) })),
  }));
  const submit = vi.fn(async () => { registered = true; });
  return {
    runtime: new IwaStrk20PrivacyRuntime({
      sdk: { createPrivateTransfers },
      provingProvider: { testOnly: true },
      discoveryProvider: { testOnly: true },
      probeRegistration: async () => registered,
      submit,
    }),
    submit,
  };
}

describe("Iwa Wallet lifecycle STRK20 recovery boundary", () => {
  it("restores the same local viewing authority, rediscovers private state, and can invoke again without exposing the scalar", async () => {
    const original = lifecycle();
    const harness = privateRuntime();
    await original.controller.provision({ walletId, password, pin });
    const account = await original.controller.provisionStarknetAuthority({ walletId, password, accountClass });
    await original.controller.markStarknetAccountDeployed({
      walletId,
      password,
      networkId: account.networkId,
      accountAddress: account.accountAddress,
    });
    const viewing = await original.controller.provisionStrk20ViewingAuthority({
      walletId,
      password,
      networkId: account.networkId,
      poolAddress: "0x9876",
      accountAddress: account.accountAddress,
    });
    const provider = { getChainId: async () => account.networkId };
    await original.controller.registerStrk20ViewingAuthority({
      walletId,
      password,
      provider: provider as never,
      runtime: harness.runtime,
    });
    await expect(original.controller.discoverStrk20PrivateState({
      walletId,
      provider: provider as never,
      runtime: harness.runtime,
    })).resolves.toEqual({ noteCount: 1, balances: [{ token: "0x1", amount: "5" }] });

    const exported = await original.controller.exportRecovery({
      walletId,
      recoveryKey,
      packageId: "lifecycle-strk20-recovery-one",
    });
    const exportedPayload = await openRecoveryPackage(exported, recoveryKey, walletId);
    const exportedViewing = exportedPayload.authorities.find(isStrk20ViewingVaultAuthority);
    if (exportedViewing === undefined) throw new Error("test setup failed");
    const expectedViewing = new Uint8Array(exportedViewing.privateKey);
    exportedPayload.rootSecret.fill(0);
    wipeVaultAuthorities(exportedPayload.authorities);
    await original.store.remove(walletId);
    original.controller.lock();

    const replacement = lifecycle();
    const replacementPackage = await replacement.controller.recover({
      recovery: exported,
      recoveryKey,
      walletId,
      expectedGeneration: 1,
      password: recoveryPassword,
      pin: "654321",
      replacementPackageId: "lifecycle-strk20-recovery-two",
    });
    const recoveredViewing = replacement.controller.strk20ViewingAuthorityDescriptor(walletId);
    expect(recoveredViewing).toEqual({ ...viewing, registrationState: "registered" });
    await expect(replacement.controller.discoverStrk20PrivateState({
      walletId,
      provider: provider as never,
      runtime: harness.runtime,
    })).resolves.toEqual({ noteCount: 1, balances: [{ token: "0x1", amount: "5" }] });
    // B2-B deliberately exposes no generic private-invoke capability through
    // this lifecycle or the React provider. The low-level runtime's bounded
    // helper proof remains covered separately; B2-C must introduce only a
    // reviewed, fixed settlement intent rather than a UI-supplied call builder.
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replacement.controller.view())).not.toContain("privateKey");

    const replacementPayload = await openRecoveryPackage(replacementPackage, recoveryKey, walletId);
    const replacementViewing = replacementPayload.authorities.find(isStrk20ViewingVaultAuthority);
    if (replacementViewing === undefined) throw new Error("test setup failed");
    try {
      expect(replacementPackage.generation).toBe(2);
      expect(replacementViewing.privateKey).toEqual(expectedViewing);
    } finally {
      expectedViewing.fill(0);
      replacementPayload.rootSecret.fill(0);
      wipeVaultAuthorities(replacementPayload.authorities);
      recoveryKey.fill(0);
    }
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);
});
