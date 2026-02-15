export interface DebugPanelMetrics {
  drawCalls: number;
  triangles: number;
  tileKey: string;
  activeTileCount: number;
  prefetchTileCount: number;
  activeTileSample: string;
  prefetchTileSample: string;
  floatingOriginRecenters: number;
  tileDataStatus: string;
  tileRoadsCount: number;
  tileBuildingsCount: number;
  topologyNodeCount: number;
  topologyEdgeCount: number;
  topologyIntersectionSplits: number;
  topologyDroppedSegments: number;
  topologyStitchedNodes: number;
  roadMeshEdgeCount: number;
  roadMeshTriangleCount: number;
  roadCollisionTriangleCount: number;
  roadMeshWidthRange: string;
  roadJunctionSummary: string;
  roadDebugOverlayEnabled: boolean;
  renderedRoadTiles: number;
  streamDesiredTiles: number;
  streamLoadedTiles: number;
  streamPendingTiles: number;
  streamInflightFetches: number;
  streamInflightBuilds: number;
  streamLastFetchMs: number;
  streamLastBuildMs: number;
  streamCanceledLoads: number;
  streamDisposedTiles: number;
  streamFetchErrors: number;
  streamBuildErrors: number;
  streamApproxMeshMegabytes: number;
  streamBuildMode: 'worker' | 'main-thread';
  gpuGeometries: number;
  gpuTextures: number;
}

export class DebugPanel {
  private readonly rootElement: HTMLDivElement;
  private readonly tileElement: HTMLParagraphElement;
  private readonly activeTilesElement: HTMLParagraphElement;
  private readonly prefetchTilesElement: HTMLParagraphElement;
  private readonly activeSampleElement: HTMLParagraphElement;
  private readonly prefetchSampleElement: HTMLParagraphElement;
  private readonly recenterElement: HTMLParagraphElement;
  private readonly tileDataStatusElement: HTMLParagraphElement;
  private readonly tileDataCountsElement: HTMLParagraphElement;
  private readonly topologyCountsElement: HTMLParagraphElement;
  private readonly topologyStatsElement: HTMLParagraphElement;
  private readonly roadMeshCountsElement: HTMLParagraphElement;
  private readonly roadMeshStatsElement: HTMLParagraphElement;
  private readonly roadJunctionElement: HTMLParagraphElement;
  private readonly roadDebugElement: HTMLParagraphElement;
  private readonly streamQueueElement: HTMLParagraphElement;
  private readonly streamTimingElement: HTMLParagraphElement;
  private readonly streamReliabilityElement: HTMLParagraphElement;
  private readonly streamMemoryElement: HTMLParagraphElement;
  private readonly gpuResourcesElement: HTMLParagraphElement;
  private readonly drawCallsElement: HTMLParagraphElement;
  private readonly trianglesElement: HTMLParagraphElement;

  public constructor(parent: HTMLElement) {
    this.rootElement = document.createElement('div');
    this.rootElement.className = 'overlay-panel debug-panel';

    const title = document.createElement('h2');
    title.className = 'overlay-title';
    title.textContent = 'Debug';

    this.tileElement = document.createElement('p');
    this.tileElement.className = 'overlay-row';

    this.activeTilesElement = document.createElement('p');
    this.activeTilesElement.className = 'overlay-row';

    this.prefetchTilesElement = document.createElement('p');
    this.prefetchTilesElement.className = 'overlay-row';

    this.activeSampleElement = document.createElement('p');
    this.activeSampleElement.className = 'overlay-row';

    this.prefetchSampleElement = document.createElement('p');
    this.prefetchSampleElement.className = 'overlay-row';

    this.recenterElement = document.createElement('p');
    this.recenterElement.className = 'overlay-row';

    this.tileDataStatusElement = document.createElement('p');
    this.tileDataStatusElement.className = 'overlay-row';

    this.tileDataCountsElement = document.createElement('p');
    this.tileDataCountsElement.className = 'overlay-row';

    this.topologyCountsElement = document.createElement('p');
    this.topologyCountsElement.className = 'overlay-row';

    this.topologyStatsElement = document.createElement('p');
    this.topologyStatsElement.className = 'overlay-row';

    this.roadMeshCountsElement = document.createElement('p');
    this.roadMeshCountsElement.className = 'overlay-row';

    this.roadMeshStatsElement = document.createElement('p');
    this.roadMeshStatsElement.className = 'overlay-row';

    this.roadJunctionElement = document.createElement('p');
    this.roadJunctionElement.className = 'overlay-row';

    this.roadDebugElement = document.createElement('p');
    this.roadDebugElement.className = 'overlay-row';

    this.streamQueueElement = document.createElement('p');
    this.streamQueueElement.className = 'overlay-row';

    this.streamTimingElement = document.createElement('p');
    this.streamTimingElement.className = 'overlay-row';

    this.streamReliabilityElement = document.createElement('p');
    this.streamReliabilityElement.className = 'overlay-row';

    this.streamMemoryElement = document.createElement('p');
    this.streamMemoryElement.className = 'overlay-row';

    this.gpuResourcesElement = document.createElement('p');
    this.gpuResourcesElement.className = 'overlay-row';

    this.drawCallsElement = document.createElement('p');
    this.drawCallsElement.className = 'overlay-row';

    this.trianglesElement = document.createElement('p');
    this.trianglesElement.className = 'overlay-row';

    this.rootElement.append(
      title,
      this.tileElement,
      this.activeTilesElement,
      this.prefetchTilesElement,
      this.activeSampleElement,
      this.prefetchSampleElement,
      this.recenterElement,
      this.tileDataStatusElement,
      this.tileDataCountsElement,
      this.topologyCountsElement,
      this.topologyStatsElement,
      this.roadMeshCountsElement,
      this.roadMeshStatsElement,
      this.roadJunctionElement,
      this.roadDebugElement,
      this.streamQueueElement,
      this.streamTimingElement,
      this.streamReliabilityElement,
      this.streamMemoryElement,
      this.gpuResourcesElement,
      this.drawCallsElement,
      this.trianglesElement,
    );
    parent.appendChild(this.rootElement);

    this.update({
      drawCalls: 0,
      triangles: 0,
      tileKey: 'N/A',
      activeTileCount: 0,
      prefetchTileCount: 0,
      activeTileSample: '-',
      prefetchTileSample: '-',
      floatingOriginRecenters: 0,
      tileDataStatus: 'idle',
      tileRoadsCount: 0,
      tileBuildingsCount: 0,
      topologyNodeCount: 0,
      topologyEdgeCount: 0,
      topologyIntersectionSplits: 0,
      topologyDroppedSegments: 0,
      topologyStitchedNodes: 0,
      roadMeshEdgeCount: 0,
      roadMeshTriangleCount: 0,
      roadCollisionTriangleCount: 0,
      roadMeshWidthRange: '0-0',
      roadJunctionSummary: '-',
      roadDebugOverlayEnabled: false,
      renderedRoadTiles: 0,
      streamDesiredTiles: 0,
      streamLoadedTiles: 0,
      streamPendingTiles: 0,
      streamInflightFetches: 0,
      streamInflightBuilds: 0,
      streamLastFetchMs: 0,
      streamLastBuildMs: 0,
      streamCanceledLoads: 0,
      streamDisposedTiles: 0,
      streamFetchErrors: 0,
      streamBuildErrors: 0,
      streamApproxMeshMegabytes: 0,
      streamBuildMode: 'main-thread',
      gpuGeometries: 0,
      gpuTextures: 0,
    });
  }

