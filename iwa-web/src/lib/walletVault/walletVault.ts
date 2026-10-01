import { Account, Signer, type RpcProvider } from "starknet";

import {
  VaultError,
  authorityRecordsMatchManifest,
  createAuthorityRecord,
  createRootWrap,
  openAuthorityRecord,
  openRootWrap,
  productionPasswordKdfPolicy,
  rootPasskeyMetadata,
  type PasswordKdfPolicy,
  type RootWrapRecordV1,
  type WalletPasskeyMetadata,
} from "./vaultCrypto";
import {
  createRecoveryPackage,
  isStarknetVaultAuthority,
  isStrk20ViewingVaultAuthority,
  isSyntheticVaultAuthority,
  openRecoveryPackage,
  wipeVaultAuthorities,
  type VaultAuthority,
  type RecoveryPackageV1,
} from "./recoveryPackage";
import {
  STARKNET_AUTHORITY_FORMAT,
  STARKNET_AUTHORITY_VERSION,
  createStarknetAuthority,
  signStarknetAuthorityProof,
  validateStarknetAuthority,
  withStarknetDeploymentState,
  type StarknetAccountClassInput,
  type StarknetAccountDescriptor,
  type StarknetAuthoritySignature,
  type StarknetVaultAuthority,
} from "./starknetAuthority";
import {
  STRK20_VIEWING_AUTHORITY_FORMAT,
  STRK20_VIEWING_AUTHORITY_VERSION,
  createStrk20ViewingAuthority,
  validateStrk20ViewingAuthority,
  withStrk20ViewingRegistrationState,
  type Strk20ViewingDescriptor,
  type Strk20ViewingVaultAuthority,
} from "./strk20ViewingAuthority";
import {
  type IwaStrk20PrivacyRuntime,
  type Strk20PrivateStateSummary,
} from "./strk20PrivacyRuntime";
import type { WalletVaultStore } from "./vaultStore";

const AUTHORITY_FORMAT = "iwa-synthetic-vault-authority";
const PIN_ATTEMPT_LIMIT = 5;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export interface WalletPasskeyAuthority {
  assertPrf(binding: WalletPasskeyMetadata): Promise<Uint8Array>;
}

export interface VaultTimeout {
  set(callback: () => void, milliseconds: number): number;
  clear(handle: number): void;
}

/** Optional deterministic test instrumentation; never persists or exposes secrets. */
export type VaultOperationBoundary =
  | "after-storage-load"
  | "after-manifest-validation"
  | "after-passkey-assertion"
  | "after-root-kdf-and-decrypt"
  | "after-authority-decrypt";

export interface WalletVaultDependencies {
  store: WalletVaultStore;
  passkey: WalletPasskeyAuthority;
  passwordKdf?: () => PasswordKdfPolicy;
  timeout?: VaultTimeout;
  idleTimeoutMs?: number;
  operationCheckpoint?: (boundary: VaultOperationBoundary) => Promise<void>;
}

export interface CreateWalletVaultInput {
  walletId: string;
  password: string;
  passkey: WalletPasskeyMetadata;
  authorities: readonly VaultAuthority[];
}

export interface UnlockWalletVaultInput {
  walletId: string;
  password: string;
}

export interface ImportRecoveryInput {
  recovery: RecoveryPackageV1;
  recoveryKey: Uint8Array;
  password: string;
  passkey: WalletPasskeyMetadata;
  /** A newly generated user-held package identifier for the rotated backup. */
  replacementPackageId: string;
}

export interface ProvisionStarknetAuthorityInput {
  readonly walletId: string;
  readonly password: string;
  readonly accountClass: StarknetAccountClassInput;
}

export interface SignStarknetAuthorityProofInput {
  readonly walletId: string;
  readonly networkId: string;
  readonly accountAddress: string;
  readonly proofHash: string;
}

export interface MarkStarknetAccountDeployedInput {
  readonly walletId: string;
  readonly password: string;
  readonly networkId: string;
  readonly accountAddress: string;
}

export interface DeployStarknetAccountInput {
  readonly walletId: string;
  readonly password: string;
  /** The caller supplies a test/devnet RPC provider. No endpoint is bundled into the vault. */
  readonly provider: RpcProvider;
}

export interface ProvisionStrk20ViewingAuthorityInput {
  readonly walletId: string;
  readonly password: string;
  readonly networkId: string;
  readonly poolAddress: string;
  readonly accountAddress: string;
}

export interface RegisterStrk20ViewingAuthorityInput {
  readonly walletId: string;
  readonly password: string;
  readonly provider: RpcProvider;
  readonly runtime: IwaStrk20PrivacyRuntime;
}

export interface DiscoverStrk20PrivateStateInput {
  readonly walletId: string;
  readonly provider: RpcProvider;
  readonly runtime: IwaStrk20PrivacyRuntime;
}

export interface StarknetAccountDeploymentResult {
  readonly accountAddress: string;
  readonly transactionHash: string | null;
  readonly resumed: boolean;
}

/** Public, opaque capability. It deliberately has no secret object graph. */
export interface WalletVaultSession {
  readonly walletId: string;
}

