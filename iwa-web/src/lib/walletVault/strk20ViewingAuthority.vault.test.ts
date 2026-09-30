import { describe, expect, it, vi } from "vitest";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { isStrk20ViewingVaultAuthority, openRecoveryPackage, wipeVaultAuthorities } from "./recoveryPackage";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const walletId = "wallet-strk20-viewing-authority";
const password = "Iwa STRK20 viewing authority vault password";
const replacementPassword = "Iwa recovered STRK20 viewing authority password";
const passkey: WalletPasskeyMetadata = {
  credentialId: "wallet-strk20-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 9),
};
const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 97);
const accountClass = {
  networkId: "SN_IWA_DEVNET",
  accountClassId: "openzeppelin-account-component-devnet",
  accountClassHash: "0x1234",
  descriptorVersion: 1 as const,
};
const CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS = 20_000;

function newVault(store = new InMemoryVaultStore()) {
  return {
    store,
    vault: new WalletVault({
      store,
      passkey: { assertPrf: async () => Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 7) % 256) },
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
      timeout: { set: () => 1, clear: () => undefined },
    }),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("encrypted STRK20 viewing authority record", () => {
  it("adds exactly one account-bound viewing authority to the authenticated manifest and refuses a context substitution", async () => {
    const { vault, store } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });
    const account = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    await vault.markStarknetAccountDeployed(session, {
      walletId,
      password,
      networkId: account.networkId,
      accountAddress: account.accountAddress,
    });

    const first = await vault.provisionStrk20ViewingAuthority(session, {
      walletId,
      password,
      networkId: account.networkId,
      poolAddress: "0x9876",
      accountAddress: account.accountAddress,
    });
    const retry = await vault.provisionStrk20ViewingAuthority(session, {
      walletId,
      password,
      networkId: account.networkId,
      poolAddress: "0x9876",
      accountAddress: account.accountAddress,
    });
    const persisted = await store.load(walletId);

    expect(retry).toEqual(first);
    expect(first.registrationState).toBe("local");
    expect(persisted?.authorityRecords.map((record) => record.namespace)).toEqual(["starknet/account", "strk20/viewing"]);
    expect(persisted?.authorityManifest.map((entry) => entry.namespace)).toEqual(["starknet/account", "strk20/viewing"]);
    await expect(vault.provisionStrk20ViewingAuthority(session, {
      walletId,
      password,
      networkId: account.networkId,
      poolAddress: "0x9877",
      accountAddress: account.accountAddress,
    })).rejects.toThrow();
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);

  it("restores the same STRK20 viewing authority and context from portable recovery without replacement", async () => {
    const original = newVault();
    await original.vault.create({ walletId, password, passkey, authorities: [] });
    const session = await original.vault.unlock({ walletId, password });
    const account = await original.vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    await original.vault.markStarknetAccountDeployed(session, {
      walletId,
      password,
      networkId: account.networkId,
      accountAddress: account.accountAddress,
    });
    const descriptor = await original.vault.provisionStrk20ViewingAuthority(session, {
      walletId,
      password,
      networkId: account.networkId,
      poolAddress: "0x9876",
      accountAddress: account.accountAddress,
    });
    const firstRecovery = await original.vault.exportRecovery(session, walletId, recoveryKey, "strk20-recovery-one");
    const firstPayload = await openRecoveryPackage(firstRecovery, recoveryKey, walletId);
    const firstViewing = firstPayload.authorities.find(isStrk20ViewingVaultAuthority);
    if (firstViewing === undefined) throw new Error("test setup failed");
    const originalScalar = new Uint8Array(firstViewing.privateKey);
    firstPayload.rootSecret.fill(0);
    wipeVaultAuthorities(firstPayload.authorities);
    await original.vault.destroy(walletId);

    const recovered = newVault(original.store);
    const replacement = await recovered.vault.importRecovery({
      recovery: firstRecovery,
      recoveryKey,
      password: replacementPassword,
      passkey,
      replacementPackageId: "strk20-recovery-two",
    });
    const recoveredSession = await recovered.vault.unlock({ walletId, password: replacementPassword });
    const restored = recovered.vault.strk20ViewingAuthorityDescriptor(recoveredSession, walletId);
    const replacementPayload = await openRecoveryPackage(replacement, recoveryKey, walletId);
    const replacementViewing = replacementPayload.authorities.find(isStrk20ViewingVaultAuthority);
    if (restored === null || replacementViewing === undefined) throw new Error("test setup failed");

    try {
      expect(restored).toEqual(descriptor);
      expect(replacement.generation).toBe(2);
      expect(replacementViewing.privateKey).toEqual(originalScalar);
    } finally {
      originalScalar.fill(0);
      replacementPayload.rootSecret.fill(0);
      wipeVaultAuthorities(replacementPayload.authorities);
    }
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);

  it("keeps the viewing scalar out of public descriptors and detects a deleted encrypted viewing record before unlock", async () => {
    const { vault, store } = newVault();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const testRecoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 41);
    try {
      await vault.create({ walletId, password, passkey, authorities: [] });
      const session = await vault.unlock({ walletId, password });
      const account = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
      await vault.markStarknetAccountDeployed(session, {
        walletId,
        password,
        networkId: account.networkId,
        accountAddress: account.accountAddress,
      });
      const descriptor = await vault.provisionStrk20ViewingAuthority(session, {
        walletId,
        password,
        networkId: account.networkId,
        poolAddress: "0x9876",
        accountAddress: account.accountAddress,
      });
      const recovery = await vault.exportRecovery(session, walletId, testRecoveryKey, "strk20-secret-boundary");
      const payload = await openRecoveryPackage(recovery, testRecoveryKey, walletId);
      const viewing = payload.authorities.find(isStrk20ViewingVaultAuthority);
      if (viewing === undefined) throw new Error("test setup failed");
      const canary = base64Url(viewing.privateKey);
      try {
        expect(JSON.stringify(store.unsafeRecords)).not.toContain(canary);
        expect(JSON.stringify(descriptor)).not.toContain(canary);
        expect(Object.keys(descriptor).sort()).toEqual([
          "accountAddress",
          "descriptorVersion",
          "namespace",
          "networkId",
          "poolAddress",
          "registrationState",
        ]);
        expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
        expect(JSON.stringify(error.mock.calls)).not.toContain(canary);
      } finally {
        payload.rootSecret.fill(0);
        wipeVaultAuthorities(payload.authorities);
      }

      vault.lock();
      const persisted = store.unsafeRecords.get(walletId);
      if (persisted === undefined || typeof persisted !== "object" || persisted === null) throw new Error("test setup failed");
      const tampered = JSON.parse(JSON.stringify(persisted)) as { authorityRecords: Array<{ namespace: string }> };
      tampered.authorityRecords = tampered.authorityRecords.filter((record) => record.namespace !== "strk20/viewing");
      store.unsafeRecords.set(walletId, tampered);
      await expect(vault.unlock({ walletId, password })).rejects.toThrow();
    } finally {
      testRecoveryKey.fill(0);
      log.mockRestore();
      error.mockRestore();
    }
  }, CRYPTO_LIFECYCLE_TEST_TIMEOUT_MS);
});
