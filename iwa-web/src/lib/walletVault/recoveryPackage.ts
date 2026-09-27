import { VaultError } from "./vaultCrypto";

export { VaultError } from "./vaultCrypto";

const RECOVERY_FORMAT = "iwa-wallet-recovery";
const RECOVERY_PAYLOAD_FORMAT = "iwa-wallet-recovery-payload";
const RECOVERY_VERSION = 1;
const SECRET_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_RECOVERY_CIPHERTEXT_BYTES = 256 * 1024;

export interface SyntheticVaultAuthority {
  id: string;
  material: Uint8Array;
}

export interface RecoveryPublicDescriptor {
  namespace: string;
  publicId: string;
}

export interface RecoveryPackageV1 {
  format: typeof RECOVERY_FORMAT;
  version: typeof RECOVERY_VERSION;
  walletId: string;
  packageId: string;
  generation: number;
  createdAt: string;
  cipher: {
    algorithm: "AES-256-GCM";
    iv: string;
    ciphertext: string;
  };
}

export interface CreateRecoveryPackageInput {
  walletId: string;
  packageId: string;
  generation: number;
  recoveryKey: Uint8Array;
  rootSecret: Uint8Array;
  authorities: readonly SyntheticVaultAuthority[];
  publicDescriptors: readonly RecoveryPublicDescriptor[];
}

export interface RecoveredVaultPayload {
  walletId: string;
  packageId: string;
  generation: number;
  rootSecret: Uint8Array;
  authorities: SyntheticVaultAuthority[];
  publicDescriptors: RecoveryPublicDescriptor[];
}

interface RecoveryPayloadV1 {
  format: typeof RECOVERY_PAYLOAD_FORMAT;
  version: typeof RECOVERY_VERSION;
  walletId: string;
  packageId: string;
  generation: number;
  rootSecret: string;
  authorities: Array<{ id: string; material: string }>;
  publicDescriptors: RecoveryPublicDescriptor[];
}

function fail(code: VaultError["code"] = "invalid_record"): never {
  throw new VaultError(code);
}

function cryptoApi(): Crypto {
  if (typeof globalThis.crypto === "undefined" || globalThis.crypto.subtle === undefined) fail("unavailable");
  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  cryptoApi().getRandomValues(value);
  return value;
}

function wipe(value: Uint8Array | undefined): void {
  value?.fill(0);
}

function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: unknown, length?: number, maximumLength?: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  if (length !== undefined && value.length !== base64UrlEncodedLength(length)) fail();
  if (maximumLength !== undefined && value.length > base64UrlEncodedLength(maximumLength)) fail();
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (length !== undefined && bytes.length !== length) fail();
    return bytes;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  }
}

function base64UrlEncodedLength(bytes: number): number {
  const fullGroups = Math.floor(bytes / 3);
  const remainder = bytes % 3;
  return fullGroups * 4 + (remainder === 0 ? 0 : remainder + 1);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) fail();
}

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("|")) fail("invalid_input");
}

function assertGeneration(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail("invalid_input");
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 || /[|\r\n]/.test(value) || Number.isNaN(Date.parse(value))) fail("invalid_input");
}

function recoveryAad(walletId: string, packageId: string, generation: number, createdAt: string): Uint8Array {
  assertIdentifier(walletId);
  assertIdentifier(packageId);
  assertGeneration(generation);
  assertTimestamp(createdAt);
  return new TextEncoder().encode(`IWA-WALLET-RECOVERY-AAD-V1|${walletId}|${packageId}|${generation}|${RECOVERY_VERSION}|${createdAt}`);
}

function assertSecret(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== SECRET_BYTES) fail("invalid_input");
}

function validateDescriptor(value: unknown): RecoveryPublicDescriptor {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, ["namespace", "publicId"]);
  assertIdentifier(value.namespace);
  assertIdentifier(value.publicId);
  return { namespace: value.namespace, publicId: value.publicId };
}

function validatePayload(value: unknown, header: RecoveryPackageV1): RecoveredVaultPayload {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, ["format", "version", "walletId", "packageId", "generation", "rootSecret", "authorities", "publicDescriptors"]);
  if (
    value.format !== RECOVERY_PAYLOAD_FORMAT ||
    value.version !== RECOVERY_VERSION ||
    value.walletId !== header.walletId ||
    value.packageId !== header.packageId ||
    value.generation !== header.generation ||
    !Array.isArray(value.authorities) ||
    !Array.isArray(value.publicDescriptors)
  ) {
    fail();
  }
  let rootSecret: Uint8Array | undefined;
  const authorities: SyntheticVaultAuthority[] = [];
  try {
    rootSecret = base64UrlDecode(value.rootSecret, SECRET_BYTES);
    for (const authority of value.authorities) {
      if (!isPlainObject(authority)) fail();
      assertExactKeys(authority, ["id", "material"]);
      assertIdentifier(authority.id);
      authorities.push({ id: authority.id, material: base64UrlDecode(authority.material, SECRET_BYTES) });
    }
    const uniqueAuthorityIds = new Set(authorities.map((authority) => authority.id));
    if (uniqueAuthorityIds.size !== authorities.length) fail();
    const publicDescriptors = value.publicDescriptors.map(validateDescriptor);
    const recoveredRoot = rootSecret;
    rootSecret = undefined;
    return {
      walletId: header.walletId,
      packageId: header.packageId,
      generation: header.generation,
      rootSecret: recoveredRoot,
      authorities: [...authorities],
      publicDescriptors,
    };
  } finally {
    wipe(rootSecret);
    if (rootSecret !== undefined) for (const authority of authorities) wipe(authority.material);
  }
}

