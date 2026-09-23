import { describe, expect, it } from "vitest";

import {
  emptyWalletCredentialInputs,
  pinDigits,
  validateWalletCredentialInputs,
} from "./onboardingCredentials";
import { onboardingTransitionRequest } from "./onboarding";

describe("wallet password and PIN setup", () => {
  it("requires matching wallet passwords between 12 and 128 characters", () => {
    expect(validateWalletCredentialInputs({ password: "short", confirmPassword: "short", pin: "123456", confirmPin: "123456" }).passwordError)
      .toBe("Use 12 to 128 characters for your wallet password.");
    expect(validateWalletCredentialInputs({ password: "a".repeat(129), confirmPassword: "a".repeat(129), pin: "123456", confirmPin: "123456" }).passwordError)
      .toBe("Use 12 to 128 characters for your wallet password.");
    expect(validateWalletCredentialInputs({ password: "one secure password", confirmPassword: "a different password", pin: "123456", confirmPin: "123456" }).passwordError)
      .toBe("Your wallet passwords do not match.");
    expect(validateWalletCredentialInputs({ password: "one secure password", confirmPassword: "one secure password", pin: "123456", confirmPin: "123456" }).passwordError)
      .toBeUndefined();
  });

  it("requires matching six-digit PIN entries", () => {
    expect(pinDigits("1a2 345678")).toBe("123456");
    expect(validateWalletCredentialInputs({ password: "one secure password", confirmPassword: "one secure password", pin: "12345", confirmPin: "12345" }).pinError)
      .toBe("Enter a six-digit PIN.");
    expect(validateWalletCredentialInputs({ password: "one secure password", confirmPassword: "one secure password", pin: "12345a", confirmPin: "12345a" }).pinError)
      .toBe("Enter a six-digit PIN.");
    expect(validateWalletCredentialInputs({ password: "one secure password", confirmPassword: "one secure password", pin: "123456", confirmPin: "654321" }).pinError)
      .toBe("Your PIN entries do not match.");
    expect(validateWalletCredentialInputs({ password: "one secure password", confirmPassword: "one secure password", pin: "123456", confirmPin: "123456" }).pinError)
      .toBeUndefined();
  });

  it("keeps credentials empty after a refresh and sends only step metadata", () => {
    expect(emptyWalletCredentialInputs()).toEqual({
      password: "",
      confirmPassword: "",
      pin: "",
      confirmPin: "",
    });
    expect(onboardingTransitionRequest("profile", "passwordPin")).toEqual({
      from: "profile",
      to: "passwordPin",
    });
  });
});
