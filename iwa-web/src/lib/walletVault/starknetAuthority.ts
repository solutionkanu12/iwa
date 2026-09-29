import { ec, hash } from "starknet";

import { VaultError } from "./vaultCrypto";

export const STARKNET_AUTHORITY_FORMAT = "iwa-starknet-authority";
export const STARKNET_AUTHORITY_VERSION = 1;
const STARKNET_AUTHORITY_NAMESPACE = "starknet/account";
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_RANDOM_ATTEMPTS = 256;

export { STARKNET_AUTHORITY_NAMESPACE };

export type StarknetDeploymentState = "addressComputed" | "deployed";

/** Non-secret account facts encrypted alongside the signing scalar for binding and recovery. */
export interface StarknetAccountDescriptor {
  readonly namespace: typeof STARKNET_AUTHORITY_NAMESPACE;
  readonly descriptorVersion: 1;
  readonly networkId: string;
  readonly accountClassId: string;
  readonly accountClassHash: string;
  readonly publicKey: string;
  readonly accountAddress: string;
  readonly deploymentState: StarknetDeploymentState;
}

/**
 * The only B2-A chain authority. It never crosses the vault API boundary;
 * callers receive only `StarknetAccountDescriptor` or a public signature.
 */
export interface StarknetVaultAuthority {
  readonly kind: "starknet";
  readonly privateKey: Uint8Array;
  readonly descriptor: StarknetAccountDescriptor;
}

export interface StarknetAccountClassInput {
  readonly networkId: string;
  readonly accountClassId: string;
  readonly accountClassHash: string;
  readonly descriptorVersion: 1;
}

export interface StarknetAuthoritySignature {
  readonly r: string;
  readonly s: string;
}

function fail(code: VaultError["code"] = "invalid_input"): never {
  throw new VaultError(code);
}

function cryptoApi(): Crypto {
  if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.getRandomValues !== "function") fail("unavailable");
  return globalThis.crypto;
}

function assertIdentifier(value: unknown, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail();
}

function assertNetworkId(value: unknown): asserts value is string {
  assertIdentifier(value, /^[A-Za-z0-9_:-]{1,64}$/);
}

function assertClassId(value: unknown): asserts value is string {
  assertIdentifier(value, /^[a-z0-9][a-z0-9-]{0,127}$/);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) fail();
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

function assertScalar(bytes: unknown): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) fail();
  const scalar = bytesToBigInt(bytes);
  if (scalar <= 0n || scalar >= ec.starkCurve.CURVE.n) fail();
}

function cloneDescriptor(value: StarknetAccountDescriptor): StarknetAccountDescriptor {
  return {
    namespace: STARKNET_AUTHORITY_NAMESPACE,
    descriptorVersion: 1,
    networkId: value.networkId,
    accountClassId: value.accountClassId,
    accountClassHash: value.accountClassHash,
    publicKey: value.publicKey,
    accountAddress: value.accountAddress,
    deploymentState: value.deploymentState,
  };
}

function deriveDescriptor(privateKey: Uint8Array, input: StarknetAccountClassInput): StarknetAccountDescriptor {
  assertScalar(privateKey);
  assertNetworkId(input.networkId);
  assertClassId(input.accountClassId);
  if (input.descriptorVersion !== 1) fail();
  const accountClassHash = canonicalFelt(input.accountClassHash);
  const privateScalar = bytesToBigInt(privateKey);
  const publicKey = canonicalFelt(ec.starkCurve.getStarkKey(scalarToHex(privateScalar)));
  const accountAddress = canonicalFelt(
    hash.calculateContractAddressFromHash(publicKey, accountClassHash, [publicKey], 0),
  );
  return {
    namespace: STARKNET_AUTHORITY_NAMESPACE,
    descriptorVersion: 1,
    networkId: input.networkId,
    accountClassId: input.accountClassId,
    accountClassHash,
    publicKey,
    accountAddress,
    deploymentState: "addressComputed",
  };
}

/**
 * Generates a Stark scalar by rejection sampling Web Crypto CSPRNG output.
 * It deliberately never reduces random bytes modulo the curve order, avoiding
 * distribution bias and every account/login/password-derived input.
 */
