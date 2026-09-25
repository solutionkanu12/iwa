const VAULT_FORMAT = "iwa-wallet-vault";
const ROOT_RECORD_TYPE = "root-wrap";
const ROOT_NAMESPACE = "root";
const VAULT_VERSION = 1;
const ROOT_SECRET_BYTES = 32;
const SALT_BYTES = 32;
const GCM_IV_BYTES = 12;
const PRODUCTION_PBKDF2_ITERATIONS = 600_000;
const TEST_PBKDF2_ITERATIONS = 8;

export class VaultError extends Error {
  constructor(readonly code: "unavailable" | "invalid_input" | "invalid_record" | "authentication_failed") {
    super("Iwa Wallet could not open its local vault.");
    this.name = "VaultError";
  }
}

export interface VaultBinding {
  walletId: string;
  recordType: string;
  namespace: string;
  version: number;
}

type KdfProfile = "production" | "test-only";

export interface PasswordKdfPolicy {
  algorithm: "PBKDF2-HMAC-SHA-256";
  profile: KdfProfile;
  iterations: number;
  salt: Uint8Array;
}

interface PersistedPasswordKdf {
  algorithm: "PBKDF2-HMAC-SHA-256";
  profile: KdfProfile;
  iterations: number;
  salt: string;
}

export interface WalletPasskeyMetadata {
  credentialId: string;
  rpId: string;
  prfInput: Uint8Array;
}

interface PersistedWalletPasskeyMetadata {
  credentialId: string;
  rpId: string;
  prfInput: string;
}

export interface RootWrapRecordV1 {
  format: typeof VAULT_FORMAT;
  version: typeof VAULT_VERSION;
  walletId: string;
  recordType: typeof ROOT_RECORD_TYPE;
  namespace: typeof ROOT_NAMESPACE;
  createdAt: string;
  updatedAt: string;
  passwordKdf: PersistedPasswordKdf;
  passkey: PersistedWalletPasskeyMetadata;
  authorityRecords: AuthorityRecordV1[];
  cipher: {
    algorithm: "AES-256-GCM";
    iv: string;
    hkdfSalt: string;
    ciphertext: string;
  };
}

export interface CreateRootWrapInput {
  binding: VaultBinding;
  password: string;
  passkeyPrf: Uint8Array;
  rootSecret: Uint8Array;
  passwordKdf?: PasswordKdfPolicy;
  passkey: WalletPasskeyMetadata;
}

export interface AuthorityRecordV1 {
  format: "iwa-wallet-vault-record";
  version: typeof VAULT_VERSION;
  walletId: string;
  recordType: "authority";
  namespace: string;
  cipher: {
    algorithm: "AES-256-GCM";
    iv: string;
    hkdfSalt: string;
    ciphertext: string;
  };
}

export interface CreateAuthorityRecordInput {
  binding: VaultBinding;
  rootSecret: Uint8Array;
  plaintext: Uint8Array;
}

function cryptoApi(): Crypto {
  if (typeof globalThis.crypto === "undefined" || globalThis.crypto.subtle === undefined) {
    throw new VaultError("unavailable");
  }
  return globalThis.crypto;
}

function testRuntime(): boolean {
  return import.meta.env.MODE === "test";
}

function fail(code: VaultError["code"] = "invalid_record"): never {
  throw new VaultError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) fail();
}

function assertSafeBindingPart(value: string): void {
  if (value.length === 0 || value.length > 256 || value.includes("|")) fail("invalid_input");
}

function assertBinding(binding: VaultBinding): void {
  if (!Number.isInteger(binding.version) || binding.version < 1) fail("invalid_input");
  assertSafeBindingPart(binding.walletId);
  assertSafeBindingPart(binding.recordType);
  assertSafeBindingPart(binding.namespace);
}

function associatedData(binding: VaultBinding): Uint8Array {
  assertBinding(binding);
  return new TextEncoder().encode(
    `IWA-WALLET-AAD-V1|${binding.walletId}|${binding.recordType}|${binding.namespace}|${binding.version}`,
  );
}

