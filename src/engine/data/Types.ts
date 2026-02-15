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
}

export interface RoadFeature {
  readonly id: string;
  readonly points: readonly PointMeters[];
  readonly properties: RoadProperties;
}

export interface BuildingFeature {
  readonly id: string;
  readonly footprint: readonly PointMeters[];
  readonly properties: BuildingProperties;
}

export interface TileOSMData {
  readonly tileKey: string;
  readonly schemaVersion: string;
  readonly sourceVersion: string;
  readonly sourceEndpoint: string;
  readonly fetchedAt: number;
  readonly bbox: GeoBoundsLatLon;
  readonly tileOriginGlobalMeters: PointMeters;
  readonly roads: readonly RoadFeature[];
  readonly buildings: readonly BuildingFeature[];
}

export interface TileFetchParams {
  readonly tileKey: string;
  readonly bbox: GeoBoundsLatLon;
  readonly tileOriginGlobalMeters: PointMeters;
}

export interface TileFetchResult {
  readonly data: TileOSMData;
  readonly source: 'network' | 'cache-fresh' | 'cache-stale';
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
