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
  openRecoveryPackage,
  type RecoveryPackageV1,
  type SyntheticVaultAuthority,
} from "./recoveryPackage";
import type { WalletVaultStore } from "./vaultStore";

const AUTHORITY_FORMAT = "iwa-synthetic-vault-authority";
const PIN_ATTEMPT_LIMIT = 5;

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
  authorities: readonly SyntheticVaultAuthority[];
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

/** Public, opaque capability. It deliberately has no secret object graph. */
export interface WalletVaultSession {
  readonly walletId: string;
}

interface StoredSyntheticAuthority {
  format: typeof AUTHORITY_FORMAT;
  version: 1;
  id: string;
  material: string;
}

interface WarmState {
  readonly session: WalletVaultSession;
  readonly walletId: string;
  readonly record: RootWrapRecordV1;
  readonly rootSecret: Uint8Array;
  readonly authorities: SyntheticVaultAuthority[];
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

function wipeAuthorities(authorities: readonly SyntheticVaultAuthority[]): void {
  for (const authority of authorities) wipe(authority.material);
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

function assertWalletId(walletId: string): void {
  if (walletId.length === 0 || walletId.length > 256 || /[|\r\n]/.test(walletId)) fail();
}

function assertPin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) fail();
}

function assertPackageId(packageId: string): void {
  if (packageId.length === 0 || packageId.length > 256 || /[|\r\n]/.test(packageId)) fail();
}

function randomRootSecret(): Uint8Array {
  const root = new Uint8Array(32);
  crypto.getRandomValues(root);
  return root;
}

function serializeAuthority(authority: SyntheticVaultAuthority): Uint8Array {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(authority.id) || authority.material.length !== 32) fail();
  return new TextEncoder().encode(
    JSON.stringify({ format: AUTHORITY_FORMAT, version: 1, id: authority.id, material: base64UrlEncode(authority.material) }),
  );
}

function parseAuthority(plaintext: Uint8Array): SyntheticVaultAuthority {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<StoredSyntheticAuthority>;
    if (
      parsed.format !== AUTHORITY_FORMAT ||
      parsed.version !== 1 ||
      typeof parsed.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.id)
    ) {
      fail();
    }
    const material = base64UrlDecode(parsed.material);
    if (material.length !== 32) {
      wipe(material);
      fail();
    }
    return { id: parsed.id, material };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  } finally {
    wipe(plaintext);
  }
}

function cloneAuthorities(authorities: readonly SyntheticVaultAuthority[]): SyntheticVaultAuthority[] {
  return authorities.map((authority) => ({ id: authority.id, material: new Uint8Array(authority.material) }));
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

function newWarmState(walletId: string, record: RootWrapRecordV1, rootSecret: Uint8Array, authorities: SyntheticVaultAuthority[]): WarmState {
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
        const plaintext = serializeAuthority(authority);
        try {
          authorityRecords.push(
            await createAuthorityRecord({
              binding: { walletId: input.walletId, recordType: "authority", namespace: `synthetic/${authority.id}`, version: 1 },
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
    let authorities: SyntheticVaultAuthority[] = [];
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
    let authorities: SyntheticVaultAuthority[] = [];
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
        const plaintext = serializeAuthority(authority);
        try {
          authorityRecords.push(
            await createAuthorityRecord({
              binding: { walletId: payload.walletId, recordType: "authority", namespace: `synthetic/${authority.id}`, version: 1 },
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
