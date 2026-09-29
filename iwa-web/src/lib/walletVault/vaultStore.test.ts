import { describe, expect, it } from "vitest";

import { createRootWrap, forTestOnlyPasswordKdfPolicy, type VaultBinding } from "./vaultCrypto";
import { InMemoryVaultStore } from "./vaultStore";

const binding = (walletId: string): VaultBinding => ({ walletId, recordType: "root-wrap", namespace: "root", version: 1 });
const rootSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const passkeyPrf = Uint8Array.from({ length: 32 }, (_, index) => index + 33);

async function record(walletId: string) {
  return createRootWrap({
    binding: binding(walletId),
    password: "Iwa synthetic local vault password",
    passkeyPrf,
    rootSecret,
    passwordKdf: forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 9)),
    passkey: { credentialId: "test-wallet-passkey", rpId: "wallet.example.test", prfInput: Uint8Array.from({ length: 32 }, (_, index) => 255 - index) },
  });
}

describe("wallet vault persistence", () => {
  it("stores only a validated encrypted record and returns a detached copy", async () => {
    const store = new InMemoryVaultStore();
    const encrypted = await record("wallet-persisted");

    await store.create(encrypted);
    const loaded = await store.load("wallet-persisted");

    expect(loaded).toEqual(encrypted);
    expect(loaded).not.toBe(encrypted);
    if (loaded === null) throw new Error("test setup failed");
    loaded.walletId = "wallet-mutated";
    expect((await store.load("wallet-persisted"))?.walletId).toBe("wallet-persisted");
  });

  it("rejects cross-wallet record substitution even when storage is corrupted", async () => {
    const store = new InMemoryVaultStore();
    const walletA = await record("wallet-a");

    (store as unknown as { unsafeRecords: Map<string, unknown> }).unsafeRecords.set("wallet-b", walletA);

    await expect(store.load("wallet-b")).rejects.toThrow("Iwa Wallet could not open its local vault.");
  });

  it("deletes the complete encrypted local record", async () => {
    const store = new InMemoryVaultStore();
    await store.create(await record("wallet-delete"));

    await store.remove("wallet-delete");

    await expect(store.load("wallet-delete")).resolves.toBeNull();
  });

  it("compare-and-deletes only the import record it originally inserted", async () => {
    const store = new InMemoryVaultStore();
    const stale = await record("wallet-cas");
    await store.create(stale);
    await store.remove("wallet-cas");
    const replacement = await record("wallet-cas");
    await store.create(replacement);

    await expect(store.removeIfUnchanged(stale)).resolves.toBe(false);
    await expect(store.load("wallet-cas")).resolves.toEqual(replacement);
  });

  it("atomically replaces only the root record that was read", async () => {
    const store = new InMemoryVaultStore();
    const original = await record("wallet-replace");
    const replacement = await record("wallet-replace");
    await store.create(original);

    await expect(store.replaceIfUnchanged(original, replacement)).resolves.toBe(true);
    await expect(store.load("wallet-replace")).resolves.toEqual(replacement);
    await expect(store.replaceIfUnchanged(original, original)).resolves.toBe(false);
    await expect(store.load("wallet-replace")).resolves.toEqual(replacement);
  });
});
