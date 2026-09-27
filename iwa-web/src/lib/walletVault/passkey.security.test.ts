import { describe, expect, it, vi } from "vitest";

import { BrowserWalletPasskey, type WalletPasskeyBrowser } from "./passkey";
import type { WalletPasskeyMetadata } from "./vaultCrypto";

const credentialId = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const prfInput = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const prfResult = Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + 9) % 256);

function credential(extensions: unknown): PublicKeyCredential {
  return {
    type: "public-key",
    rawId: credentialId.buffer.slice(0),
    getClientExtensionResults: () => extensions,
  } as PublicKeyCredential;
}

function browser(overrides: Partial<WalletPasskeyBrowser>): WalletPasskeyBrowser {
  return {
    credentials: {
      create: vi.fn(),
      get: vi.fn(),
    },
    randomValues: (value) => value.fill(7),
    ...overrides,
  };
}

const binding: WalletPasskeyMetadata = {
  credentialId: btoa(String.fromCharCode(...credentialId)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
  rpId: "wallet.example.test",
  prfInput,
};

describe("WebAuthn PRF conformance boundary", () => {
  it("accepts a conforming authentication PRF result without registration-only enabled", async () => {
    const instance = new BrowserWalletPasskey(
      browser({
        credentials: {
          create: vi.fn(),
          get: vi.fn().mockResolvedValue(credential({ prf: { results: { first: prfResult.buffer } } })),
        },
      }),
    );

    await expect(instance.assertPrf(binding)).resolves.toEqual(prfResult);
  });

  it("recognizes the standards-defined extension:prf capability key before enrollment", async () => {
    const instance = new BrowserWalletPasskey(
      browser({
        clientCapabilities: async () => ({ "extension:prf": true }),
        credentials: {
          create: vi.fn().mockResolvedValue(credential({ prf: { enabled: true } })),
          get: vi.fn().mockResolvedValue(credential({ prf: { results: { first: prfResult.buffer } } })),
        },
      }),
    );

    await expect(instance.enroll("wallet.example.test")).resolves.toMatchObject({ rpId: "wallet.example.test" });
  });
});
