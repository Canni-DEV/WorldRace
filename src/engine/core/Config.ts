export interface RuntimeConfig {
  readonly initialLatitude: number;
  readonly initialLongitude: number;
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
}

export const runtimeConfig: RuntimeConfig = Object.freeze({
  initialLatitude: 40.7128,
  initialLongitude: -74.006,
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
});
