export interface DebugPanelMetrics {
  drawCalls: number;
  triangles: number;
  tileKey: string;
  activeTileCount: number;
  prefetchTileCount: number;
  activeTileSample: string;
  prefetchTileSample: string;
  floatingOriginRecenters: number;
}

export class DebugPanel {
  private readonly rootElement: HTMLDivElement;
  private readonly tileElement: HTMLParagraphElement;
  private readonly activeTilesElement: HTMLParagraphElement;
  private readonly prefetchTilesElement: HTMLParagraphElement;
  private readonly activeSampleElement: HTMLParagraphElement;
  private readonly prefetchSampleElement: HTMLParagraphElement;
  private readonly recenterElement: HTMLParagraphElement;
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
    });
  }

  public update(metrics: DebugPanelMetrics): void {
    this.tileElement.textContent = `Tile: ${metrics.tileKey}`;
    this.activeTilesElement.textContent = `Active tiles: ${metrics.activeTileCount}`;
    this.prefetchTilesElement.textContent = `Prefetch tiles: ${metrics.prefetchTileCount}`;
    this.activeSampleElement.textContent = `Active sample: ${metrics.activeTileSample}`;
    this.prefetchSampleElement.textContent = `Prefetch sample: ${metrics.prefetchTileSample}`;
    this.recenterElement.textContent = `Floating recenter: ${metrics.floatingOriginRecenters}`;
    this.drawCallsElement.textContent = `Draw calls: ${metrics.drawCalls}`;
    this.trianglesElement.textContent = `Triangles: ${metrics.triangles}`;
  }

  public dispose(): void {
    this.rootElement.remove();
  }
}
