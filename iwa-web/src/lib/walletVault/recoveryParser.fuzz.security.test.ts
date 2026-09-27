import { describe, expect, it } from "vitest";

import { VaultError, createRecoveryPackage, openRecoveryPackage, validateRecoveryPackage } from "./recoveryPackage";

function next(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value;
  };
}

async function packageForFuzz() {
  return createRecoveryPackage({
    walletId: "wallet-recovery-fuzz",
    packageId: "package-recovery-fuzz",
    generation: 1,
    recoveryKey: Uint8Array.from({ length: 32 }, (_, index) => index + 10),
    rootSecret: Uint8Array.from({ length: 32 }, (_, index) => index + 60),
    authorities: [{ id: "authority-fuzz", material: Uint8Array.from({ length: 32 }, (_, index) => 255 - index) }],
    publicDescriptors: [],
  });
}

describe("recovery-envelope parser corruption properties", () => {
  it("fails closed with a VaultError across 128 generated malformed header, metadata, and version mutations", async () => {
    const recovery = await packageForFuzz();
    const random = next(0xb10a);
    const fields = ["format", "version", "walletId", "packageId", "generation", "createdAt", "cipher"] as const;
    const invalid: Record<(typeof fields)[number], unknown[]> = {
      format: [null, 0, "", [], { unexpected: true }],
      version: [null, 0, "1", [], { unexpected: true }],
      walletId: [null, 0, "", "contains|delimiter", [], { unexpected: true }],
      packageId: [null, 0, "", "contains|delimiter", [], { unexpected: true }],
      generation: [null, 0, -1, 1.5, "1", []],
      createdAt: [null, 0, "", "not-a-date", [], { unexpected: true }],
      cipher: [null, 0, "", [], { unexpected: true }],
    };

    for (let index = 0; index < 128; index += 1) {
      const corrupt = JSON.parse(JSON.stringify(recovery)) as Record<string, unknown>;
      const field = fields[random() % fields.length]!;
      const candidates = invalid[field];
      corrupt[field] = candidates[random() % candidates.length];
      let accepted = false;
      try {
        validateRecoveryPackage(corrupt);
        accepted = true;
      } catch (error) {
        expect(error).toBeInstanceOf(VaultError);
      }
      expect(accepted).toBe(false);
    }
  });

  it("rejects deterministic ciphertext mutations before returning a recovery payload", async () => {
    const recovery = await packageForFuzz();
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 10);
    const results: number[] = [];
    for (let index = 0; index < 32; index += 1) {
      const original = recovery.cipher.ciphertext;
      const position = index % original.length;
      const replacement = original[position] === "A" ? "B" : "A";
      const corrupted = {
        ...recovery,
        cipher: { ...recovery.cipher, ciphertext: `${original.slice(0, position)}${replacement}${original.slice(position + 1)}` },
      };
      results.push(await openRecoveryPackage(corrupted, key, recovery.walletId).then(() => 1, () => 0));
    }

    expect(results.every((result) => result === 0)).toBe(true);
  });

  it("authenticates recovery header timestamps as well as wallet, package, and generation", async () => {
    const recovery = await packageForFuzz();
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 10);
    const tampered = { ...recovery, createdAt: new Date(Date.parse(recovery.createdAt) + 1_000).toISOString() };
    await expect(openRecoveryPackage(tampered, key, recovery.walletId)).rejects.toBeInstanceOf(VaultError);
  });

  it("rejects oversized recovery header fields before base64 decoding", async () => {
    const recovery = await packageForFuzz();
    const huge = "A".repeat(1_000_000);
    expect(() => validateRecoveryPackage({ ...recovery, cipher: { ...recovery.cipher, iv: huge } })).toThrow(VaultError);
    expect(() => validateRecoveryPackage({ ...recovery, cipher: { ...recovery.cipher, ciphertext: huge } })).toThrow(VaultError);
  });
});
