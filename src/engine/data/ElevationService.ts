import type { Projection } from '../geo/Projection';
import type { GeoBoundsLatLon, PointMeters } from './Types';

interface ElevationServiceConfig {
  readonly enabled: boolean;
  readonly zoom: number;
  readonly endpointTemplate: string;
  readonly maxCachedTiles: number;
  readonly fallbackMeters: number;
}

interface ElevationRasterTile {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
}

const TILE_SIZE_PIXELS = 256;
const MAX_MERCATOR_LATITUDE = 85.05112878;

const defaultConfig: ElevationServiceConfig = {
  enabled: true,
  zoom: 14,
  endpointTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxCachedTiles: 256,
  fallbackMeters: 0,
};

export class ElevationService {
  private readonly projection: Projection;
  private readonly config: ElevationServiceConfig;
  private readonly rasterByTileKey = new Map<string, ElevationRasterTile | null>();
  private readonly inflightByTileKey = new Map<string, Promise<void>>();

  public constructor(projection: Projection, config: Partial<ElevationServiceConfig> = {}) {
    this.projection = projection;
    this.config = {
      enabled: config.enabled ?? defaultConfig.enabled,
      zoom: Math.max(1, Math.min(15, Math.floor(config.zoom ?? defaultConfig.zoom))),
      endpointTemplate: config.endpointTemplate ?? defaultConfig.endpointTemplate,
      maxCachedTiles: Math.max(32, Math.floor(config.maxCachedTiles ?? defaultConfig.maxCachedTiles)),
      fallbackMeters: config.fallbackMeters ?? defaultConfig.fallbackMeters,
    };
  }