function rootBinding(binding: VaultBinding): VaultBinding {
  assertBinding(binding);
  if (binding.recordType !== ROOT_RECORD_TYPE || binding.namespace !== ROOT_NAMESPACE || binding.version !== VAULT_VERSION) {
    fail("invalid_input");
  }
  return binding;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

function wipe(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

/** Web Crypto's DOM types require an ArrayBuffer, not a SharedArrayBuffer-capable view. */
function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: unknown, expectedLength?: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (expectedLength !== undefined && bytes.length !== expectedLength) fail();
    return bytes;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  }
}

function assertPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 12 || length > 128) fail("invalid_input");
}

function assert32ByteSecret(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== ROOT_SECRET_BYTES) fail("invalid_input");
}

function isValidTestKdf(policy: PersistedPasswordKdf): boolean {
  return testRuntime() && policy.profile === "test-only" && policy.iterations === TEST_PBKDF2_ITERATIONS;
}

function validatePersistedKdf(value: unknown): PersistedPasswordKdf {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, ["algorithm", "profile", "iterations", "salt"]);
  if (value.algorithm !== "PBKDF2-HMAC-SHA-256") fail();
  if (value.profile !== "production" && value.profile !== "test-only") fail();
  if (!Number.isInteger(value.iterations) || typeof value.salt !== "string") fail();
  const policy: PersistedPasswordKdf = {
    algorithm: value.algorithm,
    profile: value.profile,
    iterations: value.iterations as number,
    salt: value.salt,
  };
  base64UrlDecode(policy.salt, SALT_BYTES);
  if (
    !(
      (policy.profile === "production" && policy.iterations === PRODUCTION_PBKDF2_ITERATIONS) ||
      isValidTestKdf(policy)
    )
  ) {
    fail();
  }
  return policy;
}

function validatePersistedPasskey(value: unknown): PersistedWalletPasskeyMetadata {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, ["credentialId", "rpId", "prfInput"]);
  if (
    typeof value.credentialId !== "string" ||
    !/^[A-Za-z0-9_-]{1,1024}$/.test(value.credentialId) ||
    typeof value.rpId !== "string" ||
    value.rpId.length === 0 ||
    value.rpId.length > 253 ||
    /\s/.test(value.rpId) ||
    typeof value.prfInput !== "string"
  ) {
    fail();
  }
  base64UrlDecode(value.prfInput, SALT_BYTES);
  return { credentialId: value.credentialId, rpId: value.rpId, prfInput: value.prfInput };
}

function validateCipher(value: unknown): RootWrapRecordV1["cipher"] {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, ["algorithm", "iv", "hkdfSalt", "ciphertext"]);
  if (
    value.algorithm !== "AES-256-GCM" ||
    typeof value.iv !== "string" ||
    typeof value.hkdfSalt !== "string" ||
    typeof value.ciphertext !== "string"
  ) {
    fail();
  }
  base64UrlDecode(value.iv, GCM_IV_BYTES);
  base64UrlDecode(value.hkdfSalt, SALT_BYTES);
  const ciphertext = base64UrlDecode(value.ciphertext);
  if (ciphertext.length <= ROOT_SECRET_BYTES) fail();
  return { algorithm: value.algorithm, iv: value.iv, hkdfSalt: value.hkdfSalt, ciphertext: value.ciphertext };
}

export function validateRootWrap(value: unknown): RootWrapRecordV1 {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, [
    "format",
    "version",
    "walletId",
    "recordType",
    "namespace",
    "createdAt",
    "updatedAt",
    "passwordKdf",
    "passkey",
    "authorityRecords",
    "cipher",
  ]);
  if (
    value.format !== VAULT_FORMAT ||
    value.version !== VAULT_VERSION ||
    typeof value.walletId !== "string" ||
    value.recordType !== ROOT_RECORD_TYPE ||
    value.namespace !== ROOT_NAMESPACE ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.authorityRecords)
  ) {
    fail();
  }
  assertBinding({ walletId: value.walletId, recordType: value.recordType, namespace: value.namespace, version: value.version });
  if (Number.isNaN(Date.parse(value.createdAt)) || Number.isNaN(Date.parse(value.updatedAt))) fail();
  const authorityRecords = value.authorityRecords.map(validateAuthorityRecord);
  if (
    authorityRecords.some((record) => record.walletId !== value.walletId) ||
    new Set(authorityRecords.map((record) => record.namespace)).size !== authorityRecords.length
  ) {
    fail();
  }
  return {
    format: value.format,
    version: value.version,
    walletId: value.walletId,
    recordType: value.recordType,
    namespace: value.namespace,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    passwordKdf: validatePersistedKdf(value.passwordKdf),
    passkey: validatePersistedPasskey(value.passkey),
    authorityRecords,
    cipher: validateCipher(value.cipher),
  };
}

