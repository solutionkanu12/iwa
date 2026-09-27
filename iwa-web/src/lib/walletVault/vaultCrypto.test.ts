import { describe, expect, it } from "vitest";

import {
  VaultError,
  createAuthorityRecord,
  createRootWrap,
  derivePasswordContribution,
  forTestOnlyPasswordKdfPolicy,
  openAuthorityRecord,
  openRootWrap,
  productionPasswordKdfPolicy,
  validateRootWrap,
  type VaultBinding,
} from "./vaultCrypto";

const password = "Iwa synthetic vault password 2026";
const otherPassword = "A different synthetic vault password";
const passkeyPrf = Uint8Array.from({ length: 32 }, (_, index) => (index * 19 + 7) % 256);
const otherPasskeyPrf = Uint8Array.from({ length: 32 }, (_, index) => (index * 23 + 11) % 256);
const rootSecret = Uint8Array.from({ length: 32 }, (_, index) => (index * 29 + 3) % 256);

const binding = (overrides: Partial<VaultBinding> = {}): VaultBinding => ({
  walletId: "wallet-test-7a0ddc1b",
  recordType: "root-wrap",
  namespace: "root",
  version: 1,
  ...overrides,
});

const testPolicy = () => forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 1));

describe("Iwa Wallet vault cryptography", () => {
  it("keeps the production password policy locked to PBKDF2-HMAC-SHA-256 at 600000 iterations", () => {
    expect(productionPasswordKdfPolicy().algorithm).toBe("PBKDF2-HMAC-SHA-256");
    expect(productionPasswordKdfPolicy().iterations).toBe(600_000);
    expect(productionPasswordKdfPolicy().salt).toHaveLength(32);
  });

  it("derives a password contribution without retaining the supplied password", async () => {
    const policy = testPolicy();

    const first = await derivePasswordContribution(password, policy);
    const second = await derivePasswordContribution(password, policy);
    const different = await derivePasswordContribution(otherPassword, policy);

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
    expect(first).toHaveLength(32);
  });

  it("round-trips a root secret only with the password and dedicated passkey PRF output", async () => {
    const record = await createRootWrap({
      binding: binding(),
      password,
      passkeyPrf,
      rootSecret,
      passwordKdf: testPolicy(),
      passkey: {
        credentialId: "test-wallet-passkey",
        rpId: "wallet.example.test",
        prfInput: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      },
    });

    await expect(openRootWrap(record, binding(), password, passkeyPrf)).resolves.toEqual(rootSecret);
    await expect(openRootWrap(record, binding(), otherPassword, passkeyPrf)).rejects.toBeInstanceOf(VaultError);
    await expect(openRootWrap(record, binding(), password, otherPasskeyPrf)).rejects.toBeInstanceOf(VaultError);
    expect(JSON.stringify(record)).not.toContain(password);
    expect(JSON.stringify(record)).not.toContain(Array.from(rootSecret).join(","));
  });

  it("authenticates wallet, record-type, namespace, and version as associated data", async () => {
    const record = await createRootWrap({
      binding: binding(),
      password,
      passkeyPrf,
      rootSecret,
      passwordKdf: testPolicy(),
      passkey: {
        credentialId: "test-wallet-passkey",
        rpId: "wallet.example.test",
        prfInput: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      },
    });

    for (const changedBinding of [
      binding({ walletId: "wallet-other" }),
      binding({ recordType: "authority" }),
      binding({ namespace: "starknet/mainnet" }),
      binding({ version: 2 }),
    ]) {
      await expect(openRootWrap(record, changedBinding, password, passkeyPrf)).rejects.toBeInstanceOf(VaultError);
    }
  });

  it("rejects tampered metadata, ciphertext, non-production KDF policy, and malformed encodings", async () => {
    const record = await createRootWrap({
      binding: binding(),
      password,
      passkeyPrf,
      rootSecret,
      passwordKdf: testPolicy(),
      passkey: {
        credentialId: "test-wallet-passkey",
        rpId: "wallet.example.test",
        prfInput: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
      },
    });

    expect(() => validateRootWrap({ ...record, version: 99 })).toThrow(VaultError);
    for (const passwordKdf of [
      { ...record.passwordKdf, iterations: 1 },
      { ...record.passwordKdf, iterations: 599_999 },
      { ...record.passwordKdf, iterations: 600_001 },
      { ...record.passwordKdf, iterations: Number.MAX_SAFE_INTEGER },
      { ...record.passwordKdf, profile: "production", algorithm: "PBKDF2-HMAC-SHA-1" },
    ]) {
      expect(() => validateRootWrap({ ...record, passwordKdf })).toThrow(VaultError);
    }
    await expect(openRootWrap({ ...record, updatedAt: new Date(Date.now() + 1_000).toISOString() }, binding(), password, passkeyPrf)).rejects.toBeInstanceOf(VaultError);
    expect(() => validateRootWrap({ ...record, cipher: { ...record.cipher, ciphertext: "!bad!" } })).toThrow(VaultError);
    await expect(
      openRootWrap({ ...record, cipher: { ...record.cipher, ciphertext: record.cipher.ciphertext.slice(1) } }, binding(), password, passkeyPrf),
    ).rejects.toBeInstanceOf(VaultError);
  });

  it("encrypts each authority under its own record-bound key and rejects chain-account substitution", async () => {
    const authority = Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 1) % 256);
    const record = await createAuthorityRecord({
      binding: binding({ recordType: "authority", namespace: "synthetic/starknet" }),
      rootSecret,
      plaintext: authority,
    });

    await expect(
      openAuthorityRecord(record, binding({ recordType: "authority", namespace: "synthetic/starknet" }), rootSecret),
    ).resolves.toEqual(authority);
    await expect(
      openAuthorityRecord(record, binding({ recordType: "authority", namespace: "synthetic/solana" }), rootSecret),
    ).rejects.toBeInstanceOf(VaultError);
    await expect(
      openAuthorityRecord(record, binding({ recordType: "authority", namespace: "synthetic/starknet" }), otherPasskeyPrf),
    ).rejects.toBeInstanceOf(VaultError);
  });
});