interface StoredStarknetAuthority {
  format: typeof STARKNET_AUTHORITY_FORMAT;
  version: typeof STARKNET_AUTHORITY_VERSION;
  kind: "starknet";
  privateKey: string;
  descriptor: StarknetAccountDescriptor;
}

interface StoredStrk20ViewingAuthority {
  format: typeof STRK20_VIEWING_AUTHORITY_FORMAT;
  version: typeof STRK20_VIEWING_AUTHORITY_VERSION;
  kind: "strk20Viewing";
  privateKey: string;
  descriptor: Strk20ViewingDescriptor;
}

interface WarmState {
  readonly session: WalletVaultSession;
  readonly walletId: string;
  record: RootWrapRecordV1;
  readonly rootSecret: Uint8Array;
  authorities: VaultAuthority[];
  pinVerifier: Uint8Array | null;
  pinNonce: Uint8Array;
  pinFailures: number;
  locked: boolean;
}

/** Module-private association: public sessions cannot enumerate or serialize secret material. */
const warmStateForSession = new WeakMap<WalletVaultSession, WarmState>();
/** Module-private association: the vault object itself must not expose a warm state. */
const warmStateForVault = new WeakMap<WalletVault, WarmState>();

function fail(): never {
  throw new VaultError("authentication_failed");
}

function wipe(value: Uint8Array | undefined): void {
  value?.fill(0);
}

function wipeAuthorities(authorities: readonly VaultAuthority[]): void {
  wipeVaultAuthorities(authorities);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    fail();
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function assertWalletId(walletId: string): void {
  if (walletId.length === 0 || walletId.length > 256 || /[|\r\n]/.test(walletId)) fail();
}

function assertPin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) fail();
}

function assertPackageId(packageId: string): void {
  if (packageId.length === 0 || packageId.length > 256 || /[|\r\n]/.test(packageId)) fail();
}

function canonicalStarknetFelt(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) fail();
  try {
    const felt = BigInt(value);
    if (felt <= 0n || felt >= STARK_FIELD_PRIME) fail();
    return `0x${felt.toString(16)}`;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  }
}

/** Starknet JSON-RPC CONTRACT_NOT_FOUND. Only this documented response permits a deploy retry. */
function isStarknetContractNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { readonly code?: unknown }).code === 20;
}

function randomRootSecret(): Uint8Array {
  const root = new Uint8Array(32);
  crypto.getRandomValues(root);
  return root;
}

function authorityNamespace(authority: VaultAuthority): string {
  if (isSyntheticVaultAuthority(authority)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(authority.id) || authority.material.length !== 32) fail();
    return `synthetic/${authority.id}`;
  }
  if (isStarknetVaultAuthority(authority)) {
    const valid = validateStarknetAuthority(authority);
    try {
      return valid.descriptor.namespace;
    } finally {
      wipe(valid.privateKey);
    }
  }
  if (isStrk20ViewingVaultAuthority(authority)) {
    const valid = validateStrk20ViewingAuthority(authority);
    try {
      return valid.descriptor.namespace;
    } finally {
      wipe(valid.privateKey);
    }
  }
  return fail();
}

function serializeAuthority(authority: VaultAuthority): Uint8Array {
  if (isSyntheticVaultAuthority(authority)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(authority.id) || authority.material.length !== 32) fail();
    return new TextEncoder().encode(
      JSON.stringify({ format: AUTHORITY_FORMAT, version: 1, id: authority.id, material: base64UrlEncode(authority.material) }),
    );
  }
  if (isStarknetVaultAuthority(authority)) {
    const valid = validateStarknetAuthority(authority);
    try {
      return new TextEncoder().encode(
        JSON.stringify({
          format: STARKNET_AUTHORITY_FORMAT,
          version: STARKNET_AUTHORITY_VERSION,
          kind: "starknet",
          privateKey: base64UrlEncode(valid.privateKey),
          descriptor: valid.descriptor,
        } satisfies StoredStarknetAuthority),
      );
    } finally {
      wipe(valid.privateKey);
    }
  }
  if (isStrk20ViewingVaultAuthority(authority)) {
    const valid = validateStrk20ViewingAuthority(authority);
    try {
      return new TextEncoder().encode(
        JSON.stringify({
          format: STRK20_VIEWING_AUTHORITY_FORMAT,
          version: STRK20_VIEWING_AUTHORITY_VERSION,
          kind: "strk20Viewing",
          privateKey: base64UrlEncode(valid.privateKey),
          descriptor: valid.descriptor,
        } satisfies StoredStrk20ViewingAuthority),
      );
    } finally {
      wipe(valid.privateKey);
    }
  }
  return fail();
}

