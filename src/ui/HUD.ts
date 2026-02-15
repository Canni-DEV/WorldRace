export interface HUDMetrics {
  fps: number;
  frameMs: number;
  status: string;
  anchorEastMeters: number;
  anchorNorthMeters: number;
  anchorLatitude: number;
  anchorLongitude: number;
}

export class HUD {
  private readonly rootElement: HTMLDivElement;
  private readonly fpsElement: HTMLParagraphElement;
  private readonly frameElement: HTMLParagraphElement;
  private readonly statusElement: HTMLParagraphElement;
  private readonly anchorLocalElement: HTMLParagraphElement;
  private readonly anchorGeoElement: HTMLParagraphElement;

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

    this.anchorLocalElement = document.createElement('p');
    this.anchorLocalElement.className = 'overlay-row';

    this.anchorGeoElement = document.createElement('p');
    this.anchorGeoElement.className = 'overlay-row';

    this.rootElement.append(
      title,
      this.fpsElement,
      this.frameElement,
      this.statusElement,
      this.anchorLocalElement,
      this.anchorGeoElement,
    );
    parent.appendChild(this.rootElement);

    this.update({
      fps: 0,
      frameMs: 0,
      status: 'Initializing',
      anchorEastMeters: 0,
      anchorNorthMeters: 0,
      anchorLatitude: 0,
      anchorLongitude: 0,
    });
  }

  public update(metrics: HUDMetrics): void {
    this.fpsElement.textContent = `FPS: ${metrics.fps.toFixed(1)}`;
    this.frameElement.textContent = `Frame: ${metrics.frameMs.toFixed(2)} ms`;
    this.statusElement.textContent = `Status: ${metrics.status}`;
    this.anchorLocalElement.textContent = `Anchor local: E ${metrics.anchorEastMeters.toFixed(1)}m | N ${metrics.anchorNorthMeters.toFixed(1)}m`;
    this.anchorGeoElement.textContent = `Anchor geo: ${metrics.anchorLatitude.toFixed(6)}, ${metrics.anchorLongitude.toFixed(6)}`;
  }

  public dispose(): void {
    this.rootElement.remove();
  }
}
