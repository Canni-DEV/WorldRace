import { Clock } from '../engine/core/Clock';
import { runtimeConfig } from '../engine/core/Config';
import { TileDataService } from '../engine/data/TileDataService';
import { Projection } from '../engine/geo/Projection';
import { TileSystem } from '../engine/geo/TileSystem';
import { SceneComposer } from '../engine/render/SceneComposer';
import { Anchor } from '../engine/sim/Anchor';
import { CameraController } from '../engine/sim/CameraController';
import { RoadMesher } from '../engine/world/RoadMesher';
import { TopologyRegistry } from '../engine/world/TopologyRegistry';
import { DebugPanel } from '../ui/DebugPanel';
import { HUD } from '../ui/HUD';
import type { CacheMetricsSnapshot, TileFetchParams } from '../engine/data/Types';
import type { GeoBoundsMeters } from '../engine/geo/GeoBounds';
import type { TileDebugGridData } from '../engine/render/SceneComposer';
import type { GlobalOffsetMeters, TileCoordinate, TileRings } from '../engine/geo/TileSystem';
import type { RoadMeshStats } from '../engine/world/RoadMeshTypes';

interface SpatialState {
  readonly tileKey: string;
  readonly currentTile: TileCoordinate;
  readonly tileRings: TileRings;
  readonly anchorLatitude: number;
  readonly anchorLongitude: number;
  readonly anchorEastMeters: number;
  readonly anchorNorthMeters: number;
  readonly tileDebugGridData: TileDebugGridData;
}

const EMPTY_CACHE_METRICS: CacheMetricsSnapshot = {
  hits: 0,
  misses: 0,
  staleHits: 0,
  hitRatio: 0,
  lastEntryAgeMs: null,
  normalizedStoreEntries: 0,
  normalizedStoreBytes: 0,
  rawStoreEntries: 0,
  rawStoreBytes: 0,
  lastSource: 'none',
};

const EMPTY_ROAD_MESH_STATS: RoadMeshStats = {
  edgeCountMeshed: 0,
  droppedEdges: 0,
  triangleCount: 0,
  collisionTriangleCount: 0,
  minResolvedWidthMeters: 0,
  maxResolvedWidthMeters: 0,
  junctionNodesConsidered: 0,
  junctionPolygonsBuilt: 0,
  junctionTriangles: 0,
  junctionMiterCorners: 0,
  junctionBevelCorners: 0,
  junctionFallbackCorners: 0,
  junctionTriangulationFailures: 0,
};

export class App {
  private readonly clock = new Clock();
  private readonly sceneComposer: SceneComposer;
  private readonly hud: HUD;
  private readonly debugPanel: DebugPanel;
  private readonly projection: Projection;
  private readonly tileSystem: TileSystem;
  private readonly anchor: Anchor;
  private readonly cameraController: CameraController;
  private readonly tileDataService: TileDataService;
  private readonly roadMesher: RoadMesher;
  private readonly topologyRegistry: TopologyRegistry;
  private globalOffsetMeters: GlobalOffsetMeters = { east: 0, north: 0 };
  private floatingOriginRecenters = 0;
  private lastTileDataRequestKey: string | null = null;
  private lastRenderedRoadTileKey: string | null = null;
  private currentTileDataStatus = 'idle';
  private currentTileRoadsCount = 0;
  private currentTileBuildingsCount = 0;
  private currentTopologyNodeCount = 0;
  private currentTopologyEdgeCount = 0;
  private currentTopologyIntersectionSplits = 0;
  private currentTopologyDroppedSegments = 0;
  private currentTopologyStitchedNodes = 0;
  private currentRoadMeshStats: RoadMeshStats = EMPTY_ROAD_MESH_STATS;
  private roadDebugOverlayEnabled = false;
  private cacheMetrics: CacheMetricsSnapshot = EMPTY_CACHE_METRICS;
  private frameHandle = 0;
  private isRunning = false;

  private readonly onResize = (): void => {
    this.sceneComposer.resize(window.innerWidth, window.innerHeight);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyB') {
      return;
    }

