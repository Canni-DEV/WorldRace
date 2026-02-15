const EARTH_RADIUS_METERS = 6378137;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const MIN_COSINE_ABS = 1e-6;

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface LocalMeters {
  readonly east: number;
  readonly north: number;
}

export class Projection {
  private origin: GeoPoint;
  private cosineOfOriginLatitude: number;

  public constructor(origin: GeoPoint) {
    this.origin = { latitude: 0, longitude: 0 };
    this.cosineOfOriginLatitude = 1;
    this.setOrigin(origin);
  }

  public getOrigin(): GeoPoint {
    return {
      latitude: this.origin.latitude,
      longitude: this.origin.longitude,
    };
  }

  public setOrigin(origin: GeoPoint): void {
    this.origin = {
      latitude: this.clampLatitude(origin.latitude),
      longitude: this.normalizeLongitude(origin.longitude),
    };

    const cosine = Math.cos(this.origin.latitude * DEGREES_TO_RADIANS);
    const absCosine = Math.abs(cosine);
    if (absCosine < MIN_COSINE_ABS) {
      this.cosineOfOriginLatitude = cosine >= 0 ? MIN_COSINE_ABS : -MIN_COSINE_ABS;
      return;
    }

    this.cosineOfOriginLatitude = cosine;
  }

  public latLonToLocalMeters(point: GeoPoint): LocalMeters {
    const deltaLatitude = (point.latitude - this.origin.latitude) * DEGREES_TO_RADIANS;
    const deltaLongitude = (point.longitude - this.origin.longitude) * DEGREES_TO_RADIANS;

    return {
      east: deltaLongitude * EARTH_RADIUS_METERS * this.cosineOfOriginLatitude,
      north: deltaLatitude * EARTH_RADIUS_METERS,
    };
  }

  public localMetersToLatLon(local: LocalMeters): GeoPoint {
    const latitude =
      this.origin.latitude + (local.north / EARTH_RADIUS_METERS) * RADIANS_TO_DEGREES;
    const longitude =
      this.origin.longitude +
      (local.east / (EARTH_RADIUS_METERS * this.cosineOfOriginLatitude)) * RADIANS_TO_DEGREES;

    return {
      latitude: this.clampLatitude(latitude),
      longitude: this.normalizeLongitude(longitude),
    };
  }

  public shiftOriginByLocalMeters(local: LocalMeters): GeoPoint {
    const nextOrigin = this.localMetersToLatLon(local);
    this.setOrigin(nextOrigin);
    return nextOrigin;
  }

  private clampLatitude(latitude: number): number {
    return Math.min(Math.max(latitude, -85), 85);
  }

  private normalizeLongitude(longitude: number): number {
    const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
    return normalized === -180 ? 180 : normalized;
  }
}
