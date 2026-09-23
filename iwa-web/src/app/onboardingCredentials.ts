// Wallet credentials are deliberately page-memory only until wallet
// provisioning can encrypt a locally-held wallet. This module validates user
// input but has no persistence or transport responsibility.

export const MIN_WALLET_PASSWORD_LENGTH = 12;
export const MAX_WALLET_PASSWORD_LENGTH = 128;
export const WALLET_PIN_LENGTH = 6;

export interface WalletCredentialInputs {
  password: string;
  confirmPassword: string;
  pin: string;
  confirmPin: string;
}

export interface WalletCredentialValidation {
  passwordError?: string;
  pinError?: string;
}

export function emptyWalletCredentialInputs(): WalletCredentialInputs {
  return { password: "", confirmPassword: "", pin: "", confirmPin: "" };
}

/** Keeps browser paste/keyboard input inside the PIN's narrow numeric format. */
export function pinDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, WALLET_PIN_LENGTH);
}

export function validateWalletCredentialInputs(input: WalletCredentialInputs): WalletCredentialValidation {
  const passwordLength = Array.from(input.password).length;
  const passwordError =
    passwordLength < MIN_WALLET_PASSWORD_LENGTH || passwordLength > MAX_WALLET_PASSWORD_LENGTH
      ? "Use 12 to 128 characters for your wallet password."
      : input.password !== input.confirmPassword
        ? "Your wallet passwords do not match."
        : undefined;

  const pinError =
    !new RegExp(`^\\d{${WALLET_PIN_LENGTH}}$`).test(input.pin) ||
    !new RegExp(`^\\d{${WALLET_PIN_LENGTH}}$`).test(input.confirmPin)
      ? "Enter a six-digit PIN."
      : input.pin !== input.confirmPin
        ? "Your PIN entries do not match."
        : undefined;

  return { passwordError, pinError };
}
