import {
  AmbientLight,
  AxesHelper,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';

export interface RenderStats {
  drawCalls: number;
  triangles: number;
}

type DisposableMesh = Mesh<BufferGeometry, Material | Material[]>;

export class SceneComposer {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly container: HTMLElement;

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

    const grid = new GridHelper(100, 40, 0x94a3b8, 0x334155);
    const axes = new AxesHelper(4);

    this.scene.add(ambientLight, directionalLight, grid, axes);
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  public getRenderStats(): RenderStats {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  public dispose(): void {
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
}