  public update(metrics: DebugPanelMetrics): void {
    this.tileElement.textContent = `Tile: ${metrics.tileKey}`;
    this.activeTilesElement.textContent = `Active tiles: ${metrics.activeTileCount}`;
    this.prefetchTilesElement.textContent = `Prefetch tiles: ${metrics.prefetchTileCount}`;
    this.activeSampleElement.textContent = `Active sample: ${metrics.activeTileSample}`;
    this.prefetchSampleElement.textContent = `Prefetch sample: ${metrics.prefetchTileSample}`;
    this.recenterElement.textContent = `Floating recenter: ${metrics.floatingOriginRecenters}`;
    this.tileDataStatusElement.textContent = `Tile data: ${metrics.tileDataStatus}`;
    this.tileDataCountsElement.textContent = `Current payload: ${metrics.tileRoadsCount} roads | ${metrics.tileBuildingsCount} buildings`;
    this.topologyCountsElement.textContent = `Topology: ${metrics.topologyNodeCount} nodes | ${metrics.topologyEdgeCount} edges`;
    this.topologyStatsElement.textContent = `Topology stats: splits ${metrics.topologyIntersectionSplits} | dropped ${metrics.topologyDroppedSegments} | stitched ${metrics.topologyStitchedNodes}`;
    this.roadMeshCountsElement.textContent = `Road mesh: ${metrics.roadMeshEdgeCount} edges | ${metrics.roadMeshTriangleCount} tris | collision ${metrics.roadCollisionTriangleCount} tris`;
    this.roadMeshStatsElement.textContent = `Width range: ${metrics.roadMeshWidthRange} m`;
    this.roadJunctionElement.textContent = `Junctions: ${metrics.roadJunctionSummary}`;
    this.roadDebugElement.textContent = `Road debug: ${metrics.roadDebugOverlayEnabled ? 'on' : 'off'} | rendered tiles ${metrics.renderedRoadTiles}`;
    this.streamQueueElement.textContent = `Stream queue: desired ${metrics.streamDesiredTiles} | loaded ${metrics.streamLoadedTiles} | pending ${metrics.streamPendingTiles} | fetch ${metrics.streamInflightFetches} | build ${metrics.streamInflightBuilds}`;
    this.streamTimingElement.textContent = `Stream timings: fetch ${metrics.streamLastFetchMs.toFixed(1)} ms | build ${metrics.streamLastBuildMs.toFixed(1)} ms | mode ${metrics.streamBuildMode}`;
    this.streamReliabilityElement.textContent = `Stream reliability: cancel ${metrics.streamCanceledLoads} | disposed ${metrics.streamDisposedTiles} | errors f/b ${metrics.streamFetchErrors}/${metrics.streamBuildErrors}`;
    this.streamMemoryElement.textContent = `Stream memory: mesh approx ${metrics.streamApproxMeshMegabytes.toFixed(2)} MB`;
    this.gpuResourcesElement.textContent = `GPU resources: geometries ${metrics.gpuGeometries} | textures ${metrics.gpuTextures}`;
    this.drawCallsElement.textContent = `Draw calls: ${metrics.drawCalls}`;
    this.trianglesElement.textContent = `Triangles: ${metrics.triangles}`;
  }

  public dispose(): void {
    this.rootElement.remove();
  }
}