function parseAuthority(plaintext: Uint8Array): VaultAuthority {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail();
    const record = parsed as Record<string, unknown>;
    if (record.format === AUTHORITY_FORMAT && record.version === 1) {
      if (
        Object.keys(record).length !== 4 ||
        !["format", "version", "id", "material"].every((key) => key in record) ||
        typeof record.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)
      ) {
        fail();
      }
      const material = base64UrlDecode(record.material);
      if (material.length !== 32) {
        wipe(material);
        fail();
      }
      return { id: record.id, material };
    }
    if (Object.keys(record).length !== 5 || !["format", "version", "kind", "privateKey", "descriptor"].every((key) => key in record)) fail();
    let privateKey: Uint8Array | undefined;
    try {
      privateKey = base64UrlDecode(record.privateKey);
      const authority =
        record.format === STARKNET_AUTHORITY_FORMAT &&
        record.version === STARKNET_AUTHORITY_VERSION &&
        record.kind === "starknet"
          ? validateStarknetAuthority({ kind: "starknet", privateKey, descriptor: record.descriptor })
          : record.format === STRK20_VIEWING_AUTHORITY_FORMAT &&
            record.version === STRK20_VIEWING_AUTHORITY_VERSION &&
            record.kind === "strk20Viewing"
            ? validateStrk20ViewingAuthority({ kind: "strk20Viewing", privateKey, descriptor: record.descriptor })
            : fail();
      privateKey = undefined;
      return authority;
    } finally {
      wipe(privateKey);
    }
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  } finally {
    wipe(plaintext);
  }
}

function cloneAuthorities(authorities: readonly VaultAuthority[]): VaultAuthority[] {
  return authorities.map((authority) => {
    if (isSyntheticVaultAuthority(authority)) return { id: authority.id, material: new Uint8Array(authority.material) };
    if (isStarknetVaultAuthority(authority)) return validateStarknetAuthority(authority);
    if (isStrk20ViewingVaultAuthority(authority)) return validateStrk20ViewingAuthority(authority);
    return fail();
  });
}

function singleStarknetAuthority(authorities: readonly VaultAuthority[]): StarknetVaultAuthority | null {
  let found: StarknetVaultAuthority | null = null;
  try {
    for (const authority of authorities) {
      if (!isStarknetVaultAuthority(authority)) continue;
      const valid = validateStarknetAuthority(authority);
      if (found !== null) {
        wipe(valid.privateKey);
        fail();
      }
      found = valid;
    }
    return found;
  } catch (error) {
    wipe(found?.privateKey);
    throw error;
  }
}

function singleStrk20ViewingAuthority(authorities: readonly VaultAuthority[]): Strk20ViewingVaultAuthority | null {
  let found: Strk20ViewingVaultAuthority | null = null;
  try {
    for (const authority of authorities) {
      if (!isStrk20ViewingVaultAuthority(authority)) continue;
      const valid = validateStrk20ViewingAuthority(authority);
      if (found !== null) {
        wipe(valid.privateKey);
        fail();
      }
      found = valid;
    }
    return found;
  } catch (error) {
    wipe(found?.privateKey);
    throw error;
  }
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let different = 0;
  for (let index = 0; index < first.length; index += 1) different |= first[index]! ^ second[index]!;
  return different === 0;
}

async function pinDigest(nonce: Uint8Array, pin: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(`${base64UrlEncode(nonce)}|${pin}`);
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  } finally {
    wipe(input);
  }
}

function newWarmState(walletId: string, record: RootWrapRecordV1, rootSecret: Uint8Array, authorities: VaultAuthority[]): WarmState {
  const session = Object.freeze({ walletId }) as WalletVaultSession;
  const state: WarmState = {
    session,
    walletId,
    record,
    rootSecret,
    authorities,
    pinVerifier: null,
    pinNonce: crypto.getRandomValues(new Uint8Array(32)),
    pinFailures: 0,
    locked: false,
  };
  warmStateForSession.set(session, state);
  return state;
}

function wipeWarmState(state: WarmState): void {
  if (state.locked) return;
  state.locked = true;
  warmStateForSession.delete(state.session);
  wipe(state.rootSecret);
  wipeAuthorities(state.authorities);
  wipe(state.pinVerifier ?? undefined);
  wipe(state.pinNonce);
  state.pinVerifier = null;
}

export class WalletVault {
  private timeoutHandle: number | null = null;
  private operationEpoch = 0;
  private readonly timeout: VaultTimeout;
  private readonly idleTimeoutMs: number;
  private readonly passwordKdf: () => PasswordKdfPolicy;
  private ongoingStarknetProvision: Promise<StarknetAccountDescriptor> | null = null;
  private ongoingStrk20ViewingProvision: Promise<Strk20ViewingDescriptor> | null = null;

  constructor(private readonly dependencies: WalletVaultDependencies) {
    this.timeout = dependencies.timeout ?? { set: (callback, milliseconds) => window.setTimeout(callback, milliseconds), clear: window.clearTimeout };
    this.idleTimeoutMs = dependencies.idleTimeoutMs ?? 5 * 60_000;
    this.passwordKdf = dependencies.passwordKdf ?? productionPasswordKdfPolicy;
  }

  state(): "cold" | "warm" {
    return warmStateForVault.has(this) ? "warm" : "cold";
  }

