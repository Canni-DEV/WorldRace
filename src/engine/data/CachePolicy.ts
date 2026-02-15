import type { CacheDB, CacheStoreName } from './CacheDB';

export interface CachePolicyConfig {
  readonly normalizedStoreMaxEntries: number;
  readonly rawStoreMaxEntries: number;
  readonly ttlMs: number;
}

export const defaultCachePolicyConfig: CachePolicyConfig = {
  normalizedStoreMaxEntries: 500,
  rawStoreMaxEntries: 150,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
};

export class CachePolicy {
  private readonly database: CacheDB;
  private readonly config: CachePolicyConfig;

  public constructor(database: CacheDB, config: CachePolicyConfig = defaultCachePolicyConfig) {
    this.database = database;
    this.config = config;
  }

  public getTtlMs(): number {
    return this.config.ttlMs;
  }

  public async applyCleanup(now: number): Promise<void> {
    await this.cleanupStore('normalized_tile_cache', this.config.normalizedStoreMaxEntries, now);
    await this.cleanupStore('raw_query_cache', this.config.rawStoreMaxEntries, now);
  }

  private async cleanupStore(storeName: CacheStoreName, maxEntries: number, now: number): Promise<void> {
    await this.database.removeExpired(storeName, now);
    await this.database.enforceMaxEntries(storeName, maxEntries);
  }
}
