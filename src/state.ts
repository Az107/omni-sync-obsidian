/**
 * Per-vault sync state, in IndexedDB.
 *
 * Not in `data.json`: that file lives inside the vault and would be synced by
 * Obsidian Sync or iCloud before this plugin ever sees it. The device token in
 * particular must never leave the device that enrolled, so it is kept here,
 * keyed by a vault id that lives in the plugin's settings.
 */

import type { ChunkRefDto, LogEntryDto } from "./api";

/** What this device last synced for one path. */
export interface FileRecord {
  path: string;
  versionId: number;
  size: number;
  /** Local mtime in milliseconds; exact enough for metadata triage. */
  mtimeMs: number;
  chunks: ChunkRefDto[];
}

/**
 * A pulled op held back because its file is open in an editor.
 *
 * Persisted so closing the app does not lose it: the watermark already moved
 * past the op, so without this record the update would never be applied.
 */
export interface PendingRecord {
  path: string;
  entry: LogEntryDto;
}

const DB_VERSION = 2;
const KV = "kv";
const FILES = "files";
const PENDING = "pending";

const TOKEN = "token";
const DEVICE_ID = "device_id";
const APPLIED_SEQ = "applied_seq";

export class State {
  private constructor(private readonly db: IDBDatabase) {}

  static open(vaultId: string): Promise<State> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`omni-sync:${vaultId}`, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(FILES)) {
          db.createObjectStore(FILES, { keyPath: "path" });
        }
        if (!db.objectStoreNames.contains(PENDING)) {
          db.createObjectStore(PENDING, { keyPath: "path" });
        }
      };
      request.onsuccess = () => resolve(new State(request.result));
      request.onerror = () =>
        reject(request.error ?? new Error("could not open the sync database"));
    });
  }

  close(): void {
    this.db.close();
  }

  async token(): Promise<string | undefined> {
    return this.get<string>(TOKEN);
  }

  async setToken(token: string): Promise<void> {
    await this.set(TOKEN, token);
  }

  async deviceId(): Promise<string | undefined> {
    return this.get<string>(DEVICE_ID);
  }

  async setDeviceId(deviceId: string): Promise<void> {
    await this.set(DEVICE_ID, deviceId);
  }

  async appliedSeq(): Promise<number> {
    return (await this.get<number>(APPLIED_SEQ)) ?? 0;
  }

  async setAppliedSeq(seq: number): Promise<void> {
    await this.set(APPLIED_SEQ, seq);
  }

  async getFile(path: string): Promise<FileRecord | undefined> {
    return (await this.request<FileRecord | undefined>(FILES, "readonly", (store) =>
      store.get(path),
    )) as FileRecord | undefined;
  }

  async allFiles(): Promise<Map<string, FileRecord>> {
    const records = (await this.request<FileRecord[]>(FILES, "readonly", (store) =>
      store.getAll(),
    )) as FileRecord[];
    const map = new Map<string, FileRecord>();
    for (const record of records) map.set(record.path, record);
    return map;
  }

  async setFile(record: FileRecord): Promise<void> {
    await this.request(FILES, "readwrite", (store) => store.put(record));
  }

  async removeFile(path: string): Promise<void> {
    await this.request(FILES, "readwrite", (store) => store.delete(path));
  }

  async getPending(path: string): Promise<PendingRecord | undefined> {
    return (await this.request<PendingRecord | undefined>(PENDING, "readonly", (store) =>
      store.get(path),
    )) as PendingRecord | undefined;
  }

  async allPending(): Promise<PendingRecord[]> {
    return (await this.request<PendingRecord[]>(PENDING, "readonly", (store) =>
      store.getAll(),
    )) as PendingRecord[];
  }

  async setPending(record: PendingRecord): Promise<void> {
    await this.request(PENDING, "readwrite", (store) => store.put(record));
  }

  async removePending(path: string): Promise<void> {
    await this.request(PENDING, "readwrite", (store) => store.delete(path));
  }

  /** Forget everything except the token and device id (a re-pair or a reset). */
  async reset(): Promise<void> {
    await this.request(FILES, "readwrite", (store) => store.clear());
    await this.request(PENDING, "readwrite", (store) => store.clear());
    await this.setAppliedSeq(0);
  }

  /** Forget everything, including the token: the next use must pair again. */
  async unpair(): Promise<void> {
    await this.request(FILES, "readwrite", (store) => store.clear());
    await this.request(PENDING, "readwrite", (store) => store.clear());
    await this.request(KV, "readwrite", (store) => store.clear());
  }

  private async get<T>(key: string): Promise<T | undefined> {
    return (await this.request<T | undefined>(KV, "readonly", (store) =>
      store.get(key),
    )) as T | undefined;
  }

  private async set(key: string, value: unknown): Promise<void> {
    await this.request(KV, "readwrite", (store) => store.put(value, key));
  }

  private async request<T>(
    storeName: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const transaction = this.db.transaction(storeName, mode);
    const request = work(transaction.objectStore(storeName));
    const value = await wrap(request);
    // `put`/`delete` resolve before the transaction commits.
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("indexeddb transaction failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("indexeddb transaction aborted"));
    });
    return value;
  }
}

function wrap<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexeddb request failed"));
  });
}
