import { describe, expect, it } from "vitest";

import { VaultError, createRootWrap, forTestOnlyPasswordKdfPolicy, validateRootWrap } from "./vaultCrypto";

function next(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value;
  };
}

describe("vault-record parser corruption properties", () => {
  it("fails closed with a safe vault error for generated malformed records", async () => {
    const record = await createRootWrap({
      binding: { walletId: "wallet-fuzz", recordType: "root-wrap", namespace: "root", version: 1 },
      password: "Iwa synthetic fuzz vault password",
      passkeyPrf: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      rootSecret: Uint8Array.from({ length: 32 }, (_, index) => index + 64),
      passwordKdf: forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 90)),
      passkey: { credentialId: "test-wallet-passkey", rpId: "wallet.example.test", prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 120) },
    });
    const random = next(0x1a70);
    const values: unknown[] = [null, undefined, 0, "record", [], { unexpected: true }];
    for (let index = 0; index < 128; index += 1) {
      const corrupt = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
      const field = ["format", "version", "walletId", "recordType", "namespace", "passwordKdf", "passkey", "cipher"][random() % 8]!;
      corrupt[field] = values[random() % values.length];
      try {
        validateRootWrap(corrupt);
        throw new Error("corrupt record unexpectedly accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(VaultError);
      }
    }
  });
});
