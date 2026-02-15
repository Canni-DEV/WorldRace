import type { TileDataService } from '../data/TileDataService';
import type { TileFetchParams, TileFetchResult } from '../data/Types';
import type { SceneComposer } from '../render/SceneComposer';
import type { TileCoordinate, TileRings, TileSystem } from '../geo/TileSystem';
import { BuildingMesher } from './BuildingMesher';
import { RoadMeshBuildService } from './RoadMeshBuildService';
import type { RoadMeshStats } from './RoadMeshTypes';
import type { TopologyRegistry } from './TopologyRegistry';

type TileRingKind = 'active' | 'prefetch';
type TilePriorityBand = 'focus' | 'near-active' | 'far-active' | 'prefetch';
type InflightCancelReason = 'none' | 'obsolete' | 'preempted';

interface DesiredTileEntry {
  readonly tile: TileCoordinate;
  readonly tileKey: string;
  readonly ringKind: TileRingKind;
  readonly priorityBand: TilePriorityBand;
  readonly chebyshevDistance: number;
  readonly manhattanDistance: number;
  readonly priorityScore: number;
}

interface PendingTileEntry {
  readonly desired: DesiredTileEntry;
  readonly enqueueSequence: number;
  readonly deferredUntilMs: number;
}

interface InflightTileEntry {
  readonly tile: TileCoordinate;
  readonly priorityBand: TilePriorityBand;
  phase: 'fetch' | 'build';
  abortController: AbortController | null;
  cancelReason: InflightCancelReason;
}

interface LoadedTileEntry {
  readonly tile: TileCoordinate;
  readonly tileKey: string;
  readonly source: TileFetchResult['source'];
  readonly roadsCount: number;
  readonly buildingsCount: number;
  readonly topologyNodeCount: number;
  readonly topologyEdgeCount: number;
  readonly topologyIntersectionSplits: number;
  readonly topologyDroppedSegments: number;
  readonly topologyStitchedNodes: number;
  readonly roadMeshStats: RoadMeshStats;
  readonly fetchTimeMs: number;
  readonly buildTimeMs: number;
  readonly approxMeshBytes: number;
}

export interface WorldStreamConfig {
  readonly maxConcurrentLoads: number;
  readonly maxConcurrentFetches: number;
  readonly useBuildWorker: boolean;
  readonly prefetchRequestIntervalMs: number;
  readonly prefetchDeferMsWhenForegroundIncomplete: number;
}

export interface WorldStreamCurrentTileSnapshot {
  readonly tileKey: string;
  readonly source: TileFetchResult['source'];
  readonly roadsCount: number;
  readonly buildingsCount: number;
  readonly topologyNodeCount: number;
  readonly topologyEdgeCount: number;
  readonly topologyIntersectionSplits: number;
  readonly topologyDroppedSegments: number;
  readonly topologyStitchedNodes: number;
  readonly roadMeshStats: RoadMeshStats;
}

export interface WorldStreamSnapshot {
  readonly status: string;
  readonly desiredTiles: number;
  readonly loadedTiles: number;
  readonly pendingTiles: number;
  readonly inflightFetches: number;
  readonly inflightBuilds: number;
  readonly canceledObsoleteLoads: number;
  readonly deferredPrefetchLoads: number;
  readonly skippedPrefetchBecauseForeground: number;
  readonly disposedTiles: number;
  readonly fetchErrors: number;
  readonly buildErrors: number;
  readonly lastFetchMs: number;
  readonly lastBuildMs: number;
  readonly approxMeshMegabytes: number;
  readonly buildMode: 'worker' | 'main-thread';
  readonly currentTile: WorldStreamCurrentTileSnapshot | null;
}

interface WorldStreamDependencies {
  readonly tileSystem: TileSystem;
  readonly tileDataService: TileDataService;
  readonly topologyRegistry: TopologyRegistry;
  readonly sceneComposer: SceneComposer;
  readonly createTileFetchParams: (tile: TileCoordinate, tileKey: string) => TileFetchParams;
}

const defaultConfig: WorldStreamConfig = {
  maxConcurrentLoads: 2,
  maxConcurrentFetches: 1,
  useBuildWorker: true,
  prefetchRequestIntervalMs: 650,
  prefetchDeferMsWhenForegroundIncomplete: 250,
};

