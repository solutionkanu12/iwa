import { describe, expect, it } from "vitest";

import { createAuthorityRecord, createRootWrap, forTestOnlyPasswordKdfPolicy, validateAuthorityRecord, validateRootWrap } from "./vaultCrypto";

describe("vault-envelope resource boundary", () => {
  it("rejects a root ciphertext whose length cannot represent the fixed 32-byte root secret plus GCM tag", async () => {
    const record = await createRootWrap({
      binding: { walletId: "wallet-parser-security", recordType: "root-wrap", namespace: "root", version: 1 },
      password: "Iwa parser security test password",
      passkeyPrf: Uint8Array.from({ length: 32 }, (_, index) => index + 20),
      rootSecret: Uint8Array.from({ length: 32 }, (_, index) => index + 80),
      passwordKdf: forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 40)),
      passkey: {
        credentialId: "parser-security-credential",
        rpId: "wallet.example.test",
        prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 100),
      },
    });
    for (const ciphertext of ["", "A".repeat(63), "A".repeat(65), "A".repeat(68), "A".repeat(1_000_000)]) {
      expect(() => validateRootWrap({ ...record, cipher: { ...record.cipher, ciphertext } })).toThrow();
    }
  });

  it("rejects oversized fixed fields and authority ciphertext before base64 decoding", async () => {
    const root = await createRootWrap({
      binding: { walletId: "wallet-parser-bounds", recordType: "root-wrap", namespace: "root", version: 1 },
      password: "Iwa parser bounds test password",
      passkeyPrf: Uint8Array.from({ length: 32 }, (_, index) => index + 4),
      rootSecret: Uint8Array.from({ length: 32 }, (_, index) => index + 44),
      passwordKdf: forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 74)),
      passkey: { credentialId: "parser-bounds", rpId: "wallet.example.test", prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 104) },
    });
    const authority = await createAuthorityRecord({
      binding: { walletId: "wallet-parser-bounds", recordType: "authority", namespace: "synthetic/bounds", version: 1 },
      rootSecret: Uint8Array.from({ length: 32 }, (_, index) => index + 44),
      plaintext: Uint8Array.from({ length: 32 }, (_, index) => index + 144),
    });
    const huge = "A".repeat(1_000_000);
    expect(() => validateRootWrap({ ...root, cipher: { ...root.cipher, iv: huge } })).toThrow();
    expect(() => validateRootWrap({ ...root, cipher: { ...root.cipher, hkdfSalt: huge } })).toThrow();
    expect(() => validateAuthorityRecord({ ...authority, cipher: { ...authority.cipher, ciphertext: huge } })).toThrow();
  });
});
