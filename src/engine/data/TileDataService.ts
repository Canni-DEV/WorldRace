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
  BuildingPolygon,
  CacheMetricsSnapshot,
  GeoBoundsLatLon,
  PointMeters,
  RoadFeature,
  TileFetchOptions,
  TileFetchParams,
  TileFetchResult,
  TileOSMData,
} from './Types';

const NORMALIZED_SCHEMA_VERSION = 'tile-osm-v6';
const OVERPASS_SOURCE_VERSION = 'overpass-roads-buildings-meta-v3';
const META_TILE_SCHEMA_VERSION = 'meta-tile-v3';
const STATS_REFRESH_INTERVAL_MS = 2500;

type OverpassWayElement = Extract<OverpassResponse['elements'][number], { type: 'way' }>;
type OverpassRelationElement = Extract<OverpassResponse['elements'][number], { type: 'relation' }>;

interface TileDataServiceConfig {
  readonly staleWhileRevalidate: boolean;
  readonly cacheTtlMs: number;
  readonly metaTileSpan: number;
  readonly metaTilePaddingMeters: number;
  readonly selectionPaddingMeters: number;
  readonly suspectEmptyRoadThreshold: number;
  readonly suspectNeighborRoadThreshold: number;
  readonly suspectRetryPaddingMeters: number;
}

interface MetaTileContext {
  readonly metaTileKey: string;
  readonly cacheKey: string;
  readonly tileSizeMeters: number;
  readonly span: number;
  readonly paddingMeters: number;
  readonly queryBounds: GeoBoundsLatLon;
  readonly globalBounds: {
    readonly minEast: number;
    readonly minNorth: number;
    readonly maxEast: number;
    readonly maxNorth: number;
  };
}

interface GlobalRoadFeature {
  readonly id: string;
  readonly globalPoints: readonly PointMeters[];
  readonly properties: RoadFeature['properties'];
}

interface GlobalBuildingFeature {
  readonly id: string;
  readonly polygons: readonly BuildingPolygon[];
  readonly properties: BuildingFeature['properties'];
}

interface MetaTilePayload {
  readonly metaTileKey: string;
  readonly schemaVersion: string;
  readonly sourceVersion: string;
  readonly sourceEndpoint: string;
  readonly fetchedAt: number;
  readonly queryBounds: GeoBoundsLatLon;
  readonly tileSizeMeters: number;
  readonly span: number;
  readonly paddingMeters: number;
  readonly globalBounds: {
    readonly minEast: number;
    readonly minNorth: number;
    readonly maxEast: number;
    readonly maxNorth: number;
  };
  readonly roads: readonly GlobalRoadFeature[];
  readonly buildings: readonly GlobalBuildingFeature[];
}

interface MetaTileFetchResult {
  readonly payload: MetaTilePayload;
  readonly source: TileFetchResult['source'];
}

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

const defaultServiceConfig: TileDataServiceConfig = {
  staleWhileRevalidate: true,
  cacheTtlMs: defaultCachePolicyConfig.ttlMs,
  metaTileSpan: 2,
  metaTilePaddingMeters: 50,
  selectionPaddingMeters: 3,
  suspectEmptyRoadThreshold: 2,
  suspectNeighborRoadThreshold: 12,
  suspectRetryPaddingMeters: 120,
};

