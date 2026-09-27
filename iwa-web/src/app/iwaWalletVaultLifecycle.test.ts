import { describe, expect, it } from "vitest";

import { IwaWalletVaultLifecycle } from "./iwaWalletVaultLifecycle";
import { VaultError, forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "../lib/walletVault/vaultCrypto";
import { InMemoryVaultStore } from "../lib/walletVault/vaultStore";

const walletId = "00000000-0000-4000-8000-000000000111";
const password = "Iwa onboarding local vault password";
const pin = "123456";

class TestWalletPasskey {
  enrollments = 0;
  assertions = 0;

  async enroll(rpId: string): Promise<WalletPasskeyMetadata> {
    this.enrollments += 1;
    return {
      credentialId: "onboarding-wallet-passkey",
      rpId,
      prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    };
  }

  async assertPrf(_binding: WalletPasskeyMetadata): Promise<Uint8Array> {
    this.assertions += 1;
    return Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 7) % 256);
  }
}

function lifecycle(store = new InMemoryVaultStore(), passkey = new TestWalletPasskey()) {
  return {
    store,
    passkey,
    controller: new IwaWalletVaultLifecycle({
      openStore: async () => store,
      createPasskey: () => passkey,
      rpId: () => "wallet.example.test",
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 10)),
      timeout: { set: () => 1, clear: () => undefined },
    }),
  };
}

describe("Iwa Wallet onboarding vault lifecycle", () => {
  it("creates one empty encrypted vault and exposes only public warm state", async () => {
    const { controller, store, passkey } = lifecycle();

    await controller.inspect(walletId);
    expect(controller.view()).toEqual({ walletId, localVault: "absent", state: "cold" });

    await controller.provision({ walletId, password, pin });

    expect(controller.view()).toEqual({ walletId, localVault: "present", state: "warm" });
    expect(JSON.stringify(controller.view())).not.toContain(password);
    expect(JSON.stringify(controller.view())).not.toContain(pin);
    expect(Object.keys(controller.view())).toEqual(["walletId", "localVault", "state"]);
    expect((await store.load(walletId))?.authorityRecords).toEqual([]);
    expect((await store.load(walletId))?.authorityManifest).toEqual([]);
    expect(passkey.enrollments).toBe(1);

    // A lost server response may retry setup. It must re-open the existing
    // container rather than create or overwrite a second one.
    await controller.provision({ walletId, password, pin });
    expect(passkey.enrollments).toBe(1);
    expect((await store.load(walletId))?.authorityRecords).toEqual([]);
  });

  it("cold-locks after lifecycle lock and requires wallet password plus passkey before publishing warm state", async () => {
    const { controller } = lifecycle();
    await controller.provision({ walletId, password, pin });

    controller.lock();
    expect(controller.view()).toEqual({ walletId, localVault: "present", state: "cold" });

    await expect(controller.unlock({ walletId, password: "wrong onboarding password" })).rejects.toBeInstanceOf(VaultError);
    expect(controller.view()).toEqual({ walletId, localVault: "present", state: "cold" });

    await controller.unlock({ walletId, password });
    expect(controller.view()).toEqual({ walletId, localVault: "present", state: "warm" });
    expect("session" in controller.view()).toBe(false);
  });

  it("treats a refresh as cold and a second device as absent without silently creating another vault", async () => {
    const original = lifecycle();
    await original.controller.provision({ walletId, password, pin });

    const restarted = lifecycle(original.store);
    await restarted.controller.inspect(walletId);
    expect(restarted.controller.view()).toEqual({ walletId, localVault: "present", state: "cold" });

    const otherDevice = lifecycle();
    await otherDevice.controller.inspect(walletId);
    expect(otherDevice.controller.view()).toEqual({ walletId, localVault: "absent", state: "cold" });
  });

  it("fails closed before local storage when dedicated wallet passkey enrollment is unavailable", async () => {
    const store = new InMemoryVaultStore();
    const controller = new IwaWalletVaultLifecycle({
      openStore: async () => store,
      createPasskey: () => ({
        async enroll(): Promise<WalletPasskeyMetadata> {
          throw new VaultError("unavailable");
        },
        async assertPrf(): Promise<Uint8Array> {
          throw new VaultError("unavailable");
        },
      }),
      rpId: () => "wallet.example.test",
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 10)),
      timeout: { set: () => 1, clear: () => undefined },
    });

    await expect(controller.provision({ walletId, password, pin })).rejects.toBeInstanceOf(VaultError);
    await expect(store.load(walletId)).resolves.toBeNull();
    expect(controller.view()).toEqual({ walletId: null, localVault: "unknown", state: "cold" });
  });

  it("leaves no container behind when the user cancels the dedicated wallet passkey ceremony", async () => {
    const store = new InMemoryVaultStore();
    const controller = new IwaWalletVaultLifecycle({
      openStore: async () => store,
      createPasskey: () => ({
        async enroll(): Promise<WalletPasskeyMetadata> {
          throw new Error("passkey ceremony cancelled");
        },
        async assertPrf(): Promise<Uint8Array> {
          throw new Error("unreachable");
        },
      }),
      rpId: () => "wallet.example.test",
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 10)),
      timeout: { set: () => 1, clear: () => undefined },
    });

    await expect(controller.provision({ walletId, password, pin })).rejects.toThrow("passkey ceremony cancelled");
    await expect(store.load(walletId)).resolves.toBeNull();
    expect(controller.view()).toEqual({ walletId: null, localVault: "unknown", state: "cold" });
  });

  it("does not publish a warm vault when a logout-style lock races passkey enrollment", async () => {
    const store = new InMemoryVaultStore();
    let resolveEnrollment: ((metadata: WalletPasskeyMetadata) => void) | undefined;
    const enrolled = new Promise<WalletPasskeyMetadata>((resolve) => { resolveEnrollment = resolve; });
    const controller = new IwaWalletVaultLifecycle({
      openStore: async () => store,
      createPasskey: () => ({
        enroll: async () => enrolled,
        assertPrf: async () => Uint8Array.from({ length: 32 }, (_, index) => index + 5),
      }),
      rpId: () => "wallet.example.test",
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 10)),
      timeout: { set: () => 1, clear: () => undefined },
    });

    const provisioning = controller.provision({ walletId, password, pin });
    await Promise.resolve();
    controller.lock();
    resolveEnrollment?.({
      credentialId: "onboarding-wallet-passkey",
      rpId: "wallet.example.test",
      prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    });

    await expect(provisioning).rejects.toBeInstanceOf(VaultError);
    expect(controller.view().state).toBe("cold");
    await expect(store.load(walletId)).resolves.toBeNull();
  });
});
