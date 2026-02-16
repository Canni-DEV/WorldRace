import type { RouteWeightingProfile } from '../data/Types';

export interface RuntimeConfig {
  readonly initialLatitude: number;
  readonly initialLongitude: number;
  readonly projectionEastSign: 1 | -1;
  readonly projectionNorthSign: 1 | -1;
  readonly tileSizeMeters: number;
  readonly activeRadiusTiles: number;
  readonly prefetchRadiusTiles: number;
  readonly floatingOriginThresholdMeters: number;
  readonly cacheTtlMs: number;
  readonly cacheStaleWhileRevalidate: boolean;
  readonly streamMaxConcurrentLoads: number;
  readonly streamMaxConcurrentFetches: number;
  readonly streamUseBuildWorker: boolean;
  readonly streamPrefetchRequestIntervalMs: number;
  readonly streamPrefetchDeferMsWhenForegroundIncomplete: number;
  readonly streamTileHysteresisMeters: number;
  readonly routeWeightingProfile: RouteWeightingProfile;
}

const defaultRouteWeightingProfile: RouteWeightingProfile = {
  excludedCategories: ['service'],
  categoryWeightByKind: {
    street: 1,
    avenue: 0.95,
    route: 0.9,
    highway: 0.88,
    service: 1.25,
    path: 1.35,
    other: 1.1,
  },
  pavementWeightByKind: {
    paved: 0.95,
    unpaved: 1.3,
    unknown: 1,
  },
  minWeightMultiplier: 0.5,
  maxWeightMultiplier: 4,
};
//Casa -32.95016559793226, -60.63083041636645
//Casa LasPa -32.68501167668344, -61.52219240633147
export const runtimeConfig: RuntimeConfig = Object.freeze({
  initialLatitude: -32.95016559793226,
  initialLongitude: -60.63083041636645,
  projectionEastSign: -1,
  projectionNorthSign: 1,
  tileSizeMeters: 256,
  activeRadiusTiles: 2,
  prefetchRadiusTiles: 3,
  floatingOriginThresholdMeters: 2000,
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  cacheStaleWhileRevalidate: true,
  streamMaxConcurrentLoads: 2,
  streamMaxConcurrentFetches: 1,
  streamUseBuildWorker: true,
  streamPrefetchRequestIntervalMs: 650,
  streamPrefetchDeferMsWhenForegroundIncomplete: 250,
  streamTileHysteresisMeters: 18,
  routeWeightingProfile: defaultRouteWeightingProfile,
});
