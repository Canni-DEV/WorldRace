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
  DecorationAreaFeature,
  DecorationAreaKind,
  DecorationPointFeature,
  DecorationPointKind,
  GeoBoundsLatLon,
  PointMeters,
  RoadFeature,
  TerrainAreaFeature,
  TerrainKind,
  TileTerrainCoverage,
  TileTerrainSummary,
  TileFetchOptions,
  TileFetchParams,
  TileFetchResult,
  TileOSMData,
} from './Types';

const NORMALIZED_SCHEMA_VERSION = 'tile-osm-v10';
const OVERPASS_SOURCE_VERSION = 'overpass-roads-buildings-decoration-terrain-meta-v5';
const META_TILE_SCHEMA_VERSION = 'meta-tile-v7';
const STATS_REFRESH_INTERVAL_MS = 2500;
const POLYGON_POINT_EPSILON_METERS = 0.01;
const RELATION_RING_SNAP_TOLERANCE_METERS = 0.35;
const WAY_RING_CLOSING_TOLERANCE_METERS = 0.35;
const TERRAIN_WATER_DOMINANT_COVERAGE = 0.35;
const TERRAIN_URBAN_DOMINANT_COVERAGE = 0.3;
const TERRAIN_URBAN_BUILDING_COUNT_THRESHOLD = 4;
const TERRAIN_URBAN_ROAD_COUNT_THRESHOLD = 6;

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

interface AxisAlignedBounds {
  readonly minEast: number;
  readonly minNorth: number;
  readonly maxEast: number;
  readonly maxNorth: number;
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

interface GlobalDecorationPointFeature {
  readonly id: string;
  readonly kind: DecorationPointKind;
  readonly point: PointMeters;
}

interface GlobalDecorationAreaFeature {
  readonly id: string;
  readonly kind: DecorationAreaKind;
  readonly polygons: readonly BuildingPolygon[];
}

interface GlobalTerrainAreaFeature {
  readonly id: string;
  readonly kind: TerrainKind;
  readonly polygons: readonly BuildingPolygon[];
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
  readonly decorationPoints: readonly GlobalDecorationPointFeature[];
  readonly decorationAreas: readonly GlobalDecorationAreaFeature[];
  readonly terrainAreas: readonly GlobalTerrainAreaFeature[];
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
  private readonly sourceVersion: string;
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
    this.sourceVersion = `${OVERPASS_SOURCE_VERSION}::${this.normalizationProjection.getAxisOrientationKey()}`;
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
    const decorationPoints: GlobalDecorationPointFeature[] = [];
    const decorationAreas: GlobalDecorationAreaFeature[] = [];
    const terrainAreas: GlobalTerrainAreaFeature[] = [];
    const waysById = new Map<number, OverpassWayElement>();
    for (const element of payload.elements) {
      if (element.type === 'way') {
        waysById.set(element.id, element);
      }
    }

    const buildingRelationMemberWayIds = new Set<number>();
    const decorationRelationMemberWayIds = new Set<number>();
    const terrainRelationMemberWayIds = new Set<number>();
    for (const element of payload.elements) {
      if (element.type !== 'relation') {
        continue;
      }

      if (this.isBuildingRelation(element)) {
        const relationPolygons = this.extractRelationPolygons(element, waysById);
        if (relationPolygons.length > 0) {
          for (const wayId of this.collectRelationAreaWayIds(element)) {
            buildingRelationMemberWayIds.add(wayId);
          }

          buildings.push({
            id: `relation/${element.id}`,
            polygons: relationPolygons,
            properties: this.parseBuildingProperties(element.tags),
          });
        }
      }

      const decorationAreaKind = this.parseDecorationAreaKind(element.tags);
      const terrainAreaKind = this.parseTerrainAreaKind(element.tags);
      if (decorationAreaKind === null && terrainAreaKind === null) {
        continue;
      }

      const relationPolygons = this.extractRelationPolygons(element, waysById);
      if (relationPolygons.length === 0) {
        continue;
      }

      const relationWayIds = this.collectRelationAreaWayIds(element);
      if (decorationAreaKind !== null) {
        for (const wayId of relationWayIds) {
          decorationRelationMemberWayIds.add(wayId);
        }
        decorationAreas.push({
          id: `relation/${element.id}`,
          kind: decorationAreaKind,
          polygons: relationPolygons,
        });
      }

      if (terrainAreaKind !== null) {
        for (const wayId of relationWayIds) {
          terrainRelationMemberWayIds.add(wayId);
        }
        terrainAreas.push({
          id: `relation/${element.id}`,
          kind: terrainAreaKind,
          polygons: relationPolygons,
        });
      }
    }

