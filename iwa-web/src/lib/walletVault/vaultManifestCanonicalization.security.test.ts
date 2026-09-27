import { describe, expect, it } from "vitest";

import {
  createAuthorityRecord,
  createRootWrap,
  forTestOnlyPasswordKdfPolicy,
  openRootWrap,
} from "./vaultCrypto";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const binding = { walletId: "wallet-manifest-canonicalization", recordType: "root-wrap", namespace: "root", version: 1 } as const;
const password = "Iwa manifest canonicalization password";
const passkeyPrf = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const rootSecret = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const passkey = {
  credentialId: "manifest-canonicalization-credential",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 40),
};
const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 200);

function testKdf() {
  return forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 120));
}

function vault(store: InMemoryVaultStore): WalletVault {
  return new WalletVault({
    store,
    passkey: { assertPrf: async () => new Uint8Array(passkeyPrf) },
    passwordKdf: testKdf,
    timeout: { set: () => 1, clear: () => undefined },
  });
}

async function createSyntheticVault(instance: WalletVault): Promise<void> {
  await instance.create({
    walletId: binding.walletId,
    password,
    passkey: { ...passkey, prfInput: new Uint8Array(passkey.prfInput) },
    authorities: [
      { id: "a-z", material: Uint8Array.from({ length: 32 }, (_, index) => index + 80) },
      { id: "a_z", material: Uint8Array.from({ length: 32 }, (_, index) => index + 120) },
    ],
  });
}

async function underReversedDefaultCollation<T>(operation: () => Promise<T>): Promise<T> {
  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = function reverseDefaultCollation(other: string): number {
    return -originalLocaleCompare.call(this, other);
  };
  try {
    return await operation();
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
}

describe("authority-manifest cross-runtime canonicalization", () => {
  it("opens a valid vault when the runtime's default locale collation changes", async () => {
    const first = await createAuthorityRecord({
      binding: { walletId: binding.walletId, recordType: "authority", namespace: "synthetic/a-z", version: 1 },
      rootSecret,
      plaintext: Uint8Array.from({ length: 32 }, (_, index) => index + 80),
    });
    const second = await createAuthorityRecord({
      binding: { walletId: binding.walletId, recordType: "authority", namespace: "synthetic/a_z", version: 1 },
      rootSecret,
      plaintext: Uint8Array.from({ length: 32 }, (_, index) => index + 120),
    });
    const record = await createRootWrap({
      binding,
      password,
      passkeyPrf,
      rootSecret,
      passwordKdf: forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 160)),
      passkey,
      authorityRecords: [first, second],
    });
    const normallyOpened = await openRootWrap(record, binding, password, passkeyPrf);
    expect(normallyOpened).toEqual(rootSecret);
    normallyOpened.fill(0);

    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = function reverseDefaultCollation(other: string): number {
      return -originalLocaleCompare.call(this, other);
    };
    try {
      const opened = await openRootWrap(record, binding, password, passkeyPrf);
      try {
        expect(opened).toEqual(rootSecret);
      } finally {
        opened.fill(0);
      }
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it("unlocks a normally created vault when its default collation changes", async () => {
    const instance = vault(new InMemoryVaultStore());
    await createSyntheticVault(instance);

    await expect(underReversedDefaultCollation(() => instance.unlock({ walletId: binding.walletId, password }))).resolves.toEqual({ walletId: binding.walletId });
  });

  it("unlocks a replacement vault after recovery/import under a different default collation", async () => {
    const store = new InMemoryVaultStore();
    const source = vault(store);
    await createSyntheticVault(source);
    const session = await source.unlock({ walletId: binding.walletId, password });
    const recovery = await source.exportRecovery(session, binding.walletId, recoveryKey, "manifest-recovery-a");
    await source.destroy(binding.walletId);

    const restored = vault(store);
    await underReversedDefaultCollation(() => restored.importRecovery({
      recovery,
      recoveryKey,
      password,
      passkey: { ...passkey, prfInput: new Uint8Array(passkey.prfInput) },
      replacementPackageId: "manifest-recovery-b",
    }));

    await expect(restored.unlock({ walletId: binding.walletId, password })).resolves.toEqual({ walletId: binding.walletId });
  });

  it("serializes the same authenticated manifest from reversed input under a different default collation", async () => {
    const first = await createAuthorityRecord({
      binding: { walletId: binding.walletId, recordType: "authority", namespace: "synthetic/a-z", version: 1 },
      rootSecret,
      plaintext: Uint8Array.from({ length: 32 }, (_, index) => index + 20),
    });
    const second = await createAuthorityRecord({
      binding: { walletId: binding.walletId, recordType: "authority", namespace: "synthetic/a_z", version: 1 },
      rootSecret,
      plaintext: Uint8Array.from({ length: 32 }, (_, index) => index + 60),
    });
    const native = await createRootWrap({
      binding,
      password,
      passkeyPrf,
      rootSecret,
      passwordKdf: testKdf(),
      passkey,
      authorityRecords: [first, second],
    });
    const reversed = await underReversedDefaultCollation(() => createRootWrap({
      binding,
      password,
      passkeyPrf,
      rootSecret,
      passwordKdf: testKdf(),
      passkey,
      authorityRecords: [second, first],
    }));

    expect(reversed.authorityManifest).toEqual(native.authorityManifest);
  });
});
