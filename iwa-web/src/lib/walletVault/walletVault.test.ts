import { describe, expect, it } from "vitest";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const passkey: WalletPasskeyMetadata = {
  credentialId: "test-wallet-passkey",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
};
const passkeyPrf = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 2) % 256);
const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => (index * 3 + 8) % 256);

function vault(store = new InMemoryVaultStore()) {
  return new WalletVault({
    store,
    passkey: { assertPrf: async () => new Uint8Array(passkeyPrf) },
    passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    timeout: { set: () => 1, clear: () => undefined },
  });
}

async function create(vaultInstance: WalletVault, walletId = "wallet-vault-a") {
  await vaultInstance.create({
    walletId,
    password: "Iwa synthetic local vault password",
    passkey,
    authorities: [{ id: "synthetic-starknet", material: Uint8Array.from({ length: 32 }, (_, index) => index + 100) }],
  });
}

describe("cold and warm Iwa Wallet vault lifecycle", () => {
  it("starts cold after creation or browser restart and requires password plus dedicated passkey to unlock", async () => {
    const store = new InMemoryVaultStore();
    const first = vault(store);
    await create(first);
    expect(first.state()).toBe("cold");

    await expect(first.unlock({ walletId: "wallet-vault-a", password: "wrong synthetic vault password" })).rejects.toThrow();
    const warm = await first.unlock({ walletId: "wallet-vault-a", password: "Iwa synthetic local vault password" });
    expect(first.state()).toBe("warm");
    expect(warm.syntheticAuthorities()).toEqual([{ id: "synthetic-starknet", material: Uint8Array.from({ length: 32 }, (_, index) => index + 100) }]);

    const restarted = vault(store);
    expect(restarted.state()).toBe("cold");
    await expect(restarted.exportRecovery("wallet-vault-a", recoveryKey, "recovery-a", 1)).rejects.toThrow();
  });

  it("keeps the PIN convenience-only and locks after exhausted warm-session attempts", async () => {
    const instance = vault();
    await create(instance);
    await expect(instance.confirmPin("123456")).rejects.toThrow();
    await expect(instance.unlockWithPin("wallet-vault-a", "123456")).rejects.toThrow();

    await instance.unlock({ walletId: "wallet-vault-a", password: "Iwa synthetic local vault password" });
    await instance.setPin("123456");
    await expect(instance.confirmPin("654321")).rejects.toThrow();
    await expect(instance.confirmPin("654321")).rejects.toThrow();
    await expect(instance.confirmPin("654321")).rejects.toThrow();
    await expect(instance.confirmPin("654321")).rejects.toThrow();
    await expect(instance.confirmPin("654321")).rejects.toThrow();
    expect(instance.state()).toBe("cold");
  });

  it("automatically locks stale warm state and clears its usable authority boundary", async () => {
    const callbacks: Array<() => void> = [];
    const instance = new WalletVault({
      store: new InMemoryVaultStore(),
      passkey: { assertPrf: async () => new Uint8Array(passkeyPrf) },
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
      timeout: { set: (next) => { callbacks.push(next); return 1; }, clear: () => undefined },
    });
    await create(instance);
    const warm = await instance.unlock({ walletId: "wallet-vault-a", password: "Iwa synthetic local vault password" });

    const callback = callbacks.at(-1);
    if (callback === undefined) throw new Error("test setup failed");
    callback();

    expect(instance.state()).toBe("cold");
    expect(() => warm.syntheticAuthorities()).toThrow();
  });

  it("exports, destroys, imports, and restores identical synthetic authority material with fresh passkey and password wrapping", async () => {
    const store = new InMemoryVaultStore();
    const first = vault(store);
    await create(first);
    await first.unlock({ walletId: "wallet-vault-a", password: "Iwa synthetic local vault password" });

    const recovery = await first.exportRecovery("wallet-vault-a", recoveryKey, "recovery-a", 1);
    await first.destroy("wallet-vault-a");
    expect(first.state()).toBe("cold");

    await first.importRecovery({
      recovery,
      recoveryKey,
      password: "New synthetic local vault password",
      passkey,
    });
    const restored = await first.unlock({ walletId: "wallet-vault-a", password: "New synthetic local vault password" });
    expect(restored.syntheticAuthorities()).toEqual([{ id: "synthetic-starknet", material: Uint8Array.from({ length: 32 }, (_, index) => index + 100) }]);
    await expect(first.importRecovery({ recovery, recoveryKey, password: "Another synthetic password", passkey })).rejects.toThrow();
  });
});
