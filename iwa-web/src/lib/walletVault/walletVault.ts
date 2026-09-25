import {
  VaultError,
  createAuthorityRecord,
  createRootWrap,
  openAuthorityRecord,
  openRootWrap,
  productionPasswordKdfPolicy,
  rootPasskeyMetadata,
  type PasswordKdfPolicy,
  type RootWrapRecordV1,
  type WalletPasskeyMetadata,
  withAuthorityRecords,
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

export interface WalletVaultDependencies {
  store: WalletVaultStore;
  passkey: WalletPasskeyAuthority;
  passwordKdf?: () => PasswordKdfPolicy;
  timeout?: VaultTimeout;
  idleTimeoutMs?: number;
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
}

interface StoredSyntheticAuthority {
  format: typeof AUTHORITY_FORMAT;
  version: 1;
  id: string;
  material: string;
}

function fail(): never {
  throw new VaultError("authentication_failed");
}

function wipe(value: Uint8Array | undefined): void {
  value?.fill(0);
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
  if (walletId.length === 0 || walletId.length > 256 || walletId.includes("|")) fail();
}

function assertPin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) fail();
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
    if (material.length !== 32) fail();
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

class WarmVaultSession {
  private pinVerifier: Uint8Array | null = null;
  private pinNonce = crypto.getRandomValues(new Uint8Array(32));
  private pinFailures = 0;
  private locked = false;

  constructor(
    readonly walletId: string,
    readonly record: RootWrapRecordV1,
    private readonly rootSecret: Uint8Array,
    private readonly authorities: SyntheticVaultAuthority[],
    private readonly onLock: () => void,
  ) {}

  syntheticAuthorities(): SyntheticVaultAuthority[] {
    this.requireOpen();
    return cloneAuthorities(this.authorities);
  }

  async setPin(pin: string): Promise<void> {
    this.requireOpen();
    assertPin(pin);
    wipe(this.pinVerifier ?? undefined);
    this.pinVerifier = await this.pinDigest(pin);
    this.pinFailures = 0;
  }

  async confirmPin(pin: string): Promise<void> {
    this.requireOpen();
    assertPin(pin);
    if (this.pinVerifier === null) fail();
    const candidate = await this.pinDigest(pin);
    const matched = sameBytes(candidate, this.pinVerifier);
    wipe(candidate);
    if (!matched) {
      this.pinFailures += 1;
      if (this.pinFailures >= PIN_ATTEMPT_LIMIT) this.onLock();
      fail();
    }
    this.pinFailures = 0;
  }

  rootForRecovery(): Uint8Array {
    this.requireOpen();
    return new Uint8Array(this.rootSecret);
  }

  lock(): void {
    if (this.locked) return;
    this.locked = true;
    wipe(this.rootSecret);
    for (const authority of this.authorities) wipe(authority.material);
    wipe(this.pinVerifier ?? undefined);
    wipe(this.pinNonce);
    this.pinVerifier = null;
  }

  private requireOpen(): void {
    if (this.locked) fail();
  }

  private async pinDigest(pin: string): Promise<Uint8Array> {
    const input = new TextEncoder().encode(`${base64UrlEncode(this.pinNonce)}|${pin}`);
    try {
      return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    } finally {
      wipe(input);
    }
  }
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let different = 0;
  for (let index = 0; index < first.length; index += 1) different |= first[index]! ^ second[index]!;
  return different === 0;
}

export class WalletVault {
  private warm: WarmVaultSession | null = null;
  private timeoutHandle: number | null = null;
  private readonly timeout: VaultTimeout;
  private readonly idleTimeoutMs: number;
  private readonly passwordKdf: () => PasswordKdfPolicy;

  constructor(private readonly dependencies: WalletVaultDependencies) {
    this.timeout = dependencies.timeout ?? { set: (callback, milliseconds) => window.setTimeout(callback, milliseconds), clear: window.clearTimeout };
    this.idleTimeoutMs = dependencies.idleTimeoutMs ?? 5 * 60_000;
    this.passwordKdf = dependencies.passwordKdf ?? productionPasswordKdfPolicy;
  }

  state(): "cold" | "warm" {
    return this.warm === null ? "cold" : "warm";
  }