export class TileDataService {
  private readonly overpassClient: OverpassClient;
  private readonly cacheDatabase: CacheDB;
  private readonly cachePolicy: CachePolicy;
  private readonly normalizationProjection: Projection;
  private readonly config: TileDataServiceConfig;
  private readonly inflightTileByKey = new Map<string, Promise<TileFetchResult>>();
  private readonly inflightMetaByKey = new Map<string, Promise<MetaTileFetchResult>>();
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
      metaTileSpan: Math.max(1, Math.floor(config.metaTileSpan ?? defaultServiceConfig.metaTileSpan)),
      metaTilePaddingMeters: Math.max(0, config.metaTilePaddingMeters ?? defaultServiceConfig.metaTilePaddingMeters),
      selectionPaddingMeters: Math.max(0, config.selectionPaddingMeters ?? defaultServiceConfig.selectionPaddingMeters),
      suspectEmptyRoadThreshold: Math.max(
        0,
        Math.floor(config.suspectEmptyRoadThreshold ?? defaultServiceConfig.suspectEmptyRoadThreshold),
      ),
      suspectNeighborRoadThreshold: Math.max(
        1,
        Math.floor(config.suspectNeighborRoadThreshold ?? defaultServiceConfig.suspectNeighborRoadThreshold),
      ),
      suspectRetryPaddingMeters: Math.max(
        0,
        config.suspectRetryPaddingMeters ?? defaultServiceConfig.suspectRetryPaddingMeters,
      ),
    };
  }

  public async getOrFetchTile(
    params: TileFetchParams,
    options: TileFetchOptions = {},
  ): Promise<TileFetchResult> {
    if (options.signal?.aborted === true) {
      throw this.createAbortError();
    }

    const cacheKey = this.buildTileVersionedKey(params.tileKey);
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
    return this.fetchTileWithInFlight(params, cacheKey, options);
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

  private async fetchTileWithInFlight(
    params: TileFetchParams,
    cacheKey: string,
    options: TileFetchOptions,
  ): Promise<TileFetchResult> {
    const existing = this.inflightTileByKey.get(cacheKey);
    if (existing !== undefined) {
      return this.awaitWithAbort(existing, options.signal);
    }

    const requestPromise = this.fetchAndCacheTile(params, cacheKey, options).finally(() => {
      this.inflightTileByKey.delete(cacheKey);
    });
    this.inflightTileByKey.set(cacheKey, requestPromise);
    return this.awaitWithAbort(requestPromise, options.signal);
  }

  private scheduleRevalidate(params: TileFetchParams, cacheKey: string): void {
    if (this.revalidateInFlight.has(cacheKey)) {
      return;
    }

    this.revalidateInFlight.add(cacheKey);
    void this.fetchAndCacheTile(params, cacheKey, { priority: 'background' })
      .catch(() => undefined)
      .finally(() => {
        this.revalidateInFlight.delete(cacheKey);
      });
  }

  private async fetchAndCacheTile(
    params: TileFetchParams,
    cacheKey: string,
    options: TileFetchOptions,
  ): Promise<TileFetchResult> {
    const requestedPriority = options.priority ?? 'foreground';
    const primaryMeta = await this.getOrFetchMetaTile(
      params,
      this.config.metaTilePaddingMeters,
      options,
    );

    let normalizedTile = this.deriveTileFromMeta(params, primaryMeta.payload, this.config.selectionPaddingMeters);
    let finalSource = primaryMeta.source;

    if (this.shouldRetrySuspectEmpty(normalizedTile, params, primaryMeta.payload)) {
      const retryPadding = Math.max(
        this.config.suspectRetryPaddingMeters,
        this.config.metaTilePaddingMeters + 40,
      );
      const retryMeta = await this.getOrFetchMetaTile(params, retryPadding, {
        signal: options.signal,
        priority: requestedPriority,
      });
      const retryTile = this.deriveTileFromMeta(params, retryMeta.payload, this.config.selectionPaddingMeters);

      if (retryTile.roads.length > normalizedTile.roads.length) {
        normalizedTile = {
          ...retryTile,
          emptyReason: 'suspect-empty-recovered',
        };
        finalSource = retryMeta.source;
      } else if (normalizedTile.roads.length <= this.config.suspectEmptyRoadThreshold) {
        normalizedTile = {
          ...normalizedTile,
          emptyReason: 'suspect-empty-confirmed',
        };
      }
    } else if (normalizedTile.roads.length === 0) {
      normalizedTile = {
        ...normalizedTile,
        emptyReason: 'real-empty',
      };
    }

    const now = Date.now();
    await this.cacheDatabase.put('normalized_tile_cache', this.createEnvelope(cacheKey, normalizedTile, now));
    await this.cachePolicy.applyCleanup(now);
    await this.refreshStoreStats();

    this.metrics.lastSource = finalSource;
    this.metrics.lastEntryAgeMs = 0;

    return {
      data: normalizedTile,
      source: finalSource,
    };
  }

  private async getOrFetchMetaTile(
    params: TileFetchParams,
    paddingMeters: number,
    options: TileFetchOptions,
  ): Promise<MetaTileFetchResult> {
    const context = this.buildMetaTileContext(params, paddingMeters);
    const now = Date.now();
    const cached = await this.cacheDatabase.get<MetaTilePayload>('meta_tile_cache', context.cacheKey);

    if (cached !== undefined) {
      this.metrics.hits += 1;
      this.metrics.lastEntryAgeMs = Math.max(0, now - cached.updatedAt);
      await this.cacheDatabase.touch('meta_tile_cache', context.cacheKey, now);

      if (cached.expiresAt > now) {
        return {
          payload: cached.payload,
          source: 'cache-fresh',
        };
      }

      if (this.config.staleWhileRevalidate) {
        this.metrics.staleHits += 1;
        this.scheduleMetaRevalidate(context);
        return {
          payload: cached.payload,
          source: 'cache-stale',
        };
      }
    }

    return this.fetchMetaWithInFlight(context, options);
  }

  private scheduleMetaRevalidate(context: MetaTileContext): void {
    const revalidateKey = `meta-revalidate::${context.cacheKey}`;
    if (this.revalidateInFlight.has(revalidateKey)) {
      return;
    }

    this.revalidateInFlight.add(revalidateKey);
    void this.fetchAndCacheMeta(context, { priority: 'background' })
      .catch(() => undefined)
      .finally(() => {
        this.revalidateInFlight.delete(revalidateKey);
      });
  }

  private async fetchMetaWithInFlight(
    context: MetaTileContext,
    options: TileFetchOptions,
  ): Promise<MetaTileFetchResult> {
    const existing = this.inflightMetaByKey.get(context.cacheKey);
    if (existing !== undefined) {
      return this.awaitWithAbort(existing, options.signal);
    }

    const requestPromise = this.fetchAndCacheMeta(context, options).finally(() => {
      this.inflightMetaByKey.delete(context.cacheKey);
    });
    this.inflightMetaByKey.set(context.cacheKey, requestPromise);
    return this.awaitWithAbort(requestPromise, options.signal);
  }

  private async fetchAndCacheMeta(
    context: MetaTileContext,
    options: TileFetchOptions,
  ): Promise<MetaTileFetchResult> {
    const fetchResult = await this.overpassClient.fetchTileData(context.queryBounds, {
      signal: options.signal,
      priority: options.priority ?? 'foreground',
    });

    const normalized = this.normalizeMetaTilePayload(context, fetchResult.response, fetchResult.endpoint, fetchResult.fetchedAt);
    const now = Date.now();

    await this.cacheDatabase.put(
      'raw_query_cache',
      this.createEnvelope(`meta-raw::${context.cacheKey}`, fetchResult.response, now),
    );
    await this.cacheDatabase.put('meta_tile_cache', this.createEnvelope(context.cacheKey, normalized, now));
    await this.cachePolicy.applyCleanup(now);
    await this.refreshStoreStats();

    this.metrics.lastSource = 'network';
    this.metrics.lastEntryAgeMs = 0;

    return {
      payload: normalized,
      source: 'network',
    };
  }

  private normalizeMetaTilePayload(
    context: MetaTileContext,
    payload: OverpassResponse,
    endpoint: string,
    fetchedAt: number,
  ): MetaTilePayload {
    const roads: GlobalRoadFeature[] = [];
    const buildings: GlobalBuildingFeature[] = [];
    const waysById = new Map<number, OverpassWayElement>();
    for (const element of payload.elements) {
      if (element.type === 'way') {
        waysById.set(element.id, element);
      }
    }

    for (const element of payload.elements) {
      if (element.type !== 'way') {
        continue;
      }

      const way = element;
      const geometry = this.normalizeGeometryToGlobal(way.geometry ?? []);

      if (this.isRoadWay(way) && geometry.length >= 2) {
        roads.push({
          id: `way/${way.id}`,
          globalPoints: geometry,
          properties: {
            highway: way.tags?.highway ?? 'unclassified',
            widthMeters: this.parseWidthMeters(way.tags?.width ?? null),
            lanes: this.parsePositiveInteger(way.tags?.lanes ?? null),
            oneway: this.parseOnewayTag(way.tags?.oneway ?? null),
            maxspeed: way.tags?.maxspeed ?? null,
          },
        });
      }

      if (!this.isBuildingWay(way)) {
        continue;
      }

      const outer = this.sanitizePolygonRing(geometry);
      if (outer === null) {
        continue;
      }

      buildings.push({
        id: `way/${way.id}`,
        polygons: [
          {
            outer,
            holes: [],
          },
        ],
        properties: this.parseBuildingProperties(way.tags),
      });
    }

    for (const element of payload.elements) {
      if (element.type !== 'relation' || !this.isBuildingRelation(element)) {
        continue;
      }

      const relationPolygons = this.extractRelationPolygons(element, waysById);
      if (relationPolygons.length === 0) {
        continue;
      }

      buildings.push({
        id: `relation/${element.id}`,
        polygons: relationPolygons,
        properties: this.parseBuildingProperties(element.tags),
      });
    }

    return {
      metaTileKey: context.metaTileKey,
      schemaVersion: META_TILE_SCHEMA_VERSION,
      sourceVersion: OVERPASS_SOURCE_VERSION,
      sourceEndpoint: endpoint,
      fetchedAt,
      queryBounds: context.queryBounds,
      tileSizeMeters: context.tileSizeMeters,
      span: context.span,
      paddingMeters: context.paddingMeters,
      globalBounds: context.globalBounds,
      roads,
      buildings,
    };
  }

  private deriveTileFromMeta(
    params: TileFetchParams,
    meta: MetaTilePayload,
    selectionPaddingMeters: number,
  ): TileOSMData {
    const tileBounds = {
      minEast: params.tileOriginGlobalMeters.east,
      minNorth: params.tileOriginGlobalMeters.north,
      maxEast: params.tileOriginGlobalMeters.east + params.tileSizeMeters,
      maxNorth: params.tileOriginGlobalMeters.north + params.tileSizeMeters,
    };

    const expandedBounds = this.expandBounds(tileBounds, selectionPaddingMeters);

    const roads: RoadFeature[] = [];
    for (const road of meta.roads) {
      if (!this.polylineIntersectsBounds(road.globalPoints, expandedBounds)) {
        continue;
      }

      const localPoints = road.globalPoints.map((point) => ({
        east: point.east - params.tileOriginGlobalMeters.east,
        north: point.north - params.tileOriginGlobalMeters.north,
      }));

      roads.push({
        id: road.id,
        points: localPoints,
        properties: road.properties,
      });
    }

    const buildings: BuildingFeature[] = [];
    for (const building of meta.buildings) {
      const localPolygons: BuildingPolygon[] = [];
      for (const polygon of building.polygons) {
        if (!this.polygonBoundsIntersects(polygon.outer, expandedBounds)) {
          continue;
        }

        const localOuter = polygon.outer.map((point) => ({
          east: point.east - params.tileOriginGlobalMeters.east,
          north: point.north - params.tileOriginGlobalMeters.north,
        }));
        const localHoles = polygon.holes
          .map((hole) =>
            hole.map((point) => ({
              east: point.east - params.tileOriginGlobalMeters.east,
              north: point.north - params.tileOriginGlobalMeters.north,
            })),
          )
          .filter((hole) => hole.length >= 4);

        localPolygons.push({
          outer: this.ensureClosedPolygon(localOuter),
          holes: localHoles.map((hole) => this.ensureClosedPolygon(hole)),
        });
      }

      if (localPolygons.length === 0) {
        continue;
      }

      buildings.push({
        id: building.id,
        polygons: localPolygons,
        properties: building.properties,
      });
    }

    return {
      tileKey: params.tileKey,
      schemaVersion: NORMALIZED_SCHEMA_VERSION,
      sourceVersion: OVERPASS_SOURCE_VERSION,
      sourceEndpoint: meta.sourceEndpoint,
      fetchedAt: meta.fetchedAt,
      bbox: params.bbox,
      tileOriginGlobalMeters: {
        east: params.tileOriginGlobalMeters.east,
        north: params.tileOriginGlobalMeters.north,
      },
      tileSizeMeters: params.tileSizeMeters,
      roads,
      buildings,
      emptyReason: roads.length === 0 ? 'real-empty' : 'not-empty',
    };
  }

  private shouldRetrySuspectEmpty(
    tileData: TileOSMData,
    params: TileFetchParams,
    meta: MetaTilePayload,
  ): boolean {
    if (tileData.roads.length > this.config.suspectEmptyRoadThreshold) {
      return false;
    }

    let denseNeighborDetected = false;
    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        if (deltaX === 0 && deltaY === 0) {
          continue;
        }

        const neighbor = {
          x: params.tileCoordinate.x + deltaX,
          y: params.tileCoordinate.y + deltaY,
        };
        const neighborBounds = {
          minEast: neighbor.x * params.tileSizeMeters,
          minNorth: neighbor.y * params.tileSizeMeters,
          maxEast: (neighbor.x + 1) * params.tileSizeMeters,
          maxNorth: (neighbor.y + 1) * params.tileSizeMeters,
        };

        let neighborRoadCount = 0;
        for (const road of meta.roads) {
          if (this.polylineIntersectsBounds(road.globalPoints, neighborBounds)) {
            neighborRoadCount += 1;
          }
        }

        if (neighborRoadCount >= this.config.suspectNeighborRoadThreshold) {
          denseNeighborDetected = true;
          break;
        }
      }

      if (denseNeighborDetected) {
        break;
      }
    }

    return denseNeighborDetected;
  }

  private buildMetaTileContext(params: TileFetchParams, paddingMeters: number): MetaTileContext {
    const span = this.config.metaTileSpan;
    const baseTileX = Math.floor(params.tileCoordinate.x / span) * span;
    const baseTileY = Math.floor(params.tileCoordinate.y / span) * span;
    const minEast = baseTileX * params.tileSizeMeters - paddingMeters;
    const minNorth = baseTileY * params.tileSizeMeters - paddingMeters;
    const maxEast = (baseTileX + span) * params.tileSizeMeters + paddingMeters;
    const maxNorth = (baseTileY + span) * params.tileSizeMeters + paddingMeters;

    const southWest = this.globalMetersToLatLon(minEast, minNorth);
    const northEast = this.globalMetersToLatLon(maxEast, maxNorth);

    const queryBounds: GeoBoundsLatLon = {
      south: Math.min(southWest.latitude, northEast.latitude),
      west: Math.min(southWest.longitude, northEast.longitude),
      north: Math.max(southWest.latitude, northEast.latitude),
      east: Math.max(southWest.longitude, northEast.longitude),
    };

    const metaTileKey = `${baseTileX}:${baseTileY}:span=${span}`;
    return {
      metaTileKey,
      cacheKey: this.buildMetaVersionedKey(metaTileKey, paddingMeters),
      tileSizeMeters: params.tileSizeMeters,
      span,
      paddingMeters,
      queryBounds,
      globalBounds: {
        minEast,
        minNorth,
        maxEast,
        maxNorth,
      },
    };
  }

  private buildTileVersionedKey(tileKey: string): string {
    return `${tileKey}::schema=${NORMALIZED_SCHEMA_VERSION}::source=${OVERPASS_SOURCE_VERSION}`;
  }

  private buildMetaVersionedKey(metaTileKey: string, paddingMeters: number): string {
    return `${metaTileKey}::schema=${META_TILE_SCHEMA_VERSION}::source=${OVERPASS_SOURCE_VERSION}::pad=${paddingMeters}`;
  }

  private normalizeGeometryToGlobal(
    geometry: readonly OverpassGeometryPoint[],
  ): PointMeters[] {
    const points: PointMeters[] = [];
    for (const point of geometry) {
      const global = this.normalizationProjection.latLonToLocalMeters({
        latitude: point.lat,
        longitude: point.lon,
      });
      points.push({
        east: global.east,
        north: global.north,
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
    if (first?.east === last?.east && first?.north === last?.north) {
      return [...points];
    }

    if (first === undefined) {
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

  private isRoadWay(way: OverpassWayElement): boolean {
    return typeof way.tags?.highway === 'string';
  }

  private isBuildingWay(way: OverpassWayElement): boolean {
    const buildingTag = way.tags?.building;
    return typeof buildingTag === 'string' && buildingTag !== 'no';
  }

  private isBuildingRelation(relation: OverpassRelationElement): boolean {
    const buildingTag = relation.tags?.building;
    return typeof buildingTag === 'string' && buildingTag !== 'no';
  }

  private parseBuildingProperties(tags: Record<string, string> | undefined): BuildingFeature['properties'] {
    return {
      kind: tags?.building ?? 'yes',
      levels: this.parsePositiveInteger(tags?.['building:levels'] ?? null),
      heightMeters: this.parseHeightMeters(tags?.height ?? null),
      roofShape: this.parseRoofShape(tags?.['roof:shape'] ?? null),
    };
  }

  private extractRelationPolygons(
    relation: OverpassRelationElement,
    waysById: Map<number, OverpassWayElement>,
  ): BuildingPolygon[] {
    const outerRings: PointMeters[][] = [];
    const holeRings: PointMeters[][] = [];

    for (const member of relation.members ?? []) {
      if (member.type !== 'way') {
        continue;
      }

      const role = member.role.trim().toLowerCase();
      if (role !== 'outer' && role !== 'inner') {
        continue;
      }

      const geometry = member.geometry ?? waysById.get(member.ref)?.geometry;
      if (geometry === undefined) {
        continue;
      }

      const ring = this.sanitizePolygonRing(this.normalizeGeometryToGlobal(geometry));
      if (ring === null) {
        continue;
      }

      if (role === 'outer') {
        outerRings.push(ring);
      } else {
        holeRings.push(ring);
      }
    }

    if (outerRings.length === 0) {
      return [];
    }

    const polygons: { outer: PointMeters[]; holes: PointMeters[][] }[] = outerRings.map((outer) => ({
      outer,
      holes: [],
    }));

    for (const hole of holeRings) {
      const holeAnchor = hole[0];
      if (holeAnchor === undefined) {
        continue;
      }

      let assigned = false;
      for (const polygon of polygons) {
        if (this.pointInPolygon(holeAnchor, polygon.outer)) {
          polygon.holes.push(hole);
          assigned = true;
          break;
        }
      }

      if (!assigned && polygons.length > 0) {
        const fallbackPolygon = polygons[0];
        if (fallbackPolygon !== undefined) {
          fallbackPolygon.holes.push(hole);
        }
      }
    }

    return polygons.map((polygon) => ({
      outer: polygon.outer,
      holes: polygon.holes,
    }));
  }

  private sanitizePolygonRing(points: readonly PointMeters[]): PointMeters[] | null {
    if (points.length < 3) {
      return null;
    }

    const compact: PointMeters[] = [];
    for (const point of points) {
      const previous = compact[compact.length - 1];
      if (previous !== undefined && this.pointsNear(previous, point, 0.01)) {
        continue;
      }
      compact.push(point);
    }

    if (compact.length < 3) {
      return null;
    }

    const first = compact[0];
    const last = compact[compact.length - 1];
    if (first !== undefined && last !== undefined && this.pointsNear(first, last, 0.01)) {
      compact.pop();
    }

    if (compact.length < 3) {
      return null;
    }

    const closed = this.ensureClosedPolygon(compact);
    const area = Math.abs(this.computeSignedArea(closed));
    if (!Number.isFinite(area) || area < 0.25) {
      return null;
    }
    return closed;
  }

  private pointsNear(pointA: PointMeters, pointB: PointMeters, epsilonMeters: number): boolean {
    const deltaEast = pointA.east - pointB.east;
    const deltaNorth = pointA.north - pointB.north;
    return deltaEast * deltaEast + deltaNorth * deltaNorth <= epsilonMeters * epsilonMeters;
  }

  private computeSignedArea(ring: readonly PointMeters[]): number {
    if (ring.length < 4) {
      return 0;
    }

    let signedArea = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
      const current = ring[index];
      const next = ring[index + 1];
      if (current === undefined || next === undefined) {
        continue;
      }
      signedArea += current.east * next.north - next.east * current.north;
    }

    return signedArea * 0.5;
  }

  private pointInPolygon(point: PointMeters, polygonRing: readonly PointMeters[]): boolean {
    if (polygonRing.length < 4) {
      return false;
    }

    let inside = false;
    const lastIndex = polygonRing.length - 1;
    for (let index = 0; index < lastIndex; index += 1) {
      const current = polygonRing[index];
      const next = polygonRing[index + 1];
      if (current === undefined || next === undefined) {
        continue;
      }

      const intersects =
        (current.north > point.north) !== (next.north > point.north) &&
        point.east <
          ((next.east - current.east) * (point.north - current.north)) /
            (next.north - current.north + Number.EPSILON) +
            current.east;

      if (intersects) {
        inside = !inside;
      }
    }

    return inside;
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

  private parseRoofShape(value: string | null): string | null {
    if (value === null) {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    return normalized.length === 0 ? null : normalized;
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

  private expandBounds(
    bounds: {
      readonly minEast: number;
      readonly minNorth: number;
      readonly maxEast: number;
      readonly maxNorth: number;
    },
    paddingMeters: number,
  ): {
    readonly minEast: number;
    readonly minNorth: number;
    readonly maxEast: number;
    readonly maxNorth: number;
  } {
    return {
      minEast: bounds.minEast - paddingMeters,
      minNorth: bounds.minNorth - paddingMeters,
      maxEast: bounds.maxEast + paddingMeters,
      maxNorth: bounds.maxNorth + paddingMeters,
    };
  }

  private polygonBoundsIntersects(
    polygon: readonly PointMeters[],
    bounds: {
      readonly minEast: number;
      readonly minNorth: number;
      readonly maxEast: number;
      readonly maxNorth: number;
    },
  ): boolean {
    const polygonBounds = this.computePointsBounds(polygon);
    if (polygonBounds === null) {
      return false;
    }

    return !(
      polygonBounds.maxEast < bounds.minEast ||
      polygonBounds.minEast > bounds.maxEast ||
      polygonBounds.maxNorth < bounds.minNorth ||
      polygonBounds.minNorth > bounds.maxNorth
    );
  }

  private computePointsBounds(
    points: readonly PointMeters[],
  ): {
    readonly minEast: number;
    readonly minNorth: number;
    readonly maxEast: number;
    readonly maxNorth: number;
  } | null {
    if (points.length === 0) {
      return null;
    }

    let minEast = Number.POSITIVE_INFINITY;
    let minNorth = Number.POSITIVE_INFINITY;
    let maxEast = Number.NEGATIVE_INFINITY;
    let maxNorth = Number.NEGATIVE_INFINITY;

    for (const point of points) {
      minEast = Math.min(minEast, point.east);
      minNorth = Math.min(minNorth, point.north);
      maxEast = Math.max(maxEast, point.east);
      maxNorth = Math.max(maxNorth, point.north);
    }

    return {
      minEast,
      minNorth,
      maxEast,
      maxNorth,
    };
  }

  private polylineIntersectsBounds(
    points: readonly PointMeters[],
    bounds: {
      readonly minEast: number;
      readonly minNorth: number;
      readonly maxEast: number;
      readonly maxNorth: number;
    },
  ): boolean {
    if (points.length < 2) {
      return false;
    }

    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (point !== undefined && this.pointInsideBounds(point, bounds)) {
        return true;
      }

      if (index === 0) {
        continue;
      }

      const previousPoint = points[index - 1];
      if (point === undefined || previousPoint === undefined) {
        continue;
      }

      if (this.segmentIntersectsBounds(previousPoint, point, bounds)) {
        return true;
      }
    }

    return false;
  }

  private pointInsideBounds(
    point: PointMeters,
    bounds: {
      readonly minEast: number;
      readonly minNorth: number;
      readonly maxEast: number;
      readonly maxNorth: number;
    },
  ): boolean {
    return (
      point.east >= bounds.minEast &&
      point.east <= bounds.maxEast &&
      point.north >= bounds.minNorth &&
      point.north <= bounds.maxNorth
    );
  }

  private segmentIntersectsBounds(
    pointA: PointMeters,
    pointB: PointMeters,
    bounds: {
      readonly minEast: number;
      readonly minNorth: number;
      readonly maxEast: number;
      readonly maxNorth: number;
    },
  ): boolean {
    const segmentMinEast = Math.min(pointA.east, pointB.east);
    const segmentMaxEast = Math.max(pointA.east, pointB.east);
    const segmentMinNorth = Math.min(pointA.north, pointB.north);
    const segmentMaxNorth = Math.max(pointA.north, pointB.north);

    if (
      segmentMaxEast < bounds.minEast ||
      segmentMinEast > bounds.maxEast ||
      segmentMaxNorth < bounds.minNorth ||
      segmentMinNorth > bounds.maxNorth
    ) {
      return false;
    }

    const topLeft: PointMeters = { east: bounds.minEast, north: bounds.maxNorth };
    const topRight: PointMeters = { east: bounds.maxEast, north: bounds.maxNorth };
    const bottomLeft: PointMeters = { east: bounds.minEast, north: bounds.minNorth };
    const bottomRight: PointMeters = { east: bounds.maxEast, north: bounds.minNorth };

    return (
      this.segmentsIntersect(pointA, pointB, topLeft, topRight) ||
      this.segmentsIntersect(pointA, pointB, topRight, bottomRight) ||
      this.segmentsIntersect(pointA, pointB, bottomRight, bottomLeft) ||
      this.segmentsIntersect(pointA, pointB, bottomLeft, topLeft)
    );
  }

  private segmentsIntersect(a1: PointMeters, a2: PointMeters, b1: PointMeters, b2: PointMeters): boolean {
    const crossA = this.crossProduct(a1, a2, b1);
    const crossB = this.crossProduct(a1, a2, b2);
    const crossC = this.crossProduct(b1, b2, a1);
    const crossD = this.crossProduct(b1, b2, a2);

    if (crossA === 0 && this.pointOnSegment(b1, a1, a2)) {
      return true;
    }
    if (crossB === 0 && this.pointOnSegment(b2, a1, a2)) {
      return true;
    }
    if (crossC === 0 && this.pointOnSegment(a1, b1, b2)) {
      return true;
    }
    if (crossD === 0 && this.pointOnSegment(a2, b1, b2)) {
      return true;
    }

    return (crossA > 0) !== (crossB > 0) && (crossC > 0) !== (crossD > 0);
  }

  private crossProduct(origin: PointMeters, pointA: PointMeters, pointB: PointMeters): number {
    return (pointA.east - origin.east) * (pointB.north - origin.north) -
      (pointA.north - origin.north) * (pointB.east - origin.east);
  }

  private pointOnSegment(point: PointMeters, segmentStart: PointMeters, segmentEnd: PointMeters): boolean {
    return (
      point.east >= Math.min(segmentStart.east, segmentEnd.east) - 1e-9 &&
      point.east <= Math.max(segmentStart.east, segmentEnd.east) + 1e-9 &&
      point.north >= Math.min(segmentStart.north, segmentEnd.north) - 1e-9 &&
      point.north <= Math.max(segmentStart.north, segmentEnd.north) + 1e-9
    );
  }

  private globalMetersToLatLon(east: number, north: number): { latitude: number; longitude: number } {
    return this.normalizationProjection.localMetersToLatLon({ east, north });
  }

  private async awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) {
      return promise;
    }

    if (signal.aborted) {
      throw this.createAbortError();
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(this.createAbortError());
      };

      signal.addEventListener('abort', onAbort, { once: true });
      void promise
        .then((value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        })
        .catch((error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          if (error instanceof Error) {
            reject(error);
            return;
          }
          reject(new Error('Tile fetch failed with non-error rejection.'));
        });
    });
  }

  private createAbortError(): DOMException {
    return new DOMException('Tile fetch aborted.', 'AbortError');
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