  async create(input: CreateWalletVaultInput): Promise<void> {
    assertWalletId(input.walletId);
    let passkeyPrf: Uint8Array | undefined;
    let rootSecret: Uint8Array | undefined;
    try {
      passkeyPrf = await this.dependencies.passkey.assertPrf(input.passkey);
      rootSecret = randomRootSecret();
      const authorityRecords = [];
      for (const authority of input.authorities) {
        const namespace = authorityNamespace(authority);
        const plaintext = serializeAuthority(authority);
        try {
          authorityRecords.push(
            await createAuthorityRecord({
              binding: { walletId: input.walletId, recordType: "authority", namespace, version: 1 },
              rootSecret,
              plaintext,
            }),
          );
        } finally {
          wipe(plaintext);
        }
      }
      const root = await createRootWrap({
        binding: { walletId: input.walletId, recordType: "root-wrap", namespace: "root", version: 1 },
        password: input.password,
        passkeyPrf,
        rootSecret,
        passwordKdf: this.passwordKdf(),
        passkey: input.passkey,
        authorityRecords,
        recoveryGeneration: 1,
      });
      await this.dependencies.store.create(root);
    } finally {
      wipe(passkeyPrf);
      wipe(rootSecret);
    }
  }

  async unlock(input: UnlockWalletVaultInput): Promise<WalletVaultSession> {
    assertWalletId(input.walletId);
    const epoch = this.beginOperation();
    let passkey: WalletPasskeyMetadata | undefined;
    let passkeyPrf: Uint8Array | undefined;
    let rootSecret: Uint8Array | undefined;
    let authorities: VaultAuthority[] = [];
    try {
      const record = await this.dependencies.store.load(input.walletId);
      await this.checkpoint("after-storage-load", epoch);
      if (record === null || !(await authorityRecordsMatchManifest(record))) fail();
      await this.checkpoint("after-manifest-validation", epoch);
      passkey = rootPasskeyMetadata(record);
      passkeyPrf = await this.dependencies.passkey.assertPrf(passkey);
      await this.checkpoint("after-passkey-assertion", epoch);
      rootSecret = await openRootWrap(
        record,
        { walletId: input.walletId, recordType: "root-wrap", namespace: "root", version: 1 },
        input.password,
        passkeyPrf,
      );
      await this.checkpoint("after-root-kdf-and-decrypt", epoch);
      for (const authority of record.authorityRecords) {
        const plaintext = await openAuthorityRecord(
          authority,
          { walletId: input.walletId, recordType: "authority", namespace: authority.namespace, version: 1 },
          rootSecret,
        );
        await this.checkpoint("after-authority-decrypt", epoch);
        authorities.push(parseAuthority(plaintext));
      }
      this.assertCurrent(epoch);
      const warm = newWarmState(input.walletId, record, rootSecret, authorities);
      this.assertCurrent(epoch);
      warmStateForVault.set(this, warm);
      rootSecret = undefined;
      authorities = [];
      this.armLock();
      return warm.session;
    } finally {
      wipe(passkey?.prfInput);
      wipe(passkeyPrf);
      wipe(rootSecret);
      wipeAuthorities(authorities);
    }
  }

  lock(): void {
    this.operationEpoch += 1;
    if (this.timeoutHandle !== null) this.timeout.clear(this.timeoutHandle);
    this.timeoutHandle = null;
    const warm = warmStateForVault.get(this);
    if (warm !== undefined) wipeWarmState(warm);
    warmStateForVault.delete(this);
  }

  async setPin(session: WalletVaultSession, pin: string): Promise<void> {
    const warm = this.requireWarm(session);
    assertPin(pin);
    wipe(warm.pinVerifier ?? undefined);
    warm.pinVerifier = await pinDigest(warm.pinNonce, pin);
    if (warmStateForVault.get(this) !== warm || warm.locked) {
      wipe(warm.pinVerifier);
      warm.pinVerifier = null;
      fail();
    }
    warm.pinFailures = 0;
    this.armLock();
  }

  async confirmPin(session: WalletVaultSession, pin: string): Promise<void> {
    const warm = this.requireWarm(session);
    assertPin(pin);
    if (warm.pinVerifier === null) fail();
    const candidate = await pinDigest(warm.pinNonce, pin);
    try {
      if (warmStateForVault.get(this) !== warm || warm.locked) fail();
      if (!sameBytes(candidate, warm.pinVerifier)) {
        warm.pinFailures += 1;
        if (warm.pinFailures >= PIN_ATTEMPT_LIMIT) this.lock();
        fail();
      }
      warm.pinFailures = 0;
      this.armLock();
    } finally {
      wipe(candidate);
    }
  }

  async unlockWithPin(_walletId: string, _pin: string): Promise<never> {
    fail();
  }

  /**
   * Adds the one B2-A Starknet authority exactly once. Its scalar remains in
   * the module-private warm state and is immediately re-encrypted at rest.
   */
  async provisionStarknetAuthority(
    session: WalletVaultSession,
    input: ProvisionStarknetAuthorityInput,
  ): Promise<StarknetAccountDescriptor> {
    if (this.ongoingStarknetProvision !== null) return this.ongoingStarknetProvision;
    const operation = this.provisionStarknetAuthorityOnce(session, input);
    this.ongoingStarknetProvision = operation;
    try {
      return await operation;
    } finally {
      if (this.ongoingStarknetProvision === operation) this.ongoingStarknetProvision = null;
    }
  }

