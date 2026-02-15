export interface HUDMetrics {
  fps: number;
  frameMs: number;
  status: string;
}

export class HUD {
  private readonly rootElement: HTMLDivElement;
  private readonly fpsElement: HTMLParagraphElement;
  private readonly frameElement: HTMLParagraphElement;
  private readonly statusElement: HTMLParagraphElement;

  public constructor(parent: HTMLElement) {
    this.rootElement = document.createElement('div');
    this.rootElement.className = 'overlay-panel hud-panel';

    const title = document.createElement('h2');
    title.className = 'overlay-title';
    title.textContent = 'HUD';

    this.fpsElement = document.createElement('p');
    this.fpsElement.className = 'overlay-row';

    this.frameElement = document.createElement('p');
    this.frameElement.className = 'overlay-row';

    this.statusElement = document.createElement('p');
    this.statusElement.className = 'overlay-row';

    this.rootElement.append(title, this.fpsElement, this.frameElement, this.statusElement);
    parent.appendChild(this.rootElement);

    this.update({ fps: 0, frameMs: 0, status: 'Initializing' });
  }

  public update(metrics: HUDMetrics): void {
    this.fpsElement.textContent = `FPS: ${metrics.fps.toFixed(1)}`;
    this.frameElement.textContent = `Frame: ${metrics.frameMs.toFixed(2)} ms`;
    this.statusElement.textContent = `Status: ${metrics.status}`;
  }

  public dispose(): void {
    this.rootElement.remove();
  }
}