    for (const element of payload.elements) {
      if (element.type === 'node') {
        const pointKind = this.parseDecorationPointKind(element.tags);
        if (pointKind === null) {
          continue;
        }

        const globalPoint = this.normalizationProjection.latLonToLocalMeters({
          latitude: element.lat,
          longitude: element.lon,
        });
        decorationPoints.push({
          id: `node/${element.id}`,
          kind: pointKind,
          point: {
            east: globalPoint.east,
            north: globalPoint.north,
          },
        });
        continue;
      }

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

      const decorationAreaKind = this.parseDecorationAreaKind(way.tags);
      if (decorationAreaKind !== null && !decorationRelationMemberWayIds.has(way.id)) {
        const decorationOuter = this.sanitizePolygonRing(geometry, WAY_RING_CLOSING_TOLERANCE_METERS);
        if (decorationOuter !== null) {
          decorationAreas.push({
            id: `way/${way.id}`,
            kind: decorationAreaKind,
            polygons: [
              {
                outer: decorationOuter,
                holes: [],
              },
            ],
          });
        }
      }

      const terrainAreaKind = this.parseTerrainAreaKind(way.tags);
      if (terrainAreaKind !== null && !terrainRelationMemberWayIds.has(way.id)) {
        const terrainOuter = this.sanitizePolygonRing(geometry, WAY_RING_CLOSING_TOLERANCE_METERS);
        if (terrainOuter !== null) {
          terrainAreas.push({
            id: `way/${way.id}`,
            kind: terrainAreaKind,
            polygons: [
              {
                outer: terrainOuter,
                holes: [],
              },
            ],
          });
        }
      }

      if (!this.isBuildingWay(way)) {
        continue;
      }

      if (buildingRelationMemberWayIds.has(way.id)) {
        continue;
      }

      const outer = this.sanitizePolygonRing(geometry, WAY_RING_CLOSING_TOLERANCE_METERS);
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

    return {
      metaTileKey: context.metaTileKey,
      schemaVersion: META_TILE_SCHEMA_VERSION,
      sourceVersion: this.sourceVersion,
      sourceEndpoint: endpoint,
      fetchedAt,
      queryBounds: context.queryBounds,
      tileSizeMeters: context.tileSizeMeters,
      span: context.span,
      paddingMeters: context.paddingMeters,
      globalBounds: context.globalBounds,
      roads,
      buildings,
      decorationPoints,
      decorationAreas,
      terrainAreas,
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
        if (
          !this.isPolygonOwnedByTile(
            polygon.outer,
            params.tileCoordinate,
            params.tileSizeMeters,
          )
        ) {
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

    const decorationPoints: DecorationPointFeature[] = [];
    for (const feature of meta.decorationPoints) {
      if (!this.pointInsideBounds(feature.point, expandedBounds)) {
        continue;
      }
      if (
        !this.isPointOwnedByTile(
          feature.point,
          params.tileCoordinate,
          params.tileSizeMeters,
        )
      ) {
        continue;
      }

      decorationPoints.push({
        id: feature.id,
        kind: feature.kind,
        point: {
          east: feature.point.east - params.tileOriginGlobalMeters.east,
          north: feature.point.north - params.tileOriginGlobalMeters.north,
        },
      });
    }

    const decorationAreas: DecorationAreaFeature[] = [];
    for (const area of meta.decorationAreas) {
      const localPolygons: BuildingPolygon[] = [];
      for (const polygon of area.polygons) {
        if (!this.polygonBoundsIntersects(polygon.outer, expandedBounds)) {
          continue;
        }
        if (
          !this.isPolygonOwnedByTile(
            polygon.outer,
            params.tileCoordinate,
            params.tileSizeMeters,
          )
        ) {
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

      decorationAreas.push({
        id: area.id,
        kind: area.kind,
        polygons: localPolygons,
      });
    }

    const terrainAreas: TerrainAreaFeature[] = [];
    for (const area of meta.terrainAreas) {
      const localPolygons: BuildingPolygon[] = [];
      for (const polygon of area.polygons) {
        if (!this.polygonBoundsIntersects(polygon.outer, tileBounds)) {
          continue;
        }

        const clippedOuterGlobal = this.clipPolygonRingToBounds(polygon.outer, tileBounds);
        if (clippedOuterGlobal === null) {
          continue;
        }

        const localOuter = clippedOuterGlobal.map((point) => ({
          east: point.east - params.tileOriginGlobalMeters.east,
          north: point.north - params.tileOriginGlobalMeters.north,
        }));
        const localHoles = polygon.holes
          .map((hole) => this.clipPolygonRingToBounds(hole, tileBounds))
          .filter((hole): hole is PointMeters[] => hole !== null)
          .filter((hole) => {
            const anchor = hole[0];
            return anchor !== undefined && this.pointInPolygon(anchor, clippedOuterGlobal);
          })
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

      terrainAreas.push({
        id: area.id,
        kind: area.kind,
        polygons: localPolygons,
      });
    }

    const terrainSummary = this.buildTileTerrainSummary(
      terrainAreas,
      roads.length,
      buildings.length,
      params.tileSizeMeters,
    );

    return {
      tileKey: params.tileKey,
      schemaVersion: NORMALIZED_SCHEMA_VERSION,
      sourceVersion: this.sourceVersion,
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
      decorationPoints,
      decorationAreas,
      terrainAreas,
      terrainSummary,
      emptyReason: roads.length === 0 ? 'real-empty' : 'not-empty',
    };
  }

  private buildTileTerrainSummary(
    terrainAreas: readonly TerrainAreaFeature[],
    roadCount: number,
    buildingCount: number,
    tileSizeMeters: number,
  ): TileTerrainSummary {
    const tileAreaSquareMeters = Math.max(1, tileSizeMeters * tileSizeMeters);
    const rawCoverage = {
      urban: 0,
      green: 0,
      water: 0,
    };

    for (const area of terrainAreas) {
      let accumulatedArea = 0;
      for (const polygon of area.polygons) {
        accumulatedArea += this.computePolygonAreaMeters(polygon);
      }
      rawCoverage[area.kind] += accumulatedArea / tileAreaSquareMeters;
    }

    const coverage: TileTerrainCoverage = {
      urban: this.clamp01(rawCoverage.urban),
      green: this.clamp01(rawCoverage.green),
      water: this.clamp01(rawCoverage.water),
    };

    const hasUrbanDensitySignal =
      buildingCount >= TERRAIN_URBAN_BUILDING_COUNT_THRESHOLD ||
      roadCount >= TERRAIN_URBAN_ROAD_COUNT_THRESHOLD;
    const dominantKind = this.resolveDominantTerrainKind(coverage, hasUrbanDensitySignal);
    const confidence = this.resolveTerrainConfidence(coverage, dominantKind, hasUrbanDensitySignal);

    return {
      dominantKind,
      coverage,
      confidence,
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

  private resolveDominantTerrainKind(
    coverage: TileTerrainCoverage,
    hasUrbanDensitySignal: boolean,
  ): TerrainKind {
    if (coverage.water >= TERRAIN_WATER_DOMINANT_COVERAGE) {
      return 'water';
    }

    if (coverage.urban >= TERRAIN_URBAN_DOMINANT_COVERAGE || hasUrbanDensitySignal) {
      return 'urban';
    }

    if (coverage.green >= coverage.urban && coverage.green >= coverage.water) {
      return 'green';
    }
    if (coverage.water >= coverage.urban) {
      return 'water';
    }
    if (coverage.urban > 0) {
      return 'urban';
    }

    return 'green';
  }

  private resolveTerrainConfidence(
    coverage: TileTerrainCoverage,
    dominantKind: TerrainKind,
    hasUrbanDensitySignal: boolean,
  ): number {
    const values = [coverage.urban, coverage.green, coverage.water].sort((left, right) => right - left);
    const strongest = values[0] ?? 0;
    const secondStrongest = values[1] ?? 0;
    let confidence = this.clamp01(0.25 + strongest * 0.5 + (strongest - secondStrongest) * 0.5);

    if (dominantKind === 'urban' && hasUrbanDensitySignal && coverage.urban < TERRAIN_URBAN_DOMINANT_COVERAGE) {
      confidence = Math.max(confidence, 0.45);
    }

    return confidence;
  }

  private computePolygonAreaMeters(polygon: BuildingPolygon): number {
    const outerArea = Math.abs(this.computeSignedArea(this.ensureClosedPolygon(polygon.outer)));
    const holeArea = polygon.holes.reduce(
      (accumulator, hole) => accumulator + Math.abs(this.computeSignedArea(this.ensureClosedPolygon(hole))),
      0,
    );
    return Math.max(0, outerArea - holeArea);
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
    return `${tileKey}::schema=${NORMALIZED_SCHEMA_VERSION}::source=${this.sourceVersion}`;
  }

  private buildMetaVersionedKey(metaTileKey: string, paddingMeters: number): string {
    return `${metaTileKey}::schema=${META_TILE_SCHEMA_VERSION}::source=${this.sourceVersion}::pad=${paddingMeters}`;
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

  private parseDecorationPointKind(tags: Record<string, string> | undefined): DecorationPointKind | null {
    if (tags === undefined) {
      return null;
    }

    const natural = tags.natural?.trim().toLowerCase();
    const highway = tags.highway?.trim().toLowerCase();
    const amenity = tags.amenity?.trim().toLowerCase();
    const trafficSign = tags.traffic_sign;

    if (natural === 'tree') {
      return 'tree';
    }

    if (highway === 'street_lamp') {
      return 'lamp';
    }

    if (amenity === 'bench') {
      return 'bench';
    }

    if (typeof trafficSign === 'string' && trafficSign.trim().length > 0) {
      return 'sign';
    }

    return null;
  }

  private parseDecorationAreaKind(tags: Record<string, string> | undefined): DecorationAreaKind | null {
    if (tags === undefined) {
      return null;
    }

    const landuse = tags.landuse?.trim().toLowerCase();
    const natural = tags.natural?.trim().toLowerCase();
    const leisure = tags.leisure?.trim().toLowerCase();

    if (landuse === 'forest' || natural === 'wood') {
      return 'forest';
    }

    if (leisure === 'park') {
      return 'park';
    }

    if (natural === 'scrub') {
      return 'scrub';
    }

    return null;
  }

  private parseTerrainAreaKind(tags: Record<string, string> | undefined): TerrainKind | null {
    if (tags === undefined) {
      return null;
    }

    const landuse = tags.landuse?.trim().toLowerCase();
    const natural = tags.natural?.trim().toLowerCase();
    const leisure = tags.leisure?.trim().toLowerCase();
    const waterway = tags.waterway?.trim().toLowerCase();

    if (
      natural === 'water' ||
      natural === 'wetland' ||
      waterway === 'riverbank' ||
      landuse === 'reservoir'
    ) {
      return 'water';
    }

    if (
      landuse === 'residential' ||
      landuse === 'commercial' ||
      landuse === 'industrial' ||
      landuse === 'retail'
    ) {
      return 'urban';
    }

    if (
      landuse === 'forest' ||
      landuse === 'farmland' ||
      landuse === 'meadow' ||
      landuse === 'grass' ||
      natural === 'wood' ||
      natural === 'scrub' ||
      natural === 'grassland' ||
      leisure === 'park' ||
      leisure === 'garden' ||
      leisure === 'golf_course'
    ) {
      return 'green';
    }

    return null;
  }

  private extractRelationPolygons(
    relation: OverpassRelationElement,
    waysById: Map<number, OverpassWayElement>,
  ): BuildingPolygon[] {
    const outerSegments: PointMeters[][] = [];
    const holeSegments: PointMeters[][] = [];

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

      const segment = this.sanitizeRelationMemberSegment(this.normalizeGeometryToGlobal(geometry));
      if (segment === null) {
        continue;
      }

      if (role === 'outer') {
        outerSegments.push(segment);
      } else {
        holeSegments.push(segment);
      }
    }

    const outerRings = this.assembleRelationRings(outerSegments);
    if (outerRings.length === 0) {
      return [];
    }
    const holeRings = this.assembleRelationRings(holeSegments);

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

  private collectRelationAreaWayIds(relation: OverpassRelationElement): number[] {
    const wayIds: number[] = [];
    for (const member of relation.members ?? []) {
      if (member.type !== 'way') {
        continue;
      }

      const role = member.role.trim().toLowerCase();
      if (role !== 'outer' && role !== 'inner') {
        continue;
      }
      wayIds.push(member.ref);
    }
    return wayIds;
  }

  private sanitizeRelationMemberSegment(points: readonly PointMeters[]): PointMeters[] | null {
    if (points.length < 2) {
      return null;
    }

    const compact = this.collapseConsecutivePoints(points, POLYGON_POINT_EPSILON_METERS);
    if (compact.length < 2) {
      return null;
    }

    const first = compact[0];
    const last = compact[compact.length - 1];
    if (first !== undefined && last !== undefined && this.pointsNear(first, last, POLYGON_POINT_EPSILON_METERS)) {
      compact.pop();
    }

    return compact.length >= 2 ? compact : null;
  }

  private assembleRelationRings(segments: readonly (readonly PointMeters[])[]): PointMeters[][] {
    const remaining = segments
      .map((segment) => this.collapseConsecutivePoints(segment, POLYGON_POINT_EPSILON_METERS))
      .filter((segment) => segment.length >= 2)
      .map((segment) => [...segment]);
    const rings: PointMeters[][] = [];

    while (remaining.length > 0) {
      const currentPath = remaining.pop();
      if (currentPath === undefined || currentPath.length < 2) {
        continue;
      }

      let path = [...currentPath];
      let merged = true;
      while (merged) {
        merged = false;

        if (this.isPathClosed(path, RELATION_RING_SNAP_TOLERANCE_METERS)) {
          const ring = this.sanitizePolygonRing(path, RELATION_RING_SNAP_TOLERANCE_METERS);
          if (ring !== null) {
            rings.push(ring);
          }
          path = [];
          break;
        }

        for (let index = 0; index < remaining.length; index += 1) {
          const candidate = remaining[index];
          if (candidate === undefined) {
            continue;
          }

          const mergedPath = this.tryMergeRelationPaths(path, candidate);
          if (mergedPath === null) {
            continue;
          }

          remaining.splice(index, 1);
          path = this.collapseConsecutivePoints(mergedPath, POLYGON_POINT_EPSILON_METERS);
          merged = true;
          break;
        }
      }

      if (path.length > 0 && this.isPathClosed(path, RELATION_RING_SNAP_TOLERANCE_METERS)) {
        const ring = this.sanitizePolygonRing(path, RELATION_RING_SNAP_TOLERANCE_METERS);
        if (ring !== null) {
          rings.push(ring);
        }
      }
    }

    return rings;
  }

  private tryMergeRelationPaths(
    path: readonly PointMeters[],
    candidate: readonly PointMeters[],
  ): PointMeters[] | null {
    const pathStart = path[0];
    const pathEnd = path[path.length - 1];
    const candidateStart = candidate[0];
    const candidateEnd = candidate[candidate.length - 1];
    if (pathStart === undefined || pathEnd === undefined || candidateStart === undefined || candidateEnd === undefined) {
      return null;
    }

    if (this.pointsNear(pathEnd, candidateStart, RELATION_RING_SNAP_TOLERANCE_METERS)) {
      return [...path, ...candidate.slice(1)];
    }

    if (this.pointsNear(pathEnd, candidateEnd, RELATION_RING_SNAP_TOLERANCE_METERS)) {
      const reversed = [...candidate].reverse();
      return [...path, ...reversed.slice(1)];
    }

    if (this.pointsNear(pathStart, candidateEnd, RELATION_RING_SNAP_TOLERANCE_METERS)) {
      return [...candidate.slice(0, candidate.length - 1), ...path];
    }

    if (this.pointsNear(pathStart, candidateStart, RELATION_RING_SNAP_TOLERANCE_METERS)) {
      const reversed = [...candidate].reverse();
      return [...reversed.slice(0, reversed.length - 1), ...path];
    }

    return null;
  }

  private isPathClosed(points: readonly PointMeters[], epsilonMeters: number): boolean {
    if (points.length < 3) {
      return false;
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) {
      return false;
    }
    return this.pointsNear(first, last, epsilonMeters);
  }

  private collapseConsecutivePoints(
    points: readonly PointMeters[],
    epsilonMeters: number,
  ): PointMeters[] {
    const compact: PointMeters[] = [];
    for (const point of points) {
      const previous = compact[compact.length - 1];
      if (previous !== undefined && this.pointsNear(previous, point, epsilonMeters)) {
        continue;
      }
      compact.push(point);
    }
    return compact;
  }

  private sanitizePolygonRing(
    points: readonly PointMeters[],
    closingToleranceMeters: number = POLYGON_POINT_EPSILON_METERS,
  ): PointMeters[] | null {
    if (points.length < 3) {
      return null;
    }

    const compact = this.collapseConsecutivePoints(points, POLYGON_POINT_EPSILON_METERS);

    if (compact.length < 3) {
      return null;
    }

    const first = compact[0];
    const last = compact[compact.length - 1];
    if (first === undefined || last === undefined || !this.pointsNear(first, last, closingToleranceMeters)) {
      return null;
    }
    compact.pop();

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

  private isPolygonOwnedByTile(
    polygonOuter: readonly PointMeters[],
    tileCoordinate: { readonly x: number; readonly y: number },
    tileSizeMeters: number,
  ): boolean {
    const centroid = this.computePolygonCentroid(polygonOuter);
    if (centroid === null) {
      return false;
    }
    const ownerTileX = Math.floor(centroid.east / tileSizeMeters);
    const ownerTileY = Math.floor(centroid.north / tileSizeMeters);
    return ownerTileX === tileCoordinate.x && ownerTileY === tileCoordinate.y;
  }

  private isPointOwnedByTile(
    point: PointMeters,
    tileCoordinate: { readonly x: number; readonly y: number },
    tileSizeMeters: number,
  ): boolean {
    const ownerTileX = Math.floor(point.east / tileSizeMeters);
    const ownerTileY = Math.floor(point.north / tileSizeMeters);
    return ownerTileX === tileCoordinate.x && ownerTileY === tileCoordinate.y;
  }

  private computePolygonCentroid(ring: readonly PointMeters[]): PointMeters | null {
    if (ring.length < 4) {
      return null;
    }

    let area2 = 0;
    let centroidEastAcc = 0;
    let centroidNorthAcc = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
      const current = ring[index];
      const next = ring[index + 1];
      if (current === undefined || next === undefined) {
        continue;
      }

      const cross = current.east * next.north - next.east * current.north;
      area2 += cross;
      centroidEastAcc += (current.east + next.east) * cross;
      centroidNorthAcc += (current.north + next.north) * cross;
    }

    if (Math.abs(area2) <= 1e-9) {
      let pointCount = 0;
      let eastSum = 0;
      let northSum = 0;
      for (let index = 0; index < ring.length - 1; index += 1) {
        const point = ring[index];
        if (point === undefined) {
          continue;
        }
        eastSum += point.east;
        northSum += point.north;
        pointCount += 1;
      }
      if (pointCount === 0) {
        return null;
      }
      return {
        east: eastSum / pointCount,
        north: northSum / pointCount,
      };
    }

    const scale = 1 / (3 * area2);
    return {
      east: centroidEastAcc * scale,
      north: centroidNorthAcc * scale,
    };
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

  private clipPolygonRingToBounds(
    ring: readonly PointMeters[],
    bounds: AxisAlignedBounds,
  ): PointMeters[] | null {
    const openRing = this.toOpenPolygonRing(ring);
    if (openRing.length < 3) {
      return null;
    }

    let clipped = openRing;
    clipped = this.clipOpenRingAgainstEdge(
      clipped,
      (point) => point.east >= bounds.minEast,
      (start, end) => this.intersectSegmentWithVerticalBoundary(start, end, bounds.minEast),
    );
    clipped = this.clipOpenRingAgainstEdge(
      clipped,
      (point) => point.east <= bounds.maxEast,
      (start, end) => this.intersectSegmentWithVerticalBoundary(start, end, bounds.maxEast),
    );
    clipped = this.clipOpenRingAgainstEdge(
      clipped,
      (point) => point.north >= bounds.minNorth,
      (start, end) => this.intersectSegmentWithHorizontalBoundary(start, end, bounds.minNorth),
    );
    clipped = this.clipOpenRingAgainstEdge(
      clipped,
      (point) => point.north <= bounds.maxNorth,
      (start, end) => this.intersectSegmentWithHorizontalBoundary(start, end, bounds.maxNorth),
    );

    if (clipped.length < 3) {
      return null;
    }

    const compact = this.collapseConsecutivePoints(
      clipped.map((point) => this.clampPointToBounds(point, bounds)),
      POLYGON_POINT_EPSILON_METERS,
    );
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

  private toOpenPolygonRing(ring: readonly PointMeters[]): PointMeters[] {
    if (ring.length === 0) {
      return [];
    }

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (
      first !== undefined &&
      last !== undefined &&
      this.pointsNear(first, last, POLYGON_POINT_EPSILON_METERS)
    ) {
      return [...ring.slice(0, ring.length - 1)];
    }

    return [...ring];
  }

  private clipOpenRingAgainstEdge(
    ring: readonly PointMeters[],
    isInside: (point: PointMeters) => boolean,
    intersect: (start: PointMeters, end: PointMeters) => PointMeters,
  ): PointMeters[] {
    if (ring.length === 0) {
      return [];
    }

    const output: PointMeters[] = [];
    for (let index = 0; index < ring.length; index += 1) {
      const current = ring[index];
      const previous = ring[(index - 1 + ring.length) % ring.length];
      if (current === undefined || previous === undefined) {
        continue;
      }

      const currentInside = isInside(current);
      const previousInside = isInside(previous);

      if (currentInside) {
        if (!previousInside) {
          output.push(intersect(previous, current));
        }
        output.push(current);
        continue;
      }

      if (previousInside) {
        output.push(intersect(previous, current));
      }
    }

    return output;
  }

  private intersectSegmentWithVerticalBoundary(
    start: PointMeters,
    end: PointMeters,
    edgeEast: number,
  ): PointMeters {
    const deltaEast = end.east - start.east;
    if (Math.abs(deltaEast) <= Number.EPSILON) {
      return {
        east: edgeEast,
        north: start.north,
      };
    }

    const t = (edgeEast - start.east) / deltaEast;
    return {
      east: edgeEast,
      north: start.north + (end.north - start.north) * t,
    };
  }

  private intersectSegmentWithHorizontalBoundary(
    start: PointMeters,
    end: PointMeters,
    edgeNorth: number,
  ): PointMeters {
    const deltaNorth = end.north - start.north;
    if (Math.abs(deltaNorth) <= Number.EPSILON) {
      return {
        east: start.east,
        north: edgeNorth,
      };
    }

    const t = (edgeNorth - start.north) / deltaNorth;
    return {
      east: start.east + (end.east - start.east) * t,
      north: edgeNorth,
    };
  }

  private clampPointToBounds(point: PointMeters, bounds: AxisAlignedBounds): PointMeters {
    return {
      east: Math.max(bounds.minEast, Math.min(bounds.maxEast, point.east)),
      north: Math.max(bounds.minNorth, Math.min(bounds.maxNorth, point.north)),
    };
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

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
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