    this.roadDebugOverlayEnabled = !this.roadDebugOverlayEnabled;
    this.sceneComposer.setRoadDebugOverlayEnabled(this.roadDebugOverlayEnabled);
  };

  public constructor(rootElement: HTMLElement) {
    const viewport = document.createElement('div');
    viewport.className = 'app-viewport';
    rootElement.appendChild(viewport);

    this.sceneComposer = new SceneComposer(viewport);
    this.hud = new HUD(rootElement);
    this.debugPanel = new DebugPanel(rootElement);
    this.projection = new Projection({
      latitude: runtimeConfig.initialLatitude,
      longitude: runtimeConfig.initialLongitude,
    });
    this.tileDataService = new TileDataService(
      new Projection({
        latitude: runtimeConfig.initialLatitude,
        longitude: runtimeConfig.initialLongitude,
      }),
      {
        staleWhileRevalidate: runtimeConfig.cacheStaleWhileRevalidate,
        cacheTtlMs: runtimeConfig.cacheTtlMs,
      },
    );
    this.roadMesher = new RoadMesher();
    this.topologyRegistry = new TopologyRegistry();
    this.tileSystem = new TileSystem(runtimeConfig.tileSizeMeters);
    this.anchor = new Anchor(this.sceneComposer.getCamera().position);
    this.cameraController = new CameraController(
      this.sceneComposer.getCamera(),
      this.sceneComposer.getInputElement(),
      this.anchor,
    );

    this.onResize();
    this.sceneComposer.setWorldOffset(this.globalOffsetMeters.east, this.globalOffsetMeters.north);
    this.sceneComposer.setRoadDebugOverlayEnabled(this.roadDebugOverlayEnabled);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.clock.reset();

    const animate = (timeMs: number): void => {
      if (!this.isRunning) {
        return;
      }

      const deltaSeconds = this.clock.tick(timeMs);
      this.cameraController.update(deltaSeconds);
      this.applyFloatingOriginIfNeeded();
      const spatialState = this.computeSpatialState();
      this.ensureTileDataForCurrentTile(spatialState);
      this.cacheMetrics = this.tileDataService.getMetricsSnapshot();
      this.sceneComposer.setWorldOffset(this.globalOffsetMeters.east, this.globalOffsetMeters.north);
      this.sceneComposer.updateTileDebugGrid(spatialState.tileDebugGridData);
      this.sceneComposer.render();

      const fps = deltaSeconds > 0 ? 1 / deltaSeconds : 0;
      const renderStats = this.sceneComposer.getRenderStats();

      this.hud.update({
        fps,
        frameMs: deltaSeconds * 1000,
        status: 'Move: WASD/Arrows, Up/Down: E/Q, RMB look, B toggles road debug',
        anchorEastMeters: spatialState.anchorEastMeters,
        anchorNorthMeters: spatialState.anchorNorthMeters,
        anchorLatitude: spatialState.anchorLatitude,
        anchorLongitude: spatialState.anchorLongitude,
        cacheHits: this.cacheMetrics.hits,
        cacheMisses: this.cacheMetrics.misses,
        cacheStaleHits: this.cacheMetrics.staleHits,
        cacheHitRatioPercent: this.cacheMetrics.hitRatio * 100,
        cacheLastAgeSeconds:
          this.cacheMetrics.lastEntryAgeMs === null ? null : this.cacheMetrics.lastEntryAgeMs / 1000,
        cacheStoreEntries: this.cacheMetrics.normalizedStoreEntries,
        cacheStoreMegabytes: this.cacheMetrics.normalizedStoreBytes / (1024 * 1024),
        dataSource: this.cacheMetrics.lastSource,
      });

      this.debugPanel.update({
        drawCalls: renderStats.drawCalls,
        triangles: renderStats.triangles,
        tileKey: spatialState.tileKey,
        activeTileCount: spatialState.tileRings.activeTiles.length,
        prefetchTileCount: spatialState.tileRings.prefetchTiles.length,
        activeTileSample: this.formatTileSample(spatialState.tileRings.activeTiles),
        prefetchTileSample: this.formatTileSample(spatialState.tileRings.prefetchTiles),
        floatingOriginRecenters: this.floatingOriginRecenters,
        tileDataStatus: this.currentTileDataStatus,
        tileRoadsCount: this.currentTileRoadsCount,
        tileBuildingsCount: this.currentTileBuildingsCount,
        topologyNodeCount: this.currentTopologyNodeCount,
        topologyEdgeCount: this.currentTopologyEdgeCount,
        topologyIntersectionSplits: this.currentTopologyIntersectionSplits,
        topologyDroppedSegments: this.currentTopologyDroppedSegments,
        topologyStitchedNodes: this.currentTopologyStitchedNodes,
        roadMeshEdgeCount: this.currentRoadMeshStats.edgeCountMeshed,
        roadMeshTriangleCount: this.currentRoadMeshStats.triangleCount,
        roadCollisionTriangleCount: this.currentRoadMeshStats.collisionTriangleCount,
        roadMeshWidthRange: this.formatRoadWidthRange(this.currentRoadMeshStats),
        roadJunctionSummary: this.formatRoadJunctionSummary(this.currentRoadMeshStats),
        roadDebugOverlayEnabled: this.roadDebugOverlayEnabled,
        renderedRoadTiles: this.sceneComposer.getRoadTileCount(),
      });

      this.frameHandle = window.requestAnimationFrame(animate);
    };

    this.frameHandle = window.requestAnimationFrame(animate);
  }

  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    window.cancelAnimationFrame(this.frameHandle);
  }

  public destroy(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.cameraController.dispose();
    this.hud.dispose();
    this.debugPanel.dispose();
    this.sceneComposer.dispose();
  }

  private computeSpatialState(): SpatialState {
    const anchorPosition = this.anchor.getPosition();
    const globalEast = this.globalOffsetMeters.east + anchorPosition.x;
    const globalNorth = this.globalOffsetMeters.north + anchorPosition.z;
    const currentTile = this.tileSystem.getTileFromGlobalMeters(globalEast, globalNorth);
    const tileRings = this.tileSystem.getDesiredTileRings(
      currentTile,
      runtimeConfig.activeRadiusTiles,
      runtimeConfig.prefetchRadiusTiles,
    );
    const currentLatLon = this.projection.localMetersToLatLon({
      east: anchorPosition.x,
      north: anchorPosition.z,
    });
    const currentTileBounds = this.tileSystem.getTileBoundsLocalMeters(currentTile, this.globalOffsetMeters);
    const tileDebugGridData: TileDebugGridData = {
      activeTileBounds: this.mapTilesToLocalBounds(tileRings.activeTiles),
      prefetchTileBounds: this.mapTilesToLocalBounds(tileRings.prefetchTiles),
      currentTileBounds,
    };

    return {
      tileKey: this.tileSystem.getTileKey(currentTile),
      currentTile,
      tileRings,
      anchorLatitude: currentLatLon.latitude,
      anchorLongitude: currentLatLon.longitude,
      anchorEastMeters: anchorPosition.x,
      anchorNorthMeters: anchorPosition.z,
      tileDebugGridData,
    };
  }

  private mapTilesToLocalBounds(tiles: readonly TileCoordinate[]): GeoBoundsMeters[] {
    return tiles.map((tile) => this.tileSystem.getTileBoundsLocalMeters(tile, this.globalOffsetMeters));
  }

  private applyFloatingOriginIfNeeded(): void {
    if (this.anchor.getDistanceToLocalOriginXZ() <= runtimeConfig.floatingOriginThresholdMeters) {
      return;
    }

    const anchorPosition = this.anchor.getPosition();
    const offsetEast = anchorPosition.x;
    const offsetNorth = anchorPosition.z;

    if (offsetEast === 0 && offsetNorth === 0) {
      return;
    }

    this.globalOffsetMeters = {
      east: this.globalOffsetMeters.east + offsetEast,
      north: this.globalOffsetMeters.north + offsetNorth,
    };
    this.projection.shiftOriginByLocalMeters({ east: offsetEast, north: offsetNorth });
    this.cameraController.applyFloatingOffset(offsetEast, offsetNorth);
    this.floatingOriginRecenters += 1;
  }

  private formatTileSample(tiles: readonly TileCoordinate[]): string {
    if (tiles.length === 0) {
      return '-';
    }

    const sampleSize = Math.min(4, tiles.length);
    const sample = tiles
      .slice(0, sampleSize)
      .map((tile) => this.tileSystem.getTileKey(tile))
      .join(' | ');

    if (tiles.length === sampleSize) {
      return sample;
    }

    return `${sample} | ...`;
  }

  private ensureTileDataForCurrentTile(spatialState: SpatialState): void {
    if (this.lastTileDataRequestKey === spatialState.tileKey) {
      return;
    }

    this.lastTileDataRequestKey = spatialState.tileKey;
    this.currentTileDataStatus = `loading ${spatialState.tileKey}`;
    const requestTileKey = spatialState.tileKey;
    const fetchParams = this.createTileFetchParams(spatialState.currentTile, requestTileKey);

    void this.tileDataService
      .getOrFetchTile(fetchParams)
      .then((result) => {
        if (this.lastTileDataRequestKey !== requestTileKey) {
          return;
        }

        const topology = this.topologyRegistry.upsertTile(result.data);
        this.currentTileDataStatus = `${result.source} ${requestTileKey}`;
        this.currentTileRoadsCount = result.data.roads.length;
        this.currentTileBuildingsCount = result.data.buildings.length;
        this.currentTopologyNodeCount = topology.nodes.length;
        this.currentTopologyEdgeCount = topology.edges.length;
        this.currentTopologyIntersectionSplits = topology.stats.intersectionSplits;
        this.currentTopologyDroppedSegments =
          topology.stats.droppedDegenerateRoads + topology.stats.droppedZeroLengthSegments;
        this.currentTopologyStitchedNodes = topology.stats.stitchedNodes;
        const roadMesh = this.roadMesher.buildTileRoadMesh(topology);

        if (this.lastRenderedRoadTileKey !== null && this.lastRenderedRoadTileKey !== requestTileKey) {
          this.sceneComposer.removeRoadTileMesh(this.lastRenderedRoadTileKey);
        }

        this.sceneComposer.upsertRoadTileMesh(roadMesh);
        this.lastRenderedRoadTileKey = requestTileKey;
        this.currentRoadMeshStats = roadMesh.stats;
      })
      .catch((error: unknown) => {
        if (this.lastTileDataRequestKey !== requestTileKey) {
          return;
        }

        const message = error instanceof Error ? error.message : 'unknown error';
        this.currentTileDataStatus = `error ${requestTileKey}: ${message}`;
      });
  }

  private formatRoadWidthRange(stats: RoadMeshStats): string {
    return `${stats.minResolvedWidthMeters.toFixed(1)}-${stats.maxResolvedWidthMeters.toFixed(1)}`;
  }

  private formatRoadJunctionSummary(stats: RoadMeshStats): string {
    return `nodes ${stats.junctionNodesConsidered} | polys ${stats.junctionPolygonsBuilt} | tris ${stats.junctionTriangles} | m/b/f ${stats.junctionMiterCorners}/${stats.junctionBevelCorners}/${stats.junctionFallbackCorners} | fail ${stats.junctionTriangulationFailures}`;
  }

  private createTileFetchParams(currentTile: TileCoordinate, tileKey: string): TileFetchParams {
    const globalBounds = this.tileSystem.getTileBoundsGlobalMeters(currentTile);
    const southWest = this.globalMetersToLatLon(globalBounds.minEast, globalBounds.minNorth);
    const northEast = this.globalMetersToLatLon(globalBounds.maxEast, globalBounds.maxNorth);

    return {
      tileKey,
      bbox: {
        south: Math.min(southWest.latitude, northEast.latitude),
        west: Math.min(southWest.longitude, northEast.longitude),
        north: Math.max(southWest.latitude, northEast.latitude),
        east: Math.max(southWest.longitude, northEast.longitude),
      },
      tileOriginGlobalMeters: {
        east: globalBounds.minEast,
        north: globalBounds.minNorth,
      },
    };
  }

  private globalMetersToLatLon(east: number, north: number): { latitude: number; longitude: number } {
    const localEast = east - this.globalOffsetMeters.east;
    const localNorth = north - this.globalOffsetMeters.north;
    return this.projection.localMetersToLatLon({
      east: localEast,
      north: localNorth,
    });
  }
}