  /** Public account facts only. It intentionally never returns a signer or scalar. */
  starknetAccountDescriptor(session: WalletVaultSession, walletId: string): StarknetAccountDescriptor | null {
    const warm = this.requireWarm(session, walletId);
    const authority = singleStarknetAuthority(warm.authorities);
    if (authority === null) return null;
    try {
      return { ...authority.descriptor };
    } finally {
      wipe(authority.privateKey);
    }
  }

  /** Public STRK20 setup facts only. The viewing scalar never leaves warm state. */
  strk20ViewingAuthorityDescriptor(session: WalletVaultSession, walletId: string): Strk20ViewingDescriptor | null {
    const warm = this.requireWarm(session, walletId);
    const authority = singleStrk20ViewingAuthority(warm.authorities);
    if (authority === null) return null;
    try {
      return { ...authority.descriptor };
    } finally {
      wipe(authority.privateKey);
    }
  }

  /**
   * Creates the independent viewing scalar once, only after the stored
   * Starknet account is verified as deployed. A retry must match every public
   * context field and returns the original descriptor instead of rotating it.
   */
  async provisionStrk20ViewingAuthority(
    session: WalletVaultSession,
    input: ProvisionStrk20ViewingAuthorityInput,
  ): Promise<Strk20ViewingDescriptor> {
    if (this.ongoingStrk20ViewingProvision !== null) return this.ongoingStrk20ViewingProvision;
    const operation = this.provisionStrk20ViewingAuthorityOnce(session, input);
    this.ongoingStrk20ViewingProvision = operation;
    try {
      return await operation;
    } finally {
      if (this.ongoingStrk20ViewingProvision === operation) this.ongoingStrk20ViewingProvision = null;
    }
  }

  /**
   * Registers only the existing local viewing identity. A completed but
   * unpersisted registration is recovered through the protocol probe; a retry
   * never creates or substitutes a second viewing scalar.
   */
  async registerStrk20ViewingAuthority(
    session: WalletVaultSession,
    input: RegisterStrk20ViewingAuthorityInput,
  ): Promise<Strk20ViewingDescriptor> {
    const warm = this.requireWarm(session, input.walletId);
    const epoch = this.operationEpoch;
    await this.withStrk20Runtime(warm, session, epoch, input.provider, async (context) => {
      await input.runtime.ensureRegistered(context);
    });
    const viewing = singleStrk20ViewingAuthority(warm.authorities);
    if (viewing === null) fail();
    let next: VaultAuthority[] = [];
    try {
      this.assertLiveWarm(warm, session, epoch);
      if (viewing.descriptor.registrationState === "registered") return { ...viewing.descriptor };
      const updated = withStrk20ViewingRegistrationState(viewing, "registered");
      next = cloneAuthorities(warm.authorities).map((authority) => isStrk20ViewingVaultAuthority(authority) ? updated : authority);
      await this.rewriteAuthorities(warm, session, input.password, next);
      next = [];
      return { ...updated.descriptor };
    } finally {
      wipe(viewing.privateKey);
      wipeAuthorities(next);
    }
  }

  /** Returns summaries only; raw notes and the viewing scalar remain internal. */
  async discoverStrk20PrivateState(
    session: WalletVaultSession,
    input: DiscoverStrk20PrivateStateInput,
  ): Promise<Strk20PrivateStateSummary> {
    const warm = this.requireWarm(session, input.walletId);
    const epoch = this.operationEpoch;
    const viewing = singleStrk20ViewingAuthority(warm.authorities);
    if (viewing === null || viewing.descriptor.registrationState !== "registered") {
      wipe(viewing?.privateKey);
      fail();
    }
    wipe(viewing.privateKey);
    return this.withStrk20Runtime(warm, session, epoch, input.provider, async (context) => input.runtime.discover(context));
  }

  /** Signs a bounded proof only after validating its wallet, network, and account context. */
  signStarknetAuthorityProof(
    session: WalletVaultSession,
    input: SignStarknetAuthorityProofInput,
  ): StarknetAuthoritySignature {
    const warm = this.requireWarm(session, input.walletId);
    const authority = singleStarknetAuthority(warm.authorities);
    if (authority === null) fail();
    try {
      if (authority.descriptor.networkId !== input.networkId || authority.descriptor.accountAddress !== input.accountAddress) fail();
      return signStarknetAuthorityProof(authority, input.proofHash);
    } finally {
      wipe(authority.privateKey);
    }
  }

  /** Persists a verified deployment transition without creating or replacing an authority. */
  async markStarknetAccountDeployed(
    session: WalletVaultSession,
    input: MarkStarknetAccountDeployedInput,
  ): Promise<StarknetAccountDescriptor> {
    const warm = this.requireWarm(session, input.walletId);
    const authority = singleStarknetAuthority(warm.authorities);
    if (authority === null) fail();
    try {
      if (authority.descriptor.networkId !== input.networkId || authority.descriptor.accountAddress !== input.accountAddress) fail();
      if (authority.descriptor.deploymentState === "deployed") return { ...authority.descriptor };
      const updated = withStarknetDeploymentState(authority, "deployed");
      const next = cloneAuthorities(warm.authorities).map((candidate) => isStarknetVaultAuthority(candidate) ? updated : candidate);
      await this.rewriteAuthorities(warm, session, input.password, next);
      return { ...updated.descriptor };
    } finally {
      wipe(authority.privateKey);
    }
  }

