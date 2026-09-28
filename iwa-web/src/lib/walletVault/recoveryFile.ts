import { VaultError } from "./vaultCrypto";
import { validateRecoveryPackage, type RecoveryPackageV1 } from "./recoveryPackage";

const MAX_RECOVERY_FILE_TEXT_BYTES = 384 * 1024;

function fail(): never {
  throw new VaultError("invalid_record");
}

/** Keeps a downloaded filename recognizable without disclosing the full opaque id. */
export function recoveryDownloadName(walletId: string, generation: number): string {
  if (typeof walletId !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(walletId)) fail();
  if (!Number.isSafeInteger(generation) || generation < 1) fail();
  return `iwa-wallet-recovery-${walletId.slice(0, 8)}-g${generation}.iwa`;
}

/**
 * Parses a selected recovery file before the recovery code is considered.
 * The file is an encrypted bearer artifact, never a place for a password,
 * PIN, or recovery code.
 */
export function parseRecoveryPackageJson(text: string): RecoveryPackageV1 {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_RECOVERY_FILE_TEXT_BYTES) fail();
  try {
    return validateRecoveryPackage(JSON.parse(text));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  }
}

/**
 * Starts a user-visible package download. It never places the recovery code
 * in the filename, URL, or blob. The short-lived object URL is revoked after
 * the click has been dispatched.
 */
export function downloadRecoveryPackage(recovery: RecoveryPackageV1): void {
  const valid = validateRecoveryPackage(recovery);
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function" || typeof URL.revokeObjectURL !== "function") {
    throw new VaultError("unavailable");
  }
  const blob = new Blob([JSON.stringify(valid)], { type: "application/vnd.iwa.wallet-recovery+json" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = recoveryDownloadName(valid.walletId, valid.generation);
  anchor.rel = "noopener";
  try {
    anchor.click();
  } finally {
    // A queued revocation permits the browser to start the user-initiated
    // download without retaining a reusable object URL indefinitely.
    queueMicrotask(() => URL.revokeObjectURL(objectUrl));
  }
}

export const IWA_WALLET_RECOVERY_FILE_LIMIT_BYTES = MAX_RECOVERY_FILE_TEXT_BYTES;