export function productionPasswordKdfPolicy(): PasswordKdfPolicy {
  return {
    algorithm: "PBKDF2-HMAC-SHA-256",
    profile: "production",
    iterations: PRODUCTION_PBKDF2_ITERATIONS,
    salt: randomBytes(SALT_BYTES),
  };
}

/** Test-only policy: production calls throw before a reduced work factor can be used. */
export function forTestOnlyPasswordKdfPolicy(iterations: number, salt: Uint8Array): PasswordKdfPolicy {
  if (!testRuntime() || iterations !== TEST_PBKDF2_ITERATIONS || salt.length !== SALT_BYTES) fail("invalid_input");
  return { algorithm: "PBKDF2-HMAC-SHA-256", profile: "test-only", iterations, salt: new Uint8Array(salt) };
}

export async function derivePasswordContribution(password: string, policy: PasswordKdfPolicy): Promise<Uint8Array> {
  assertPassword(password);
  if (
    policy.algorithm !== "PBKDF2-HMAC-SHA-256" ||
    policy.salt.length !== SALT_BYTES ||
    !(
      (policy.profile === "production" && policy.iterations === PRODUCTION_PBKDF2_ITERATIONS) ||
      (testRuntime() && policy.profile === "test-only" && policy.iterations === TEST_PBKDF2_ITERATIONS)
    )
  ) {
    fail("invalid_input");
  }
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const imported = await cryptoApi().subtle.importKey("raw", cryptoBytes(passwordBytes), "PBKDF2", false, ["deriveBits"]);
    const derived = await cryptoApi().subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: cryptoBytes(policy.salt), iterations: policy.iterations },
      imported,
      ROOT_SECRET_BYTES * 8,
    );
    return new Uint8Array(derived);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("unavailable");
  } finally {
    wipe(passwordBytes);
  }
}

async function wrappingKey(
  passwordContribution: Uint8Array,
  passkeyPrf: Uint8Array,
  hkdfSalt: Uint8Array,
  binding: VaultBinding,
): Promise<CryptoKey> {
  assert32ByteSecret(passwordContribution);
  assert32ByteSecret(passkeyPrf);
  if (hkdfSalt.length !== SALT_BYTES) fail("invalid_input");
  const combined = new Uint8Array(ROOT_SECRET_BYTES * 2);
  combined.set(passwordContribution);
  combined.set(passkeyPrf, ROOT_SECRET_BYTES);
  try {
    const source = await cryptoApi().subtle.importKey("raw", cryptoBytes(combined), "HKDF", false, ["deriveKey"]);
    return await cryptoApi().subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: cryptoBytes(hkdfSalt), info: cryptoBytes(associatedData(binding)) },
      source,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("unavailable");
  } finally {
    wipe(combined);
  }
}

function sameBinding(record: RootWrapRecordV1, binding: VaultBinding): boolean {
  return (
    record.walletId === binding.walletId &&
    record.recordType === binding.recordType &&
    record.namespace === binding.namespace &&
    record.version === binding.version
  );
}