  /**
   * Deploys the counterfactual account with the local Iwa signer. A future
   * sponsor may fund this address, but it never receives this signer buffer.
   */
  async deployStarknetAccount(
    session: WalletVaultSession,
    input: DeployStarknetAccountInput,
  ): Promise<StarknetAccountDeploymentResult> {
    const warm = this.requireWarm(session, input.walletId);
    const authority = singleStarknetAuthority(warm.authorities);
    if (authority === null) fail();
    let signer: Uint8Array | undefined;
    try {
      const descriptor = authority.descriptor;
      const providerNetwork = await input.provider.getChainId();
      if (providerNetwork !== descriptor.networkId) fail();

      if (descriptor.deploymentState === "deployed") {
        const deployedClassHash = canonicalStarknetFelt(await input.provider.getClassHashAt(descriptor.accountAddress));
        if (deployedClassHash !== descriptor.accountClassHash) fail();
        return { accountAddress: descriptor.accountAddress, transactionHash: null, resumed: true };
      }

      // A deployment can reach the isolated network immediately before an
      // interruption prevents this encrypted descriptor from being updated.
      // Probe first so a retry never blindly submits a second deployment.
      try {
        const existingClassHash = canonicalStarknetFelt(await input.provider.getClassHashAt(descriptor.accountAddress));
        if (existingClassHash !== descriptor.accountClassHash) fail();
        await this.markStarknetAccountDeployed(session, {
          walletId: input.walletId,
          password: input.password,
          networkId: descriptor.networkId,
          accountAddress: descriptor.accountAddress,
        });
        return { accountAddress: descriptor.accountAddress, transactionHash: null, resumed: true };
      } catch (error) {
        if (!isStarknetContractNotFound(error)) throw error;
      }

      signer = new Uint8Array(authority.privateKey);
      const account = new Account({ provider: input.provider, address: descriptor.accountAddress, signer });
      const deployment = await account.deployAccount({
        classHash: descriptor.accountClassHash,
        constructorCalldata: [descriptor.publicKey],
        addressSalt: descriptor.publicKey,
      });
      if (canonicalStarknetFelt(deployment.contract_address) !== descriptor.accountAddress) fail();
      await input.provider.waitForTransaction(deployment.transaction_hash);
      const deployedClassHash = canonicalStarknetFelt(await input.provider.getClassHashAt(descriptor.accountAddress));
      if (deployedClassHash !== descriptor.accountClassHash) fail();
      await this.markStarknetAccountDeployed(session, {
        walletId: input.walletId,
        password: input.password,
        networkId: descriptor.networkId,
        accountAddress: descriptor.accountAddress,
      });
      return { accountAddress: descriptor.accountAddress, transactionHash: deployment.transaction_hash, resumed: false };
    } finally {
      wipe(signer);
      wipe(authority.privateKey);
    }
  }

  /** Non-secret local freshness metadata, available only to a live capability. */
  recoveryGeneration(session: WalletVaultSession, walletId: string): number {
    return this.requireWarm(session, walletId).record.recoveryGeneration;
  }

  async exportRecovery(
    session: WalletVaultSession,
    walletId: string,
    recoveryKey: Uint8Array,
    packageId: string,
  ): Promise<RecoveryPackageV1> {
    assertPackageId(packageId);
    const warm = this.requireWarm(session, walletId);
    const epoch = this.operationEpoch;
    let metadata: WalletPasskeyMetadata | undefined;
    let prf: Uint8Array | undefined;
    let rootSecret: Uint8Array | undefined;
    let authorities: VaultAuthority[] = [];
    try {
      metadata = rootPasskeyMetadata(warm.record);
      prf = await this.dependencies.passkey.assertPrf(metadata);
      this.assertLiveWarm(warm, session, epoch);
      rootSecret = new Uint8Array(warm.rootSecret);
      authorities = cloneAuthorities(warm.authorities);
      const recovery = await createRecoveryPackage({
        walletId,
        packageId,
        generation: warm.record.recoveryGeneration,
        recoveryKey,
        rootSecret,
        authorities,
        publicDescriptors: [],
      });
      this.assertLiveWarm(warm, session, epoch);
      this.armLock();
      return recovery;
    } finally {
      wipe(metadata?.prfInput);
      wipe(prf);
      wipe(rootSecret);
      wipeAuthorities(authorities);
    }
  }

  async destroy(walletId: string): Promise<void> {
    this.lock();
    await this.dependencies.store.remove(walletId);
  }

