import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Uint32BufferAttribute,
  WebGLRenderer,
} from 'three';
import type { TerrainKind } from '../data/Types';
import type { GeoBoundsMeters } from '../geo/GeoBounds';
import type { TileCoordinate } from '../geo/TileSystem';
import type { BuildingTileMeshPayload } from '../world/BuildingMeshTypes';
import type {
  DecorationPropKind,
  DecorationTileMeshPayload,
} from '../world/DecorationMeshTypes';
import type { RoadTileMeshPayload } from '../world/RoadMeshTypes';
import type { TerrainTileMeshPayload } from '../world/TerrainMeshTypes';

interface TerrainTileBundle {
  readonly tileKey: string;
  readonly group: Group;
  readonly geometry: BufferGeometry;
}

interface RoadTileBundle {
  readonly tileKey: string;
  readonly group: Group;
  readonly surfaceGeometry: BufferGeometry;
  readonly collisionGeometry: BufferGeometry;
  readonly debugLineGeometry: BufferGeometry;
}

interface BuildingTileBundle {
  readonly tileKey: string;
  readonly group: Group;
  readonly lod0Geometry: BufferGeometry;
  readonly lod1Geometry: BufferGeometry;
  readonly lod0Mesh: Mesh;
  readonly lod1Mesh: Mesh;
  readonly tileCoordinate: TileCoordinate | null;
  readonly centerEast: number;
  readonly centerNorth: number;
  lodState: 'lod0' | 'lod1';
}

interface DecorationKindBundle {
  readonly kind: DecorationPropKind;
  readonly mesh: InstancedMesh;
  readonly totalInstances: number;
}

interface DecorationTileBundle {
  readonly tileKey: string;
  readonly group: Group;
  readonly kindBundles: readonly DecorationKindBundle[];
  readonly tileCoordinate: TileCoordinate | null;
  readonly centerEast: number;
  readonly centerNorth: number;
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
  private readonly terrainRoot = new Group();
  private readonly roadRoot = new Group();
  private readonly buildingRoot = new Group();
  private readonly decorationRoot = new Group();
  private readonly terrainTileBundles = new Map<string, TerrainTileBundle>();
  private readonly roadTileBundles = new Map<string, RoadTileBundle>();
  private readonly buildingTileBundles = new Map<string, BuildingTileBundle>();
  private readonly decorationTileBundles = new Map<string, DecorationTileBundle>();
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
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
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
  private readonly buildingMaterial = new MeshStandardMaterial({
    color: 0x4b5563,
    roughness: 0.92,
    metalness: 0.04,
    side: DoubleSide,
  });
  private readonly terrainMaterialByKind: Readonly<Record<TerrainKind, MeshStandardMaterial>> = {
    urban: new MeshStandardMaterial({
      color: 0x78716c,
      roughness: 0.96,
      metalness: 0.02,
      side: DoubleSide,
    }),
    green: new MeshStandardMaterial({
      color: 0x4d7c0f,
      roughness: 0.98,
      metalness: 0.01,
      side: DoubleSide,
    }),
    water: new MeshStandardMaterial({
      color: 0x0e7490,
      roughness: 0.4,
      metalness: 0.03,
      side: DoubleSide,
    }),
  };
  private readonly decorationGeometryByKind: Readonly<Record<DecorationPropKind, BufferGeometry>>;
  private readonly decorationMaterialByKind: Readonly<Record<DecorationPropKind, MeshStandardMaterial>>;
  private readonly instanceTransformHelper = new Object3D();
  private readonly instanceMatrix = new Matrix4();
  private roadDebugVisible = false;
  private worldOffsetEast = 0;
  private worldOffsetNorth = 0;
  private currentTileCoordinate: TileCoordinate | null = null;
  private readonly buildingLodNearDistanceMeters = 220;
  private readonly buildingLodHysteresisMeters = 24;
  private decorationEnabled = true;
  private decorationDensityBudget = 1;

