import { describe, expect, it, vi } from "vitest";

import { createRecoveryPackage, openRecoveryPackage } from "./recoveryPackage";
import { createRootWrap, forTestOnlyPasswordKdfPolicy } from "./vaultCrypto";
import { formatRecoveryKey } from "./recoveryKey";

const canaryText = "B1S1-CANARY-NOT-LOGGED-000000000";
const canary = new TextEncoder().encode(canaryText);
const recoveryKey = Uint8Array.from({ length: 32 }, (_, index) => index + 10);
const wrongRecoveryKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

describe("wallet-vault secret canary boundary", () => {
  it("keeps a synthetic canary out of persisted envelopes, generic errors, console calls, and network requests", async () => {
    expect(canary).toHaveLength(32);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const consoleSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const root = await createRootWrap({
        binding: { walletId: "wallet-canary", recordType: "root-wrap", namespace: "root", version: 1 },
        password: "Iwa canary vault test password",
        passkeyPrf: Uint8Array.from({ length: 32 }, (_, index) => index + 30),
        rootSecret: new Uint8Array(canary),
        passwordKdf: forTestOnlyPasswordKdfPolicy(8, Uint8Array.from({ length: 32 }, (_, index) => index + 90)),
        passkey: {
          credentialId: "canary-credential",
          rpId: "wallet.example.test",
          prfInput: Uint8Array.from({ length: 32 }, (_, index) => index + 120),
        },
      });
      const recovery = await createRecoveryPackage({
        walletId: "wallet-canary",
        packageId: "recovery-canary",
        generation: 1,
        recoveryKey,
        rootSecret: new Uint8Array(canary),
        authorities: [{ id: "synthetic-canary", material: new Uint8Array(canary) }],
        publicDescriptors: [],
      });
      let errorText = "";
      try {
        await openRecoveryPackage(recovery, wrongRecoveryKey, "wallet-canary");
      } catch (error) {
        errorText = String(error);
      }
      const canaryBase64 = btoa(String.fromCharCode(...canary)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const recoveryCode = formatRecoveryKey(recoveryKey);
      const escapedCanary = JSON.stringify(canaryText);
      const persisted = JSON.stringify({ root, recovery });
      const reachedForbiddenBoundary =
        persisted.includes(canaryText) ||
        persisted.includes(canaryBase64) ||
        persisted.includes(recoveryCode) ||
        errorText.includes(canaryText) ||
        errorText.includes(canaryBase64) ||
        consoleSpies.some((spy) => JSON.stringify(spy.mock.calls).includes(canaryText)) ||
        fetchSpy.mock.calls.length !== 0;

      expect(escapedCanary.length > 0 && reachedForbiddenBoundary).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
      canary.fill(0);
    }
  });
});