  async importRecovery(input: ImportRecoveryInput): Promise<RecoveryPackageV1> {
    assertPackageId(input.replacementPackageId);
    const epoch = this.beginOperation();
    let payload: Awaited<ReturnType<typeof openRecoveryPackage>> | undefined;
    let passkeyPrf: Uint8Array | undefined;
    try {
      payload = await openRecoveryPackage(input.recovery, input.recoveryKey, input.recovery.walletId);
      this.assertCurrent(epoch);
      if (input.replacementPackageId === payload.packageId) fail();
      if ((await this.dependencies.store.load(payload.walletId)) !== null) fail();
      this.assertCurrent(epoch);
      passkeyPrf = await this.dependencies.passkey.assertPrf(input.passkey);
      this.assertCurrent(epoch);
      const authorityRecords = [];
      for (const authority of payload.authorities) {
        const namespace = authorityNamespace(authority);
        const plaintext = serializeAuthority(authority);
        try {
          authorityRecords.push(
            await createAuthorityRecord({
              binding: { walletId: payload.walletId, recordType: "authority", namespace, version: 1 },
              rootSecret: payload.rootSecret,
              plaintext,
            }),
          );
          this.assertCurrent(epoch);
        } finally {
          wipe(plaintext);
        }
      }
      const recoveryGeneration = payload.generation + 1;
      if (!Number.isSafeInteger(recoveryGeneration)) fail();
      const root = await createRootWrap({
        binding: { walletId: payload.walletId, recordType: "root-wrap", namespace: "root", version: 1 },
        password: input.password,
        passkeyPrf,
        rootSecret: payload.rootSecret,
        passwordKdf: this.passwordKdf(),
        passkey: input.passkey,
        authorityRecords,
        recoveryGeneration,
      });
      this.assertCurrent(epoch);
      const replacement = await createRecoveryPackage({
        walletId: payload.walletId,
        packageId: input.replacementPackageId,
        generation: recoveryGeneration,
        recoveryKey: input.recoveryKey,
        rootSecret: payload.rootSecret,
        authorities: payload.authorities,
        publicDescriptors: payload.publicDescriptors,
      });
      this.assertCurrent(epoch);
      await this.dependencies.store.create(root);
      try {
        this.assertCurrent(epoch);
      } catch (error) {
        // Compare-and-delete prevents a stale import from deleting a record
        // created later by a distinct recovery/create flow.
        await this.dependencies.store.removeIfUnchanged(root);
        throw error;
      }
      return replacement;
    } finally {
      wipe(passkeyPrf);
      if (payload !== undefined) {
        wipe(payload.rootSecret);
        wipeAuthorities(payload.authorities);
      }
    }
  }

  private async provisionStarknetAuthorityOnce(
    session: WalletVaultSession,
    input: ProvisionStarknetAuthorityInput,
  ): Promise<StarknetAccountDescriptor> {
    const warm = this.requireWarm(session, input.walletId);
    const existing = singleStarknetAuthority(warm.authorities);
    if (existing !== null) {
      try {
        const descriptor = existing.descriptor;
        if (
          descriptor.networkId !== input.accountClass.networkId ||
          descriptor.accountClassId !== input.accountClass.accountClassId ||
          descriptor.accountClassHash !== input.accountClass.accountClassHash ||
          descriptor.descriptorVersion !== input.accountClass.descriptorVersion
        ) {
          fail();
        }
        return { ...descriptor };
      } finally {
        wipe(existing.privateKey);
      }
    }
    let created: StarknetVaultAuthority | undefined;
    let next: VaultAuthority[] = [];
    try {
      created = createStarknetAuthority(input.accountClass);
      next = [...cloneAuthorities(warm.authorities), validateStarknetAuthority(created)];
      await this.rewriteAuthorities(warm, session, input.password, next);
      const descriptor = created.descriptor;
      next = [];
      return { ...descriptor };
    } finally {
      wipe(created?.privateKey);
      wipeAuthorities(next);
    }
  }

  private async withStrk20Runtime<T>(
    warm: WarmState,
    session: WalletVaultSession,
    epoch: number,
    provider: RpcProvider,
    operation: (context: Parameters<IwaStrk20PrivacyRuntime["ensureRegistered"]>[0]) => Promise<T>,
  ): Promise<T> {
    const account = singleStarknetAuthority(warm.authorities);
    const viewing = singleStrk20ViewingAuthority(warm.authorities);
    if (account === null || viewing === null) {
      wipe(account?.privateKey);
      wipe(viewing?.privateKey);
      fail();
    }
    let signer: Uint8Array | undefined;
    try {
      this.assertLiveWarm(warm, session, epoch);
      if (
        account.descriptor.deploymentState !== "deployed" ||
        account.descriptor.networkId !== viewing.descriptor.networkId ||
        account.descriptor.accountAddress !== viewing.descriptor.accountAddress
      ) {
        fail();
      }
      const providerNetwork = await provider.getChainId();
      this.assertLiveWarm(warm, session, epoch);
      if (providerNetwork !== account.descriptor.networkId) fail();
      signer = new Uint8Array(account.privateKey);
      const embeddedSigner = new Signer(signer);
      const result = await operation({
        walletId: warm.walletId,
        networkId: account.descriptor.networkId,
        poolAddress: viewing.descriptor.poolAddress,
        accountAddress: account.descriptor.accountAddress,
        account: { address: account.descriptor.accountAddress, signer: embeddedSigner },
        // The privacy SDK requires bigint here. JavaScript BigInts are immutable
        // and cannot be zeroized; its scope is limited to this operation.
        viewingKey: bytesToBigInt(viewing.privateKey),
      });
      this.assertLiveWarm(warm, session, epoch);
      return result;
    } finally {
      wipe(signer);
      wipe(account.privateKey);
      wipe(viewing.privateKey);
    }
  }

