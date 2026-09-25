import { VaultError, validateRootWrap, type RootWrapRecordV1 } from "./vaultCrypto";

const DATABASE_NAME = "iwa-wallet-vault";
const DATABASE_VERSION = 1;
const VAULT_STORE = "vaults";

export interface WalletVaultStore {
  load(walletId: string): Promise<RootWrapRecordV1 | null>;
  save(record: RootWrapRecordV1): Promise<void>;
  remove(walletId: string): Promise<void>;
}

function fail(code: VaultError["code"] = "invalid_record"): never {
  throw new VaultError(code);
}

function assertWalletId(walletId: string): void {
  if (walletId.length === 0 || walletId.length > 256 || walletId.includes("|")) fail("invalid_input");
}

function cloneRecord(value: unknown): RootWrapRecordV1 {
  try {
    return validateRootWrap(JSON.parse(JSON.stringify(value)));
  } catch (error) {
    if (error instanceof VaultError) throw error;
    fail();
  }
}

function recordForWallet(walletId: string, value: unknown): RootWrapRecordV1 {
  assertWalletId(walletId);
  const record = cloneRecord(value);
  if (record.walletId !== walletId) fail("authentication_failed");
  return record;
}

/** Memory-only store used by unit tests; it is never selected by browser code. */
export class InMemoryVaultStore implements WalletVaultStore {
  readonly unsafeRecords = new Map<string, unknown>();

  async load(walletId: string): Promise<RootWrapRecordV1 | null> {
    const value = this.unsafeRecords.get(walletId);
    return value === undefined ? null : recordForWallet(walletId, value);
  }

  async save(record: RootWrapRecordV1): Promise<void> {
    const valid = recordForWallet(record.walletId, record);
    this.unsafeRecords.set(valid.walletId, cloneRecord(valid));
  }

  async remove(walletId: string): Promise<void> {
    assertWalletId(walletId);
    this.unsafeRecords.delete(walletId);
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new VaultError("unavailable"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new VaultError("unavailable"));
    transaction.onabort = () => reject(new VaultError("unavailable"));
  });
}

export class IndexedDbVaultStore implements WalletVaultStore {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<IndexedDbVaultStore> {
    if (typeof indexedDB === "undefined") throw new VaultError("unavailable");
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(VAULT_STORE)) database.createObjectStore(VAULT_STORE);
    };
    try {
      return new IndexedDbVaultStore(await requestResult(request));
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable");
    }
  }

  async load(walletId: string): Promise<RootWrapRecordV1 | null> {
    assertWalletId(walletId);
    try {
      const transaction = this.database.transaction(VAULT_STORE, "readonly");
      const value = await requestResult(transaction.objectStore(VAULT_STORE).get(walletId));
      await transactionComplete(transaction);
      return value === undefined ? null : recordForWallet(walletId, value);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable");
    }
  }

  async save(record: RootWrapRecordV1): Promise<void> {
    const valid = recordForWallet(record.walletId, record);
    try {
      const transaction = this.database.transaction(VAULT_STORE, "readwrite");
      transaction.objectStore(VAULT_STORE).put(cloneRecord(valid), valid.walletId);
      await transactionComplete(transaction);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable");
    }
  }

  async remove(walletId: string): Promise<void> {
    assertWalletId(walletId);
    try {
      const transaction = this.database.transaction(VAULT_STORE, "readwrite");
      transaction.objectStore(VAULT_STORE).delete(walletId);
      await transactionComplete(transaction);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable");
    }
  }
}
