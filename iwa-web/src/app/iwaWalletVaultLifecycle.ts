import {
  VaultError,
  type PasswordKdfPolicy,
  type WalletPasskeyMetadata,
} from "../lib/walletVault/vaultCrypto";
import type { WalletVaultStore } from "../lib/walletVault/vaultStore";
import {
  WalletVault,
  type VaultTimeout,
  type WalletPasskeyAuthority,
  type WalletVaultSession,
} from "../lib/walletVault/walletVault";

/** Browser passkey boundary needed only while creating the dedicated wallet credential. */
export interface WalletPasskeyEnrollmentAuthority extends WalletPasskeyAuthority {
  enroll(rpId: string): Promise<WalletPasskeyMetadata>;
}

export type LocalVaultPresence = "unknown" | "absent" | "present";

/**
 * The only state that this lifecycle layer may hand to React. A warm session,
 * root secret, password, PIN, WebAuthn PRF result, and passkey metadata stay
 * in module-private vault state or short-lived local variables.
 */
export interface PublicWalletVaultState {
  readonly walletId: string | null;
  readonly localVault: LocalVaultPresence;
  readonly state: "cold" | "warm";
}

export interface IwaWalletVaultLifecycleDependencies {
  openStore(): Promise<WalletVaultStore>;
  createPasskey(): WalletPasskeyEnrollmentAuthority;
  rpId(): string;
  passwordKdf?: () => PasswordKdfPolicy;
  timeout?: VaultTimeout;
  idleTimeoutMs?: number;
}

export interface ProvisionLocalVaultInput {
  walletId: string;
  password: string;
  pin: string;
}

export interface UnlockLocalVaultInput {
  walletId: string;
  password: string;
}

function fail(code: VaultError["code"] = "authentication_failed"): never {
  throw new VaultError(code);
}

function wipe(value: Uint8Array | undefined): void {
  value?.fill(0);
}

/** An opaque capability remains module-private and is never put on a lifecycle object or React state. */
const warmSessionForLifecycle = new WeakMap<IwaWalletVaultLifecycle, WalletVaultSession>();

/**
 * A non-React owner for the local vault lifecycle.
 *
 * It is intentionally not a signer facade. B1-B creates only an empty
 * encrypted container, and this object exposes no plaintext authority or
 * opaque session capability to UI callers.
 */
export class IwaWalletVaultLifecycle {
  private vault: WalletVault | null = null;
  private walletId: string | null = null;
  private localVault: LocalVaultPresence = "unknown";
  private operationEpoch = 0;

  constructor(private readonly dependencies: IwaWalletVaultLifecycleDependencies) {}

  view(): PublicWalletVaultState {
    return Object.freeze({
      walletId: this.walletId,
      localVault: this.localVault,
      state: this.vault?.state() === "warm" ? "warm" : "cold",
    });
  }

  /** Detects an existing encrypted container without attempting to unlock it. */
  async inspect(walletId: string): Promise<PublicWalletVaultState> {
    this.lock();
    const epoch = this.operationEpoch;
    const store = await this.dependencies.openStore();
    const existing = await store.load(walletId);
    this.assertCurrent(epoch);
    this.walletId = walletId;
    this.localVault = existing === null ? "absent" : "present";
    return this.view();
  }

  /**
   * Creates precisely one empty local encrypted container. `authorities: []`
   * is deliberate: B1-B does not generate any blockchain authority.
   */
  async provision(input: ProvisionLocalVaultInput): Promise<void> {
    this.lock();
    const epoch = this.operationEpoch;
    const store = await this.dependencies.openStore();
    this.assertCurrent(epoch);
    if ((await store.load(input.walletId)) !== null) {
      this.assertCurrent(epoch);
      // Retry is intentionally idempotent after a lost server response: it
      // proves wallet authority by cold-unlocking the same container and never
      // enrolls a second passkey or overwrites the encrypted record.
      await this.unlock({ walletId: input.walletId, password: input.password });
      await this.setWarmPin(input.pin);
      return;
    }

    const passkey = this.dependencies.createPasskey();
    let metadata: WalletPasskeyMetadata | undefined;
    let vault: WalletVault | undefined;
    let published = false;
    try {
      metadata = await passkey.enroll(this.dependencies.rpId());
      this.assertCurrent(epoch);
      vault = this.newVault(store, passkey);
      await vault.create({
        walletId: input.walletId,
        password: input.password,
        passkey: metadata,
        authorities: [],
      });
      this.assertCurrent(epoch);
      const session = await vault.unlock({ walletId: input.walletId, password: input.password });
      this.assertCurrent(epoch);
      await vault.setPin(session, input.pin);
      this.assertCurrent(epoch);
      this.vault = vault;
      warmSessionForLifecycle.set(this, session);
      this.walletId = input.walletId;
      this.localVault = "present";
      published = true;
    } finally {
      // The persisted root record owns an encoded copy. The enrollment result
      // itself must not outlive setup page memory.
      wipe(metadata?.prfInput);
      if (!published) vault?.lock();
    }
  }

  /** Password plus a fresh dedicated wallet-passkey assertion, never PIN, cold-unlocks the vault. */
  async unlock(input: UnlockLocalVaultInput): Promise<void> {
    this.lock();
    const epoch = this.operationEpoch;
    const store = await this.dependencies.openStore();
    this.assertCurrent(epoch);
    if ((await store.load(input.walletId)) === null) fail("invalid_record");
    this.assertCurrent(epoch);
    const passkey = this.dependencies.createPasskey();
    const vault = this.newVault(store, passkey);
    let published = false;
    try {
      const session = await vault.unlock(input);
      this.assertCurrent(epoch);
      this.vault = vault;
      warmSessionForLifecycle.set(this, session);
      this.walletId = input.walletId;
      this.localVault = "present";
      published = true;
    } finally {
      if (!published) vault.lock();
    }
  }

  private async setWarmPin(pin: string): Promise<void> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined) fail();
    await this.vault.setPin(session, pin);
  }

  /** Invalidates the underlying vault epoch and drops every local capability reference. */
  lock(): void {
    this.operationEpoch += 1;
    this.vault?.lock();
    this.vault = null;
    warmSessionForLifecycle.delete(this);
  }

  private newVault(store: WalletVaultStore, passkey: WalletPasskeyAuthority): WalletVault {
    return new WalletVault({
      store,
      passkey,
      ...(this.dependencies.passwordKdf === undefined ? {} : { passwordKdf: this.dependencies.passwordKdf }),
      ...(this.dependencies.timeout === undefined ? {} : { timeout: this.dependencies.timeout }),
      ...(this.dependencies.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.dependencies.idleTimeoutMs }),
    });
  }

  private assertCurrent(epoch: number): void {
    if (this.operationEpoch !== epoch) fail();
  }
}
