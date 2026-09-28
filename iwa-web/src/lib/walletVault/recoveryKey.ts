import { VaultError } from "./vaultCrypto";

const RECOVERY_KEY_BYTES = 32;
const RECOVERY_KEY_PREFIX = "iwa-recovery-v1.";
const RECOVERY_KEY_BODY_LENGTH = 43;

function fail(): never {
  throw new VaultError("invalid_input");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) fail();
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (decoded.length !== RECOVERY_KEY_BYTES) {
      decoded.fill(0);
      fail();
    }
    return decoded;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  }
}

/**
 * Creates a 256-bit, user-held recovery secret. This value is never placed in
 * a vault record, request, URL, or recovery package; only a caller explicitly
 * revealing it to the user may format it as a recovery code.
 */
export function createRecoveryKey(): Uint8Array {
  if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new VaultError("unavailable");
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
}

/** A strict, copyable representation of an independently held 256-bit key. */
export function formatRecoveryKey(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.length !== RECOVERY_KEY_BYTES) fail();
  const body = base64UrlEncode(value);
  if (body.length !== RECOVERY_KEY_BODY_LENGTH) fail();
  return `${RECOVERY_KEY_PREFIX}${body}`;
}

/**
 * Strictly parses a recovery code. It intentionally does not normalize case,
 * whitespace, grouping, or alternative alphabets, avoiding silent recovery
 * to a different key.
 */
export function parseRecoveryKey(value: string): Uint8Array {
  if (typeof value !== "string" || !value.startsWith(RECOVERY_KEY_PREFIX)) fail();
  const body = value.slice(RECOVERY_KEY_PREFIX.length);
  return base64UrlDecode(body);
}

export const IWA_WALLET_RECOVERY_KEY_FORMAT = {
  prefix: RECOVERY_KEY_PREFIX,
  bytes: RECOVERY_KEY_BYTES,
} as const;
