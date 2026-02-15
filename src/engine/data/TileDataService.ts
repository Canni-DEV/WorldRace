import { CacheDB, type CacheEnvelope, type CacheStoreStats } from './CacheDB';
import { CachePolicy, defaultCachePolicyConfig } from './CachePolicy';
import {
  OverpassClient,
  type OverpassGeometryPoint,
  type OverpassResponse,
} from './OverpassClient';
import type { Projection } from '../geo/Projection';
import type {
  BuildingFeature,
  CacheMetricsSnapshot,
  PointMeters,
  RoadFeature,
  TileFetchParams,
  TileFetchResult,
  TileOSMData,
} from './Types';

const NORMALIZED_SCHEMA_VERSION = 'tile-osm-v3';
const OVERPASS_SOURCE_VERSION = 'overpass-roads-buildings-v1';
const STATS_REFRESH_INTERVAL_MS = 2500;
type OverpassWayElement = Extract<OverpassResponse['elements'][number], { type: 'way' }>;

interface TileDataServiceConfig {
  readonly staleWhileRevalidate: boolean;
  readonly cacheTtlMs: number;
}

const defaultServiceConfig: TileDataServiceConfig = {
  staleWhileRevalidate: true,
  cacheTtlMs: defaultCachePolicyConfig.ttlMs,
};

interface MutableMetrics {
  hits: number;
  misses: number;
  staleHits: number;
  lastEntryAgeMs: number | null;
  normalizedStoreEntries: number;
  normalizedStoreBytes: number;
  rawStoreEntries: number;
  rawStoreBytes: number;
  lastSource: TileFetchResult['source'] | 'none';
}

export class TileDataService {
  private readonly overpassClient: OverpassClient;
  private readonly cacheDatabase: CacheDB;
  private readonly cachePolicy: CachePolicy;
  private readonly normalizationProjection: Projection;
  private readonly config: TileDataServiceConfig;
  private readonly inflightByKey = new Map<string, Promise<TileFetchResult>>();
  private readonly revalidateInFlight = new Set<string>();
  private readonly metrics: MutableMetrics = {
    hits: 0,
    misses: 0,
    staleHits: 0,
    lastEntryAgeMs: null,
    normalizedStoreEntries: 0,
    normalizedStoreBytes: 0,
    rawStoreEntries: 0,
    rawStoreBytes: 0,
    lastSource: 'none',
  };
  private lastStatsUpdateAt = 0;

  public constructor(normalizationProjection: Projection, config: Partial<TileDataServiceConfig> = {}) {
    this.normalizationProjection = normalizationProjection;
    this.overpassClient = new OverpassClient();
    this.cacheDatabase = new CacheDB();
    this.cachePolicy = new CachePolicy(this.cacheDatabase, {
      ...defaultCachePolicyConfig,
      ttlMs: config.cacheTtlMs ?? defaultServiceConfig.cacheTtlMs,
    });
    this.config = {
      staleWhileRevalidate: config.staleWhileRevalidate ?? defaultServiceConfig.staleWhileRevalidate,
      cacheTtlMs: config.cacheTtlMs ?? defaultServiceConfig.cacheTtlMs,
    };
  }

  public async getOrFetchTile(params: TileFetchParams): Promise<TileFetchResult> {
    const cacheKey = this.buildVersionedKey(params.tileKey);
    const now = Date.now();
    const cached = await this.cacheDatabase.get<TileOSMData>('normalized_tile_cache', cacheKey);

    if (cached !== undefined) {
      this.metrics.hits += 1;
      this.metrics.lastEntryAgeMs = Math.max(0, now - cached.updatedAt);
      await this.cacheDatabase.touch('normalized_tile_cache', cacheKey, now);

      if (cached.expiresAt > now) {
        this.metrics.lastSource = 'cache-fresh';
        await this.maybeRefreshStoreStats(now);
        return {
          data: cached.payload,
          source: 'cache-fresh',
        };
      }

      if (this.config.staleWhileRevalidate) {
        this.metrics.staleHits += 1;
        this.metrics.lastSource = 'cache-stale';
        this.scheduleRevalidate(params, cacheKey);
        await this.maybeRefreshStoreStats(now);
        return {
          data: cached.payload,
          source: 'cache-stale',
        };
      }
    }

    this.metrics.misses += 1;
    return this.fetchAndCacheWithInFlight(params, cacheKey);
  }

