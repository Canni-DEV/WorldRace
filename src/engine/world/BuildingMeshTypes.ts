export interface BuildingMeshStats {
  readonly sourceBuildings: number;
  readonly lod0Buildings: number;
  readonly lod1Buildings: number;
  readonly lod0TriangleCount: number;
  readonly lod1TriangleCount: number;
  readonly droppedPolygons: number;
}

export interface BuildingTileMeshPayload {
  readonly tileKey: string;
  readonly tileCenter: {
    readonly east: number;
    readonly north: number;
  };
  readonly lod0Positions: Float32Array;
  readonly lod0Indices: Uint32Array;
  readonly lod1Positions: Float32Array;
  readonly lod1Indices: Uint32Array;
  readonly stats: BuildingMeshStats;
}
