import type { GeoBoundsMeters } from './GeoBounds';

export interface TileCoordinate {
  readonly x: number;
  readonly y: number;
}

export interface GlobalOffsetMeters {
  readonly east: number;
  readonly north: number;
}

export interface TileRings {
  readonly activeTiles: readonly TileCoordinate[];
  readonly prefetchTiles: readonly TileCoordinate[];
}

export class TileSystem {
  private tileSizeMeters: number;

  public constructor(tileSizeMeters: number) {
    this.tileSizeMeters = this.normalizeTileSize(tileSizeMeters);
  }

  public getTileSizeMeters(): number {
    return this.tileSizeMeters;
  }

  public setTileSizeMeters(tileSizeMeters: number): void {
    this.tileSizeMeters = this.normalizeTileSize(tileSizeMeters);
  }

  public getTileKey(tile: TileCoordinate): string {
    return `${tile.x}:${tile.y}`;
  }

  public getTileFromGlobalMeters(east: number, north: number): TileCoordinate {
    return {
      x: Math.floor(east / this.tileSizeMeters),
      y: Math.floor(north / this.tileSizeMeters),
    };
  }

  public getTileBoundsGlobalMeters(tile: TileCoordinate): GeoBoundsMeters {
    const minEast = tile.x * this.tileSizeMeters;
    const minNorth = tile.y * this.tileSizeMeters;

    return {
      minEast,
      minNorth,
      maxEast: minEast + this.tileSizeMeters,
      maxNorth: minNorth + this.tileSizeMeters,
    };
  }

  public getTileBoundsLocalMeters(
    tile: TileCoordinate,
    globalOffset: GlobalOffsetMeters,
  ): GeoBoundsMeters {
    const globalBounds = this.getTileBoundsGlobalMeters(tile);
    return {
      minEast: globalBounds.minEast - globalOffset.east,
      minNorth: globalBounds.minNorth - globalOffset.north,
      maxEast: globalBounds.maxEast - globalOffset.east,
      maxNorth: globalBounds.maxNorth - globalOffset.north,
    };
  }

  public getTilesInRadius(centerTile: TileCoordinate, radiusTiles: number): TileCoordinate[] {
    const normalizedRadius = Math.max(0, Math.floor(radiusTiles));
    const tiles: TileCoordinate[] = [];

    for (let y = centerTile.y - normalizedRadius; y <= centerTile.y + normalizedRadius; y += 1) {
      for (let x = centerTile.x - normalizedRadius; x <= centerTile.x + normalizedRadius; x += 1) {
        tiles.push({ x, y });
      }
    }

    return tiles;
  }

  public getDesiredTileRings(
    centerTile: TileCoordinate,
    activeRadiusTiles: number,
    prefetchRadiusTiles: number,
  ): TileRings {
    const activeTiles = this.getTilesInRadius(centerTile, activeRadiusTiles);
    const normalizedPrefetchRadius = Math.max(
      Math.floor(prefetchRadiusTiles),
      Math.floor(activeRadiusTiles),
    );
    const prefetchCandidates = this.getTilesInRadius(centerTile, normalizedPrefetchRadius);
    const activeKeys = new Set(activeTiles.map((tile) => this.getTileKey(tile)));
    const prefetchTiles = prefetchCandidates.filter((tile) => !activeKeys.has(this.getTileKey(tile)));

    return {
      activeTiles,
      prefetchTiles,
    };
  }

  private normalizeTileSize(tileSizeMeters: number): number {
    const normalizedSize = Math.floor(tileSizeMeters);
    if (normalizedSize < 16) {
      return 16;
    }

    return normalizedSize;
  }
}
