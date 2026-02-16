import type { TerrainKind, TileTerrainCoverage } from '../data/Types';

export interface TerrainKindMeshChunk {
  readonly kind: TerrainKind;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface TerrainTileMeshPayload {
  readonly tileKey: string;
  readonly tileCenter: {
    readonly east: number;
    readonly north: number;
  };
  readonly dominantKind: TerrainKind;
  readonly coverage: TileTerrainCoverage;
  readonly mosaicResolution: number;
  readonly kindChunks: readonly TerrainKindMeshChunk[];
}
