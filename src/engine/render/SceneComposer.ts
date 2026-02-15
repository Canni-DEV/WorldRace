import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import type { Material, Object3D } from 'three';
import type { GeoBoundsMeters } from '../geo/GeoBounds';

export interface RenderStats {
  drawCalls: number;
  triangles: number;
}

type DisposableMesh = Mesh<BufferGeometry, Material | Material[]>;
type DebugLineSegments = LineSegments<BufferGeometry, LineBasicMaterial>;

export interface TileDebugGridData {
  readonly activeTileBounds: readonly GeoBoundsMeters[];
  readonly prefetchTileBounds: readonly GeoBoundsMeters[];
  readonly currentTileBounds: GeoBoundsMeters;
}

export class SceneComposer {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly container: HTMLElement;
  private readonly prefetchLines: DebugLineSegments;
  private readonly activeLines: DebugLineSegments;
  private readonly currentTileLines: DebugLineSegments;
  private readonly prefetchMaterial = new LineBasicMaterial({ color: 0x334155 });
  private readonly activeMaterial = new LineBasicMaterial({ color: 0x60a5fa });
  private readonly currentTileMaterial = new LineBasicMaterial({ color: 0xfacc15 });

  public constructor(container: HTMLElement) {
    this.container = container;
    this.scene = new Scene();
    this.scene.background = new Color(0x0a1325);

    this.camera = new PerspectiveCamera(60, 1, 0.1, 3000);
    this.camera.position.set(16, 12, 16);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.container.appendChild(this.renderer.domElement);

    const ambientLight = new AmbientLight(0xffffff, 0.7);
    const directionalLight = new DirectionalLight(0xffffff, 1.2);
    directionalLight.position.set(30, 50, 20);

    this.prefetchLines = this.createDebugLines(this.prefetchMaterial);
    this.activeLines = this.createDebugLines(this.activeMaterial);
    this.currentTileLines = this.createDebugLines(this.currentTileMaterial);

    this.scene.add(
      ambientLight,
      directionalLight,
      this.prefetchLines,
      this.activeLines,
      this.currentTileLines,
    );
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  public getCamera(): PerspectiveCamera {
    return this.camera;
  }

  public getInputElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  public getRenderStats(): RenderStats {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  public updateTileDebugGrid(data: TileDebugGridData): void {
    this.updateLineGeometry(this.prefetchLines, data.prefetchTileBounds, 0.03);
    this.updateLineGeometry(this.activeLines, data.activeTileBounds, 0.06);
    this.updateLineGeometry(this.currentTileLines, [data.currentTileBounds], 0.1);
  }

  public dispose(): void {
    this.prefetchLines.geometry.dispose();
    this.activeLines.geometry.dispose();
    this.currentTileLines.geometry.dispose();
    this.prefetchMaterial.dispose();
    this.activeMaterial.dispose();
    this.currentTileMaterial.dispose();

    this.scene.traverse((object3D) => {
      if (this.isDisposableMesh(object3D)) {
        object3D.geometry.dispose();
        this.disposeMaterial(object3D.material);
      }
    });

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private disposeMaterial(material: Material | Material[]): void {
    if (Array.isArray(material)) {
      for (const entry of material) {
        entry.dispose();
      }
      return;
    }

    material.dispose();
  }

  private isDisposableMesh(object3D: Object3D): object3D is DisposableMesh {
    return object3D instanceof Mesh;
  }

  private createDebugLines(material: LineBasicMaterial): DebugLineSegments {
    return new LineSegments(new BufferGeometry(), material);
  }

  private updateLineGeometry(
    lineSegments: DebugLineSegments,
    tileBounds: readonly GeoBoundsMeters[],
    height: number,
  ): void {
    const vertices = this.buildTileBorderVertices(tileBounds, height);
    const nextGeometry = new BufferGeometry();
    nextGeometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
    lineSegments.geometry.dispose();
    lineSegments.geometry = nextGeometry;
  }

  private buildTileBorderVertices(tileBounds: readonly GeoBoundsMeters[], height: number): number[] {
    const vertices: number[] = [];

    for (const bounds of tileBounds) {
      const x0 = bounds.minEast;
      const x1 = bounds.maxEast;
      const z0 = bounds.minNorth;
      const z1 = bounds.maxNorth;

      vertices.push(
        x0,
        height,
        z0,
        x1,
        height,
        z0,
        x1,
        height,
        z0,
        x1,
        height,
        z1,
        x1,
        height,
        z1,
        x0,
        height,
        z1,
        x0,
        height,
        z1,
        x0,
        height,
        z0,
      );
    }

    return vertices;
  }
}
