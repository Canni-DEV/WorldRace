import { Clock } from '../engine/core/Clock';
import { runtimeConfig } from '../engine/core/Config';
import { ElevationService } from '../engine/data/ElevationService';
import { TileDataService } from '../engine/data/TileDataService';
import { Projection } from '../engine/geo/Projection';
import { TileSystem } from '../engine/geo/TileSystem';
import { SceneComposer } from '../engine/render/SceneComposer';
import { Anchor } from '../engine/sim/Anchor';
import { CameraController } from '../engine/sim/CameraController';
import { TopologyRegistry } from '../engine/world/TopologyRegistry';
import { WorldStream } from '../engine/world/WorldStream';
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
  private readonly worldStream: WorldStream;
  private globalOffsetMeters: GlobalOffsetMeters = { east: 0, north: 0 };
  private stableCurrentTile: TileCoordinate | null = null;
  private floatingOriginRecenters = 0;
  private roadDebugOverlayEnabled = false;
  private decorationEnabled = true;
  private decorationDensityBudget = 1;
  private cacheMetrics: CacheMetricsSnapshot = EMPTY_CACHE_METRICS;
  private frameHandle = 0;
  private isRunning = false;

  private readonly onResize = (): void => {
    this.sceneComposer.resize(window.innerWidth, window.innerHeight);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'KeyB') {
      this.roadDebugOverlayEnabled = !this.roadDebugOverlayEnabled;
      this.sceneComposer.setRoadDebugOverlayEnabled(this.roadDebugOverlayEnabled);
      return;
    }

    if (event.code === 'KeyN') {
      this.decorationEnabled = !this.decorationEnabled;
      this.sceneComposer.setDecorationEnabled(this.decorationEnabled);
    }
  };

  public constructor(rootElement: HTMLElement) {
    const viewport = document.createElement('div');
    viewport.className = 'app-viewport';
    rootElement.appendChild(viewport);

    this.sceneComposer = new SceneComposer(viewport);
    this.hud = new HUD(rootElement);
    this.debugPanel = new DebugPanel(rootElement, {
      onDecorationEnabledChange: (enabled) => {
        this.decorationEnabled = enabled;
        this.sceneComposer.setDecorationEnabled(enabled);
      },
      onDecorationDensityBudgetChange: (densityBudget) => {
        this.decorationDensityBudget = densityBudget;
        this.sceneComposer.setDecorationDensityBudget(densityBudget);
      },
    });
    const projectionOrigin = {
      latitude: runtimeConfig.initialLatitude,
      longitude: runtimeConfig.initialLongitude,
    };
    const projectionAxes = {
      eastSign: runtimeConfig.projectionEastSign,
      northSign: runtimeConfig.projectionNorthSign,
    };
    this.projection = new Projection(projectionOrigin, projectionAxes);
    this.tileDataService = new TileDataService(
      new Projection(projectionOrigin, projectionAxes),
      {
        staleWhileRevalidate: runtimeConfig.cacheStaleWhileRevalidate,
        cacheTtlMs: runtimeConfig.cacheTtlMs,
      },
    );
    const elevationService = new ElevationService(
      new Projection(projectionOrigin, projectionAxes),
      {
        enabled: runtimeConfig.demEnabled,
        zoom: runtimeConfig.demZoom,
        endpointTemplate: runtimeConfig.demEndpointTemplate,
        maxCachedTiles: runtimeConfig.demMaxCachedTiles,
        fallbackMeters: runtimeConfig.demFallbackMeters,
      },
    );
    const topologyRegistry = new TopologyRegistry({
      routeWeightingProfile: runtimeConfig.routeWeightingProfile,
    });
    this.tileSystem = new TileSystem(runtimeConfig.tileSizeMeters);
    this.anchor = new Anchor(this.sceneComposer.getCamera().position);
    this.cameraController = new CameraController(
      this.sceneComposer.getCamera(),
      this.sceneComposer.getInputElement(),
      this.anchor,
    );
    this.worldStream = new WorldStream(
      {
        tileSystem: this.tileSystem,
        tileDataService: this.tileDataService,
        elevationService,
        topologyRegistry,
        sceneComposer: this.sceneComposer,
        createTileFetchParams: (tile, tileKey) => this.createTileFetchParams(tile, tileKey),
      },
      {
        maxConcurrentLoads: runtimeConfig.streamMaxConcurrentLoads,
        maxConcurrentFetches: runtimeConfig.streamMaxConcurrentFetches,
        useBuildWorker: runtimeConfig.streamUseBuildWorker,
        prefetchRequestIntervalMs: runtimeConfig.streamPrefetchRequestIntervalMs,
        prefetchDeferMsWhenForegroundIncomplete:
          runtimeConfig.streamPrefetchDeferMsWhenForegroundIncomplete,
      },
    );

    this.onResize();
    this.sceneComposer.setWorldOffset(this.globalOffsetMeters.east, this.globalOffsetMeters.north);
    this.sceneComposer.setRoadDebugOverlayEnabled(this.roadDebugOverlayEnabled);
    this.sceneComposer.setDecorationEnabled(this.decorationEnabled);
    this.sceneComposer.setDecorationDensityBudget(this.decorationDensityBudget);
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
      this.worldStream.update(spatialState.currentTile, spatialState.tileRings);
      const streamSnapshot = this.worldStream.getSnapshot();
      this.cacheMetrics = this.tileDataService.getMetricsSnapshot();
      this.sceneComposer.setWorldOffset(this.globalOffsetMeters.east, this.globalOffsetMeters.north);
      this.sceneComposer.setCurrentTileCoordinate(spatialState.currentTile);
      this.sceneComposer.updateTileDebugGrid(spatialState.tileDebugGridData);
      this.sceneComposer.render();

      const fps = deltaSeconds > 0 ? 1 / deltaSeconds : 0;
      const renderStats = this.sceneComposer.getRenderStats();

      this.hud.update({
        fps,
        frameMs: deltaSeconds * 1000,
        status: 'Move: WASD/Arrows, Up/Down: E/Q, RMB look, B road debug, N decoration',
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
        tileDataStatus: streamSnapshot.status,
        tileRoadsCount: streamSnapshot.currentTile?.roadsCount ?? 0,
        tileBuildingsCount: streamSnapshot.currentTile?.buildingsCount ?? 0,
        tileTerrainKind: streamSnapshot.currentTile?.terrainDominantKind ?? 'green',
        tileDecorationPointsCount: streamSnapshot.currentTile?.decorationPointsCount ?? 0,
        tileDecorationAreasCount: streamSnapshot.currentTile?.decorationAreasCount ?? 0,
        tileDecorationInstancesCount: streamSnapshot.currentTile?.decorationInstanceCount ?? 0,
        topologyNodeCount: streamSnapshot.currentTile?.topologyNodeCount ?? 0,
        topologyEdgeCount: streamSnapshot.currentTile?.topologyEdgeCount ?? 0,
        topologyIntersectionSplits: streamSnapshot.currentTile?.topologyIntersectionSplits ?? 0,
        topologyDroppedSegments: streamSnapshot.currentTile?.topologyDroppedSegments ?? 0,
        topologyStitchedNodes: streamSnapshot.currentTile?.topologyStitchedNodes ?? 0,
        roadMeshEdgeCount: streamSnapshot.currentTile?.roadMeshStats.edgeCountMeshed ?? 0,
        roadMeshTriangleCount: streamSnapshot.currentTile?.roadMeshStats.triangleCount ?? 0,
        roadCollisionTriangleCount: streamSnapshot.currentTile?.roadMeshStats.collisionTriangleCount ?? 0,
        roadMeshWidthRange: this.formatRoadWidthRange(
          streamSnapshot.currentTile?.roadMeshStats ?? EMPTY_ROAD_MESH_STATS,
        ),
        roadJunctionSummary: this.formatRoadJunctionSummary(
          streamSnapshot.currentTile?.roadMeshStats ?? EMPTY_ROAD_MESH_STATS,
        ),
        roadDebugOverlayEnabled: this.roadDebugOverlayEnabled,
        renderedTerrainTiles: this.sceneComposer.getTerrainTileCount(),
        renderedRoadTiles: this.sceneComposer.getRoadTileCount(),
        renderedDecorationTiles: this.sceneComposer.getDecorationTileCount(),
        renderedDecorationInstances: this.sceneComposer.getVisibleDecorationInstanceCount(),
        decorationEnabled: this.decorationEnabled,
        decorationDensityBudget: this.decorationDensityBudget,
        streamDesiredTiles: streamSnapshot.desiredTiles,
        streamLoadedTiles: streamSnapshot.loadedTiles,
        streamPendingTiles: streamSnapshot.pendingTiles,
        streamInflightFetches: streamSnapshot.inflightFetches,
        streamInflightBuilds: streamSnapshot.inflightBuilds,
        streamLastFetchMs: streamSnapshot.lastFetchMs,
        streamLastBuildMs: streamSnapshot.lastBuildMs,
        streamCanceledObsoleteLoads: streamSnapshot.canceledObsoleteLoads,
        streamDeferredPrefetchLoads: streamSnapshot.deferredPrefetchLoads,
        streamSkippedPrefetchBecauseForeground: streamSnapshot.skippedPrefetchBecauseForeground,
        streamDisposedTiles: streamSnapshot.disposedTiles,
        streamFetchErrors: streamSnapshot.fetchErrors,
        streamBuildErrors: streamSnapshot.buildErrors,
        streamApproxMeshMegabytes: streamSnapshot.approxMeshMegabytes,
        streamBuildMode: streamSnapshot.buildMode,
        gpuGeometries: renderStats.geometries,
        gpuTextures: renderStats.textures,
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
    this.worldStream.dispose();
    this.cameraController.dispose();
    this.hud.dispose();
    this.debugPanel.dispose();
    this.sceneComposer.dispose();
  }

  private computeSpatialState(): SpatialState {
    const anchorPosition = this.anchor.getPosition();
    const globalEast = this.globalOffsetMeters.east + anchorPosition.x;
    const globalNorth = this.globalOffsetMeters.north + anchorPosition.z;
    const rawCurrentTile = this.tileSystem.getTileFromGlobalMeters(globalEast, globalNorth);
    const currentTile = this.resolveCurrentTileWithHysteresis(rawCurrentTile, globalEast, globalNorth);
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

  private resolveCurrentTileWithHysteresis(
    rawTile: TileCoordinate,
    globalEast: number,
    globalNorth: number,
  ): TileCoordinate {
    const stableTile = this.stableCurrentTile;
    if (stableTile === null) {
      this.stableCurrentTile = rawTile;
      return rawTile;
    }

    if (stableTile.x === rawTile.x && stableTile.y === rawTile.y) {
      return stableTile;
    }

    const tileDeltaX = Math.abs(rawTile.x - stableTile.x);
    const tileDeltaY = Math.abs(rawTile.y - stableTile.y);
    if (tileDeltaX > 1 || tileDeltaY > 1) {
      this.stableCurrentTile = rawTile;
      return rawTile;
    }

    const rawTileBounds = this.tileSystem.getTileBoundsGlobalMeters(rawTile);
    const tileSizeMeters = this.tileSystem.getTileSizeMeters();
    const maxMargin = Math.max(0, tileSizeMeters * 0.5 - 1);
    const hysteresisMargin = Math.min(runtimeConfig.streamTileHysteresisMeters, maxMargin);

    if (hysteresisMargin <= 0) {
      this.stableCurrentTile = rawTile;
      return rawTile;
    }

    const isInsideInnerRawTile =
      globalEast >= rawTileBounds.minEast + hysteresisMargin &&
      globalEast <= rawTileBounds.maxEast - hysteresisMargin &&
      globalNorth >= rawTileBounds.minNorth + hysteresisMargin &&
      globalNorth <= rawTileBounds.maxNorth - hysteresisMargin;

    if (isInsideInnerRawTile) {
      this.stableCurrentTile = rawTile;
      return rawTile;
    }

    return stableTile;
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

  private formatRoadWidthRange(stats: RoadMeshStats): string {
    return `${stats.minResolvedWidthMeters.toFixed(1)}-${stats.maxResolvedWidthMeters.toFixed(1)}`;
  }

  private formatRoadJunctionSummary(stats: RoadMeshStats): string {
    return `nodes ${stats.junctionNodesConsidered} | polys ${stats.junctionPolygonsBuilt} | tris ${stats.junctionTriangles} | m/b/f ${stats.junctionMiterCorners}/${stats.junctionBevelCorners}/${stats.junctionFallbackCorners} | fail ${stats.junctionTriangulationFailures}`;
  }

  private createTileFetchParams(currentTile: TileCoordinate, tileKey: string): TileFetchParams {
    const globalBounds = this.tileSystem.getTileBoundsGlobalMeters(currentTile);
    const tileSizeMeters = this.tileSystem.getTileSizeMeters();
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
      tileSizeMeters,
      tileCoordinate: {
        x: currentTile.x,
        y: currentTile.y,
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
