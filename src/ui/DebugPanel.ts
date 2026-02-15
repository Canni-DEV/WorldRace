export interface DebugPanelMetrics {
  drawCalls: number;
  triangles: number;
  tileKey: string;
}

export class DebugPanel {
  private readonly rootElement: HTMLDivElement;
  private readonly tileElement: HTMLParagraphElement;
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

    this.drawCallsElement = document.createElement('p');
    this.drawCallsElement.className = 'overlay-row';

    this.trianglesElement = document.createElement('p');
    this.trianglesElement.className = 'overlay-row';

    this.rootElement.append(title, this.tileElement, this.drawCallsElement, this.trianglesElement);
    parent.appendChild(this.rootElement);

    this.update({ drawCalls: 0, triangles: 0, tileKey: 'N/A' });
  }

  public update(metrics: DebugPanelMetrics): void {
    this.tileElement.textContent = `Tile: ${metrics.tileKey}`;
    this.drawCallsElement.textContent = `Draw calls: ${metrics.drawCalls}`;
    this.trianglesElement.textContent = `Triangles: ${metrics.triangles}`;
  }

  public dispose(): void {
    this.rootElement.remove();
  }
}