  private async provisionStrk20ViewingAuthorityOnce(
    session: WalletVaultSession,
    input: ProvisionStrk20ViewingAuthorityInput,
  ): Promise<Strk20ViewingDescriptor> {
    const warm = this.requireWarm(session, input.walletId);
    const account = singleStarknetAuthority(warm.authorities);
    if (account === null) fail();
    let created: Strk20ViewingVaultAuthority | undefined;
    let next: VaultAuthority[] = [];
    try {
      if (
        account.descriptor.deploymentState !== "deployed" ||
        account.descriptor.networkId !== input.networkId ||
        account.descriptor.accountAddress !== input.accountAddress
      ) {
        fail();
      }
      const existing = singleStrk20ViewingAuthority(warm.authorities);
      if (existing !== null) {
        try {
          const descriptor = existing.descriptor;
          if (
            descriptor.networkId !== input.networkId ||
            descriptor.poolAddress !== canonicalStarknetFelt(input.poolAddress) ||
            descriptor.accountAddress !== input.accountAddress
          ) {
            fail();
          }
          return { ...descriptor };
        } finally {
          wipe(existing.privateKey);
        }
      }
      created = createStrk20ViewingAuthority({
        networkId: input.networkId,
        poolAddress: input.poolAddress,
        accountAddress: input.accountAddress,
        descriptorVersion: 1,
      });
      next = [...cloneAuthorities(warm.authorities), validateStrk20ViewingAuthority(created)];
      await this.rewriteAuthorities(warm, session, input.password, next);
      const descriptor = created.descriptor;
      next = [];
      return { ...descriptor };
    } finally {
      wipe(account.privateKey);
      wipe(created?.privateKey);
      wipeAuthorities(next);
    }
  }

  private async rewriteAuthorities(
    warm: WarmState,
    session: WalletVaultSession,
    password: string,
    nextAuthorities: VaultAuthority[],
  ): Promise<void> {
    const epoch = this.operationEpoch;
    let metadata: WalletPasskeyMetadata | undefined;
    let passkeyPrf: Uint8Array | undefined;
    let root: RootWrapRecordV1 | undefined;
    let committed = false;
    try {
      this.assertLiveWarm(warm, session, epoch);
      metadata = rootPasskeyMetadata(warm.record);
      passkeyPrf = await this.dependencies.passkey.assertPrf(metadata);
      this.assertLiveWarm(warm, session, epoch);
      const authorityRecords = [];
      for (const authority of nextAuthorities) {
        const namespace = authorityNamespace(authority);
        const plaintext = serializeAuthority(authority);
        try {
          authorityRecords.push(
            await createAuthorityRecord({
              binding: { walletId: warm.walletId, recordType: "authority", namespace, version: 1 },
              rootSecret: warm.rootSecret,
              plaintext,
            }),
          );
          this.assertLiveWarm(warm, session, epoch);
        } finally {
          wipe(plaintext);
        }
      }
      root = await createRootWrap({
        binding: { walletId: warm.walletId, recordType: "root-wrap", namespace: "root", version: 1 },
        password,
        passkeyPrf,
        rootSecret: warm.rootSecret,
        passwordKdf: this.passwordKdf(),
        passkey: metadata,
        authorityRecords,
        recoveryGeneration: warm.record.recoveryGeneration,
      });
      this.assertLiveWarm(warm, session, epoch);
      if (!(await this.dependencies.store.replaceIfUnchanged(warm.record, root))) fail();
      this.assertLiveWarm(warm, session, epoch);
      const previousAuthorities = warm.authorities;
      warm.record = root;
      warm.authorities = nextAuthorities;
      committed = true;
      wipeAuthorities(previousAuthorities);
      this.armLock();
    } finally {
      wipe(metadata?.prfInput);
      wipe(passkeyPrf);
      if (!committed) wipeAuthorities(nextAuthorities);
    }
  }

  private beginOperation(): number {
    this.lock();
    return this.operationEpoch;
  }

  private assertCurrent(epoch: number): void {
    if (this.operationEpoch !== epoch) fail();
  }

  private async checkpoint(boundary: VaultOperationBoundary, epoch: number): Promise<void> {
    await this.dependencies.operationCheckpoint?.(boundary);
    this.assertCurrent(epoch);
  }

  private requireWarm(session: WalletVaultSession, walletId?: string): WarmState {
    const warm = warmStateForVault.get(this);
    if (
      warm === undefined ||
      warm.session !== session ||
      warmStateForSession.get(session) !== warm ||
      warm.locked ||
      (walletId !== undefined && warm.walletId !== walletId)
    ) {
      fail();
    }
    return warm;
  }

  private assertLiveWarm(warm: WarmState, session: WalletVaultSession, epoch: number): void {
    this.assertCurrent(epoch);
    if (warmStateForVault.get(this) !== warm || warm.session !== session || warmStateForSession.get(session) !== warm || warm.locked) fail();
  }

  private armLock(): void {
    if (this.timeoutHandle !== null) this.timeout.clear(this.timeoutHandle);
    this.timeoutHandle = this.timeout.set(() => this.lock(), this.idleTimeoutMs);
  }
}