export async function createRootWrap(input: CreateRootWrapInput): Promise<RootWrapRecordV1> {
  const binding = rootBinding(input.binding);
  assert32ByteSecret(input.rootSecret);
  assert32ByteSecret(input.passkeyPrf);
  if (
    !/^[A-Za-z0-9_-]{1,1024}$/.test(input.passkey.credentialId) ||
    input.passkey.rpId.length === 0 ||
    input.passkey.rpId.length > 253 ||
    /\s/.test(input.passkey.rpId)
  ) {
    fail("invalid_input");
  }
  if (input.passkey.prfInput.length !== SALT_BYTES) fail("invalid_input");
  const policy = input.passwordKdf ?? productionPasswordKdfPolicy();
  const passwordContribution = await derivePasswordContribution(input.password, policy);
  const hkdfSalt = randomBytes(SALT_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  const now = new Date().toISOString();
  try {
    const key = await wrappingKey(passwordContribution, input.passkeyPrf, hkdfSalt, binding);
    const ciphertext = await cryptoApi().subtle.encrypt(
      { name: "AES-GCM", iv: cryptoBytes(iv), additionalData: cryptoBytes(associatedData(binding)), tagLength: 128 },
      key,
      cryptoBytes(input.rootSecret),
    );
    return validateRootWrap({
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      walletId: binding.walletId,
      recordType: ROOT_RECORD_TYPE,
      namespace: ROOT_NAMESPACE,
      createdAt: now,
      updatedAt: now,
      passwordKdf: {
        algorithm: policy.algorithm,
        profile: policy.profile,
        iterations: policy.iterations,
        salt: base64UrlEncode(policy.salt),
      },
      passkey: {
        credentialId: input.passkey.credentialId,
        rpId: input.passkey.rpId,
        prfInput: base64UrlEncode(input.passkey.prfInput),
      },
      authorityRecords: [],
      cipher: {
        algorithm: "AES-256-GCM",
        iv: base64UrlEncode(iv),
        hkdfSalt: base64UrlEncode(hkdfSalt),
        ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
      },
    });
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("unavailable");
  } finally {
    wipe(passwordContribution);
    wipe(hkdfSalt);
    wipe(iv);
  }
}

export function withAuthorityRecords(record: RootWrapRecordV1, authorityRecords: readonly AuthorityRecordV1[]): RootWrapRecordV1 {
  return validateRootWrap({ ...record, authorityRecords: [...authorityRecords], updatedAt: new Date().toISOString() });
}

export function rootPasskeyMetadata(record: RootWrapRecordV1): WalletPasskeyMetadata {
  const valid = validateRootWrap(record);
  return {
    credentialId: valid.passkey.credentialId,
    rpId: valid.passkey.rpId,
    prfInput: base64UrlDecode(valid.passkey.prfInput, SALT_BYTES),
  };
}

export async function openRootWrap(
  value: unknown,
  expectedBinding: VaultBinding,
  password: string,
  passkeyPrf: Uint8Array,
): Promise<Uint8Array> {
  const binding = rootBinding(expectedBinding);
  assert32ByteSecret(passkeyPrf);
  const record = validateRootWrap(value);
  if (!sameBinding(record, binding)) fail("authentication_failed");
  const policy: PasswordKdfPolicy = {
    algorithm: record.passwordKdf.algorithm,
    profile: record.passwordKdf.profile,
    iterations: record.passwordKdf.iterations,
    salt: base64UrlDecode(record.passwordKdf.salt, SALT_BYTES),
  };
  const passwordContribution = await derivePasswordContribution(password, policy);
  const hkdfSalt = base64UrlDecode(record.cipher.hkdfSalt, SALT_BYTES);
  const iv = base64UrlDecode(record.cipher.iv, GCM_IV_BYTES);
  const ciphertext = base64UrlDecode(record.cipher.ciphertext);
  try {
    const key = await wrappingKey(passwordContribution, passkeyPrf, hkdfSalt, binding);
    const plaintext = await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: cryptoBytes(iv), additionalData: cryptoBytes(associatedData(binding)), tagLength: 128 },
      key,
      cryptoBytes(ciphertext),
    );
    const rootSecret = new Uint8Array(plaintext);
    assert32ByteSecret(rootSecret);
    return rootSecret;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("authentication_failed");
  } finally {
    wipe(policy.salt);
    wipe(passwordContribution);
    wipe(hkdfSalt);
    wipe(iv);
    wipe(ciphertext);
  }
}

function authorityBinding(binding: VaultBinding): VaultBinding {
  assertBinding(binding);
  if (binding.recordType !== "authority" || binding.namespace === ROOT_NAMESPACE || binding.version !== VAULT_VERSION) {
    fail("invalid_input");
  }
  return binding;
}