export class WorldStream {
  private readonly tileSystem: TileSystem;
  private readonly tileDataService: TileDataService;
  private readonly topologyRegistry: TopologyRegistry;
  private readonly sceneComposer: SceneComposer;
  private readonly createTileFetchParams: (tile: TileCoordinate, tileKey: string) => TileFetchParams;
  private readonly buildingMesher = new BuildingMesher();
  private readonly buildService: RoadMeshBuildService;
  private readonly maxConcurrentLoads: number;
  private readonly maxConcurrentFetches: number;
  private readonly prefetchRequestIntervalMs: number;
  private readonly prefetchDeferMsWhenForegroundIncomplete: number;

  private readonly desiredByKey = new Map<string, DesiredTileEntry>();
  private readonly pendingByKey = new Map<string, PendingTileEntry>();
  private readonly inflightByKey = new Map<string, InflightTileEntry>();
  private readonly loadedByKey = new Map<string, LoadedTileEntry>();
  private currentTileKey = '';
  private status = 'idle';
  private canceledObsoleteLoads = 0;
  private deferredPrefetchLoads = 0;
  private skippedPrefetchBecauseForeground = 0;
  private disposedTiles = 0;
  private fetchErrors = 0;
  private buildErrors = 0;
  private lastFetchMs = 0;
  private lastBuildMs = 0;
  private approxMeshBytes = 0;
  private lastPrefetchDispatchAtMs = Number.NEGATIVE_INFINITY;
  private nextPendingSequence = 1;
  private disposed = false;

  public constructor(
    dependencies: WorldStreamDependencies,
    config: Partial<WorldStreamConfig> = {},
  ) {
    this.tileSystem = dependencies.tileSystem;
    this.tileDataService = dependencies.tileDataService;
    this.topologyRegistry = dependencies.topologyRegistry;
    this.sceneComposer = dependencies.sceneComposer;
    this.createTileFetchParams = dependencies.createTileFetchParams;
    this.maxConcurrentLoads = Math.max(
      1,
      Math.floor(config.maxConcurrentLoads ?? defaultConfig.maxConcurrentLoads),
    );
    this.maxConcurrentFetches = Math.max(
      1,
      Math.floor(config.maxConcurrentFetches ?? defaultConfig.maxConcurrentFetches),
    );
    this.prefetchRequestIntervalMs = Math.max(
      0,
      config.prefetchRequestIntervalMs ?? defaultConfig.prefetchRequestIntervalMs,
    );
    this.prefetchDeferMsWhenForegroundIncomplete = Math.max(
      0,
      config.prefetchDeferMsWhenForegroundIncomplete ??
        defaultConfig.prefetchDeferMsWhenForegroundIncomplete,
    );
    this.buildService = new RoadMeshBuildService({
      useWorker: config.useBuildWorker ?? defaultConfig.useBuildWorker,
    });
  }

  public update(currentTile: TileCoordinate, tileRings: TileRings): void {
    if (this.disposed) {
      return;
    }

    this.currentTileKey = this.tileSystem.getTileKey(currentTile);
    this.reconcileDesiredTiles(currentTile, tileRings);
    this.reconcilePendingTiles();
    this.enqueueMissingTiles();
    this.abortStaleInflightFetches();
    this.preemptLowerPriorityInflightFetches();
    this.unloadTilesOutsideDesiredSet();
    this.pumpQueue();
  }

