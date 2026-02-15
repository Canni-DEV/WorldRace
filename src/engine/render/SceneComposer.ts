import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Uint32BufferAttribute,
  WebGLRenderer,
} from 'three';
import type { GeoBoundsMeters } from '../geo/GeoBounds';
import type { RoadTileMeshPayload } from '../world/RoadMeshTypes';

interface RoadTileBundle {
  readonly tileKey: string;
  readonly group: Group;
  readonly surfaceGeometry: BufferGeometry;
  readonly collisionGeometry: BufferGeometry;
  readonly debugLineGeometry: BufferGeometry;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

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
  private readonly roadRoot = new Group();
  private readonly roadTileBundles = new Map<string, RoadTileBundle>();
  private readonly prefetchLines: DebugLineSegments;
  private readonly activeLines: DebugLineSegments;
  private readonly currentTileLines: DebugLineSegments;
  private readonly prefetchMaterial = new LineBasicMaterial({ color: 0x334155 });
  private readonly activeMaterial = new LineBasicMaterial({ color: 0x60a5fa });
  private readonly currentTileMaterial = new LineBasicMaterial({ color: 0xfacc15 });
  private readonly roadSurfaceMaterial = new MeshStandardMaterial({
    color: 0x2c313a,
    roughness: 0.95,
    metalness: 0.02,
  });
  private readonly roadWireframeMaterial = new MeshBasicMaterial({
    color: 0x94a3b8,
    wireframe: true,
    transparent: true,
    opacity: 0.7,
  });
  private readonly roadCollisionMaterial = new MeshBasicMaterial({
    color: 0x0ea5e9,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  private readonly roadDebugLineMaterial = new LineBasicMaterial({ color: 0xf59e0b });
  private roadDebugVisible = false;

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
      this.roadRoot,
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
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
    };
  }

  public setWorldOffset(offsetEast: number, offsetNorth: number): void {
    this.roadRoot.position.set(-offsetEast, 0, -offsetNorth);
  }

  public setRoadDebugOverlayEnabled(enabled: boolean): void {
    this.roadDebugVisible = enabled;
    for (const bundle of this.roadTileBundles.values()) {
      for (const child of bundle.group.children) {
        if (!(child instanceof Mesh) && !(child instanceof LineSegments)) {
          continue;
        }

        if (child.name === 'road-wireframe' || child.name === 'road-debug-lines') {
          child.visible = enabled;
        }
      }
    }
  }

  public upsertRoadTileMesh(tileMesh: RoadTileMeshPayload): void {
    this.removeRoadTileMesh(tileMesh.tileKey);
    if (tileMesh.surfacePositions.length === 0 || tileMesh.surfaceIndices.length === 0) {
      return;
    }

    const surfaceGeometry = this.createRoadSurfaceGeometry(
      tileMesh.surfacePositions,
      tileMesh.surfaceIndices,
      tileMesh.surfaceUvs,
    );
    const collisionGeometry = this.createCollisionGeometry(
      tileMesh.collisionPositions,
      tileMesh.collisionIndices,
    );
    const debugLineGeometry = this.createLineGeometry(tileMesh.debugLinePositions);

    const surfaceMesh = new Mesh(surfaceGeometry, this.roadSurfaceMaterial);
    surfaceMesh.name = 'road-surface';
    surfaceMesh.castShadow = false;
    surfaceMesh.receiveShadow = true;

    const wireframeMesh = new Mesh(surfaceGeometry, this.roadWireframeMaterial);
    wireframeMesh.name = 'road-wireframe';
    wireframeMesh.visible = this.roadDebugVisible;

    const collisionMesh = new Mesh(collisionGeometry, this.roadCollisionMaterial);
    collisionMesh.name = 'road-collision';
    collisionMesh.visible = false;

    const debugLines = new LineSegments(debugLineGeometry, this.roadDebugLineMaterial);
    debugLines.name = 'road-debug-lines';
    debugLines.visible = this.roadDebugVisible;

    const group = new Group();
    group.name = `road-tile:${tileMesh.tileKey}`;
    group.add(surfaceMesh, wireframeMesh, collisionMesh, debugLines);

    this.roadRoot.add(group);
    this.roadTileBundles.set(tileMesh.tileKey, {
      tileKey: tileMesh.tileKey,
      group,
      surfaceGeometry,
      collisionGeometry,
      debugLineGeometry,
    });
  }

  public updateTileDebugGrid(data: TileDebugGridData): void {
    this.updateLineGeometry(this.prefetchLines, data.prefetchTileBounds, 0.03);
    this.updateLineGeometry(this.activeLines, data.activeTileBounds, 0.06);
    this.updateLineGeometry(this.currentTileLines, [data.currentTileBounds], 0.1);
  }

  public dispose(): void {
    this.clearRoadTiles();

    this.prefetchLines.geometry.dispose();
    this.activeLines.geometry.dispose();
    this.currentTileLines.geometry.dispose();
    this.prefetchMaterial.dispose();
    this.activeMaterial.dispose();
    this.currentTileMaterial.dispose();
    this.roadSurfaceMaterial.dispose();
    this.roadWireframeMaterial.dispose();
    this.roadCollisionMaterial.dispose();
    this.roadDebugLineMaterial.dispose();

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearRoadTiles(): void {
    for (const tileKey of this.roadTileBundles.keys()) {
      this.removeRoadTileMesh(tileKey);
    }
  }

  public removeRoadTileMesh(tileKey: string): void {
    const bundle = this.roadTileBundles.get(tileKey);
    if (bundle === undefined) {
      return;
    }

    this.roadTileBundles.delete(tileKey);
    this.roadRoot.remove(bundle.group);
    bundle.surfaceGeometry.dispose();
    bundle.collisionGeometry.dispose();
    bundle.debugLineGeometry.dispose();
  }

  public getRoadTileCount(): number {
    return this.roadTileBundles.size;
  }

  private createRoadSurfaceGeometry(
    positions: Float32Array,
    indices: Uint32Array,
    uvs: Float32Array,
  ): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(new Uint32BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createCollisionGeometry(positions: Float32Array, indices: Uint32Array): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(new Uint32BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private createLineGeometry(positions: Float32Array): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
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
