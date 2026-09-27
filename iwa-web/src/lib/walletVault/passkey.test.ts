import { describe, expect, it, vi } from "vitest";

import { VaultError } from "./vaultCrypto";
import { BrowserWalletPasskey, type WalletPasskeyBrowser } from "./passkey";

const credentialId = Uint8Array.from({ length: 32 }, (_, index) => index + 20);
const prfResult = Uint8Array.from({ length: 32 }, (_, index) => (index * 31 + 5) % 256);

function credential(
  id = credentialId,
  extensions: unknown = { prf: { results: { first: prfResult.buffer } } },
): PublicKeyCredential {
  return {
    type: "public-key",
    rawId: id.buffer.slice(0),
    getClientExtensionResults: () => extensions as AuthenticationExtensionsClientOutputs,
  } as PublicKeyCredential;
}

function browser(overrides: Partial<WalletPasskeyBrowser> = {}): WalletPasskeyBrowser {
  return {
    credentials: {
      create: vi.fn().mockResolvedValue(credential(credentialId, { prf: { enabled: true } })),
      get: vi.fn().mockResolvedValue(credential()),
    },
    clientCapabilities: vi.fn().mockResolvedValue({ "extension:prf": true }),
    randomValues: (array) => crypto.getRandomValues(array),
    ...overrides,
  };
}

describe("dedicated Iwa Wallet passkey", () => {
  it("creates and immediately verifies a discoverable, user-verified PRF-capable credential", async () => {
    const api = browser();
    const passkey = new BrowserWalletPasskey(api);

    const binding = await passkey.enroll("wallet.example.test");

    expect(binding.rpId).toBe("wallet.example.test");
    expect(binding.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(binding.prfInput).toHaveLength(32);
    expect(api.credentials.create).toHaveBeenCalledOnce();
    expect(api.credentials.get).toHaveBeenCalledOnce();

    const createCall = vi.mocked(api.credentials.create).mock.calls[0];
    if (createCall === undefined) throw new Error("test setup failed");
    const createPublicKey = createCall[0]?.publicKey;
    if (createPublicKey === undefined) throw new Error("test setup failed");
    const createOptions = createPublicKey as PublicKeyCredentialCreationOptions;
    expect(createOptions.authenticatorSelection?.residentKey).toBe("required");
    expect(createOptions.authenticatorSelection?.userVerification).toBe("required");

    const assertCall = vi.mocked(api.credentials.get).mock.calls[0];
    if (assertCall === undefined) throw new Error("test setup failed");
    const assertPublicKey = assertCall[0]?.publicKey;
    if (assertPublicKey === undefined) throw new Error("test setup failed");
    const assertOptions = assertPublicKey as PublicKeyCredentialRequestOptions;
    expect(assertOptions.userVerification).toBe("required");
    expect(assertOptions.allowCredentials).toHaveLength(1);
    expect((assertOptions.extensions as { prf?: unknown }).prf).toBeDefined();
  });

  it("returns a PRF output only after a fresh assertion from the enrolled credential", async () => {
    const api = browser();
    const passkey = new BrowserWalletPasskey(api);
    const binding = await passkey.enroll("wallet.example.test");

    const output = await passkey.assertPrf(binding);

    expect(output).toEqual(prfResult);
    expect(api.credentials.get).toHaveBeenCalledTimes(2);
  });

  it("fails closed when WebAuthn PRF support, user verification, credential identity, or output length is missing", async () => {
    await expect(new BrowserWalletPasskey(browser({ clientCapabilities: vi.fn().mockResolvedValue({ "extension:prf": false }) })).enroll("wallet.example.test"))
      .rejects.toBeInstanceOf(VaultError);

    const missingPrf = browser({
      credentials: { create: vi.fn().mockResolvedValue(credential(credentialId, {})), get: vi.fn().mockResolvedValue(credential(credentialId, {})) },
    });
    await expect(new BrowserWalletPasskey(missingPrf).enroll("wallet.example.test")).rejects.toBeInstanceOf(VaultError);

    const wrongCredential = browser({
      credentials: {
        create: vi.fn().mockResolvedValue(credential(credentialId, { prf: { enabled: true } })),
        get: vi.fn().mockResolvedValue(credential(Uint8Array.from({ length: 32 }, () => 9))),
      },
    });
    await expect(new BrowserWalletPasskey(wrongCredential).enroll("wallet.example.test")).rejects.toBeInstanceOf(VaultError);

    const shortPrf = browser({
      credentials: {
        create: vi.fn().mockResolvedValue(credential(credentialId, { prf: { enabled: true } })),
        get: vi.fn().mockResolvedValue(credential(credentialId, { prf: { results: { first: new Uint8Array(31).buffer } } })),
      },
    });
    await expect(new BrowserWalletPasskey(shortPrf).enroll("wallet.example.test")).rejects.toBeInstanceOf(VaultError);
  });
});
