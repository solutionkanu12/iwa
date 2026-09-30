import {
  VaultError,
  type PasswordKdfPolicy,
  type WalletPasskeyMetadata,
} from "../lib/walletVault/vaultCrypto";
import type { WalletVaultStore } from "../lib/walletVault/vaultStore";
import {
  verifyRecoveryPackage,
  type RecoveryPackageV1,
  type RecoveryPackageVerification,
} from "../lib/walletVault/recoveryPackage";
import {
  WalletVault,
  type DiscoverStrk20PrivateStateInput,
  type DeployStarknetAccountInput,
  type MarkStarknetAccountDeployedInput,
  type ProvisionStrk20ViewingAuthorityInput,
  type ProvisionStarknetAuthorityInput,
  type RegisterStrk20ViewingAuthorityInput,
  type SignStarknetAuthorityProofInput,
  type StarknetAccountDeploymentResult,
  type VaultTimeout,
  type WalletPasskeyAuthority,
  type WalletVaultSession,
} from "../lib/walletVault/walletVault";
import type { StarknetAccountDescriptor, StarknetAuthoritySignature } from "../lib/walletVault/starknetAuthority";
import type { Strk20ViewingDescriptor } from "../lib/walletVault/strk20ViewingAuthority";
import type { Strk20PrivateStateSummary } from "../lib/walletVault/strk20PrivacyRuntime";

/** Browser passkey boundary needed only while creating the dedicated wallet credential. */
export interface WalletPasskeyEnrollmentAuthority extends WalletPasskeyAuthority {
  enroll(rpId: string): Promise<WalletPasskeyMetadata>;
}

export type LocalVaultPresence = "unknown" | "absent" | "present" | "corrupt" | "conflict";

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

export interface ExportRecoveryPackageInput {
  walletId: string;
  recoveryKey: Uint8Array;
  packageId: string;
}

export interface VerifyRecoveryPackageInput {
  recovery: RecoveryPackageV1;
  recoveryKey: Uint8Array;
  walletId: string;
  generation: number;
}

export interface RecoverLocalVaultInput {
  recovery: RecoveryPackageV1;
  recoveryKey: Uint8Array;
  walletId: string;
  expectedGeneration: number;
  password: string;
  pin: string;
  replacementPackageId: string;
}

