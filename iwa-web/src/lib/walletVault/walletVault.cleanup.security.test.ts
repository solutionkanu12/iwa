import { describe, expect, it } from "vitest";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const walletId = "wallet-cleanup-security";
const password = "Iwa cleanup security test password";
const passkey: WalletPasskeyMetadata = {
  credentialId: "cleanup-security-credential",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};
const stablePrf = Uint8Array.from({ length: 32 }, (_, index) => index + 20);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function policy() {
  return forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 90));
}

async function create(vault: WalletVault) {
  await vault.create({
    walletId,
    password,
    passkey,
    authorities: [{ id: "cleanup-authority", material: Uint8Array.from({ length: 32 }, (_, index) => 255 - index) }],
  });
}

describe("wallet-vault secret cleanup on cancellation and error", () => {
  it("wipes a passkey PRF result when a stale unlock is cancelled after the assertion", async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    const supplied = Uint8Array.from({ length: 32 }, (_, index) => index + 111);
    let calls = 0;
    const vault = new WalletVault({
      store: new InMemoryVaultStore(),
      passkey: {
        assertPrf: () => {
          if (++calls === 1) return Promise.resolve(new Uint8Array(stablePrf));
          started.resolve();
          return pending.promise;
        },
      },
      passwordKdf: policy,
      timeout: { set: () => 1, clear: () => undefined },
    });
    await create(vault);
    const unlocking = vault.unlock({ walletId, password });
    await started.promise;
    vault.lock();
    pending.resolve(supplied);
    await expect(unlocking).rejects.toThrow();
    expect([...supplied].every((byte) => byte === 0)).toBe(true);
  });

  it("wipes a fresh export-ceremony PRF result when lock wins the race", async () => {
    const pending = deferred<Uint8Array>();
    const started = deferred<void>();
    const supplied = Uint8Array.from({ length: 32 }, (_, index) => index + 121);
    let calls = 0;
    const vault = new WalletVault({
      store: new InMemoryVaultStore(),
      passkey: {
        assertPrf: () => {
          if (++calls <= 2) return Promise.resolve(new Uint8Array(stablePrf));
          started.resolve();
          return pending.promise;
        },
      },
      passwordKdf: policy,
      timeout: { set: () => 1, clear: () => undefined },
    });
    await create(vault);
    const session = await vault.unlock({ walletId, password });
    const exporting = vault.exportRecovery(session, walletId, Uint8Array.from({ length: 32 }, (_, index) => index + 44), "cleanup-package");
    await started.promise;
    vault.lock();
    pending.resolve(supplied);
    await expect(exporting).rejects.toThrow();
    expect([...supplied].every((byte) => byte === 0)).toBe(true);
  });

  it("wipes a duplicate-create PRF result even when insert-only persistence rejects", async () => {
    const store = new InMemoryVaultStore();
    const first = new WalletVault({ store, passkey: { assertPrf: async () => new Uint8Array(stablePrf) }, passwordKdf: policy, timeout: { set: () => 1, clear: () => undefined } });
    await create(first);
    const supplied = Uint8Array.from({ length: 32 }, (_, index) => index + 151);
    const duplicate = new WalletVault({ store, passkey: { assertPrf: async () => supplied }, passwordKdf: policy, timeout: { set: () => 1, clear: () => undefined } });
    await expect(create(duplicate)).rejects.toThrow();
    expect([...supplied].every((byte) => byte === 0)).toBe(true);
  });
});
