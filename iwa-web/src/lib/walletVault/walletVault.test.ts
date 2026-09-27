import { describe, expect, it } from "vitest";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault, type WalletVaultSession } from "./walletVault";
import { openRecoveryPackage } from "./recoveryPackage";

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
    expect(warm).toEqual({ walletId: "wallet-vault-a" });

    const restarted = vault(store);
    expect(restarted.state()).toBe("cold");
    await expect(restarted.exportRecovery({ walletId: "wallet-vault-a" } as WalletVaultSession, "wallet-vault-a", recoveryKey, "recovery-a")).rejects.toThrow();
  });

  it("keeps the PIN convenience-only and locks after exhausted warm-session attempts", async () => {
    const instance = vault();
    await create(instance);
    await expect(instance.confirmPin({ walletId: "wallet-vault-a" } as WalletVaultSession, "123456")).rejects.toThrow();
    await expect(instance.unlockWithPin("wallet-vault-a", "123456")).rejects.toThrow();

    const warm = await instance.unlock({ walletId: "wallet-vault-a", password: "Iwa synthetic local vault password" });
    await instance.setPin(warm, "123456");
    await expect(instance.confirmPin(warm, "654321")).rejects.toThrow();
    await expect(instance.confirmPin(warm, "654321")).rejects.toThrow();
    await expect(instance.confirmPin(warm, "654321")).rejects.toThrow();
    await expect(instance.confirmPin(warm, "654321")).rejects.toThrow();
    await expect(instance.confirmPin(warm, "654321")).rejects.toThrow();
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
    await expect(instance.exportRecovery(warm, "wallet-vault-a", recoveryKey, "recovery-a")).rejects.toThrow();
  });

  it("exports, destroys, imports, and restores identical synthetic authority material with fresh passkey and password wrapping", async () => {
    const store = new InMemoryVaultStore();
    const first = vault(store);
    await create(first);
    const warm = await first.unlock({ walletId: "wallet-vault-a", password: "Iwa synthetic local vault password" });

    const recovery = await first.exportRecovery(warm, "wallet-vault-a", recoveryKey, "recovery-a");
    await first.destroy("wallet-vault-a");
    expect(first.state()).toBe("cold");

    const replacement = await first.importRecovery({
      recovery,
      recoveryKey,
      password: "New synthetic local vault password",
      passkey,
      replacementPackageId: "recovery-b",
    });
    expect(replacement.generation).toBe(2);
    const restored = await first.unlock({ walletId: "wallet-vault-a", password: "New synthetic local vault password" });
    expect(restored).toEqual({ walletId: "wallet-vault-a" });
    const recovered = await openRecoveryPackage(replacement, recoveryKey, "wallet-vault-a");
    expect(recovered.authorities).toEqual([{ id: "synthetic-starknet", material: Uint8Array.from({ length: 32 }, (_, index) => index + 100) }]);
    recovered.rootSecret.fill(0);
    recovered.authorities.forEach((authority) => authority.material.fill(0));
    await expect(first.importRecovery({ recovery, recoveryKey, password: "Another synthetic password", passkey, replacementPackageId: "recovery-c" })).rejects.toThrow();
  });

  it("makes create and recovery import compete through the same insert-only vault key", async () => {
    const store = new InMemoryVaultStore();
    const source = vault(store);
    await create(source);
    const session = await source.unlock({ walletId: "wallet-vault-a", password: "Iwa synthetic local vault password" });
    const recovery = await source.exportRecovery(session, "wallet-vault-a", recoveryKey, "recovery-race-a");
    await source.destroy("wallet-vault-a");

    const importing = vault(store).importRecovery({
      recovery,
      recoveryKey,
      password: "Recovered race password",
      passkey,
      replacementPackageId: "recovery-race-b",
    }).then(() => 1, () => 0);
    const creating = vault(store).create({
      walletId: "wallet-vault-a",
      password: "Competing create password",
      passkey,
      authorities: [{ id: "competing", material: Uint8Array.from({ length: 32 }, (_, index) => index + 9) }],
    }).then(() => 1, () => 0);
    const outcomes = await Promise.all([importing, creating]);
    expect(outcomes[0]! + outcomes[1]!).toBe(1);
  });
});
