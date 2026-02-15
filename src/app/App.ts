import { Clock } from '../engine/core/Clock';
import { runtimeConfig } from '../engine/core/Config';
import { Projection } from '../engine/geo/Projection';
import { TileSystem } from '../engine/geo/TileSystem';
import { SceneComposer } from '../engine/render/SceneComposer';
import { Anchor } from '../engine/sim/Anchor';
import { CameraController } from '../engine/sim/CameraController';
import { DebugPanel } from '../ui/DebugPanel';
import { HUD } from '../ui/HUD';
import type { GeoBoundsMeters } from '../engine/geo/GeoBounds';
import type { TileDebugGridData } from '../engine/render/SceneComposer';
import type { GlobalOffsetMeters, TileCoordinate, TileRings } from '../engine/geo/TileSystem';

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

export class App {
  private readonly clock = new Clock();
  private readonly sceneComposer: SceneComposer;
  private readonly hud: HUD;
  private readonly debugPanel: DebugPanel;
  private readonly projection: Projection;
  private readonly tileSystem: TileSystem;
  private readonly anchor: Anchor;
  private readonly cameraController: CameraController;
  private globalOffsetMeters: GlobalOffsetMeters = { east: 0, north: 0 };
  private floatingOriginRecenters = 0;
  private frameHandle = 0;
  private isRunning = false;

  private readonly onResize = (): void => {
    this.sceneComposer.resize(window.innerWidth, window.innerHeight);
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
    this.tileSystem = new TileSystem(runtimeConfig.tileSizeMeters);
    this.anchor = new Anchor(this.sceneComposer.getCamera().position);
    this.cameraController = new CameraController(
      this.sceneComposer.getCamera(),
      this.sceneComposer.getInputElement(),
      this.anchor,
    );

    this.onResize();
    window.addEventListener('resize', this.onResize);
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
      this.sceneComposer.updateTileDebugGrid(spatialState.tileDebugGridData);
      this.sceneComposer.render();

      const fps = deltaSeconds > 0 ? 1 / deltaSeconds : 0;
      const renderStats = this.sceneComposer.getRenderStats();

      this.hud.update({
        fps,
        frameMs: deltaSeconds * 1000,
        status: 'Move: WASD/Arrows, Up/Down: E/Q, Hold right-click to look',
        anchorEastMeters: spatialState.anchorEastMeters,
        anchorNorthMeters: spatialState.anchorNorthMeters,
        anchorLatitude: spatialState.anchorLatitude,
        anchorLongitude: spatialState.anchorLongitude,
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
}