export function validateRecoveryPackage(value: unknown): RecoveryPackageV1 {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, ["format", "version", "walletId", "packageId", "generation", "createdAt", "cipher"]);
  if (
    value.format !== RECOVERY_FORMAT ||
    value.version !== RECOVERY_VERSION ||
    typeof value.createdAt !== "string" ||
    !isPlainObject(value.cipher)
  ) {
    fail();
  }
  const cipher = value.cipher;
  assertIdentifier(value.walletId);
  assertIdentifier(value.packageId);
  assertGeneration(value.generation);
  assertTimestamp(value.createdAt);
  assertExactKeys(value.cipher, ["algorithm", "iv", "ciphertext"]);
  if (value.cipher.algorithm !== "AES-256-GCM" || typeof value.cipher.iv !== "string" || typeof value.cipher.ciphertext !== "string") fail();
  const iv = base64UrlDecode(value.cipher.iv, GCM_IV_BYTES);
  const ciphertextText = value.cipher.ciphertext;
  if (ciphertextText.length > base64UrlEncodedLength(MAX_RECOVERY_CIPHERTEXT_BYTES)) fail();
  const ciphertext = base64UrlDecode(ciphertextText, undefined, MAX_RECOVERY_CIPHERTEXT_BYTES);
  if (ciphertext.length <= GCM_TAG_BYTES || ciphertext.length > MAX_RECOVERY_CIPHERTEXT_BYTES) fail();
  wipe(iv);
  wipe(ciphertext);
  return {
    format: RECOVERY_FORMAT,
    version: RECOVERY_VERSION,
    walletId: value.walletId,
    packageId: value.packageId,
    generation: value.generation,
    createdAt: value.createdAt,
    cipher: { algorithm: "AES-256-GCM", iv: cipher.iv as string, ciphertext: cipher.ciphertext as string },
  };
}

async function recoveryCipherKey(recoveryKey: Uint8Array): Promise<CryptoKey> {
  assertSecret(recoveryKey);
  try {
    return await cryptoApi().subtle.importKey("raw", cryptoBytes(recoveryKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch {
    throw new VaultError("unavailable");
  }
}

function payloadFrom(input: CreateRecoveryPackageInput): RecoveryPayloadV1 {
  assertIdentifier(input.walletId);
  assertIdentifier(input.packageId);
  assertGeneration(input.generation);
  assertSecret(input.rootSecret);
  assertSecret(input.recoveryKey);
  const authorities = input.authorities.map((authority) => {
    assertIdentifier(authority.id);
    assertSecret(authority.material);
    return { id: authority.id, material: base64UrlEncode(authority.material) };
  });
  if (new Set(authorities.map((authority) => authority.id)).size !== authorities.length) fail("invalid_input");
  return {
    format: RECOVERY_PAYLOAD_FORMAT,
    version: RECOVERY_VERSION,
    walletId: input.walletId,
    packageId: input.packageId,
    generation: input.generation,
    rootSecret: base64UrlEncode(input.rootSecret),
    authorities,
    publicDescriptors: input.publicDescriptors.map(validateDescriptor),
  };
}

export async function createRecoveryPackage(input: CreateRecoveryPackageInput): Promise<RecoveryPackageV1> {
  const payload = payloadFrom(input);
  const iv = randomBytes(GCM_IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const createdAt = new Date().toISOString();
  try {
    const key = await recoveryCipherKey(input.recoveryKey);
    const ciphertext = await cryptoApi().subtle.encrypt(
      { name: "AES-GCM", iv: cryptoBytes(iv), additionalData: cryptoBytes(recoveryAad(input.walletId, input.packageId, input.generation, createdAt)), tagLength: 128 },
      key,
      cryptoBytes(plaintext),
    );
    return validateRecoveryPackage({
      format: RECOVERY_FORMAT,
      version: RECOVERY_VERSION,
      walletId: input.walletId,
      packageId: input.packageId,
      generation: input.generation,
      createdAt,
      cipher: { algorithm: "AES-256-GCM", iv: base64UrlEncode(iv), ciphertext: base64UrlEncode(new Uint8Array(ciphertext)) },
    });
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("unavailable");
  } finally {
    wipe(iv);
    wipe(plaintext);
  }
}

export async function openRecoveryPackage(
  value: unknown,
  recoveryKey: Uint8Array,
  expectedWalletId: string,
): Promise<RecoveredVaultPayload> {
  assertIdentifier(expectedWalletId);
  assertSecret(recoveryKey);
  const recovery = validateRecoveryPackage(value);
  if (recovery.walletId !== expectedWalletId) fail("authentication_failed");
  const iv = base64UrlDecode(recovery.cipher.iv, GCM_IV_BYTES);
  const ciphertext = base64UrlDecode(recovery.cipher.ciphertext);
  try {
    const key = await recoveryCipherKey(recoveryKey);
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: cryptoBytes(iv), additionalData: cryptoBytes(recoveryAad(recovery.walletId, recovery.packageId, recovery.generation, recovery.createdAt)), tagLength: 128 },
      key,
      cryptoBytes(ciphertext),
    );
    try {
      return validatePayload(JSON.parse(new TextDecoder().decode(plaintext)), recovery);
    } finally {
      new Uint8Array(plaintext).fill(0);
    }
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("authentication_failed");
  } finally {
    wipe(iv);
    wipe(ciphertext);
  }
}