export function createStarknetAuthority(input: StarknetAccountClassInput): StarknetVaultAuthority {
  let candidate: Uint8Array | undefined;
  try {
    for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
      candidate = cryptoApi().getRandomValues(new Uint8Array(32));
      const scalar = bytesToBigInt(candidate);
      if (scalar <= 0n || scalar >= ec.starkCurve.CURVE.n) {
        candidate.fill(0);
        candidate = undefined;
        continue;
      }
      const descriptor = deriveDescriptor(candidate, input);
      const privateKey = new Uint8Array(candidate);
      candidate.fill(0);
      candidate = undefined;
      return { kind: "starknet", privateKey, descriptor };
    }
    return fail("unavailable");
  } finally {
    candidate?.fill(0);
  }
}

export function validateStarknetAuthority(value: unknown): StarknetVaultAuthority {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const candidateRecord = value as Record<string, unknown>;
  assertExactKeys(candidateRecord, ["kind", "privateKey", "descriptor"]);
  const candidate = value as Partial<StarknetVaultAuthority>;
  if (candidate.kind !== "starknet" || !(candidate.privateKey instanceof Uint8Array) || candidate.descriptor === undefined) fail();
  assertScalar(candidate.privateKey);
  if (typeof candidate.descriptor !== "object" || candidate.descriptor === null || Array.isArray(candidate.descriptor)) fail();
  const descriptorRecord = candidate.descriptor as unknown as Record<string, unknown>;
  assertExactKeys(descriptorRecord, [
    "namespace",
    "descriptorVersion",
    "networkId",
    "accountClassId",
    "accountClassHash",
    "publicKey",
    "accountAddress",
    "deploymentState",
  ]);
  const descriptor = candidate.descriptor as Partial<StarknetAccountDescriptor>;
  if (
    descriptor.namespace !== STARKNET_AUTHORITY_NAMESPACE ||
    descriptor.descriptorVersion !== 1 ||
    (descriptor.deploymentState !== "addressComputed" && descriptor.deploymentState !== "deployed")
  ) {
    fail();
  }
  const derived = deriveDescriptor(candidate.privateKey, {
    networkId: descriptor.networkId as string,
    accountClassId: descriptor.accountClassId as string,
    accountClassHash: descriptor.accountClassHash as string,
    descriptorVersion: 1,
  });
  if (
    derived.publicKey !== canonicalFelt(descriptor.publicKey) ||
    derived.accountAddress !== canonicalFelt(descriptor.accountAddress)
  ) {
    fail("authentication_failed");
  }
  return {
    kind: "starknet",
    privateKey: new Uint8Array(candidate.privateKey),
    descriptor: { ...cloneDescriptor(derived), deploymentState: descriptor.deploymentState },
  };
}

/** Returns a public Stark-curve proof only. The private scalar remains local to this call. */
export function signStarknetAuthorityProof(authority: StarknetVaultAuthority, proofHash: string): StarknetAuthoritySignature {
  const valid = validateStarknetAuthority(authority);
  try {
    const message = canonicalFelt(proofHash);
    const signature = ec.starkCurve.sign(message, scalarToHex(bytesToBigInt(valid.privateKey)));
    const s = signature.s > ec.starkCurve.CURVE.n / 2n ? ec.starkCurve.CURVE.n - signature.s : signature.s;
    return { r: scalarToHex(signature.r), s: scalarToHex(s) };
  } finally {
    valid.privateKey.fill(0);
  }
}

/** Changes only the encrypted descriptor after an independently verified deployment. */
export function withStarknetDeploymentState(
  authority: StarknetVaultAuthority,
  deploymentState: StarknetDeploymentState,
): StarknetVaultAuthority {
  if (deploymentState !== "addressComputed" && deploymentState !== "deployed") fail();
  const valid = validateStarknetAuthority(authority);
  return {
    kind: "starknet",
    privateKey: valid.privateKey,
    descriptor: { ...valid.descriptor, deploymentState },
  };
}
