import { describe, expect, it, vi } from "vitest";

import { forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "./vaultCrypto";
import { InMemoryVaultStore } from "./vaultStore";
import { WalletVault } from "./walletVault";

const walletId = "wallet-state-security";
const password = "Iwa state security test password";
const passkey: WalletPasskeyMetadata = {
  credentialId: "state-security-credential",
  rpId: "wallet.example.test",
  prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
};
const prf = Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 3) % 256);
const authority = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function testKdf() {
  return forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 50));
}

async function create(vault: WalletVault): Promise<void> {
  await vault.create({
    walletId,
    password,
    passkey,
    authorities: [{ id: "synthetic-authority", material: authority }],
  });
}

describe("wallet-vault hostile lifecycle and record integrity", () => {
  it("does not expose a serializable warm object or a direct root-secret accessor to callers", async () => {
    const vault = new WalletVault({
      store: new InMemoryVaultStore(),
      passkey: { assertPrf: async () => new Uint8Array(prf) },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
    });
    await create(vault);
    const warm = await vault.unlock({ walletId, password });
    const serialized = JSON.stringify(warm);
    const enumerated = Object.keys(warm);
    const spread = { ...warm };
    const vaultSerialized = JSON.stringify(vault);
    const vaultEnumerated = Object.keys(vault);
    const serializesSecretFields = serialized.includes('"rootSecret"') || serialized.includes('"authorities"');
    const exposesRootAccessor = typeof (warm as unknown as { rootForRecovery?: unknown }).rootForRecovery === "function";

    expect(serializesSecretFields || exposesRootAccessor).toBe(false);
    expect(enumerated).toEqual(["walletId"]);
    expect(spread).toEqual({ walletId });
    expect(vaultSerialized).not.toContain("rootSecret");
    expect(vaultSerialized).not.toContain("authorities");
    expect(vaultEnumerated).not.toContain("warm");
  });

  it("allows only one concurrent creation for the same wallet identifier", async () => {
    const store = new InMemoryVaultStore();
    const first = new WalletVault({
      store,
      passkey: { assertPrf: async () => new Uint8Array(prf) },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
    });
    const second = new WalletVault({
      store,
      passkey: { assertPrf: async () => new Uint8Array(prf) },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
    });
    const input = (id: string) => ({
      walletId,
      password,
      passkey,
      authorities: [{ id, material: new Uint8Array(authority) }],
    });

    const outcomes = await Promise.all([
      first.create(input("first-authority")).then(() => 1, () => 0),
      second.create(input("second-authority")).then(() => 1, () => 0),
    ]);

    expect(outcomes[0]! + outcomes[1]!).toBe(1);
  });

  it("does not publish a warm session when an explicit lock races an in-flight unlock", async () => {
    let calls = 0;
    let resolveUnlockPrf: ((value: Uint8Array) => void) | undefined;
    const store = new InMemoryVaultStore();
    const vault = new WalletVault({
      store,
      passkey: {
        assertPrf: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve(new Uint8Array(prf));
          return new Promise<Uint8Array>((resolve) => {
            resolveUnlockPrf = resolve;
          });
        },
      },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
    });
    await create(vault);

    const unlocking = vault.unlock({ walletId, password });
    await vi.waitFor(() => expect(calls).toBe(2));
    vault.lock();
    resolveUnlockPrf?.(new Uint8Array(prf));

    const outcome = await unlocking.then(() => "resolved", () => "rejected");
    expect(outcome).toBe("rejected");
    expect(vault.state()).toBe("cold");
  });

  it.each([
    "after-storage-load",
    "after-passkey-assertion",
    "after-root-kdf-and-decrypt",
    "after-authority-decrypt",
  ] as const)("invalidates an unlock when lock races %s", async (boundary) => {
    const reached = deferred<void>();
    const release = deferred<void>();
    const vault = new WalletVault({
      store: new InMemoryVaultStore(),
      passkey: { assertPrf: async () => new Uint8Array(prf) },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
      operationCheckpoint: async (current) => {
        if (current === boundary) {
          reached.resolve();
          await release.promise;
        }
      },
    });
    await create(vault);
    const unlocking = vault.unlock({ walletId, password });
    await reached.promise;
    vault.lock();
    release.resolve();
    await expect(unlocking).rejects.toThrow();
    expect(vault.state()).toBe("cold");
  });

  it("treats logout as an epoch-invalidating lock during an unlock", async () => {
    const reached = deferred<void>();
    const release = deferred<void>();
    const vault = new WalletVault({
      store: new InMemoryVaultStore(),
      passkey: { assertPrf: async () => new Uint8Array(prf) },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
      operationCheckpoint: async (boundary) => {
        if (boundary === "after-passkey-assertion") {
          reached.resolve();
          await release.promise;
        }
      },
    });
    await create(vault);
    const unlocking = vault.unlock({ walletId, password });
    await reached.promise;
    vault.lock();
    release.resolve();
    await expect(unlocking).rejects.toThrow();
    expect(vault.state()).toBe("cold");
  });

  it("allows only the latest of two overlapping unlocks to publish a session", async () => {
    const firstReached = deferred<void>();
    const firstRelease = deferred<void>();
    let passkeyCheckpoints = 0;
    const vault = new WalletVault({
      store: new InMemoryVaultStore(),
      passkey: { assertPrf: async () => new Uint8Array(prf) },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
      operationCheckpoint: async (boundary) => {
        if (boundary === "after-passkey-assertion" && ++passkeyCheckpoints === 1) {
          firstReached.resolve();
          await firstRelease.promise;
        }
      },
    });
    await create(vault);
    const first = vault.unlock({ walletId, password });
    await firstReached.promise;
    const second = vault.unlock({ walletId, password });
    firstRelease.resolve();
    await expect(first).rejects.toThrow();
    await expect(second).resolves.toMatchObject({ walletId });
    expect(vault.state()).toBe("warm");
  });

  it("rejects an IndexedDB root wrapper whose authenticated child-record set was deleted", async () => {
    const store = new InMemoryVaultStore();
    const vault = new WalletVault({
      store,
      passkey: { assertPrf: async () => new Uint8Array(prf) },
      passwordKdf: testKdf,
      timeout: { set: () => 1, clear: () => undefined },
    });
    await create(vault);
    const stored = store.unsafeRecords.get(walletId) as Record<string, unknown>;
    store.unsafeRecords.set(walletId, { ...stored, authorityRecords: [] });

    const outcome = await vault.unlock({ walletId, password }).then(() => "resolved", () => "rejected");
    expect(outcome).toBe("rejected");
  });

  it("rejects extra, substituted, or namespace-modified authority records", async () => {
    const variants: Array<(record: Record<string, unknown>) => Record<string, unknown>> = [
      (record) => ({
        ...record,
        authorityRecords: [...(record.authorityRecords as unknown[]), { ...(record.authorityRecords as Array<Record<string, unknown>>)[0], namespace: "synthetic/extra" }],
      }),
      (record) => ({
        ...record,
        authorityRecords: (record.authorityRecords as Array<Record<string, unknown>>).map((authority) => ({
          ...authority,
          cipher: { ...(authority.cipher as Record<string, unknown>), ciphertext: "A".repeat((authority.cipher as { ciphertext: string }).ciphertext.length) },
        })),
      }),
    ];
    for (const mutate of variants) {
      const store = new InMemoryVaultStore();
      const vault = new WalletVault({ store, passkey: { assertPrf: async () => new Uint8Array(prf) }, passwordKdf: testKdf, timeout: { set: () => 1, clear: () => undefined } });
      await create(vault);
      store.unsafeRecords.set(walletId, mutate(store.unsafeRecords.get(walletId) as Record<string, unknown>));
      await expect(vault.unlock({ walletId, password })).rejects.toThrow();
    }
  });

  it("accepts authority-record reordering because the authenticated manifest is a namespace-sorted set", async () => {
    const store = new InMemoryVaultStore();
    const vault = new WalletVault({ store, passkey: { assertPrf: async () => new Uint8Array(prf) }, passwordKdf: testKdf, timeout: { set: () => 1, clear: () => undefined } });
    await vault.create({
      walletId,
      password,
      passkey,
      authorities: [
        { id: "first", material: new Uint8Array(authority) },
        { id: "second", material: Uint8Array.from({ length: 32 }, (_, index) => index + 3) },
      ],
    });
    const stored = store.unsafeRecords.get(walletId) as Record<string, unknown>;
    store.unsafeRecords.set(walletId, { ...stored, authorityRecords: [...(stored.authorityRecords as unknown[])].reverse() });
    await expect(vault.unlock({ walletId, password })).resolves.toMatchObject({ walletId });
  });
});
