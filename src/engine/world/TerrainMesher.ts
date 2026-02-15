import type { TileOSMData } from '../data/Types';
import type { TerrainTileMeshPayload } from './TerrainMeshTypes';

interface TerrainMesherConfig {
  readonly floorHeightMeters: number;
}

const defaultConfig: TerrainMesherConfig = {
  floorHeightMeters: -0.03,
};

export class TerrainMesher {
  private readonly config: TerrainMesherConfig;

  public constructor(config: Partial<TerrainMesherConfig> = {}) {
    this.config = {
      floorHeightMeters: config.floorHeightMeters ?? defaultConfig.floorHeightMeters,
    };
  }

  public buildTileTerrainMesh(tileData: TileOSMData): TerrainTileMeshPayload {
    const minEast = tileData.tileOriginGlobalMeters.east;
    const minNorth = tileData.tileOriginGlobalMeters.north;
    const maxEast = minEast + tileData.tileSizeMeters;
    const maxNorth = minNorth + tileData.tileSizeMeters;
    const y = this.config.floorHeightMeters;

    const positions = new Float32Array([
      minEast, y, minNorth,
      maxEast, y, minNorth,
      maxEast, y, maxNorth,
      minEast, y, maxNorth,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

    return {
      tileKey: tileData.tileKey,
      tileCenter: {
        east: minEast + tileData.tileSizeMeters * 0.5,
        north: minNorth + tileData.tileSizeMeters * 0.5,
      },
      dominantKind: tileData.terrainSummary.dominantKind,
      coverage: tileData.terrainSummary.coverage,
      positions,
      indices,
    };
  }
}
