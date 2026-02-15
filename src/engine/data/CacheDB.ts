export type CacheStoreName = 'raw_query_cache' | 'normalized_tile_cache';

export interface CacheEnvelope<TPayload> {
  readonly key: string;
  readonly payload: TPayload;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastAccessedAt: number;
  readonly expiresAt: number;
  readonly byteSize: number;
}

export interface CacheStoreStats {
  readonly entries: number;
  readonly totalBytes: number;
  readonly oldestUpdatedAt: number | null;
}

interface CacheEnvelopeMeta {
  readonly key: string;
  readonly lastAccessedAt: number;
  readonly expiresAt: number;
}

const DATABASE_NAME = 'worldrace-cache';
const DATABASE_VERSION = 1;

export class CacheDB {
  private databasePromise: Promise<IDBDatabase> | null = null;

  public async get<TPayload>(
    storeName: CacheStoreName,
    key: string,
  ): Promise<CacheEnvelope<TPayload> | undefined> {
    const database = await this.getDatabase();
    const transaction = database.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request: IDBRequest<unknown> = store.get(key);
    const result = await this.requestToPromise<CacheEnvelope<TPayload> | undefined>(request);
    await this.transactionDone(transaction);
    return result;
  }

  public async put<TPayload>(storeName: CacheStoreName, value: CacheEnvelope<TPayload>): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    store.put(value);
    await this.transactionDone(transaction);
  }

  public async touch(storeName: CacheStoreName, key: string, touchedAt: number): Promise<void> {
    const record = await this.get<unknown>(storeName, key);
    if (record === undefined) {
      return;
    }

    await this.put(storeName, {
      ...record,
      lastAccessedAt: touchedAt,
    });
  }

  public async delete(storeName: CacheStoreName, key: string): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    store.delete(key);
    await this.transactionDone(transaction);
  }

  public async getStoreStats(storeName: CacheStoreName): Promise<CacheStoreStats> {
    const values = await this.getAll<unknown>(storeName);
    let totalBytes = 0;
    let oldestUpdatedAt: number | null = null;

    for (const entry of values) {
      totalBytes += entry.byteSize;
      if (oldestUpdatedAt === null || entry.updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = entry.updatedAt;
      }
    }

    return {
      entries: values.length,
      totalBytes,
      oldestUpdatedAt,
    };
  }

  public async removeExpired(storeName: CacheStoreName, now: number): Promise<number> {
    const values = await this.getAll<unknown>(storeName);
    const expired = values.filter((entry) => entry.expiresAt <= now);
    await Promise.all(expired.map((entry) => this.delete(storeName, entry.key)));
    return expired.length;
  }

  public async enforceMaxEntries(storeName: CacheStoreName, maxEntries: number): Promise<number> {
    if (maxEntries <= 0) {
      return 0;
    }

    const values = await this.getAll<unknown>(storeName);
    if (values.length <= maxEntries) {
      return 0;
    }

    const ordered = values
      .map<CacheEnvelopeMeta>((entry) => ({
        key: entry.key,
        lastAccessedAt: entry.lastAccessedAt,
        expiresAt: entry.expiresAt,
      }))
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt || left.expiresAt - right.expiresAt);

    const toRemove = ordered.slice(0, values.length - maxEntries);
    await Promise.all(toRemove.map((entry) => this.delete(storeName, entry.key)));
    return toRemove.length;
  }

  private async getAll<TPayload>(storeName: CacheStoreName): Promise<CacheEnvelope<TPayload>[]> {
    const database = await this.getDatabase();
    const transaction = database.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request: IDBRequest<unknown> = store.getAll();
    const result = await this.requestToPromise<CacheEnvelope<TPayload>[]>(request);
    await this.transactionDone(transaction);
    return result;
  }

  private async getDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise !== null) {
      return this.databasePromise;
    }

    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('raw_query_cache')) {
          database.createObjectStore('raw_query_cache', { keyPath: 'key' });
        }

        if (!database.objectStoreNames.contains('normalized_tile_cache')) {
          database.createObjectStore('normalized_tile_cache', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('Failed to open IndexedDB.'));
      };
    });

    return this.databasePromise;
  }

  private requestToPromise<T>(request: IDBRequest<unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result as T);
      };

      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB request failed.'));
      };
    });
  }

  private transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onabort = () => {
        reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
      };
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
      };
    });
  }
}
