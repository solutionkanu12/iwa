import { describe, expect, it } from "vitest";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { formatRecoveryKey, parseRecoveryKey } from "./recoveryKey";
import { openRecoveryPackage, wipeVaultAuthorities } from "./recoveryPackage";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const walletId = "iwa-disappearance-wallet";
const originalPasskey: WalletPasskeyMetadata = {
  credentialId: "original-wallet-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};
const replacementPasskey: WalletPasskeyMetadata = {
  credentialId: "replacement-wallet-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
};

function testVault(store: InMemoryVaultStore, prf: Uint8Array) {
  return new WalletVault({
    store,
    passkey: { assertPrf: async () => new Uint8Array(prf) },
    passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 3)),
    timeout: { set: () => 1, clear: () => undefined },
  });
}

describe("portable recovery without Iwa infrastructure", () => {
  it("restores the same synthetic authority from only package plus code, then rotates the generation", async () => {
    const originalStore = new InMemoryVaultStore();
    const original = testVault(originalStore, Uint8Array.from({ length: 32 }, (_, index) => index + 41));
    const syntheticAuthority = Uint8Array.from({ length: 32 }, (_, index) => index + 101);
    const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 171);

    await original.create({
      walletId,
      password: "Iwa original disappearance password",
      passkey: originalPasskey,
      authorities: [{ id: "synthetic-portable-authority", material: syntheticAuthority }],
    });
    const session = await original.unlock({ walletId, password: "Iwa original disappearance password" });
    const packageOne = await original.exportRecovery(session, walletId, recoveryKey, "recovery-disappearance-one");
    const savedPackageText = JSON.stringify(packageOne);
    const savedCode = formatRecoveryKey(recoveryKey);

    // Simulate deletion of every original local record. No Iwa request or
    // server-side dependency participates in the remaining recovery path.
    await original.destroy(walletId);
    expect(await originalStore.load(walletId)).toBeNull();

    const restoredStore = new InMemoryVaultStore();
    const restored = testVault(restoredStore, Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
    const packageOnly = JSON.parse(savedPackageText) as unknown;
    const codeOnly = parseRecoveryKey(savedCode);
    const packageTwo = await restored.importRecovery({
      recovery: packageOnly as typeof packageOne,
      recoveryKey: codeOnly,
      password: "Iwa replacement disappearance password",
      passkey: replacementPasskey,
      replacementPackageId: "recovery-disappearance-two",
    });
    codeOnly.fill(0);

    expect(packageTwo.walletId).toBe(walletId);
    expect(packageTwo.generation).toBe(2);
    const replacementSession = await restored.unlock({ walletId, password: "Iwa replacement disappearance password" });
    expect(replacementSession).toEqual({ walletId });

    const replacementPayload = await openRecoveryPackage(packageTwo, recoveryKey, walletId);
    expect(replacementPayload.authorities).toEqual([{ id: "synthetic-portable-authority", material: syntheticAuthority }]);
    expect(replacementPayload.generation).toBe(2);
    replacementPayload.rootSecret.fill(0);
    wipeVaultAuthorities(replacementPayload.authorities);
    recoveryKey.fill(0);
    syntheticAuthority.fill(0);
  });
});
