import type { TerrainKind, TileTerrainCoverage } from '../data/Types';

export interface TerrainTileMeshPayload {
  readonly tileKey: string;
  readonly tileCenter: {
    readonly east: number;
    readonly north: number;
  };
  readonly dominantKind: TerrainKind;
  readonly coverage: TileTerrainCoverage;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}
