import { VaultError, validateRootWrap, type RootWrapRecordV1 } from "./vaultCrypto";

const DATABASE_NAME = "iwa-wallet-vault";
const DATABASE_VERSION = 1;
const VAULT_STORE = "vaults";

export interface WalletVaultStore {
  load(walletId: string): Promise<RootWrapRecordV1 | null>;
  /** True when a browser profile contains any container other than this wallet. */
  hasOtherWallet(walletId: string): Promise<boolean>;
  /** Inserts once. Replacement is reserved for an explicit future migration flow. */
  create(record: RootWrapRecordV1): Promise<void>;
  /** Atomically replaces exactly the record previously read by a live vault operation. */
  replaceIfUnchanged(previous: RootWrapRecordV1, replacement: RootWrapRecordV1): Promise<boolean>;
  /** Removes only the exact record supplied; used to safely cancel a stale import. */
  removeIfUnchanged(record: RootWrapRecordV1): Promise<boolean>;
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

function sameRecord(first: RootWrapRecordV1, second: RootWrapRecordV1): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** Memory-only store used by unit tests; it is never selected by browser code. */
export class InMemoryVaultStore implements WalletVaultStore {
  readonly unsafeRecords = new Map<string, unknown>();

  async load(walletId: string): Promise<RootWrapRecordV1 | null> {
    const value = this.unsafeRecords.get(walletId);
    return value === undefined ? null : recordForWallet(walletId, value);
  }

  async hasOtherWallet(walletId: string): Promise<boolean> {
    assertWalletId(walletId);
    return [...this.unsafeRecords.keys()].some((key) => key !== walletId);
  }

  async create(record: RootWrapRecordV1): Promise<void> {
    const valid = recordForWallet(record.walletId, record);
    if (this.unsafeRecords.has(valid.walletId)) fail("authentication_failed");
    this.unsafeRecords.set(valid.walletId, cloneRecord(valid));
  }

  async removeIfUnchanged(record: RootWrapRecordV1): Promise<boolean> {
    const valid = recordForWallet(record.walletId, record);
    const current = this.unsafeRecords.get(valid.walletId);
    if (current === undefined || !sameRecord(recordForWallet(valid.walletId, current), valid)) return false;
    this.unsafeRecords.delete(valid.walletId);
    return true;
  }

  async replaceIfUnchanged(previous: RootWrapRecordV1, replacement: RootWrapRecordV1): Promise<boolean> {
    const validPrevious = recordForWallet(previous.walletId, previous);
    const validReplacement = recordForWallet(replacement.walletId, replacement);
    if (validPrevious.walletId !== validReplacement.walletId) fail("authentication_failed");
    const current = this.unsafeRecords.get(validPrevious.walletId);
    if (current === undefined || !sameRecord(recordForWallet(validPrevious.walletId, current), validPrevious)) return false;
    this.unsafeRecords.set(validPrevious.walletId, cloneRecord(validReplacement));
    return true;
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

  async hasOtherWallet(walletId: string): Promise<boolean> {
    assertWalletId(walletId);
    try {
      const transaction = this.database.transaction(VAULT_STORE, "readonly");
      const keys = await requestResult(transaction.objectStore(VAULT_STORE).getAllKeys());
      await transactionComplete(transaction);
      // A malformed non-string key is a conflict too. Recovery must never
      // guess which browser-profile record is safe to replace.
      return keys.some((key) => typeof key !== "string" || key !== walletId);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable");
    }
  }

  async create(record: RootWrapRecordV1): Promise<void> {
    const valid = recordForWallet(record.walletId, record);
    try {
      const transaction = this.database.transaction(VAULT_STORE, "readwrite");
      transaction.objectStore(VAULT_STORE).add(cloneRecord(valid), valid.walletId);
      await transactionComplete(transaction);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable");
    }
  }

  async removeIfUnchanged(record: RootWrapRecordV1): Promise<boolean> {
    const valid = recordForWallet(record.walletId, record);
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = this.database.transaction(VAULT_STORE, "readwrite");
        const store = transaction.objectStore(VAULT_STORE);
        let removed = false;
        const request = store.get(valid.walletId);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && sameRecord(recordForWallet(valid.walletId, request.result), valid)) {
              store.delete(valid.walletId);
              removed = true;
            }
          } catch {
            transaction.abort();
          }
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () => reject(new VaultError("unavailable"));
        transaction.onabort = () => reject(new VaultError("unavailable"));
      });
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable");
    }
  }

  async replaceIfUnchanged(previous: RootWrapRecordV1, replacement: RootWrapRecordV1): Promise<boolean> {
    const validPrevious = recordForWallet(previous.walletId, previous);
    const validReplacement = recordForWallet(replacement.walletId, replacement);
    if (validPrevious.walletId !== validReplacement.walletId) fail("authentication_failed");
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = this.database.transaction(VAULT_STORE, "readwrite");
        const store = transaction.objectStore(VAULT_STORE);
        let replaced = false;
        const request = store.get(validPrevious.walletId);
        request.onsuccess = () => {
          try {
            if (request.result !== undefined && sameRecord(recordForWallet(validPrevious.walletId, request.result), validPrevious)) {
              store.put(cloneRecord(validReplacement), validReplacement.walletId);
              replaced = true;
            }
          } catch {
            transaction.abort();
          }
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(replaced);
        transaction.onerror = () => reject(new VaultError("unavailable"));
        transaction.onabort = () => reject(new VaultError("unavailable"));
      });
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
