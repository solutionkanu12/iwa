import { describe, expect, it, vi } from "vitest";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { IwaStrk20PrivacyRuntime, type Strk20PrivacySdkFactory } from "./strk20PrivacyRuntime";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const walletId = "wallet-strk20-private-state";
const password = "Iwa STRK20 private state vault password";
const passkey: WalletPasskeyMetadata = {
  credentialId: "wallet-strk20-runtime-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 19),
};
const accountClass = {
  networkId: "SN_IWA_DEVNET",
  accountClassId: "openzeppelin-account-component-devnet",
  accountClassHash: "0x1234",
  descriptorVersion: 1 as const,
};
const CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS = 20_000;

function newVault() {
  const store = new InMemoryVaultStore();
  return {
    store,
    vault: new WalletVault({
      store,
      passkey: { assertPrf: async () => Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) % 256) },
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
      timeout: { set: () => 1, clear: () => undefined },
    }),
  };
}

function privateRuntime(probe: () => Promise<boolean>) {
  const register = vi.fn(function register() { return builder; });
  const invoke = vi.fn(function invoke() { return builder; });
  const execute = vi.fn(async () => ({
    callAndProof: {
      call: { contractAddress: "0x9876", entrypoint: "privacy_invoke", calldata: [] },
      proof: { data: "proof", proofFacts: ["fact"], output: [] },
    },
  }));
  const builder = { register, invoke, execute };
  const createPrivateTransfers = vi.fn((_: Parameters<Strk20PrivacySdkFactory["createPrivateTransfers"]>[0]) => ({
    build: vi.fn(() => builder),
    discoverNotes: vi.fn(async () => ({ notes: new Map([[0x1n, [{ amount: 8n }]]]) })),
  }));
  const submit = vi.fn(async () => undefined);
  return {
    runtime: new IwaStrk20PrivacyRuntime({
      sdk: { createPrivateTransfers },
      provingProvider: { testOnly: true },
      discoveryProvider: { testOnly: true },
      probeRegistration: probe,
      submit,
    }),
    createPrivateTransfers,
    submit,
  };
}

describe("STRK20 private state through the opaque Iwa vault", () => {
  it("registers and resumes the encrypted viewing identity with a local embedded signer only", async () => {
    const { vault } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });
    const account = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    await vault.markStarknetAccountDeployed(session, { walletId, password, networkId: account.networkId, accountAddress: account.accountAddress });
    await vault.provisionStrk20ViewingAuthority(session, {
      walletId,
      password,
      networkId: account.networkId,
      accountAddress: account.accountAddress,
      poolAddress: "0x9876",
    });
    let registered = false;
    const harness = privateRuntime(async () => registered);
    const provider = { getChainId: async () => account.networkId };

    const first = await vault.registerStrk20ViewingAuthority(session, {
      walletId,
      password,
      provider: provider as never,
      runtime: harness.runtime,
    });
    registered = true;
    const retry = await vault.registerStrk20ViewingAuthority(session, {
      walletId,
      password,
      provider: provider as never,
      runtime: harness.runtime,
    });

    expect(first.registrationState).toBe("registered");
    expect(retry).toEqual(first);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    const params = harness.createPrivateTransfers.mock.calls[0]?.[0];
    expect(params?.account.address).toBe(account.accountAddress);
    expect(await params?.viewingKeyProvider.getViewingKey()).toBeGreaterThan(0n);
    expect(JSON.stringify(harness.submit.mock.calls)).not.toContain("viewingKey");
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);

  it("discovers minimized private state and rejects the wrong network or account context", async () => {
    const { vault } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });
    const account = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    await vault.markStarknetAccountDeployed(session, { walletId, password, networkId: account.networkId, accountAddress: account.accountAddress });
    await vault.provisionStrk20ViewingAuthority(session, {
      walletId,
      password,
      networkId: account.networkId,
      accountAddress: account.accountAddress,
      poolAddress: "0x9876",
    });
    const harness = privateRuntime(async () => true);
    await vault.registerStrk20ViewingAuthority(session, {
      walletId,
      password,
      provider: { getChainId: async () => account.networkId } as never,
      runtime: harness.runtime,
    });

    await expect(vault.discoverStrk20PrivateState(session, {
      walletId,
      provider: { getChainId: async () => account.networkId } as never,
      runtime: harness.runtime,
    })).resolves.toEqual({ noteCount: 1, balances: [{ token: "0x1", amount: "8" }] });
    await expect(vault.discoverStrk20PrivateState(session, {
      walletId,
      provider: { getChainId: async () => "SN_WRONG" } as never,
      runtime: harness.runtime,
    })).rejects.toThrow();
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);

  it("does not expose a generic Iwa helper invoke builder after registration", async () => {
    const { vault } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });
    const account = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    await vault.markStarknetAccountDeployed(session, { walletId, password, networkId: account.networkId, accountAddress: account.accountAddress });
    await vault.provisionStrk20ViewingAuthority(session, {
      walletId,
      password,
      networkId: account.networkId,
      accountAddress: account.accountAddress,
      poolAddress: "0x9876",
    });
    const harness = privateRuntime(async () => true);
    const provider = { getChainId: async () => account.networkId };
    await vault.registerStrk20ViewingAuthority(session, { walletId, password, provider: provider as never, runtime: harness.runtime });

    // The vault exposes no generic private-action builder. A future product
    // operation must be a reviewed, fixed intent handled in the chain adapter.
    expect("invokeStrk20IwaHelper" in (vault as object)).toBe(false);
    expect(harness.submit).not.toHaveBeenCalled();
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);
});
