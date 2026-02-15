import type { TileDataService } from '../data/TileDataService';
import type { TileFetchParams, TileFetchResult } from '../data/Types';
import type { SceneComposer } from '../render/SceneComposer';
import type { TileCoordinate, TileRings, TileSystem } from '../geo/TileSystem';
import { RoadMeshBuildService } from './RoadMeshBuildService';
import type { RoadMeshStats } from './RoadMeshTypes';
import type { TopologyRegistry } from './TopologyRegistry';

type TileRingKind = 'active' | 'prefetch';

interface DesiredTileEntry {
  readonly tile: TileCoordinate;
  readonly tileKey: string;
  readonly ringKind: TileRingKind;
  readonly priority: number;
}

interface InflightTileEntry {
  readonly tile: TileCoordinate;
  phase: 'fetch' | 'build';
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
  readonly useBuildWorker: boolean;
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
  readonly canceledLoads: number;
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
  maxConcurrentLoads: 3,
  useBuildWorker: true,
};

export class WorldStream {
  private readonly tileSystem: TileSystem;
  private readonly tileDataService: TileDataService;
  private readonly topologyRegistry: TopologyRegistry;
  private readonly sceneComposer: SceneComposer;
  private readonly createTileFetchParams: (tile: TileCoordinate, tileKey: string) => TileFetchParams;
  private readonly buildService: RoadMeshBuildService;
  private readonly maxConcurrentLoads: number;

  private readonly desiredByKey = new Map<string, DesiredTileEntry>();
  private readonly pendingByKey = new Map<string, DesiredTileEntry>();
  private readonly inflightByKey = new Map<string, InflightTileEntry>();
  private readonly loadedByKey = new Map<string, LoadedTileEntry>();
  private currentTileKey = '';
  private status = 'idle';
  private canceledLoads = 0;
  private disposedTiles = 0;
  private fetchErrors = 0;
  private buildErrors = 0;
  private lastFetchMs = 0;
  private lastBuildMs = 0;
  private approxMeshBytes = 0;
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
    this.unloadTilesOutsideDesiredSet();
    this.enqueueMissingTiles();
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
      canceledLoads: this.canceledLoads,
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

    this.inflightByKey.clear();
    this.buildService.dispose();
  }

  private reconcileDesiredTiles(currentTile: TileCoordinate, tileRings: TileRings): void {
    const nextDesired = new Map<string, DesiredTileEntry>();

    for (const tile of tileRings.activeTiles) {
      const tileKey = this.tileSystem.getTileKey(tile);
      nextDesired.set(tileKey, {
        tile,
        tileKey,
        ringKind: 'active',
        priority: this.computeTilePriority(tile, currentTile, 'active'),
      });
    }

    for (const tile of tileRings.prefetchTiles) {
      const tileKey = this.tileSystem.getTileKey(tile);
      if (nextDesired.has(tileKey)) {
        continue;
      }
      nextDesired.set(tileKey, {
        tile,
        tileKey,
        ringKind: 'prefetch',
        priority: this.computeTilePriority(tile, currentTile, 'prefetch'),
      });
    }

    this.desiredByKey.clear();
    for (const [tileKey, entry] of nextDesired.entries()) {
      this.desiredByKey.set(tileKey, entry);
    }

    for (const pendingKey of [...this.pendingByKey.keys()]) {
      if (!this.desiredByKey.has(pendingKey)) {
        this.pendingByKey.delete(pendingKey);
      }
    }
  }

  private enqueueMissingTiles(): void {
    for (const [tileKey, desired] of this.desiredByKey.entries()) {
      if (this.pendingByKey.has(tileKey) || this.inflightByKey.has(tileKey) || this.loadedByKey.has(tileKey)) {
        continue;
      }
      this.pendingByKey.set(tileKey, desired);
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
    this.topologyRegistry.removeTile(tileKey);
    this.loadedByKey.delete(tileKey);
    this.approxMeshBytes = Math.max(0, this.approxMeshBytes - loaded.approxMeshBytes);
    this.disposedTiles += 1;
  }

  private pumpQueue(): void {
    while (this.inflightByKey.size < this.maxConcurrentLoads) {
      const nextRequest = this.dequeueNextPending();
      if (nextRequest === null) {
        break;
      }

      this.pendingByKey.delete(nextRequest.tileKey);
      this.inflightByKey.set(nextRequest.tileKey, {
        tile: nextRequest.tile,
        phase: 'fetch',
      });
      void this.processTileLoad(nextRequest);
    }
  }

  private dequeueNextPending(): DesiredTileEntry | null {
    let selected: DesiredTileEntry | null = null;
    for (const candidate of this.pendingByKey.values()) {
      if (selected === null || candidate.priority < selected.priority) {
        selected = candidate;
      }
    }
    return selected;
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
      this.status = `loading fetch ${tileKey}`;
      const fetchParams = this.createTileFetchParams(request.tile, tileKey);
      const fetchStartedAt = performance.now();
      fetched = await this.tileDataService.getOrFetchTile(fetchParams);
      this.lastFetchMs = performance.now() - fetchStartedAt;

      if (this.disposed || !this.desiredByKey.has(tileKey)) {
        this.canceledLoads += 1;
        return;
      }

      this.status = `loading build ${tileKey}`;
      inflightEntry.phase = 'build';

      const topology = this.topologyRegistry.upsertTile(fetched.data);
      topologyInserted = true;
      const buildResult = await this.buildService.build(topology);
      this.lastBuildMs = buildResult.buildTimeMs;

      if (this.disposed || !this.desiredByKey.has(tileKey)) {
        this.topologyRegistry.removeTile(tileKey);
        this.canceledLoads += 1;
        return;
      }

      this.sceneComposer.upsertRoadTileMesh(buildResult.payload);
      const previous = this.loadedByKey.get(tileKey);
      if (previous !== undefined) {
        this.approxMeshBytes = Math.max(0, this.approxMeshBytes - previous.approxMeshBytes);
      }

      const approxMeshBytes =
        buildResult.payload.surfacePositions.byteLength +
        buildResult.payload.surfaceUvs.byteLength +
        buildResult.payload.surfaceIndices.byteLength +
        buildResult.payload.collisionPositions.byteLength +
        buildResult.payload.collisionIndices.byteLength +
        buildResult.payload.debugLinePositions.byteLength;

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
        roadMeshStats: buildResult.payload.stats,
        fetchTimeMs: this.lastFetchMs,
        buildTimeMs: buildResult.buildTimeMs,
        approxMeshBytes,
      });

      this.status = `ready ${tileKey}`;
    } catch (error: unknown) {
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

  private computeTilePriority(
    tile: TileCoordinate,
    currentTile: TileCoordinate,
    ringKind: TileRingKind,
  ): number {
    const dx = Math.abs(tile.x - currentTile.x);
    const dy = Math.abs(tile.y - currentTile.y);
    const chebyshevDistance = Math.max(dx, dy);
    const manhattanDistance = dx + dy;
    const ringWeight = ringKind === 'active' ? 0 : 1000;
    return ringWeight + chebyshevDistance * 10 + manhattanDistance;
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
