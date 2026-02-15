import { Clock } from '../engine/core/Clock';
import { SceneComposer } from '../engine/render/SceneComposer';
import { DebugPanel } from '../ui/DebugPanel';
import { HUD } from '../ui/HUD';

export class App {
  private readonly clock = new Clock();
  private readonly sceneComposer: SceneComposer;
  private readonly hud: HUD;
  private readonly debugPanel: DebugPanel;
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
      this.sceneComposer.render();

      const fps = deltaSeconds > 0 ? 1 / deltaSeconds : 0;
      const renderStats = this.sceneComposer.getRenderStats();

      this.hud.update({
        fps,
        frameMs: deltaSeconds * 1000,
        status: 'Bootstrap scene running',
      });

      this.debugPanel.update({
        drawCalls: renderStats.drawCalls,
        triangles: renderStats.triangles,
        tileKey: 'N/A',
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
    this.hud.dispose();
    this.debugPanel.dispose();
    this.sceneComposer.dispose();
  }
}