  async create(input: CreateWalletVaultInput): Promise<void> {
    assertWalletId(input.walletId);
    if ((await this.dependencies.store.load(input.walletId)) !== null) fail();
    const passkeyPrf = await this.dependencies.passkey.assertPrf(input.passkey);
    const rootSecret = randomRootSecret();
    try {
      const root = await createRootWrap({
        binding: { walletId: input.walletId, recordType: "root-wrap", namespace: "root", version: 1 },
        password: input.password,
        passkeyPrf,
        rootSecret,
        passwordKdf: this.passwordKdf(),
        passkey: input.passkey,
      });
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
      await this.dependencies.store.save(withAuthorityRecords(root, authorityRecords));
    } finally {
      wipe(passkeyPrf);
      wipe(rootSecret);
    }
  }

  async unlock(input: UnlockWalletVaultInput): Promise<WarmVaultSession> {
    assertWalletId(input.walletId);
    this.lock();
    const record = await this.dependencies.store.load(input.walletId);
    if (record === null) fail();
    const passkey = rootPasskeyMetadata(record);
    const passkeyPrf = await this.dependencies.passkey.assertPrf(passkey);
    try {
      const rootSecret = await openRootWrap(record, { walletId: input.walletId, recordType: "root-wrap", namespace: "root", version: 1 }, input.password, passkeyPrf);
      const authorities: SyntheticVaultAuthority[] = [];
      try {
        for (const authority of record.authorityRecords) {
          const plaintext = await openAuthorityRecord(
            authority,
            { walletId: input.walletId, recordType: "authority", namespace: authority.namespace, version: 1 },
            rootSecret,
          );
          authorities.push(parseAuthority(plaintext));
        }
        const warm = new WarmVaultSession(input.walletId, record, rootSecret, authorities, () => this.lock());
        this.warm = warm;
        this.armLock();
        return warm;
      } catch (error) {
        wipe(rootSecret);
        for (const authority of authorities) wipe(authority.material);
        throw error;
      }
    } finally {
      wipe(passkey.prfInput);
      wipe(passkeyPrf);
    }
  }

  lock(): void {
    if (this.timeoutHandle !== null) this.timeout.clear(this.timeoutHandle);
    this.timeoutHandle = null;
    this.warm?.lock();
    this.warm = null;
  }

  async setPin(pin: string): Promise<void> {
    await this.requireWarm().setPin(pin);
    this.armLock();
  }

  async confirmPin(pin: string): Promise<void> {
    await this.requireWarm().confirmPin(pin);
    this.armLock();
  }

  async unlockWithPin(_walletId: string, _pin: string): Promise<never> {
    fail();
  }

  async exportRecovery(walletId: string, recoveryKey: Uint8Array, packageId: string, generation: number): Promise<RecoveryPackageV1> {
    const warm = this.requireWarm(walletId);
    const prf = await this.dependencies.passkey.assertPrf(rootPasskeyMetadata(warm.record));
    const rootSecret = warm.rootForRecovery();
    const authorities = warm.syntheticAuthorities();
    try {
      return await createRecoveryPackage({
        walletId,
        packageId,
        generation,
        recoveryKey,
        rootSecret,
        authorities,
        publicDescriptors: [],
      });
    } finally {
      wipe(prf);
      wipe(rootSecret);
      for (const authority of authorities) wipe(authority.material);
      this.armLock();
    }
  }

  async destroy(walletId: string): Promise<void> {
    this.lock();
    await this.dependencies.store.remove(walletId);
  }

  async importRecovery(input: ImportRecoveryInput): Promise<void> {
    const payload = await openRecoveryPackage(input.recovery, input.recoveryKey, input.recovery.walletId);
    if ((await this.dependencies.store.load(payload.walletId)) !== null) fail();
    const passkeyPrf = await this.dependencies.passkey.assertPrf(input.passkey);
    try {
      const root = await createRootWrap({
        binding: { walletId: payload.walletId, recordType: "root-wrap", namespace: "root", version: 1 },
        password: input.password,
        passkeyPrf,
        rootSecret: payload.rootSecret,
        passwordKdf: this.passwordKdf(),
        passkey: input.passkey,
      });
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
        } finally {
          wipe(plaintext);
        }
      }
      await this.dependencies.store.save(withAuthorityRecords(root, authorityRecords));
    } finally {
      wipe(payload.rootSecret);
      for (const authority of payload.authorities) wipe(authority.material);
      wipe(passkeyPrf);
    }
  }

  private requireWarm(walletId?: string): WarmVaultSession {
    if (this.warm === null || (walletId !== undefined && this.warm.walletId !== walletId)) fail();
    return this.warm;
  }

  private armLock(): void {
    if (this.timeoutHandle !== null) this.timeout.clear(this.timeoutHandle);
    this.timeoutHandle = this.timeout.set(() => this.lock(), this.idleTimeoutMs);
  }
}