export type ProvisionLocalStarknetAuthorityInput = ProvisionStarknetAuthorityInput;
export type MarkLocalStarknetAccountDeployedInput = MarkStarknetAccountDeployedInput;
export type SignLocalStarknetAuthorityProofInput = SignStarknetAuthorityProofInput;
export type DeployLocalStarknetAccountInput = DeployStarknetAccountInput;
export type ProvisionLocalStrk20ViewingAuthorityInput = ProvisionStrk20ViewingAuthorityInput;
export type RegisterLocalStrk20ViewingAuthorityInput = RegisterStrk20ViewingAuthorityInput;
export type DiscoverLocalStrk20PrivateStateInput = DiscoverStrk20PrivateStateInput;

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
  /** A transitional vault is lockable before it is allowed to publish warm state. */
  private inFlightVault: WalletVault | null = null;
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
    const presence = await this.storedPresence(store, walletId);
    this.assertCurrent(epoch);
    this.walletId = walletId;
    this.localVault = presence;
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

  /** Exports only an encrypted package. The user-held recovery key stays outside this object. */
  async exportRecovery(input: ExportRecoveryPackageInput): Promise<RecoveryPackageV1> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    const key = new Uint8Array(input.recoveryKey);
    try {
      return await this.vault.exportRecovery(session, input.walletId, key, input.packageId);
    } finally {
      wipe(key);
    }
  }

  /**
   * Validates a user-selected backup against the live local generation without
   * giving root or authority plaintext to the caller.
   */
  async verifyRecovery(input: VerifyRecoveryPackageInput): Promise<RecoveryPackageVerification> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    const localGeneration = this.vault.recoveryGeneration(session, input.walletId);
    if (input.generation !== localGeneration) fail();
    return verifyRecoveryPackage(input.recovery, input.recoveryKey, {
      walletId: input.walletId,
      generation: localGeneration,
    });
  }

  /** Adds a real encrypted Starknet scalar without exposing it to React or callers. */
  async provisionStarknetAuthority(input: ProvisionLocalStarknetAuthorityInput): Promise<StarknetAccountDescriptor> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    return this.vault.provisionStarknetAuthority(session, input);
  }

  /** Returns only public descriptor facts for server-side coordination. */
  starknetAccountDescriptor(walletId: string): StarknetAccountDescriptor | null {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== walletId) fail();
    return this.vault.starknetAccountDescriptor(session, walletId);
  }

  /** Bounded proof operation; neither caller nor UI receives a scalar. */
  signStarknetAuthorityProof(input: SignLocalStarknetAuthorityProofInput): StarknetAuthoritySignature {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    return this.vault.signStarknetAuthorityProof(session, input);
  }

  async markStarknetAccountDeployed(input: MarkLocalStarknetAccountDeployedInput): Promise<StarknetAccountDescriptor> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    return this.vault.markStarknetAccountDeployed(session, input);
  }

  async deployStarknetAccount(input: DeployLocalStarknetAccountInput): Promise<StarknetAccountDeploymentResult> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    return this.vault.deployStarknetAccount(session, input);
  }

  /** Adds the independent encrypted STRK20 viewing authority without exposing its scalar. */
  async provisionStrk20ViewingAuthority(input: ProvisionLocalStrk20ViewingAuthorityInput): Promise<Strk20ViewingDescriptor> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    return this.vault.provisionStrk20ViewingAuthority(session, input);
  }

  /** Public setup facts only. The viewing scalar remains module-private. */
  strk20ViewingAuthorityDescriptor(walletId: string): Strk20ViewingDescriptor | null {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== walletId) fail();
    return this.vault.strk20ViewingAuthorityDescriptor(session, walletId);
  }

  /** Registers only the existing local viewing authority through the embedded signer path. */
  async registerStrk20ViewingAuthority(input: RegisterLocalStrk20ViewingAuthorityInput): Promise<Strk20ViewingDescriptor> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    return this.vault.registerStrk20ViewingAuthority(session, input);
  }

  /** Returns only a minimized private-state summary. Raw notes never leave the vault adapter. */
  async discoverStrk20PrivateState(input: DiscoverLocalStrk20PrivateStateInput): Promise<Strk20PrivateStateSummary> {
    const session = warmSessionForLifecycle.get(this);
    if (this.vault === null || session === undefined || this.walletId !== input.walletId) fail();
    return this.vault.discoverStrk20PrivateState(session, input);
  }

  /**
   * Rewraps a verified portable package on a device that holds no existing
   * container. Recovery is an explicit replacement flow: a healthy local
   * vault is never overwritten, and the imported root is immediately wrapped
   * with a newly enrolled wallet passkey, password, and device-local PIN.
   */
  async recover(input: RecoverLocalVaultInput): Promise<RecoveryPackageV1> {
    this.lock();
    const epoch = this.operationEpoch;
    const store = await this.dependencies.openStore();
    this.assertCurrent(epoch);
    const localPresence = await this.storedPresence(store, input.walletId);
    if (localPresence === "present" || localPresence === "conflict") fail("authentication_failed");
    this.assertCurrent(epoch);

    const key = new Uint8Array(input.recoveryKey);
    let verification: RecoveryPackageVerification | undefined;
    let metadata: WalletPasskeyMetadata | undefined;
    let vault: WalletVault | undefined;
    let published = false;
    try {
      verification = await verifyRecoveryPackage(input.recovery, key, {
        walletId: input.walletId,
        generation: input.expectedGeneration,
      });
      this.assertCurrent(epoch);
      // A caller reaches this path only after explicitly selecting recovery.
      // A malformed same-wallet record cannot be unlocked and would block the
      // insert-only import, so remove it only after package possession has
      // already been proven. Healthy and different-wallet records were
      // rejected above and never reach this deletion.
      if (localPresence === "corrupt") {
        await store.remove(input.walletId);
        this.assertCurrent(epoch);
      }

      const passkey = this.dependencies.createPasskey();
      metadata = await passkey.enroll(this.dependencies.rpId());
      this.assertCurrent(epoch);
      vault = this.newVault(store, passkey);
      this.inFlightVault = vault;
      const replacement = await vault.importRecovery({
        recovery: input.recovery,
        recoveryKey: key,
        password: input.password,
        passkey: metadata,
        replacementPackageId: input.replacementPackageId,
      });
      this.assertCurrent(epoch);
      const session = await vault.unlock({ walletId: input.walletId, password: input.password });
      this.assertCurrent(epoch);
      await vault.setPin(session, input.pin);
      this.assertCurrent(epoch);
      this.vault = vault;
      this.inFlightVault = null;
      warmSessionForLifecycle.set(this, session);
      this.walletId = verification.walletId;
      this.localVault = "present";
      published = true;
      return replacement;
    } finally {
      wipe(key);
      wipe(metadata?.prfInput);
      if (this.inFlightVault === vault) this.inFlightVault = null;
      if (!published) vault?.lock();
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
    this.inFlightVault?.lock();
    this.inFlightVault = null;
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

  private async storedPresence(store: WalletVaultStore, walletId: string): Promise<Exclude<LocalVaultPresence, "unknown">> {
    if (await store.hasOtherWallet(walletId)) return "conflict";
    try {
      return (await store.load(walletId)) === null ? "absent" : "present";
    } catch (error) {
      if (error instanceof VaultError && (error.code === "invalid_record" || error.code === "authentication_failed")) {
        return "corrupt";
      }
      throw error;
    }
  }

  private assertCurrent(epoch: number): void {
    if (this.operationEpoch !== epoch) fail();
  }
}