function validateAuthorityCipher(value: unknown): AuthorityRecordV1["cipher"] {
  return validateCipher(value);
}

export function validateAuthorityRecord(value: unknown): AuthorityRecordV1 {
  if (!isPlainObject(value)) fail();
  assertExactKeys(value, ["format", "version", "walletId", "recordType", "namespace", "cipher"]);
  if (
    value.format !== "iwa-wallet-vault-record" ||
    value.version !== VAULT_VERSION ||
    typeof value.walletId !== "string" ||
    value.recordType !== "authority" ||
    typeof value.namespace !== "string"
  ) {
    fail();
  }
  authorityBinding({ walletId: value.walletId, recordType: value.recordType, namespace: value.namespace, version: value.version });
  return {
    format: value.format,
    version: value.version,
    walletId: value.walletId,
    recordType: value.recordType,
    namespace: value.namespace,
    cipher: validateAuthorityCipher(value.cipher),
  };
}

async function authorityKey(rootSecret: Uint8Array, hkdfSalt: Uint8Array, binding: VaultBinding): Promise<CryptoKey> {
  assert32ByteSecret(rootSecret);
  if (hkdfSalt.length !== SALT_BYTES) fail("invalid_input");
  try {
    const source = await cryptoApi().subtle.importKey("raw", cryptoBytes(rootSecret), "HKDF", false, ["deriveKey"]);
    return await cryptoApi().subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: cryptoBytes(hkdfSalt), info: cryptoBytes(associatedData(binding)) },
      source,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("unavailable");
  }
}

export async function createAuthorityRecord(input: CreateAuthorityRecordInput): Promise<AuthorityRecordV1> {
  const binding = authorityBinding(input.binding);
  assert32ByteSecret(input.rootSecret);
  if (!(input.plaintext instanceof Uint8Array) || input.plaintext.length === 0 || input.plaintext.length > 65_536) {
    fail("invalid_input");
  }
  const hkdfSalt = randomBytes(SALT_BYTES);
  const iv = randomBytes(GCM_IV_BYTES);
  try {
    const key = await authorityKey(input.rootSecret, hkdfSalt, binding);
    const ciphertext = await cryptoApi().subtle.encrypt(
      { name: "AES-GCM", iv: cryptoBytes(iv), additionalData: cryptoBytes(associatedData(binding)), tagLength: 128 },
      key,
      cryptoBytes(input.plaintext),
    );
    return validateAuthorityRecord({
      format: "iwa-wallet-vault-record",
      version: VAULT_VERSION,
      walletId: binding.walletId,
      recordType: "authority",
      namespace: binding.namespace,
      cipher: {
        algorithm: "AES-256-GCM",
        iv: base64UrlEncode(iv),
        hkdfSalt: base64UrlEncode(hkdfSalt),
        ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
      },
    });
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("unavailable");
  } finally {
    wipe(hkdfSalt);
    wipe(iv);
  }
}

export async function openAuthorityRecord(
  value: unknown,
  expectedBinding: VaultBinding,
  rootSecret: Uint8Array,
): Promise<Uint8Array> {
  const binding = authorityBinding(expectedBinding);
  const record = validateAuthorityRecord(value);
  if (
    record.walletId !== binding.walletId ||
    record.recordType !== binding.recordType ||
    record.namespace !== binding.namespace ||
    record.version !== binding.version
  ) {
    fail("authentication_failed");
  }
  const hkdfSalt = base64UrlDecode(record.cipher.hkdfSalt, SALT_BYTES);
  const iv = base64UrlDecode(record.cipher.iv, GCM_IV_BYTES);
  const ciphertext = base64UrlDecode(record.cipher.ciphertext);
  try {
    const key = await authorityKey(rootSecret, hkdfSalt, binding);
    return new Uint8Array(
      await cryptoApi().subtle.decrypt(
        { name: "AES-GCM", iv: cryptoBytes(iv), additionalData: cryptoBytes(associatedData(binding)), tagLength: 128 },
        key,
        cryptoBytes(ciphertext),
      ),
    );
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("authentication_failed");
  } finally {
    wipe(hkdfSalt);
    wipe(iv);
    wipe(ciphertext);
  }
}
