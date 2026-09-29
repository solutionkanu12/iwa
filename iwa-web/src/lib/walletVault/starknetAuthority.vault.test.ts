import { describe, expect, it } from "vitest";
import { ec } from "starknet";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { isSyntheticVaultAuthority, openRecoveryPackage, wipeVaultAuthorities } from "./recoveryPackage";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const walletId = "wallet-starknet-authority";
const password = "Iwa Starknet authority vault password";
const replacementPassword = "Iwa recovered Starknet authority password";
const passkey: WalletPasskeyMetadata = {
  credentialId: "wallet-starknet-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
};
const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 71);
const accountClass = {
  networkId: "SN_IWA_DEVNET",
  accountClassId: "openzeppelin-account-component-devnet",
  accountClassHash: "0x1234",
  descriptorVersion: 1 as const,
};

function newVault(store = new InMemoryVaultStore()) {
  return {
    store,
    vault: new WalletVault({
      store,
      passkey: { assertPrf: async () => Uint8Array.from({ length: 32 }, (_, index) => (index * 9 + 5) % 256) },
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
      timeout: { set: () => 1, clear: () => undefined },
    }),
  };
}

function compactSignature(signature: { r: string; s: string }) {
  return ec.starkCurve.Signature.fromCompact(
    `${signature.r.slice(2).padStart(64, "0")}${signature.s.slice(2).padStart(64, "0")}`,
  );
}

function scalarHex(privateKey: Uint8Array): string {
  return `0x${Array.from(privateKey, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("encrypted Starknet authority record", () => {
  it("adds exactly one manifest-bound local authority without serializing its private scalar", async () => {
    const { vault, store } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });

    const [first, retry] = await Promise.all([
      vault.provisionStarknetAuthority(session, { walletId, password, accountClass }),
      vault.provisionStarknetAuthority(session, { walletId, password, accountClass }),
    ]);
    const persisted = await store.load(walletId);

    expect(retry).toEqual(first);
    expect(persisted?.authorityRecords).toHaveLength(1);
    expect(persisted?.authorityRecords[0]?.namespace).toBe("starknet/account");
    expect(persisted?.authorityManifest.map((entry) => entry.namespace)).toEqual(["starknet/account"]);
    expect(JSON.stringify(persisted)).not.toContain(first.publicKey);
    expect(vault.starknetAccountDescriptor(session, walletId)).toEqual(first);
  });

  it("persists only a verified address-computed to deployed transition", async () => {
    const { vault, store } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });
    const descriptor = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });

    await expect(vault.markStarknetAccountDeployed(session, {
      walletId,
      password,
      networkId: "SN_WRONG_NETWORK",
      accountAddress: descriptor.accountAddress,
    })).rejects.toThrow();
    const deployed = await vault.markStarknetAccountDeployed(session, {
      walletId,
      password,
      networkId: descriptor.networkId,
      accountAddress: descriptor.accountAddress,
    });

    expect(deployed.deploymentState).toBe("deployed");
    expect(await vault.markStarknetAccountDeployed(session, {
      walletId,
      password,
      networkId: descriptor.networkId,
      accountAddress: descriptor.accountAddress,
    })).toEqual(deployed);
    expect((await store.load(walletId))?.authorityRecords).toHaveLength(1);
  });

  it("resumes an interrupted deployment when the exact account class is already present", async () => {
    const { vault } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });
    const descriptor = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    let deployCalled = false;
    const provider = {
      getChainId: async () => descriptor.networkId,
      getClassHashAt: async () => descriptor.accountClassHash,
      deployAccount: async () => {
        deployCalled = true;
        throw new Error("a resumed deployment must not submit a transaction");
      },
    };

    await expect(vault.deployStarknetAccount(session, {
      walletId,
      password,
      provider: provider as never,
    })).resolves.toEqual({ accountAddress: descriptor.accountAddress, transactionHash: null, resumed: true });
    expect(deployCalled).toBe(false);
    expect(vault.starknetAccountDescriptor(session, walletId)?.deploymentState).toBe("deployed");
  });

  it("signs an ownership proof only for the committed address/network and invalidates the capability on lock", async () => {
    const { vault } = newVault();
    await vault.create({ walletId, password, passkey, authorities: [] });
    const session = await vault.unlock({ walletId, password });
    const descriptor = await vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    const signature = vault.signStarknetAuthorityProof(session, {
      walletId,
      networkId: descriptor.networkId,
      accountAddress: descriptor.accountAddress,
      proofHash: "0x4567",
    });

    const recovery = await vault.exportRecovery(session, walletId, recoveryKey, "starknet-signature-proof");
    const payload = await openRecoveryPackage(recovery, recoveryKey, walletId);
    try {
      const authority = payload.authorities[0];
      if (authority === undefined || isSyntheticVaultAuthority(authority)) throw new Error("test setup failed");
      expect(ec.starkCurve.verify(compactSignature(signature), "0x4567", ec.starkCurve.getPublicKey(scalarHex(authority.privateKey)))).toBe(true);
    } finally {
      payload.rootSecret.fill(0);
      wipeVaultAuthorities(payload.authorities);
    }
    expect(() => vault.signStarknetAuthorityProof(session, { ...descriptor, walletId, proofHash: "0x4567", accountAddress: "0x1" })).toThrow();
    vault.lock();
    expect(() => vault.signStarknetAuthorityProof(session, { walletId, networkId: descriptor.networkId, accountAddress: descriptor.accountAddress, proofHash: "0x4567" })).toThrow();
  });

  it("restores the same Starknet authority, account descriptor, and signing proof from portable recovery", async () => {
    const original = newVault();
    await original.vault.create({ walletId, password, passkey, authorities: [] });
    const session = await original.vault.unlock({ walletId, password });
    const originalDescriptor = await original.vault.provisionStarknetAuthority(session, { walletId, password, accountClass });
    const recovery = await original.vault.exportRecovery(session, walletId, recoveryKey, "starknet-recovery-one");
    await original.vault.destroy(walletId);

    const recovered = newVault(original.store);
    const replacement = await recovered.vault.importRecovery({
      recovery,
      recoveryKey,
      password: replacementPassword,
      passkey,
      replacementPackageId: "starknet-recovery-two",
    });
    const recoveredSession = await recovered.vault.unlock({ walletId, password: replacementPassword });
    const recoveredDescriptor = recovered.vault.starknetAccountDescriptor(recoveredSession, walletId);
    if (recoveredDescriptor === null) throw new Error("test setup failed");
    const signature = recovered.vault.signStarknetAuthorityProof(recoveredSession, {
      walletId,
      networkId: recoveredDescriptor.networkId,
      accountAddress: recoveredDescriptor.accountAddress,
      proofHash: "0x4568",
    });
    const packagePayload = await openRecoveryPackage(replacement, recoveryKey, walletId);

    expect(replacement.generation).toBe(2);
    expect(recoveredDescriptor).toEqual(originalDescriptor);
    try {
      const authority = packagePayload.authorities[0];
      if (authority === undefined || isSyntheticVaultAuthority(authority)) throw new Error("test setup failed");
      expect(ec.starkCurve.verify(compactSignature(signature), "0x4568", ec.starkCurve.getPublicKey(scalarHex(authority.privateKey)))).toBe(true);
      expect(packagePayload.authorities).toHaveLength(1);
    } finally {
      packagePayload.rootSecret.fill(0);
      wipeVaultAuthorities(packagePayload.authorities);
    }
  });
});
