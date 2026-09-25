import { describe, expect, it } from "vitest";

import {
  VaultError,
  createRecoveryPackage,
  openRecoveryPackage,
  validateRecoveryPackage,
  type SyntheticVaultAuthority,
} from "./recoveryPackage";

const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 2) % 256);
const wrongRecoveryKey = Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 9) % 256);
const rootSecret = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 1) % 256);
const authorities: SyntheticVaultAuthority[] = [
  {
    id: "synthetic-starknet-authority",
    material: Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 4) % 256),
  },
];

describe("portable encrypted recovery package", () => {
  it("round-trips identical synthetic authority material without serializing it in the envelope", async () => {
    const recovery = await createRecoveryPackage({
      walletId: "wallet-recovery-a",
      packageId: "recovery-package-a",
      generation: 1,
      recoveryKey,
      rootSecret,
      authorities,
      publicDescriptors: [{ namespace: "synthetic/test", publicId: "public-test-authority" }],
    });

    const restored = await openRecoveryPackage(recovery, recoveryKey, "wallet-recovery-a");

    expect(restored.rootSecret).toEqual(rootSecret);
    expect(restored.authorities).toEqual(authorities);
    expect(restored.publicDescriptors).toEqual([{ namespace: "synthetic/test", publicId: "public-test-authority" }]);
    expect(JSON.stringify(recovery)).not.toContain(Array.from(rootSecret).join(","));
    expect(JSON.stringify(recovery)).not.toContain(Array.from(authorities[0]!.material).join(","));
  });

  it("rejects a wrong recovery key, wrong wallet, tampered header, corrupted ciphertext, and malformed envelope", async () => {
    const recovery = await createRecoveryPackage({
      walletId: "wallet-recovery-a",
      packageId: "recovery-package-a",
      generation: 1,
      recoveryKey,
      rootSecret,
      authorities,
      publicDescriptors: [],
    });

    await expect(openRecoveryPackage(recovery, wrongRecoveryKey, "wallet-recovery-a")).rejects.toBeInstanceOf(VaultError);
    await expect(openRecoveryPackage(recovery, recoveryKey, "wallet-recovery-b")).rejects.toBeInstanceOf(VaultError);
    await expect(openRecoveryPackage({ ...recovery, generation: 2 }, recoveryKey, "wallet-recovery-a")).rejects.toBeInstanceOf(VaultError);
    await expect(
      openRecoveryPackage({ ...recovery, cipher: { ...recovery.cipher, ciphertext: recovery.cipher.ciphertext.slice(1) } }, recoveryKey, "wallet-recovery-a"),
    ).rejects.toBeInstanceOf(VaultError);
    expect(() => validateRecoveryPackage({ format: "iwa-wallet-recovery", version: 1 })).toThrow(VaultError);
  });
});
