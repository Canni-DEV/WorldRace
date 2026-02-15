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
    this.drawCallsElement.textContent = `Draw calls: ${metrics.drawCalls}`;
    this.trianglesElement.textContent = `Triangles: ${metrics.triangles}`;
  }

  public dispose(): void {
    this.rootElement.remove();
  }
}
