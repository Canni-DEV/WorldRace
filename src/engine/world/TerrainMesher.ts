import type {
  BuildingFeature,
  BuildingPolygon,
  PointMeters,
  TerrainAreaFeature,
  TerrainKind,
  TileOSMData,
} from '../data/Types';
import type { TerrainKindMeshChunk, TerrainTileMeshPayload } from './TerrainMeshTypes';

interface TerrainMesherConfig {
  readonly floorHeightMeters: number;
  readonly mosaicResolution: number;
}

const defaultConfig: TerrainMesherConfig = {
  floorHeightMeters: -0.04,
  mosaicResolution: 16,
};

export class TerrainMesher {
  private readonly config: TerrainMesherConfig;

  public constructor(config: Partial<TerrainMesherConfig> = {}) {
    this.config = {
      floorHeightMeters: config.floorHeightMeters ?? defaultConfig.floorHeightMeters,
      mosaicResolution: this.resolveMosaicResolution(config.mosaicResolution),
    };
  }

  public buildTileTerrainMesh(tileData: TileOSMData): TerrainTileMeshPayload {
    const tileOriginEast = tileData.tileOriginGlobalMeters.east;
    const tileOriginNorth = tileData.tileOriginGlobalMeters.north;
    const y = this.config.floorHeightMeters;
    const resolution = this.config.mosaicResolution;
    const cellSizeMeters = tileData.tileSizeMeters / resolution;
    const positionsByKind: Record<TerrainKind, number[]> = {
      urban: [],
      green: [],
      water: [],
    };
    const indicesByKind: Record<TerrainKind, number[]> = {
      urban: [],
      green: [],
      water: [],
    };
    const vertexCountByKind = this.createMutableKindBuckets(0);

    for (let cellY = 0; cellY < resolution; cellY += 1) {
      for (let cellX = 0; cellX < resolution; cellX += 1) {
        const minLocalEast = cellX * cellSizeMeters;
        const minLocalNorth = cellY * cellSizeMeters;
        const maxLocalEast = minLocalEast + cellSizeMeters;
        const maxLocalNorth = minLocalNorth + cellSizeMeters;
        const centerPoint: PointMeters = {
          east: minLocalEast + cellSizeMeters * 0.5,
          north: minLocalNorth + cellSizeMeters * 0.5,
        };
        const cellKind = this.resolveCellKind(centerPoint, tileData);

        this.appendCellQuad(
          positionsByKind[cellKind],
          indicesByKind[cellKind],
          vertexCountByKind[cellKind],
          {
            minEast: tileOriginEast + minLocalEast,
            minNorth: tileOriginNorth + minLocalNorth,
            maxEast: tileOriginEast + maxLocalEast,
            maxNorth: tileOriginNorth + maxLocalNorth,
          },
          y,
        );
        vertexCountByKind[cellKind] += 4;
      }
    }

    const kindOrder: TerrainKind[] = ['water', 'urban', 'green'];
    const kindChunks: TerrainKindMeshChunk[] = [];
    for (const kind of kindOrder) {
      const positions = positionsByKind[kind];
      const indices = indicesByKind[kind];
      if (positions.length === 0 || indices.length === 0) {
        continue;
      }

      kindChunks.push({
        kind,
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
      });
    }

    return {
      tileKey: tileData.tileKey,
      tileCenter: {
        east: tileOriginEast + tileData.tileSizeMeters * 0.5,
        north: tileOriginNorth + tileData.tileSizeMeters * 0.5,
      },
      dominantKind: tileData.terrainSummary.dominantKind,
      coverage: tileData.terrainSummary.coverage,
      mosaicResolution: resolution,
      kindChunks,
    };
  }

  private resolveCellKind(cellCenter: PointMeters, tileData: TileOSMData): TerrainKind {
    const insideKind = this.resolveKindFromTerrainAreas(cellCenter, tileData.terrainAreas);
    if (insideKind !== null) {
      return insideKind;
    }

    if (this.isInsideAnyBuilding(cellCenter, tileData.buildings)) {
      return 'urban';
    }

    return tileData.terrainSummary.dominantKind;
  }

  private resolveKindFromTerrainAreas(
    point: PointMeters,
    terrainAreas: readonly TerrainAreaFeature[],
  ): TerrainKind | null {
    const coveredKinds = this.createMutableKindBuckets(false);

    for (const area of terrainAreas) {
      for (const polygon of area.polygons) {
        if (!this.isPointInsidePolygonWithHoles(point, polygon)) {
          continue;
        }
        coveredKinds[area.kind] = true;
        break;
      }
    }

    if (coveredKinds.water) {
      return 'water';
    }
    if (coveredKinds.urban) {
      return 'urban';
    }
    if (coveredKinds.green) {
      return 'green';
    }

    return null;
  }

  private isInsideAnyBuilding(
    point: PointMeters,
    buildings: readonly BuildingFeature[],
  ): boolean {
    for (const building of buildings) {
      for (const polygon of building.polygons) {
        if (this.isPointInsidePolygonWithHoles(point, polygon)) {
          return true;
        }
      }
    }
    return false;
  }

  private isPointInsidePolygonWithHoles(point: PointMeters, polygon: BuildingPolygon): boolean {
    if (!this.isPointInsideRing(point, polygon.outer)) {
      return false;
    }

    for (const hole of polygon.holes) {
      if (this.isPointInsideRing(point, hole)) {
        return false;
      }
    }
    return true;
  }

  private isPointInsideRing(point: PointMeters, ring: readonly PointMeters[]): boolean {
    const openRing = this.toOpenRing(ring);
    if (openRing.length < 3) {
      return false;
    }

    let inside = false;
    let previous = openRing[openRing.length - 1];
    for (const current of openRing) {
      if (previous === undefined) {
        previous = current;
        continue;
      }

      const intersects =
        (current.north > point.north) !== (previous.north > point.north) &&
        point.east <
          ((previous.east - current.east) * (point.north - current.north)) /
            (previous.north - current.north + Number.EPSILON) +
            current.east;
      if (intersects) {
        inside = !inside;
      }
      previous = current;
    }

    return inside;
  }

  private toOpenRing(ring: readonly PointMeters[]): readonly PointMeters[] {
    if (ring.length < 2) {
      return ring;
    }

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first === undefined || last === undefined) {
      return ring;
    }
    if (first.east === last.east && first.north === last.north) {
      return ring.slice(0, ring.length - 1);
    }
    return ring;
  }

  private appendCellQuad(
    positions: number[],
    indices: number[],
    baseVertex: number,
    bounds: {
      readonly minEast: number;
      readonly minNorth: number;
      readonly maxEast: number;
      readonly maxNorth: number;
    },
    y: number,
  ): void {
    positions.push(
      bounds.minEast, y, bounds.minNorth,
      bounds.maxEast, y, bounds.minNorth,
      bounds.maxEast, y, bounds.maxNorth,
      bounds.minEast, y, bounds.maxNorth,
    );

    indices.push(
      baseVertex + 0,
      baseVertex + 1,
      baseVertex + 2,
      baseVertex + 0,
      baseVertex + 2,
      baseVertex + 3,
    );
  }

  private resolveMosaicResolution(value: number | undefined): number {
    const raw = value ?? defaultConfig.mosaicResolution;
    const normalized = Math.floor(raw);
    return Math.max(4, Math.min(32, normalized));
  }

  private createMutableKindBuckets<TValue>(initialValue: TValue): Record<TerrainKind, TValue> {
    return {
      urban: initialValue,
      green: initialValue,
      water: initialValue,
    };
  }
}
