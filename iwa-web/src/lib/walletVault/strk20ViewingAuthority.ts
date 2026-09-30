import { ec } from "starknet";

import { VaultError } from "./vaultCrypto";

export const STRK20_VIEWING_AUTHORITY_FORMAT = "iwa-strk20-viewing-authority";
export const STRK20_VIEWING_AUTHORITY_VERSION = 1;
export const STRK20_VIEWING_AUTHORITY_NAMESPACE = "strk20/viewing";

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
// A full-width sample is accepted only about once per 64 draws for the SDK's
// `curveOrder / 2` bound. Keep the generator uniform over that exact protocol
// range while making an honest CSPRNG exhaustion astronomically unlikely.
const MAX_RANDOM_ATTEMPTS = 4096;

export type Strk20ViewingRegistrationState = "local" | "registered";

/** Public context only. The viewing scalar is intentionally absent. */
export interface Strk20ViewingDescriptor {
  readonly namespace: typeof STRK20_VIEWING_AUTHORITY_NAMESPACE;
  readonly descriptorVersion: 1;
  readonly networkId: string;
  readonly poolAddress: string;
  readonly accountAddress: string;
  readonly registrationState: Strk20ViewingRegistrationState;
}

/**
 * A separate STRK20 decryption authority. It is never derived from the
 * Starknet spending authority or any Iwa account or vault credential.
 */
export interface Strk20ViewingVaultAuthority {
  readonly kind: "strk20Viewing";
  readonly privateKey: Uint8Array;
  readonly descriptor: Strk20ViewingDescriptor;
}

export interface Strk20ViewingAuthorityInput {
  readonly networkId: string;
  readonly poolAddress: string;
  readonly accountAddress: string;
  readonly descriptorVersion: 1;
}

function fail(code: VaultError["code"] = "invalid_input"): never {
  throw new VaultError(code);
}

function cryptoApi(): Crypto {
  if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.getRandomValues !== "function") fail("unavailable");
  return globalThis.crypto;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) fail();
}

function assertNetworkId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,64}$/.test(value)) fail();
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function scalarToHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function canonicalFelt(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) fail();
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    fail();
  }
  if (parsed <= 0n || parsed >= STARK_FIELD_PRIME) fail();
  return scalarToHex(parsed);
}

/** The compatible SDK accepts private viewing scalars in [1, curve order / 2]. */
function assertViewingScalar(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) fail();
  const scalar = bytesToBigInt(value);
  if (scalar <= 0n || scalar > ec.starkCurve.CURVE.n / 2n) fail();
}

function deriveDescriptor(input: Strk20ViewingAuthorityInput): Strk20ViewingDescriptor {
  assertNetworkId(input.networkId);
  if (input.descriptorVersion !== STRK20_VIEWING_AUTHORITY_VERSION) fail();
  return {
    namespace: STRK20_VIEWING_AUTHORITY_NAMESPACE,
    descriptorVersion: STRK20_VIEWING_AUTHORITY_VERSION,
    networkId: input.networkId,
    poolAddress: canonicalFelt(input.poolAddress),
    accountAddress: canonicalFelt(input.accountAddress),
    registrationState: "local",
  };
}

function cloneDescriptor(descriptor: Strk20ViewingDescriptor): Strk20ViewingDescriptor {
  return {
    namespace: STRK20_VIEWING_AUTHORITY_NAMESPACE,
    descriptorVersion: STRK20_VIEWING_AUTHORITY_VERSION,
    networkId: descriptor.networkId,
    poolAddress: descriptor.poolAddress,
    accountAddress: descriptor.accountAddress,
    registrationState: descriptor.registrationState,
  };
}

/**
 * Uses Web Crypto rejection sampling rather than reducing random bytes modulo
 * the bound, preserving uniformity and keeping all external identity material
 * out of the viewing authority.
 */
export function createStrk20ViewingAuthority(input: Strk20ViewingAuthorityInput): Strk20ViewingVaultAuthority {
  const descriptor = deriveDescriptor(input);
  let candidate: Uint8Array | undefined;
  try {
    for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
      candidate = cryptoApi().getRandomValues(new Uint8Array(32));
      const scalar = bytesToBigInt(candidate);
      if (scalar <= 0n || scalar > ec.starkCurve.CURVE.n / 2n) {
        candidate.fill(0);
        candidate = undefined;
        continue;
      }
      const privateKey = new Uint8Array(candidate);
      candidate.fill(0);
      candidate = undefined;
      return { kind: "strk20Viewing", privateKey, descriptor };
    }
    return fail("unavailable");
  } finally {
    candidate?.fill(0);
  }
}

export function validateStrk20ViewingAuthority(value: unknown): Strk20ViewingVaultAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  assertExactKeys(record, ["kind", "privateKey", "descriptor"]);
  if (record.kind !== "strk20Viewing" || !(record.privateKey instanceof Uint8Array) || record.descriptor === null) fail();
  assertViewingScalar(record.privateKey);
  if (typeof record.descriptor !== "object" || Array.isArray(record.descriptor)) fail();
  const descriptorRecord = record.descriptor as Record<string, unknown>;
  assertExactKeys(descriptorRecord, ["namespace", "descriptorVersion", "networkId", "poolAddress", "accountAddress", "registrationState"]);
  if (
    descriptorRecord.namespace !== STRK20_VIEWING_AUTHORITY_NAMESPACE ||
    descriptorRecord.descriptorVersion !== STRK20_VIEWING_AUTHORITY_VERSION ||
    (descriptorRecord.registrationState !== "local" && descriptorRecord.registrationState !== "registered")
  ) {
    fail();
  }
  const canonical = deriveDescriptor({
    networkId: descriptorRecord.networkId as string,
    poolAddress: descriptorRecord.poolAddress as string,
    accountAddress: descriptorRecord.accountAddress as string,
    descriptorVersion: STRK20_VIEWING_AUTHORITY_VERSION,
  });
  return {
    kind: "strk20Viewing",
    privateKey: new Uint8Array(record.privateKey),
    descriptor: {
      ...cloneDescriptor(canonical),
      registrationState: descriptorRecord.registrationState,
    },
  };
}

export function withStrk20ViewingRegistrationState(
  authority: Strk20ViewingVaultAuthority,
  registrationState: Strk20ViewingRegistrationState,
): Strk20ViewingVaultAuthority {
  if (registrationState !== "local" && registrationState !== "registered") fail();
  const valid = validateStrk20ViewingAuthority(authority);
  return {
    kind: "strk20Viewing",
    privateKey: valid.privateKey,
    descriptor: { ...valid.descriptor, registrationState },
  };
}
