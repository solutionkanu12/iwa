import { describe, expect, it } from "vitest";

import { IwaWalletVaultLifecycle } from "./iwaWalletVaultLifecycle";
import { VaultError, forTestOnlyPasswordKdfPolicy, type WalletPasskeyMetadata } from "../lib/walletVault/vaultCrypto";
import { InMemoryVaultStore } from "../lib/walletVault/vaultStore";
import { openRecoveryPackage } from "../lib/walletVault/recoveryPackage";
import { formatRecoveryKey } from "../lib/walletVault/recoveryKey";

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

  it("exports, verifies, and restores the same wallet on a new device with a new passkey, password, and PIN", async () => {
    const original = lifecycle();
    await original.controller.provision({ walletId, password, pin });
    const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 31);

    const recovery = await original.controller.exportRecovery({
      walletId,
      recoveryKey,
      packageId: "recovery-package-one",
    });
    expect(JSON.stringify(original.store.unsafeRecords)).not.toContain(formatRecoveryKey(recoveryKey));
    expect(JSON.stringify(recovery)).not.toContain(password);
    expect(JSON.stringify(recovery)).not.toContain(pin);
    const originalAssertionsBeforeNewDeviceRecovery = original.passkey.assertions;
    await expect(original.controller.verifyRecovery({ recovery, recoveryKey, walletId, generation: 1 })).resolves.toEqual({
      walletId,
      packageId: "recovery-package-one",
      generation: 1,
      authorityCount: 0,
      publicDescriptorCount: 0,
    });

    const replacementDevice = lifecycle();
    const replacement = await replacementDevice.controller.recover({
      recovery,
      recoveryKey,
      walletId,
      expectedGeneration: 1,
      password: "Iwa replacement local vault password",
      pin: "654321",
      replacementPackageId: "recovery-package-two",
    });

    expect(replacement.generation).toBe(2);
    expect(replacementDevice.controller.view()).toEqual({ walletId, localVault: "present", state: "warm" });
    expect(replacementDevice.passkey.enrollments).toBe(1);
    expect(replacementDevice.passkey.assertions).toBeGreaterThan(0);
    expect(original.passkey.assertions).toBe(originalAssertionsBeforeNewDeviceRecovery);
    expect(JSON.stringify(replacement)).not.toContain("654321");
    await expect(
      openRecoveryPackage(replacement, recoveryKey, walletId),
    ).resolves.toMatchObject({ walletId, generation: 2, authorities: [] });
  });

  it("refuses recovery into a healthy local vault and checks expected wallet and generation before enrolling a new passkey", async () => {
    const source = lifecycle();
    await source.controller.provision({ walletId, password, pin });
    const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 63);
    const recovery = await source.controller.exportRecovery({ walletId, recoveryKey, packageId: "recovery-package-one" });

    const existing = lifecycle(source.store);
    await expect(
      existing.controller.recover({
        recovery,
        recoveryKey,
        walletId,
        expectedGeneration: 1,
        password: "Iwa replacement local vault password",
        pin: "654321",
        replacementPackageId: "recovery-package-two",
      }),
    ).rejects.toBeInstanceOf(VaultError);
    expect(existing.passkey.enrollments).toBe(0);

    const otherDevice = lifecycle();
    await expect(
      otherDevice.controller.recover({
        recovery,
        recoveryKey,
        walletId: "00000000-0000-4000-8000-000000000222",
        expectedGeneration: 1,
        password: "Iwa replacement local vault password",
        pin: "654321",
        replacementPackageId: "recovery-package-two",
      }),
    ).rejects.toBeInstanceOf(VaultError);
    expect(otherDevice.passkey.enrollments).toBe(0);

    const wrongKeyDevice = lifecycle();
    await expect(
      wrongKeyDevice.controller.recover({
        recovery,
        recoveryKey: Uint8Array.from({ length: 32 }, (_, index) => index + 4),
        walletId,
        expectedGeneration: 1,
        password: "Iwa replacement local vault password",
        pin: "654321",
        replacementPackageId: "recovery-package-three",
      }),
    ).rejects.toBeInstanceOf(VaultError);
    expect(wrongKeyDevice.passkey.enrollments).toBe(0);

    await expect(
      otherDevice.controller.recover({
        recovery,
        recoveryKey,
        walletId,
        expectedGeneration: 2,
        password: "Iwa replacement local vault password",
        pin: "654321",
        replacementPackageId: "recovery-package-two",
      }),
    ).rejects.toBeInstanceOf(VaultError);
    expect(otherDevice.passkey.enrollments).toBe(0);
  });

  it("fails closed when this browser already holds a different Iwa Wallet container", async () => {
    const source = lifecycle();
    await source.controller.provision({ walletId, password, pin });
    const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 91);
    const recovery = await source.controller.exportRecovery({ walletId, recoveryKey, packageId: "recovery-package-one" });

    const localDifferentWallet = lifecycle();
    await localDifferentWallet.controller.provision({
      walletId: "00000000-0000-4000-8000-000000000333",
      password,
      pin,
    });
    await localDifferentWallet.controller.inspect(walletId);
    expect(localDifferentWallet.controller.view()).toEqual({ walletId, localVault: "conflict", state: "cold" });

    await expect(
      localDifferentWallet.controller.recover({
        recovery,
        recoveryKey,
        walletId,
        expectedGeneration: 1,
        password: "Iwa replacement local vault password",
        pin: "654321",
        replacementPackageId: "recovery-package-two",
      }),
    ).rejects.toBeInstanceOf(VaultError);
    expect(localDifferentWallet.passkey.enrollments).toBe(1);
  });

  it("labels a malformed matching record as corrupt and permits explicit package-validated recovery only", async () => {
    const source = lifecycle();
    await source.controller.provision({ walletId, password, pin });
    const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 121);
    const recovery = await source.controller.exportRecovery({ walletId, recoveryKey, packageId: "recovery-package-one" });

    const corruptedStore = new InMemoryVaultStore();
    corruptedStore.unsafeRecords.set(walletId, { not: "a vault record" });
    const target = lifecycle(corruptedStore);
    await target.controller.inspect(walletId);
    expect(target.controller.view()).toEqual({ walletId, localVault: "corrupt", state: "cold" });

    await target.controller.recover({
      recovery,
      recoveryKey,
      walletId,
      expectedGeneration: 1,
      password: "Iwa replacement local vault password",
      pin: "654321",
      replacementPackageId: "recovery-package-two",
    });
    expect(target.controller.view()).toEqual({ walletId, localVault: "present", state: "warm" });
  });

  it("does not publish a recovered warm vault when logout locks during the new-device passkey assertion", async () => {
    const source = lifecycle();
    await source.controller.provision({ walletId, password, pin });
    const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 151);
    const recovery = await source.controller.exportRecovery({ walletId, recoveryKey, packageId: "recovery-package-one" });

    const targetStore = new InMemoryVaultStore();
    let assertionStarted: (() => void) | undefined;
    let resolveAssertion: ((value: Uint8Array) => void) | undefined;
    const assertion = new Promise<Uint8Array>((resolve) => { resolveAssertion = resolve; });
    const controller = new IwaWalletVaultLifecycle({
      openStore: async () => targetStore,
      createPasskey: () => ({
        async enroll(rpId: string): Promise<WalletPasskeyMetadata> {
          return {
            credentialId: "recovery-race-passkey",
            rpId,
            prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 9),
          };
        },
        async assertPrf(): Promise<Uint8Array> {
          assertionStarted?.();
          return assertion;
        },
      }),
      rpId: () => "wallet.example.test",
      passwordKdf: () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 10)),
      timeout: { set: () => 1, clear: () => undefined },
    });
    const started = new Promise<void>((resolve) => { assertionStarted = resolve; });
    const recovering = controller.recover({
      recovery,
      recoveryKey,
      walletId,
      expectedGeneration: 1,
      password: "Iwa replacement local vault password",
      pin: "654321",
      replacementPackageId: "recovery-package-two",
    });
    await started;
    controller.lock();
    resolveAssertion?.(Uint8Array.from({ length: 32 }, (_, index) => index + 19));

    await expect(recovering).rejects.toBeInstanceOf(VaultError);
    expect(controller.view().state).toBe("cold");
    await expect(targetStore.load(walletId)).resolves.toBeNull();
  });
});