  public constructor(container: HTMLElement) {
    this.container = container;
    this.scene = new Scene();
    this.scene.background = new Color(0x0a1325);

    this.camera = new PerspectiveCamera(60, 1, 0.75, 1600);
    this.camera.position.set(16, 12, 16);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.container.appendChild(this.renderer.domElement);
    this.decorationGeometryByKind = this.createDecorationGeometries();
    this.decorationMaterialByKind = this.createDecorationMaterials();

    const ambientLight = new AmbientLight(0xffffff, 0.7);
    const directionalLight = new DirectionalLight(0xffffff, 1.2);
    directionalLight.position.set(30, 50, 20);

    this.prefetchLines = this.createDebugLines(this.prefetchMaterial);
    this.activeLines = this.createDebugLines(this.activeMaterial);
    this.currentTileLines = this.createDebugLines(this.currentTileMaterial);
    this.scene.add(
      ambientLight,
      directionalLight,
      this.terrainRoot,
      this.roadRoot,
      this.buildingRoot,
      this.decorationRoot,
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
    this.updateBuildingLodVisibility();
    this.updateDecorationVisibility();
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
    this.worldOffsetEast = offsetEast;
    this.worldOffsetNorth = offsetNorth;
    this.terrainRoot.position.set(-offsetEast, 0, -offsetNorth);
    this.roadRoot.position.set(-offsetEast, 0, -offsetNorth);
    this.buildingRoot.position.set(-offsetEast, 0, -offsetNorth);
    this.decorationRoot.position.set(-offsetEast, 0, -offsetNorth);
  }

  public setCurrentTileCoordinate(tile: TileCoordinate): void {
    this.currentTileCoordinate = tile;
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

  public upsertTerrainTileMesh(tileMesh: TerrainTileMeshPayload): void {
    this.removeTerrainTileMesh(tileMesh.tileKey);
    if (tileMesh.positions.length === 0 || tileMesh.indices.length === 0) {
      return;
    }

    const geometry = this.createIndexedGeometry(tileMesh.positions, tileMesh.indices);
    const material = this.terrainMaterialByKind[tileMesh.dominantKind];
    const surfaceMesh = new Mesh(geometry, material);
    surfaceMesh.name = 'terrain-surface';
    surfaceMesh.castShadow = false;
    surfaceMesh.receiveShadow = true;

    const group = new Group();
    group.name = `terrain-tile:${tileMesh.tileKey}`;
    group.add(surfaceMesh);

    this.terrainRoot.add(group);
    this.terrainTileBundles.set(tileMesh.tileKey, {
      tileKey: tileMesh.tileKey,
      group,
      geometry,
    });
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

  public upsertBuildingTileMesh(tileMesh: BuildingTileMeshPayload): void {
    this.removeBuildingTileMesh(tileMesh.tileKey);
    if (tileMesh.lod0Positions.length === 0 || tileMesh.lod0Indices.length === 0) {
      return;
    }

    const lod0Geometry = this.createIndexedGeometry(tileMesh.lod0Positions, tileMesh.lod0Indices);
    const lod1Geometry = this.createIndexedGeometry(tileMesh.lod1Positions, tileMesh.lod1Indices);
    const lod0Mesh = new Mesh(lod0Geometry, this.buildingMaterial);
    lod0Mesh.name = 'building-lod0';
    lod0Mesh.castShadow = false;
    lod0Mesh.receiveShadow = true;

    const lod1Mesh = new Mesh(lod1Geometry, this.buildingMaterial);
    lod1Mesh.name = 'building-lod1';
    lod1Mesh.castShadow = false;
    lod1Mesh.receiveShadow = true;

    const group = new Group();
    group.name = `building-tile:${tileMesh.tileKey}`;
    group.add(lod0Mesh, lod1Mesh);
    this.buildingRoot.add(group);

    const bundle: BuildingTileBundle = {
      tileKey: tileMesh.tileKey,
      group,
      lod0Geometry,
      lod1Geometry,
      lod0Mesh,
      lod1Mesh,
      tileCoordinate: this.parseTileCoordinateFromKey(tileMesh.tileKey),
      centerEast: tileMesh.tileCenter.east,
      centerNorth: tileMesh.tileCenter.north,
      lodState: 'lod0',
    };
    this.applyBuildingLod(bundle, this.resolveTargetLod(bundle));
    this.buildingTileBundles.set(tileMesh.tileKey, bundle);
  }

  public setDecorationEnabled(enabled: boolean): void {
    this.decorationEnabled = enabled;
    this.updateDecorationVisibility();
  }

  public setDecorationDensityBudget(densityBudget: number): void {
    this.decorationDensityBudget = Math.max(0, Math.min(1, densityBudget));
    this.updateDecorationVisibility();
  }

  public upsertDecorationTileMesh(tileMesh: DecorationTileMeshPayload): void {
    this.removeDecorationTileMesh(tileMesh.tileKey);

    const kindBundles: DecorationKindBundle[] = [];
    const group = new Group();
    group.name = `decoration-tile:${tileMesh.tileKey}`;

    for (const kindPayload of tileMesh.instancesByKind) {
      const instanceCount = Math.floor(kindPayload.transforms.length / 4);
      if (instanceCount <= 0) {
        continue;
      }

      const geometry = this.decorationGeometryByKind[kindPayload.kind];
      const material = this.decorationMaterialByKind[kindPayload.kind];
      const mesh = new InstancedMesh(geometry, material, instanceCount);
      mesh.name = `decoration-${kindPayload.kind}`;
      mesh.castShadow = false;
      mesh.receiveShadow = true;

      for (let index = 0; index < instanceCount; index += 1) {
        const base = index * 4;
        const east = kindPayload.transforms[base + 0] ?? 0;
        const north = kindPayload.transforms[base + 1] ?? 0;
        const rotationY = kindPayload.transforms[base + 2] ?? 0;
        const scale = kindPayload.transforms[base + 3] ?? 1;
        this.instanceTransformHelper.position.set(east, 0, north);
        this.instanceTransformHelper.rotation.set(0, rotationY, 0);
        this.instanceTransformHelper.scale.set(scale, scale, scale);
        this.instanceTransformHelper.updateMatrix();
        this.instanceMatrix.copy(this.instanceTransformHelper.matrix);
        mesh.setMatrixAt(index, this.instanceMatrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = instanceCount;
      group.add(mesh);
      kindBundles.push({
        kind: kindPayload.kind,
        mesh,
        totalInstances: instanceCount,
      });
    }

    if (kindBundles.length === 0) {
      return;
    }

    this.decorationRoot.add(group);
    const bundle: DecorationTileBundle = {
      tileKey: tileMesh.tileKey,
      group,
      kindBundles,
      tileCoordinate: this.parseTileCoordinateFromKey(tileMesh.tileKey),
      centerEast: tileMesh.tileCenter.east,
      centerNorth: tileMesh.tileCenter.north,
    };
    this.decorationTileBundles.set(tileMesh.tileKey, bundle);
    this.updateDecorationVisibility();
  }

  public updateTileDebugGrid(data: TileDebugGridData): void {
    this.updateLineGeometry(this.prefetchLines, data.prefetchTileBounds, 0.03);
    this.updateLineGeometry(this.activeLines, data.activeTileBounds, 0.06);
    this.updateLineGeometry(this.currentTileLines, [data.currentTileBounds], 0.1);
  }

  public dispose(): void {
    this.clearTerrainTiles();
    this.clearRoadTiles();
    this.clearBuildingTiles();
    this.clearDecorationTiles();

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
    this.buildingMaterial.dispose();
    for (const material of Object.values(this.terrainMaterialByKind)) {
      material.dispose();
    }
    for (const geometry of Object.values(this.decorationGeometryByKind)) {
      geometry.dispose();
    }
    for (const material of Object.values(this.decorationMaterialByKind)) {
      material.dispose();
    }

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clearTerrainTiles(): void {
    for (const tileKey of this.terrainTileBundles.keys()) {
      this.removeTerrainTileMesh(tileKey);
    }
  }

  private clearRoadTiles(): void {
    for (const tileKey of this.roadTileBundles.keys()) {
      this.removeRoadTileMesh(tileKey);
    }
  }

  private clearBuildingTiles(): void {
    for (const tileKey of this.buildingTileBundles.keys()) {
      this.removeBuildingTileMesh(tileKey);
    }
  }

  private clearDecorationTiles(): void {
    for (const tileKey of this.decorationTileBundles.keys()) {
      this.removeDecorationTileMesh(tileKey);
    }
  }

  public removeTerrainTileMesh(tileKey: string): void {
    const bundle = this.terrainTileBundles.get(tileKey);
    if (bundle === undefined) {
      return;
    }

    this.terrainTileBundles.delete(tileKey);
    this.terrainRoot.remove(bundle.group);
    bundle.geometry.dispose();
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

  public removeBuildingTileMesh(tileKey: string): void {
    const bundle = this.buildingTileBundles.get(tileKey);
    if (bundle === undefined) {
      return;
    }

    this.buildingTileBundles.delete(tileKey);
    this.buildingRoot.remove(bundle.group);
    bundle.lod0Geometry.dispose();
    bundle.lod1Geometry.dispose();
  }

  public removeDecorationTileMesh(tileKey: string): void {
    const bundle = this.decorationTileBundles.get(tileKey);
    if (bundle === undefined) {
      return;
    }

    this.decorationTileBundles.delete(tileKey);
    this.decorationRoot.remove(bundle.group);
  }

  public getRoadTileCount(): number {
    return this.roadTileBundles.size;
  }

  public getTerrainTileCount(): number {
    return this.terrainTileBundles.size;
  }

  public getBuildingTileCount(): number {
    return this.buildingTileBundles.size;
  }

  public getDecorationTileCount(): number {
    return this.decorationTileBundles.size;
  }

  public getVisibleDecorationInstanceCount(): number {
    let instanceCount = 0;
    for (const bundle of this.decorationTileBundles.values()) {
      for (const kind of bundle.kindBundles) {
        instanceCount += kind.mesh.count;
      }
    }
    return instanceCount;
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
    return this.createIndexedGeometry(positions, indices);
  }

  private createIndexedGeometry(positions: Float32Array, indices: Uint32Array): BufferGeometry {
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

  private updateBuildingLodVisibility(): void {
    if (this.buildingTileBundles.size === 0) {
      return;
    }

    for (const bundle of this.buildingTileBundles.values()) {
      const targetLod = this.resolveTargetLod(bundle);
      if (targetLod !== bundle.lodState) {
        this.applyBuildingLod(bundle, targetLod);
      }
    }
  }

  private updateDecorationVisibility(): void {
    if (this.decorationTileBundles.size === 0) {
      return;
    }

    for (const bundle of this.decorationTileBundles.values()) {
      const bandScale = this.resolveDecorationBandScale(bundle);
      const budgetScale = this.decorationEnabled ? this.decorationDensityBudget : 0;
      const totalScale = Math.max(0, Math.min(1, bandScale * budgetScale));
      for (const kindBundle of bundle.kindBundles) {
        if (totalScale <= 0) {
          kindBundle.mesh.count = 0;
          kindBundle.mesh.visible = false;
          continue;
        }

        const rawCount = Math.floor(kindBundle.totalInstances * totalScale);
        const visibleCount =
          rawCount <= 0 && kindBundle.totalInstances > 0
            ? 1
            : Math.min(kindBundle.totalInstances, rawCount);
        kindBundle.mesh.count = visibleCount;
        kindBundle.mesh.visible = visibleCount > 0;
      }
    }
  }

  private resolveDecorationBandScale(bundle: DecorationTileBundle): number {
    const focusTile = this.currentTileCoordinate;
    const bundleTile = bundle.tileCoordinate;
    if (focusTile !== null && bundleTile !== null) {
      const deltaX = Math.abs(bundleTile.x - focusTile.x);
      const deltaY = Math.abs(bundleTile.y - focusTile.y);
      const chebyshevDistance = Math.max(deltaX, deltaY);
      return this.resolveDecorationScaleFromTileDistance(chebyshevDistance);
    }

    const cameraPosition = this.camera.position;
    const centerX = bundle.centerEast - this.worldOffsetEast;
    const centerZ = bundle.centerNorth - this.worldOffsetNorth;
    const deltaX = centerX - cameraPosition.x;
    const deltaZ = centerZ - cameraPosition.z;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance <= 220) {
      return 1;
    }
    if (distance <= 360) {
      return 0.65;
    }
    if (distance <= 520) {
      return 0.28;
    }
    return 0;
  }

  private resolveDecorationScaleFromTileDistance(distance: number): number {
    if (distance <= 1) {
      return 1;
    }
    if (distance === 2) {
      return 0.65;
    }
    if (distance === 3) {
      return 0.28;
    }
    return 0;
  }

  private resolveTargetLod(bundle: BuildingTileBundle): 'lod0' | 'lod1' {
    const focusTile = this.currentTileCoordinate;
    const bundleTile = bundle.tileCoordinate;
    if (focusTile !== null && bundleTile !== null) {
      const deltaX = Math.abs(bundleTile.x - focusTile.x);
      const deltaY = Math.abs(bundleTile.y - focusTile.y);
      const chebyshevDistance = Math.max(deltaX, deltaY);
      return chebyshevDistance <= 1 ? 'lod0' : 'lod1';
    }

    const nearDistance = this.buildingLodNearDistanceMeters;
    const hysteresis = this.buildingLodHysteresisMeters;
    const nearEnterSq = Math.max(0, nearDistance - hysteresis) ** 2;
    const nearExitSq = (nearDistance + hysteresis) ** 2;
    const cameraPosition = this.camera.position;
    const centerX = bundle.centerEast - this.worldOffsetEast;
    const centerZ = bundle.centerNorth - this.worldOffsetNorth;
    const deltaX = centerX - cameraPosition.x;
    const deltaZ = centerZ - cameraPosition.z;
    const distanceSq = deltaX * deltaX + deltaZ * deltaZ;

    if (bundle.lodState === 'lod0') {
      return distanceSq > nearExitSq ? 'lod1' : 'lod0';
    }
    return distanceSq < nearEnterSq ? 'lod0' : 'lod1';
  }

  private parseTileCoordinateFromKey(tileKey: string): TileCoordinate | null {
    const parts = tileKey.split(':');
    if (parts.length !== 2) {
      return null;
    }

    const x = Number.parseInt(parts[0] ?? '', 10);
    const y = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return { x, y };
  }

  private applyBuildingLod(bundle: BuildingTileBundle, targetLod: 'lod0' | 'lod1'): void {
    bundle.lodState = targetLod;
    bundle.lod0Mesh.visible = targetLod === 'lod0';
    bundle.lod1Mesh.visible = targetLod === 'lod1';
  }

  private createDecorationGeometries(): Readonly<Record<DecorationPropKind, BufferGeometry>> {
    const tree = new ConeGeometry(0.95, 3.8, 7);
    tree.translate(0, 1.9, 0);
    const lamp = new CylinderGeometry(0.08, 0.12, 4.2, 6);
    lamp.translate(0, 2.1, 0);
    const sign = new BoxGeometry(0.72, 0.8, 0.1);
    sign.translate(0, 1.55, 0);
    const bench = new BoxGeometry(1.4, 0.46, 0.5);
    bench.translate(0, 0.24, 0);

    return {
      tree,
      lamp,
      sign,
      bench,
    };
  }

  private createDecorationMaterials(): Readonly<Record<DecorationPropKind, MeshStandardMaterial>> {
    return {
      tree: new MeshStandardMaterial({
        color: 0x2f855a,
        roughness: 0.9,
        metalness: 0.02,
      }),
      lamp: new MeshStandardMaterial({
        color: 0xd1d5db,
        roughness: 0.35,
        metalness: 0.45,
      }),
      sign: new MeshStandardMaterial({
        color: 0xf59e0b,
        roughness: 0.7,
        metalness: 0.1,
      }),
      bench: new MeshStandardMaterial({
        color: 0x92400e,
        roughness: 0.82,
        metalness: 0.05,
      }),
    };
  }
}
