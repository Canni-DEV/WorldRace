export interface GeoBoundsLatLon {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export interface PointMeters {
  readonly east: number;
  readonly north: number;
}

export interface RoadProperties {
  readonly highway: string;
  readonly widthMeters: number | null;
  readonly lanes: number | null;
  readonly oneway: boolean | null;
  readonly maxspeed: string | null;
}

export interface BuildingProperties {
  readonly kind: string;
  readonly levels: number | null;
  readonly heightMeters: number | null;
  readonly roofShape: string | null;
}

export interface BuildingPolygon {
  readonly outer: readonly PointMeters[];
  readonly holes: readonly (readonly PointMeters[])[];
}

export interface RoadFeature {
  readonly id: string;
  readonly points: readonly PointMeters[];
  readonly properties: RoadProperties;
}

export interface BuildingFeature {
  readonly id: string;
  readonly polygons: readonly BuildingPolygon[];
  readonly properties: BuildingProperties;
}

export type TileEmptyReason =
  | 'not-empty'
  | 'real-empty'
  | 'suspect-empty-confirmed'
  | 'suspect-empty-recovered';

export interface TileOSMData {
  readonly tileKey: string;
  readonly schemaVersion: string;
  readonly sourceVersion: string;
  readonly sourceEndpoint: string;
  readonly fetchedAt: number;
  readonly bbox: GeoBoundsLatLon;
  readonly tileOriginGlobalMeters: PointMeters;
  readonly tileSizeMeters: number;
  readonly roads: readonly RoadFeature[];
  readonly buildings: readonly BuildingFeature[];
  readonly emptyReason: TileEmptyReason;
}

export interface TileFetchParams {
  readonly tileKey: string;
  readonly bbox: GeoBoundsLatLon;
  readonly tileOriginGlobalMeters: PointMeters;
  readonly tileSizeMeters: number;
  readonly tileCoordinate: {
    readonly x: number;
    readonly y: number;
  };
}

export interface TileFetchResult {
  readonly data: TileOSMData;
  readonly source: 'network' | 'cache-fresh' | 'cache-stale';
}

export type TileFetchPriority = 'foreground' | 'background';

export interface TileFetchOptions {
  readonly signal?: AbortSignal;
  readonly priority?: TileFetchPriority;
}

export interface CacheMetricsSnapshot {
  readonly hits: number;
  readonly misses: number;
  readonly staleHits: number;
  readonly hitRatio: number;
  readonly lastEntryAgeMs: number | null;
  readonly normalizedStoreEntries: number;
  readonly normalizedStoreBytes: number;
  readonly rawStoreEntries: number;
  readonly rawStoreBytes: number;
  readonly lastSource: TileFetchResult['source'] | 'none';
}