  public getSnapshot(): WorldStreamSnapshot {
    const inflightFetches = this.countInflightByPhase('fetch');
    const inflightBuilds = this.countInflightByPhase('build');
    const currentTile = this.loadedByKey.get(this.currentTileKey);
    const liveStatus = this.resolveCurrentTileStatus(currentTile);

    return {
      status: liveStatus,
      desiredTiles: this.desiredByKey.size,
      loadedTiles: this.loadedByKey.size,
      pendingTiles: this.pendingByKey.size,
      inflightFetches,
      inflightBuilds,
      canceledObsoleteLoads: this.canceledObsoleteLoads,
      deferredPrefetchLoads: this.deferredPrefetchLoads,
      skippedPrefetchBecauseForeground: this.skippedPrefetchBecauseForeground,
      disposedTiles: this.disposedTiles,
      fetchErrors: this.fetchErrors,
      buildErrors: this.buildErrors,
      lastFetchMs: this.lastFetchMs,
      lastBuildMs: this.lastBuildMs,
      approxMeshMegabytes: this.approxMeshBytes / (1024 * 1024),
      buildMode: this.buildService.getMode(),
      currentTile:
        currentTile === undefined
          ? null
          : {
              tileKey: currentTile.tileKey,
              source: currentTile.source,
              roadsCount: currentTile.roadsCount,
              buildingsCount: currentTile.buildingsCount,
              topologyNodeCount: currentTile.topologyNodeCount,
              topologyEdgeCount: currentTile.topologyEdgeCount,
              topologyIntersectionSplits: currentTile.topologyIntersectionSplits,
              topologyDroppedSegments: currentTile.topologyDroppedSegments,
              topologyStitchedNodes: currentTile.topologyStitchedNodes,
              roadMeshStats: currentTile.roadMeshStats,
            },
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.pendingByKey.clear();
    this.desiredByKey.clear();

    for (const tileKey of this.loadedByKey.keys()) {
      this.unloadTile(tileKey);
    }

    for (const inflight of this.inflightByKey.values()) {
      if (inflight.phase !== 'fetch') {
        continue;
      }
      this.abortInflightFetch(inflight, 'obsolete');
    }
    this.inflightByKey.clear();
    this.buildService.dispose();
  }

  private reconcileDesiredTiles(currentTile: TileCoordinate, tileRings: TileRings): void {
    const nextDesired = new Map<string, DesiredTileEntry>();

    for (const tile of tileRings.activeTiles) {
      const tileKey = this.tileSystem.getTileKey(tile);
      const distances = this.computeTileDistances(tile, currentTile);
      nextDesired.set(tileKey, {
        tile,
        tileKey,
        ringKind: 'active',
        priorityBand: this.resolvePriorityBand(distances.chebyshevDistance, 'active'),
        chebyshevDistance: distances.chebyshevDistance,
        manhattanDistance: distances.manhattanDistance,
        priorityScore: this.computeTilePriorityScore(
          this.resolvePriorityBand(distances.chebyshevDistance, 'active'),
          distances.chebyshevDistance,
          distances.manhattanDistance,
        ),
      });
    }

    for (const tile of tileRings.prefetchTiles) {
      const tileKey = this.tileSystem.getTileKey(tile);
      if (nextDesired.has(tileKey)) {
        continue;
      }
      const distances = this.computeTileDistances(tile, currentTile);
      nextDesired.set(tileKey, {
        tile,
        tileKey,
        ringKind: 'prefetch',
        priorityBand: this.resolvePriorityBand(distances.chebyshevDistance, 'prefetch'),
        chebyshevDistance: distances.chebyshevDistance,
        manhattanDistance: distances.manhattanDistance,
        priorityScore: this.computeTilePriorityScore(
          this.resolvePriorityBand(distances.chebyshevDistance, 'prefetch'),
          distances.chebyshevDistance,
          distances.manhattanDistance,
        ),
      });
    }

    this.desiredByKey.clear();
    for (const [tileKey, entry] of nextDesired.entries()) {
      this.desiredByKey.set(tileKey, entry);
    }

  }

  private reconcilePendingTiles(): void {
    for (const [tileKey, pending] of [...this.pendingByKey.entries()]) {
      const desired = this.desiredByKey.get(tileKey);
      if (desired === undefined) {
        this.pendingByKey.delete(tileKey);
        continue;
      }

      this.pendingByKey.set(tileKey, {
        desired,
        enqueueSequence: pending.enqueueSequence,
        deferredUntilMs: desired.priorityBand === 'prefetch' ? pending.deferredUntilMs : 0,
      });
    }
  }

  private enqueueMissingTiles(): void {
    for (const [tileKey, desired] of this.desiredByKey.entries()) {
      if (this.pendingByKey.has(tileKey) || this.inflightByKey.has(tileKey) || this.loadedByKey.has(tileKey)) {
        continue;
      }
      this.pendingByKey.set(tileKey, {
        desired,
        enqueueSequence: this.nextPendingSequence,
        deferredUntilMs: 0,
      });
      this.nextPendingSequence += 1;
    }
  }

  private unloadTilesOutsideDesiredSet(): void {
    for (const tileKey of [...this.loadedByKey.keys()]) {
      if (this.desiredByKey.has(tileKey)) {
        continue;
      }
      this.unloadTile(tileKey);
    }
  }

  private unloadTile(tileKey: string): void {
    const loaded = this.loadedByKey.get(tileKey);
    if (loaded === undefined) {
      return;
    }

    this.sceneComposer.removeRoadTileMesh(tileKey);
    this.sceneComposer.removeBuildingTileMesh(tileKey);
    this.topologyRegistry.removeTile(tileKey);
    this.loadedByKey.delete(tileKey);
    this.approxMeshBytes = Math.max(0, this.approxMeshBytes - loaded.approxMeshBytes);
    this.disposedTiles += 1;
  }

  private pumpQueue(): void {
    while (this.inflightByKey.size < this.maxConcurrentLoads) {
      const inflightFetchCount = this.countInflightByPhase('fetch');
      if (inflightFetchCount >= this.maxConcurrentFetches) {
        break;
      }

      const nowMs = performance.now();
      const nextRequest = this.dequeueNextPending(nowMs);
      if (nextRequest === null) {
        break;
      }

      this.pendingByKey.delete(nextRequest.desired.tileKey);
      const abortController = new AbortController();
      this.inflightByKey.set(nextRequest.desired.tileKey, {
        tile: nextRequest.desired.tile,
        priorityBand: nextRequest.desired.priorityBand,
        phase: 'fetch',
        abortController,
        cancelReason: 'none',
      });

      if (nextRequest.desired.priorityBand === 'prefetch') {
        this.lastPrefetchDispatchAtMs = nowMs;
      }
      void this.processTileLoad(nextRequest.desired);
    }
  }

  private dequeueNextPending(nowMs: number): PendingTileEntry | null {
    const foregroundComplete = this.isForegroundComplete();
    const canDispatchPrefetch = foregroundComplete && this.canDispatchPrefetchByBudget(nowMs);
    let selected: PendingTileEntry | null = null;

    for (const [tileKey, pending] of this.pendingByKey.entries()) {
      if (nowMs < pending.deferredUntilMs) {
        continue;
      }

      if (pending.desired.priorityBand === 'prefetch' && !canDispatchPrefetch) {
        const deferredUntil = foregroundComplete
          ? nowMs + this.prefetchRequestIntervalMs
          : nowMs + this.prefetchDeferMsWhenForegroundIncomplete;
        this.pendingByKey.set(tileKey, {
          desired: pending.desired,
          enqueueSequence: pending.enqueueSequence,
          deferredUntilMs: deferredUntil,
        });
        this.deferredPrefetchLoads += 1;
        if (!foregroundComplete) {
          this.skippedPrefetchBecauseForeground += 1;
        }
        continue;
      }

      if (selected === null) {
        selected = pending;
        continue;
      }

      const selectedScore = selected.desired.priorityScore;
      const candidateScore = pending.desired.priorityScore;
      if (candidateScore < selectedScore) {
        selected = pending;
        continue;
      }

      if (candidateScore === selectedScore && pending.enqueueSequence < selected.enqueueSequence) {
        selected = pending;
      }
    }

    return selected;
  }

  private isForegroundComplete(): boolean {
    for (const desired of this.desiredByKey.values()) {
      if (desired.priorityBand === 'focus' || desired.priorityBand === 'near-active') {
        if (!this.loadedByKey.has(desired.tileKey)) {
          return false;
        }
      }
    }
    return true;
  }

  private canDispatchPrefetchByBudget(nowMs: number): boolean {
    return nowMs - this.lastPrefetchDispatchAtMs >= this.prefetchRequestIntervalMs;
  }

  private async processTileLoad(request: DesiredTileEntry): Promise<void> {
    const tileKey = request.tileKey;
    const inflightEntry = this.inflightByKey.get(tileKey);
    if (inflightEntry === undefined) {
      return;
    }

    let fetched: TileFetchResult | null = null;
    let topologyInserted = false;

    try {
      const desiredAtStart = this.desiredByKey.get(tileKey);
      if (this.disposed || desiredAtStart === undefined) {
        this.canceledObsoleteLoads += 1;
        return;
      }

      this.status = `loading fetch ${tileKey}`;
      const fetchParams = this.createTileFetchParams(request.tile, tileKey);
      const fetchStartedAt = performance.now();
      fetched = await this.tileDataService.getOrFetchTile(fetchParams, {
        signal: inflightEntry.abortController?.signal,
        priority: this.toFetchPriority(request.priorityBand),
      });
      this.lastFetchMs = performance.now() - fetchStartedAt;

      if (this.disposed || !this.desiredByKey.has(tileKey)) {
        this.canceledObsoleteLoads += 1;
        return;
      }

      this.status = `loading build ${tileKey}`;
      inflightEntry.phase = 'build';
      inflightEntry.abortController = null;
      inflightEntry.cancelReason = 'none';

      const topology = this.topologyRegistry.upsertTile(fetched.data);
      topologyInserted = true;
      const roadBuildResult = await this.buildService.build(topology);
      const buildingBuildStartedAt = performance.now();
      const buildingMesh = this.buildingMesher.buildTileBuildingMesh(fetched.data);
      const buildingBuildMs = performance.now() - buildingBuildStartedAt;
      this.lastBuildMs = roadBuildResult.buildTimeMs + buildingBuildMs;

      if (this.disposed || !this.desiredByKey.has(tileKey)) {
        this.topologyRegistry.removeTile(tileKey);
        this.canceledObsoleteLoads += 1;
        return;
      }

      this.sceneComposer.upsertRoadTileMesh(roadBuildResult.payload);
      this.sceneComposer.upsertBuildingTileMesh(buildingMesh);
      const previous = this.loadedByKey.get(tileKey);
      if (previous !== undefined) {
        this.approxMeshBytes = Math.max(0, this.approxMeshBytes - previous.approxMeshBytes);
      }

      const approxMeshBytes =
        roadBuildResult.payload.surfacePositions.byteLength +
        roadBuildResult.payload.surfaceUvs.byteLength +
        roadBuildResult.payload.surfaceIndices.byteLength +
        roadBuildResult.payload.collisionPositions.byteLength +
        roadBuildResult.payload.collisionIndices.byteLength +
        roadBuildResult.payload.debugLinePositions.byteLength +
        buildingMesh.lod0Positions.byteLength +
        buildingMesh.lod0Indices.byteLength +
        buildingMesh.lod1Positions.byteLength +
        buildingMesh.lod1Indices.byteLength;

      this.approxMeshBytes += approxMeshBytes;
      this.loadedByKey.set(tileKey, {
        tile: request.tile,
        tileKey,
        source: fetched.source,
        roadsCount: fetched.data.roads.length,
        buildingsCount: fetched.data.buildings.length,
        topologyNodeCount: topology.nodes.length,
        topologyEdgeCount: topology.edges.length,
        topologyIntersectionSplits: topology.stats.intersectionSplits,
        topologyDroppedSegments:
          topology.stats.droppedDegenerateRoads + topology.stats.droppedZeroLengthSegments,
        topologyStitchedNodes: topology.stats.stitchedNodes,
        roadMeshStats: roadBuildResult.payload.stats,
        fetchTimeMs: this.lastFetchMs,
        buildTimeMs: this.lastBuildMs,
        approxMeshBytes,
      });

      this.status = `ready ${tileKey}`;
    } catch (error: unknown) {
      if (this.isAbortError(error)) {
        if (inflightEntry.cancelReason !== 'none') {
          this.canceledObsoleteLoads += 1;
        }
        this.status = `canceled ${tileKey}`;
        if (topologyInserted) {
          this.topologyRegistry.removeTile(tileKey);
        }
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown stream error.';
      if (inflightEntry.phase === 'fetch') {
        this.fetchErrors += 1;
        this.status = `fetch error ${tileKey}: ${message}`;
      } else {
        this.buildErrors += 1;
        this.status = `build error ${tileKey}: ${message}`;
      }

      if (topologyInserted) {
        this.topologyRegistry.removeTile(tileKey);
      }
    } finally {
      this.inflightByKey.delete(tileKey);
      this.unloadTilesOutsideDesiredSet();
      this.pumpQueue();
    }
  }

  private computeTileDistances(
    tile: TileCoordinate,
    currentTile: TileCoordinate,
  ): { readonly chebyshevDistance: number; readonly manhattanDistance: number } {
    const dx = Math.abs(tile.x - currentTile.x);
    const dy = Math.abs(tile.y - currentTile.y);
    return {
      chebyshevDistance: Math.max(dx, dy),
      manhattanDistance: dx + dy,
    };
  }

  private resolvePriorityBand(
    chebyshevDistance: number,
    ringKind: TileRingKind,
  ): TilePriorityBand {
    if (chebyshevDistance === 0) {
      return 'focus';
    }

    if (ringKind === 'active' && chebyshevDistance === 1) {
      return 'near-active';
    }

    if (ringKind === 'active') {
      return 'far-active';
    }

    return 'prefetch';
  }

  private computeTilePriorityScore(
    priorityBand: TilePriorityBand,
    chebyshevDistance: number,
    manhattanDistance: number,
  ): number {
    const priorityBandWeight = this.getPriorityBandWeight(priorityBand);
    return priorityBandWeight * 10000 + chebyshevDistance * 100 + manhattanDistance;
  }

  private getPriorityBandWeight(priorityBand: TilePriorityBand): number {
    switch (priorityBand) {
      case 'focus':
        return 0;
      case 'near-active':
        return 1;
      case 'far-active':
        return 2;
      case 'prefetch':
      default:
        return 3;
    }
  }

  private abortStaleInflightFetches(): void {
    for (const [tileKey, inflight] of this.inflightByKey.entries()) {
      if (inflight.phase !== 'fetch') {
        continue;
      }
      if (this.desiredByKey.has(tileKey)) {
        continue;
      }
      this.abortInflightFetch(inflight, 'obsolete');
    }
  }

  private preemptLowerPriorityInflightFetches(): void {
    const targetPriorityScore = this.getMostUrgentForegroundPendingScore();
    if (targetPriorityScore === null) {
      return;
    }

    for (const [tileKey, inflight] of this.inflightByKey.entries()) {
      if (inflight.phase !== 'fetch') {
        continue;
      }

      const desired = this.desiredByKey.get(tileKey);
      if (desired === undefined) {
        this.abortInflightFetch(inflight, 'obsolete');
        continue;
      }

      if (desired.priorityScore <= targetPriorityScore) {
        continue;
      }
      this.abortInflightFetch(inflight, 'preempted');
    }
  }

  private getMostUrgentForegroundPendingScore(): number | null {
    let bestScore: number | null = null;
    for (const pending of this.pendingByKey.values()) {
      if (pending.desired.priorityBand === 'prefetch') {
        continue;
      }
      if (bestScore === null || pending.desired.priorityScore < bestScore) {
        bestScore = pending.desired.priorityScore;
      }
    }
    return bestScore;
  }

  private abortInflightFetch(inflight: InflightTileEntry, reason: InflightCancelReason): void {
    if (inflight.phase !== 'fetch') {
      return;
    }
    if (inflight.abortController === null) {
      return;
    }
    inflight.cancelReason = reason;
    inflight.abortController.abort();
    inflight.abortController = null;
  }

  private toFetchPriority(priorityBand: TilePriorityBand): 'foreground' | 'background' {
    if (priorityBand === 'prefetch') {
      return 'background';
    }
    return 'foreground';
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return true;
    }
    return error instanceof Error && error.name === 'AbortError';
  }

  private countInflightByPhase(phase: 'fetch' | 'build'): number {
    let count = 0;
    for (const inflight of this.inflightByKey.values()) {
      if (inflight.phase === phase) {
        count += 1;
      }
    }
    return count;
  }

  private resolveCurrentTileStatus(currentTile: LoadedTileEntry | undefined): string {
    if (currentTile !== undefined) {
      return `${currentTile.source} ${currentTile.tileKey}`;
    }

    const inflight = this.inflightByKey.get(this.currentTileKey);
    if (inflight !== undefined) {
      return `loading ${inflight.phase} ${this.currentTileKey}`;
    }

    if (this.pendingByKey.has(this.currentTileKey)) {
      return `queued ${this.currentTileKey}`;
    }

    if (this.status !== 'idle') {
      return this.status;
    }

    if (this.currentTileKey.length === 0) {
      return 'idle';
    }

    return `idle ${this.currentTileKey}`;
  }
}