  public async ensureCoverage(bounds: GeoBoundsLatLon): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const minLatitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(bounds.south, bounds.north));
    const maxLatitude = Math.min(MAX_MERCATOR_LATITUDE, Math.max(bounds.south, bounds.north));
    const minLongitude = Math.min(bounds.west, bounds.east);
    const maxLongitude = Math.max(bounds.west, bounds.east);

    const northWest = this.latLonToTile(minLatitude === maxLatitude ? maxLatitude : maxLatitude, minLongitude);
    const southEast = this.latLonToTile(minLatitude, maxLongitude);
    const minTileX = Math.min(northWest.tileX, southEast.tileX);
    const maxTileX = Math.max(northWest.tileX, southEast.tileX);
    const minTileY = Math.min(northWest.tileY, southEast.tileY);
    const maxTileY = Math.max(northWest.tileY, southEast.tileY);

    const loadPromises: Promise<void>[] = [];
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
        loadPromises.push(this.ensureTile(tileX, tileY));
      }
    }

    await Promise.all(loadPromises);
  }

  public sampleElevationMeters(globalPoint: PointMeters): number {
    if (!this.config.enabled) {
      return this.config.fallbackMeters;
    }

    const latLon = this.projection.localMetersToLatLon({
      east: globalPoint.east,
      north: globalPoint.north,
    });
    const mercatorPixel = this.latLonToWorldPixel(latLon.latitude, latLon.longitude);
    const tileX = this.wrapTileX(Math.floor(mercatorPixel.pixelX / TILE_SIZE_PIXELS));
    const tileY = this.clampTileY(Math.floor(mercatorPixel.pixelY / TILE_SIZE_PIXELS));
    const tileKey = this.toTileKey(tileX, tileY);
    const raster = this.rasterByTileKey.get(tileKey);
    if (raster === undefined || raster === null) {
      return this.config.fallbackMeters;
    }
    this.touchTile(tileKey, raster);

    const localPixelX = Math.floor(mercatorPixel.pixelX - tileX * TILE_SIZE_PIXELS);
    const localPixelY = Math.floor(mercatorPixel.pixelY - tileY * TILE_SIZE_PIXELS);
    const sampleX = Math.max(0, Math.min(raster.width - 1, localPixelX));
    const sampleY = Math.max(0, Math.min(raster.height - 1, localPixelY));
    const index = (sampleY * raster.width + sampleX) * 4;

    const red = raster.rgba[index];
    const green = raster.rgba[index + 1];
    const blue = raster.rgba[index + 2];
    if (red === undefined || green === undefined || blue === undefined) {
      return this.config.fallbackMeters;
    }

    return red * 256 + green + blue / 256 - 32768;
  }

  private async ensureTile(tileX: number, tileY: number): Promise<void> {
    const normalizedTileX = this.wrapTileX(tileX);
    const normalizedTileY = this.clampTileY(tileY);
    const tileKey = this.toTileKey(normalizedTileX, normalizedTileY);
    if (this.rasterByTileKey.has(tileKey)) {
      const cached = this.rasterByTileKey.get(tileKey);
      if (cached !== undefined) {
        this.touchTile(tileKey, cached);
      }
      return;
    }

    const inflight = this.inflightByTileKey.get(tileKey);
    if (inflight !== undefined) {
      await inflight;
      return;
    }

    const loadPromise = this.loadTile(tileKey, normalizedTileX, normalizedTileY);
    this.inflightByTileKey.set(tileKey, loadPromise);
    try {
      await loadPromise;
    } finally {
      this.inflightByTileKey.delete(tileKey);
    }
  }

  private async loadTile(tileKey: string, tileX: number, tileY: number): Promise<void> {
    try {
      const url = this.config.endpointTemplate
        .replace('{z}', String(this.config.zoom))
        .replace('{x}', String(tileX))
        .replace('{y}', String(tileY));
      const response = await fetch(url, {
        method: 'GET',
      });
      if (!response.ok) {
        throw new Error(`Elevation HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) {
        bitmap.close();
        throw new Error('Unable to create DEM canvas context.');
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();

      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      this.cacheTile(tileKey, {
        width: canvas.width,
        height: canvas.height,
        rgba: imageData.data,
      });
      return;
    } catch (error) {
      console.warn('[ElevationService] Failed to load DEM tile.', {
        tileKey,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.cacheTile(tileKey, null);
    }
  }

  private latLonToTile(latitude: number, longitude: number): { readonly tileX: number; readonly tileY: number } {
    const worldPixel = this.latLonToWorldPixel(latitude, longitude);
    return {
      tileX: this.wrapTileX(Math.floor(worldPixel.pixelX / TILE_SIZE_PIXELS)),
      tileY: this.clampTileY(Math.floor(worldPixel.pixelY / TILE_SIZE_PIXELS)),
    };
  }

  private latLonToWorldPixel(
    latitude: number,
    longitude: number,
  ): { readonly pixelX: number; readonly pixelY: number } {
    const clampedLatitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
    const normalizedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180;
    const scale = TILE_SIZE_PIXELS * 2 ** this.config.zoom;
    const x = ((normalizedLongitude + 180) / 360) * scale;
    const latitudeRadians = (clampedLatitude * Math.PI) / 180;
    const mercatorY =
      (1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI) * 0.5;
    const y = mercatorY * scale;
    return {
      pixelX: x,
      pixelY: y,
    };
  }

  private wrapTileX(value: number): number {
    const tileCount = 2 ** this.config.zoom;
    return ((value % tileCount) + tileCount) % tileCount;
  }

  private clampTileY(value: number): number {
    const tileCount = 2 ** this.config.zoom;
    return Math.max(0, Math.min(tileCount - 1, value));
  }

  private toTileKey(tileX: number, tileY: number): string {
    return `${this.config.zoom}:${tileX}:${tileY}`;
  }

  private cacheTile(tileKey: string, raster: ElevationRasterTile | null): void {
    this.rasterByTileKey.set(tileKey, raster);
    this.pruneCache();
  }

  private touchTile(tileKey: string, raster: ElevationRasterTile | null): void {
    this.rasterByTileKey.delete(tileKey);
    this.rasterByTileKey.set(tileKey, raster);
  }

  private pruneCache(): void {
    while (this.rasterByTileKey.size > this.config.maxCachedTiles) {
      const oldestKey = this.rasterByTileKey.keys().next().value;
      if (typeof oldestKey !== 'string') {
        break;
      }
      this.rasterByTileKey.delete(oldestKey);
    }
  }
}
