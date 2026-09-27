import { describe, expect, it } from "vitest";

import { VaultError, createRootWrap, forTestOnlyPasswordKdfPolicy, validateRootWrap } from "./vaultCrypto";

function next(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value;
  };
}

async function envelope() {
  return createRootWrap({
    binding: { walletId: "wallet-envelope-fuzz", recordType: "root-wrap", namespace: "root", version: 1 },
    password: "Iwa vault envelope fuzz password",
    passkeyPrf: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    rootSecret: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
    passwordKdf: forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 44)),
    passkey: { credentialId: "envelope-fuzz-credential", rpId: "wallet.example.test", prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 99) },
  });
}

describe("root-envelope parser corruption properties", () => {
  it("fails closed across 160 generated format, metadata, manifest, version, and ciphertext mutations", async () => {
    const valid = await envelope();
    const random = next(0xb1a1);
    const corruptions: Array<(record: Record<string, unknown>) => void> = [
      (record) => { record.format = "other"; },
      (record) => { record.version = random() % 2 === 0 ? 0 : 99; },
      (record) => { record.walletId = "other|wallet"; },
      (record) => { record.authorityManifest = [{ namespace: "unknown" }]; },
      (record) => { record.authorityRecords = [{ namespace: "unknown" }]; },
      (record) => { record.passwordKdf = { algorithm: "PBKDF2-HMAC-SHA-256", profile: "production", iterations: random() % 2 === 0 ? 1 : Number.MAX_SAFE_INTEGER, salt: "A".repeat(43) }; },
      (record) => { record.passkey = { credentialId: "x", rpId: "wallet.example.test", prfInput: "A".repeat(43), extra: true }; },
      (record) => { record.cipher = { ...(record.cipher as Record<string, unknown>), iv: "A".repeat(random() % 2 === 0 ? 15 : 18) }; },
      (record) => { record.cipher = { ...(record.cipher as Record<string, unknown>), ciphertext: "A".repeat(random() % 2 === 0 ? 47 : 1_000_000) }; },
      (record) => { delete record.updatedAt; },
    ];
    for (let index = 0; index < 160; index += 1) {
      const corrupted = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
      corruptions[random() % corruptions.length]!(corrupted);
      let accepted = false;
      try {
        validateRootWrap(corrupted);
        accepted = true;
      } catch (error) {
        expect(error).toBeInstanceOf(VaultError);
      }
      expect(accepted).toBe(false);
    }
  });
});
