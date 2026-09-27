import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockStep: "passwordPin" | "walletProvisioning" | "recovery" = "passwordPin";

vi.mock("../app/IwaAuthProvider", () => ({
  useIwaAuth: () => ({
    phase: "authenticated",
    user: { id: "user-a", email: "ada@example.com", status: "active", onboardingStatus: "incomplete", onboardingStep: mockStep },
    error: null,
    refresh: async () => ({ user: { id: "user-a", email: "ada@example.com", status: "active", onboardingStatus: "incomplete", onboardingStep: mockStep } }),
    logout: async () => {},
    logoutAll: async () => {},
    registerWalletLock: () => () => {},
  }),
}));

vi.mock("../app/IwaWalletVaultProvider", () => ({
  useIwaWalletVault: () => ({
    view: { walletId: null, localVault: "unknown", state: "cold" },
    inspect: async () => ({ walletId: null, localVault: "unknown", state: "cold" }),
    provision: async () => {},
    unlock: async () => {},
    lock: () => {},
  }),
}));

import { OnboardingView } from "./OnboardingView";

describe("Iwa Wallet onboarding copy", () => {
  beforeEach(() => {
    mockStep = "passwordPin";
  });

  it("frames the passkey and local password as Iwa Wallet security without external-wallet or WebAuthn jargon", () => {
    const html = renderToStaticMarkup(<OnboardingView />);

    expect(html).toContain("Secure your Iwa Wallet");
    expect(html).toContain("This is not your Iwa login password");
    expect(html).not.toMatch(/WebAuthn|MetaMask|Argent|Braavos|seed phrase/i);
  });
});