  public getMetricsSnapshot(): CacheMetricsSnapshot {
    const totalLookups = this.metrics.hits + this.metrics.misses;
    const hitRatio = totalLookups === 0 ? 0 : this.metrics.hits / totalLookups;

    return {
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      staleHits: this.metrics.staleHits,
      hitRatio,
      lastEntryAgeMs: this.metrics.lastEntryAgeMs,
      normalizedStoreEntries: this.metrics.normalizedStoreEntries,
      normalizedStoreBytes: this.metrics.normalizedStoreBytes,
      rawStoreEntries: this.metrics.rawStoreEntries,
      rawStoreBytes: this.metrics.rawStoreBytes,
      lastSource: this.metrics.lastSource,
    };
  }

  private async fetchAndCacheWithInFlight(
    params: TileFetchParams,
    cacheKey: string,
  ): Promise<TileFetchResult> {
    const existing = this.inflightByKey.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }

    const requestPromise = this.fetchAndCache(params, cacheKey).finally(() => {
      this.inflightByKey.delete(cacheKey);
    });
    this.inflightByKey.set(cacheKey, requestPromise);
    return requestPromise;
  }

  private scheduleRevalidate(params: TileFetchParams, cacheKey: string): void {
    if (this.revalidateInFlight.has(cacheKey)) {
      return;
    }

    this.revalidateInFlight.add(cacheKey);
    void this.fetchAndCache(params, cacheKey)
      .catch(() => undefined)
      .finally(() => {
        this.revalidateInFlight.delete(cacheKey);
      });
  }

  private async fetchAndCache(params: TileFetchParams, cacheKey: string): Promise<TileFetchResult> {
    const fetchResult = await this.overpassClient.fetchTileData(params.bbox);
    const normalized = this.normalizeTilePayload(
      params,
      fetchResult.response,
      fetchResult.endpoint,
      fetchResult.fetchedAt,
    );
    const now = Date.now();

    await this.cacheDatabase.put('raw_query_cache', this.createEnvelope(cacheKey, fetchResult.response, now));
    await this.cacheDatabase.put('normalized_tile_cache', this.createEnvelope(cacheKey, normalized, now));
    await this.cachePolicy.applyCleanup(now);
    await this.refreshStoreStats();

    this.metrics.lastSource = 'network';
    this.metrics.lastEntryAgeMs = 0;

    return {
      data: normalized,
      source: 'network',
    };
  }

  private normalizeTilePayload(
    params: TileFetchParams,
    payload: OverpassResponse,
    endpoint: string,
    fetchedAt: number,
  ): TileOSMData {
    const roads: RoadFeature[] = [];
    const buildings: BuildingFeature[] = [];

    for (const element of payload.elements) {
      if (element.type !== 'way') {
        continue;
      }

      const way = element;
      const geometry = this.normalizeGeometry(
        way.geometry ?? [],
        params.tileOriginGlobalMeters.east,
        params.tileOriginGlobalMeters.north,
      );

      if (this.isRoadWay(way) && geometry.length >= 2) {
        roads.push({
          id: `way/${way.id}`,
          points: geometry,
          properties: {
            highway: way.tags?.highway ?? 'unclassified',
            widthMeters: this.parseWidthMeters(way.tags?.width ?? null),
            lanes: this.parsePositiveInteger(way.tags?.lanes ?? null),
            oneway: this.parseOnewayTag(way.tags?.oneway ?? null),
            maxspeed: way.tags?.maxspeed ?? null,
          },
        });
      }

      if (this.isBuildingWay(way) && geometry.length >= 3) {
        buildings.push({
          id: `way/${way.id}`,
          footprint: this.ensureClosedPolygon(geometry),
          properties: {
            kind: way.tags?.building ?? 'yes',
            levels: this.parsePositiveInteger(way.tags?.['building:levels'] ?? null),
            heightMeters: this.parseHeightMeters(way.tags?.height ?? null),
          },
        });
      }
    }

    return {
      tileKey: params.tileKey,
      schemaVersion: NORMALIZED_SCHEMA_VERSION,
      sourceVersion: OVERPASS_SOURCE_VERSION,
      sourceEndpoint: endpoint,
      fetchedAt,
      bbox: params.bbox,
      tileOriginGlobalMeters: {
        east: params.tileOriginGlobalMeters.east,
        north: params.tileOriginGlobalMeters.north,
      },
      roads,
      buildings,
    };
  }

  private normalizeGeometry(
    geometry: readonly OverpassGeometryPoint[],
    tileOriginEast: number,
    tileOriginNorth: number,
  ): PointMeters[] {
    const points: PointMeters[] = [];
    for (const point of geometry) {
      const global = this.normalizationProjection.latLonToLocalMeters({
        latitude: point.lat,
        longitude: point.lon,
      });
      points.push({
        east: global.east - tileOriginEast,
        north: global.north - tileOriginNorth,
      });
    }
    return points;
  }

  private ensureClosedPolygon(points: readonly PointMeters[]): PointMeters[] {
    if (points.length === 0) {
      return [];
    }

    const first = points[0];
    const last = points[points.length - 1];
    if (first.east === last.east && first.north === last.north) {
      return [...points];
    }

    return [...points, first];
  }

  private createEnvelope<TPayload>(key: string, payload: TPayload, now: number): CacheEnvelope<TPayload> {
    const byteSize = this.estimateByteSize(payload);
    return {
      key,
      payload,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      expiresAt: now + this.cachePolicy.getTtlMs(),
      byteSize,
    };
  }

  private estimateByteSize(value: unknown): number {
    const serialized = JSON.stringify(value);
    return serialized.length;
  }

  private buildVersionedKey(tileKey: string): string {
    return `${tileKey}::schema=${NORMALIZED_SCHEMA_VERSION}::source=${OVERPASS_SOURCE_VERSION}`;
  }

  private isRoadWay(way: OverpassWayElement): boolean {
    return typeof way.tags?.highway === 'string';
  }

  private isBuildingWay(way: OverpassWayElement): boolean {
    return typeof way.tags?.building === 'string';
  }

  private parsePositiveInteger(value: string | null): number | null {
    if (value === null) {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private parseOnewayTag(value: string | null): boolean | null {
    if (value === null) {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'yes' || normalized === '1' || normalized === 'true') {
      return true;
    }

    if (normalized === 'no' || normalized === '0' || normalized === 'false') {
      return false;
    }

    return null;
  }

  private parseHeightMeters(value: string | null): number | null {
    if (value === null) {
      return null;
    }

    const match = /^-?\d+(\.\d+)?/.exec(value.trim());
    if (match === null) {
      return null;
    }

    const parsed = Number.parseFloat(match[0]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private parseWidthMeters(value: string | null): number | null {
    if (value === null) {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }

    const firstToken = normalized.split(';')[0] ?? normalized;
    const match = /^-?\d+(\.\d+)?/.exec(firstToken.trim());
    if (match === null) {
      return null;
    }

    const parsed = Number.parseFloat(match[0]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return parsed;
  }

  private async maybeRefreshStoreStats(now: number): Promise<void> {
    if (now - this.lastStatsUpdateAt < STATS_REFRESH_INTERVAL_MS) {
      return;
    }
    await this.refreshStoreStats();
  }

  private async refreshStoreStats(): Promise<void> {
    const normalizedStats = await this.cacheDatabase.getStoreStats('normalized_tile_cache');
    const rawStats = await this.cacheDatabase.getStoreStats('raw_query_cache');
    this.applyStoreStats(normalizedStats, rawStats);
    this.lastStatsUpdateAt = Date.now();
  }

  private applyStoreStats(normalized: CacheStoreStats, raw: CacheStoreStats): void {
    this.metrics.normalizedStoreEntries = normalized.entries;
    this.metrics.normalizedStoreBytes = normalized.totalBytes;
    this.metrics.rawStoreEntries = raw.entries;
    this.metrics.rawStoreBytes = raw.totalBytes;
  }
}
