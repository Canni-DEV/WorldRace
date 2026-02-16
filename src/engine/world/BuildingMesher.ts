import { ShapeUtils, Vector2 } from 'three';
import type {
  BuildingFeature,
  PointMeters,
  TileOSMData,
} from '../data/Types';
import type { BuildingTileMeshPayload } from './BuildingMeshTypes';

interface BuildingMesherConfig {
  readonly levelHeightMeters: number;
  readonly defaultBuildingHeightMeters: number;
  readonly minBuildingHeightMeters: number;
  readonly maxBuildingHeightMeters: number;
  readonly roofGableHeightMeters: number;
}

export interface BuildingMesherBuildOptions {
  readonly sampleElevationMeters?: (east: number, north: number) => number;
}

interface MutableBounds {
  minEast: number;
  minNorth: number;
  maxEast: number;
  maxNorth: number;
}

interface MutableBuildingMeshStats {
  sourceBuildings: number;
  lod0Buildings: number;
  lod1Buildings: number;
  lod0TriangleCount: number;
  lod1TriangleCount: number;
  droppedPolygons: number;
}

const defaultConfig: BuildingMesherConfig = {
  levelHeightMeters: 3,
  defaultBuildingHeightMeters: 9,
  minBuildingHeightMeters: 3,
  maxBuildingHeightMeters: 220,
  roofGableHeightMeters: 2.25,
};

const LOD1_COLINEAR_TOLERANCE_METERS = 0.08;

export class BuildingMesher {
  private readonly config: BuildingMesherConfig;

  public constructor(config: Partial<BuildingMesherConfig> = {}) {
    this.config = {
      levelHeightMeters: config.levelHeightMeters ?? defaultConfig.levelHeightMeters,
      defaultBuildingHeightMeters:
        config.defaultBuildingHeightMeters ?? defaultConfig.defaultBuildingHeightMeters,
      minBuildingHeightMeters: config.minBuildingHeightMeters ?? defaultConfig.minBuildingHeightMeters,
      maxBuildingHeightMeters: config.maxBuildingHeightMeters ?? defaultConfig.maxBuildingHeightMeters,
      roofGableHeightMeters: config.roofGableHeightMeters ?? defaultConfig.roofGableHeightMeters,
    };
  }

  public buildTileBuildingMesh(
    tileData: TileOSMData,
    options: BuildingMesherBuildOptions = {},
  ): BuildingTileMeshPayload {
    const lod0Positions: number[] = [];
    const lod0Indices: number[] = [];
    const lod1Positions: number[] = [];
    const lod1Indices: number[] = [];
    const stats: MutableBuildingMeshStats = {
      sourceBuildings: tileData.buildings.length,
      lod0Buildings: 0,
      lod1Buildings: 0,
      lod0TriangleCount: 0,
      lod1TriangleCount: 0,
      droppedPolygons: 0,
    };

    for (const building of tileData.buildings) {
      const buildingHeight = this.resolveHeightMeters(building);
      let hasLod0Geometry = false;
      let hasLod1Geometry = false;

      for (const polygon of building.polygons) {
        const outer = this.offsetRingToGlobal(
          this.toOpenRing(polygon.outer),
          tileData.tileOriginGlobalMeters,
        );
        if (outer.length < 3) {
          stats.droppedPolygons += 1;
          continue;
        }

        const holes = polygon.holes
          .map((hole) => this.offsetRingToGlobal(this.toOpenRing(hole), tileData.tileOriginGlobalMeters))
          .filter((hole) => hole.length >= 3);
        const baseElevationMeters = this.resolvePolygonBaseElevation(outer, options);
        const appended = this.appendLod0BuildingPolygon(
          outer,
          holes,
          baseElevationMeters,
          buildingHeight,
          building.properties.roofShape,
          lod0Positions,
          lod0Indices,
        );
        if (!appended) {
          stats.droppedPolygons += 1;
          continue;
        }

        const simplifiedOuter = this.simplifyLod1Ring(outer);
        const lod1Outer =
          simplifiedOuter.length >= 3
            ? this.ensureWinding(simplifiedOuter, true)
            : this.ensureWinding(outer, true);
        if (lod1Outer.length >= 3) {
          this.appendLod1BuildingPolygon(
            lod1Outer,
            baseElevationMeters,
            buildingHeight,
            lod1Positions,
            lod1Indices,
          );
          hasLod1Geometry = true;
        }
        hasLod0Geometry = true;
      }

      if (!hasLod0Geometry) {
        continue;
      }

      stats.lod0Buildings += 1;
      if (hasLod1Geometry) {
        stats.lod1Buildings += 1;
      }
    }

    stats.lod0TriangleCount = Math.floor(lod0Indices.length / 3);
    stats.lod1TriangleCount = Math.floor(lod1Indices.length / 3);

    return {
      tileKey: tileData.tileKey,
      tileCenter: {
        east: tileData.tileOriginGlobalMeters.east + tileData.tileSizeMeters * 0.5,
        north: tileData.tileOriginGlobalMeters.north + tileData.tileSizeMeters * 0.5,
      },
      lod0Positions: new Float32Array(lod0Positions),
      lod0Indices: new Uint32Array(lod0Indices),
      lod1Positions: new Float32Array(lod1Positions),
      lod1Indices: new Uint32Array(lod1Indices),
      stats,
    };
  }

  private resolveHeightMeters(building: BuildingFeature): number {
    const explicitHeight = building.properties.heightMeters;
    if (explicitHeight !== null && Number.isFinite(explicitHeight)) {
      return this.clampHeight(explicitHeight);
    }

    const levels = building.properties.levels;
    if (levels !== null && levels > 0) {
      return this.clampHeight(levels * this.config.levelHeightMeters);
    }

    return this.clampHeight(this.defaultHeightByKind(building.properties.kind));
  }

  private clampHeight(heightMeters: number): number {
    return Math.max(
      this.config.minBuildingHeightMeters,
      Math.min(this.config.maxBuildingHeightMeters, heightMeters),
    );
  }

  private defaultHeightByKind(kind: string): number {
    switch (kind) {
      case 'commercial':
      case 'office':
      case 'industrial':
        return 14;
      case 'retail':
      case 'apartments':
      case 'residential':
        return 10;
      case 'garage':
      case 'hut':
        return 5;
      default:
        return this.config.defaultBuildingHeightMeters;
    }
  }

  private appendLod0BuildingPolygon(
    outerRing: readonly PointMeters[],
    holes: readonly (readonly PointMeters[])[],
    baseElevationMeters: number,
    heightMeters: number,
    roofShape: string | null,
    positions: number[],
    indices: number[],
  ): boolean {
    const normalizedOuter = this.ensureWinding(outerRing, true);
    if (normalizedOuter.length < 3) {
      return false;
    }

    const normalizedHoles = holes
      .map((hole) => this.ensureWinding(hole, false))
      .filter((hole) => hole.length >= 3);

    this.appendWallsForRing(normalizedOuter, baseElevationMeters, heightMeters, positions, indices);
    for (const hole of normalizedHoles) {
      this.appendWallsForRing(hole, baseElevationMeters, heightMeters, positions, indices);
    }

    if (roofShape === 'gabled' && normalizedHoles.length === 0 && normalizedOuter.length === 4) {
      this.appendSimpleGabledRoof(
        normalizedOuter,
        baseElevationMeters,
        heightMeters,
        positions,
        indices,
      );
      return true;
    }

    this.appendFlatRoof(
      normalizedOuter,
      normalizedHoles,
      baseElevationMeters,
      heightMeters,
      positions,
      indices,
    );
    return true;
  }

  private appendFlatRoof(
    outerRing: readonly PointMeters[],
    holes: readonly (readonly PointMeters[])[],
    baseElevationMeters: number,
    heightMeters: number,
    positions: number[],
    indices: number[],
  ): void {
    const contour = outerRing.map((point) => new Vector2(point.east, point.north));
    const holes2d = holes.map((hole) => hole.map((point) => new Vector2(point.east, point.north)));
    const triangulated = ShapeUtils.triangulateShape(contour, holes2d);

    const baseVertex = Math.floor(positions.length / 3);
    const flatPoints = [...outerRing, ...holes.flatMap((hole) => hole)];
    for (const point of flatPoints) {
      positions.push(point.east, baseElevationMeters + heightMeters, point.north);
    }

    for (const triangle of triangulated) {
      const indexA = triangle[0];
      const indexB = triangle[1];
      const indexC = triangle[2];
      if (indexA === undefined || indexB === undefined || indexC === undefined) {
        continue;
      }
      this.appendUpwardTriangle(
        positions,
        indices,
        baseVertex + indexA,
        baseVertex + indexB,
        baseVertex + indexC,
      );
    }
  }

  private appendSimpleGabledRoof(
    outerRing: readonly PointMeters[],
    baseElevationMeters: number,
    baseHeightMeters: number,
    positions: number[],
    indices: number[],
  ): void {
    const bounds = this.computeBounds(outerRing);
    if (bounds === null) {
      this.appendFlatRoof(outerRing, [], baseElevationMeters, baseHeightMeters, positions, indices);
      return;
    }

    const widthEast = bounds.maxEast - bounds.minEast;
    const widthNorth = bounds.maxNorth - bounds.minNorth;
    if (widthEast <= 0 || widthNorth <= 0) {
      this.appendFlatRoof(outerRing, [], baseElevationMeters, baseHeightMeters, positions, indices);
      return;
    }

    const ridgeHeightMeters = Math.min(
      this.config.roofGableHeightMeters,
      Math.max(0.8, baseHeightMeters * 0.2),
    );
    const roofY = baseElevationMeters + baseHeightMeters + ridgeHeightMeters;
    const centerEast = (bounds.minEast + bounds.maxEast) * 0.5;
    const centerNorth = (bounds.minNorth + bounds.maxNorth) * 0.5;

    if (widthEast >= widthNorth) {
      const c0 = this.pushVertex(
        positions,
        bounds.minEast,
        baseElevationMeters + baseHeightMeters,
        bounds.minNorth,
      );
      const c1 = this.pushVertex(
        positions,
        bounds.maxEast,
        baseElevationMeters + baseHeightMeters,
        bounds.minNorth,
      );
      const c2 = this.pushVertex(
        positions,
        bounds.maxEast,
        baseElevationMeters + baseHeightMeters,
        bounds.maxNorth,
      );
      const c3 = this.pushVertex(
        positions,
        bounds.minEast,
        baseElevationMeters + baseHeightMeters,
        bounds.maxNorth,
      );
      const ridgeA = this.pushVertex(positions, bounds.minEast, roofY, centerNorth);
      const ridgeB = this.pushVertex(positions, bounds.maxEast, roofY, centerNorth);

      this.appendUpwardTriangle(positions, indices, c0, ridgeA, c1);
      this.appendUpwardTriangle(positions, indices, c1, ridgeA, ridgeB);
      this.appendUpwardTriangle(positions, indices, c2, ridgeB, c3);
      this.appendUpwardTriangle(positions, indices, c3, ridgeB, ridgeA);
      this.appendTriangle(indices, c3, ridgeA, c0);
      this.appendTriangle(indices, c1, ridgeB, c2);
      return;
    }

    const c0 = this.pushVertex(
      positions,
      bounds.minEast,
      baseElevationMeters + baseHeightMeters,
      bounds.minNorth,
    );
    const c1 = this.pushVertex(
      positions,
      bounds.maxEast,
      baseElevationMeters + baseHeightMeters,
      bounds.minNorth,
    );
    const c2 = this.pushVertex(
      positions,
      bounds.maxEast,
      baseElevationMeters + baseHeightMeters,
      bounds.maxNorth,
    );
    const c3 = this.pushVertex(
      positions,
      bounds.minEast,
      baseElevationMeters + baseHeightMeters,
      bounds.maxNorth,
    );
    const ridgeA = this.pushVertex(positions, centerEast, roofY, bounds.minNorth);
    const ridgeB = this.pushVertex(positions, centerEast, roofY, bounds.maxNorth);

    this.appendUpwardTriangle(positions, indices, c0, c3, ridgeA);
    this.appendUpwardTriangle(positions, indices, ridgeA, c3, ridgeB);
    this.appendUpwardTriangle(positions, indices, c1, ridgeA, c2);
    this.appendUpwardTriangle(positions, indices, c2, ridgeA, ridgeB);
    this.appendTriangle(indices, c0, ridgeA, c1);
    this.appendTriangle(indices, c2, ridgeB, c3);
  }

  private appendLod1BuildingPolygon(
    outerRing: readonly PointMeters[],
    baseElevationMeters: number,
    heightMeters: number,
    positions: number[],
    indices: number[],
  ): void {
    this.appendWallsForRing(outerRing, baseElevationMeters, heightMeters, positions, indices);
    this.appendFlatRoof(outerRing, [], baseElevationMeters, heightMeters, positions, indices);
  }

  private appendWallsForRing(
    ring: readonly PointMeters[],
    baseElevationMeters: number,
    heightMeters: number,
    positions: number[],
    indices: number[],
  ): void {
    const pointCount = ring.length;
    if (pointCount < 3) {
      return;
    }

    for (let index = 0; index < pointCount; index += 1) {
      const current = ring[index];
      const next = ring[(index + 1) % pointCount];
      if (current === undefined || next === undefined) {
        continue;
      }

      const baseVertex = Math.floor(positions.length / 3);
      positions.push(
        current.east,
        baseElevationMeters,
        current.north,
        next.east,
        baseElevationMeters,
        next.north,
        current.east,
        baseElevationMeters + heightMeters,
        current.north,
        next.east,
        baseElevationMeters + heightMeters,
        next.north,
      );

      this.appendTriangle(indices, baseVertex + 0, baseVertex + 2, baseVertex + 1);
      this.appendTriangle(indices, baseVertex + 1, baseVertex + 2, baseVertex + 3);
    }
  }

  private appendUpwardTriangle(
    positions: readonly number[],
    indices: number[],
    indexA: number,
    indexB: number,
    indexC: number,
  ): void {
    const pointA = this.readVertexXZ(positions, indexA);
    const pointB = this.readVertexXZ(positions, indexB);
    const pointC = this.readVertexXZ(positions, indexC);

    const signedArea =
      (pointB.east - pointA.east) * (pointC.north - pointA.north) -
      (pointB.north - pointA.north) * (pointC.east - pointA.east);

    if (signedArea >= 0) {
      this.appendTriangle(indices, indexA, indexB, indexC);
      return;
    }

    this.appendTriangle(indices, indexA, indexC, indexB);
  }

  private readVertexXZ(
    positions: readonly number[],
    vertexIndex: number,
  ): { east: number; north: number } {
    const base = vertexIndex * 3;
    return {
      east: positions[base] ?? 0,
      north: positions[base + 2] ?? 0,
    };
  }

  private appendTriangle(indices: number[], indexA: number, indexB: number, indexC: number): void {
    indices.push(indexA, indexB, indexC);
  }

  private pushVertex(positions: number[], east: number, height: number, north: number): number {
    const vertexIndex = Math.floor(positions.length / 3);
    positions.push(east, height, north);
    return vertexIndex;
  }

  private ensureWinding(ring: readonly PointMeters[], shouldBeCounterClockwise: boolean): PointMeters[] {
    if (ring.length < 3) {
      return [];
    }

    const signedArea = this.computeSignedAreaOpen(ring);
    const isCounterClockwise = signedArea > 0;
    if (isCounterClockwise === shouldBeCounterClockwise) {
      return [...ring];
    }
    return [...ring].reverse();
  }

  private computeSignedAreaOpen(ring: readonly PointMeters[]): number {
    if (ring.length < 3) {
      return 0;
    }

    let signedArea = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const current = ring[index];
      const next = ring[(index + 1) % ring.length];
      if (current === undefined || next === undefined) {
        continue;
      }
      signedArea += current.east * next.north - next.east * current.north;
    }

    return signedArea * 0.5;
  }

  private toOpenRing(ring: readonly PointMeters[]): PointMeters[] {
    if (ring.length < 3) {
      return [];
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first === undefined || last === undefined) {
      return [...ring];
    }
    if (first.east === last.east && first.north === last.north) {
      return ring.slice(0, ring.length - 1);
    }
    return [...ring];
  }

  private offsetRingToGlobal(
    ring: readonly PointMeters[],
    tileOrigin: { readonly east: number; readonly north: number },
  ): PointMeters[] {
    return ring.map((point) => ({
      east: point.east + tileOrigin.east,
      north: point.north + tileOrigin.north,
    }));
  }

  private simplifyLod1Ring(ring: readonly PointMeters[]): PointMeters[] {
    if (ring.length <= 4) {
      return [...ring];
    }

    const simplified: PointMeters[] = [];
    const pointCount = ring.length;
    for (let index = 0; index < pointCount; index += 1) {
      const previous = ring[(index - 1 + pointCount) % pointCount];
      const current = ring[index];
      const next = ring[(index + 1) % pointCount];
      if (previous === undefined || current === undefined || next === undefined) {
        continue;
      }

      const distance = this.distanceToSegmentMeters(current, previous, next);
      if (distance <= LOD1_COLINEAR_TOLERANCE_METERS && simplified.length >= 3) {
        continue;
      }
      simplified.push(current);
    }

    return simplified.length >= 3 ? simplified : [...ring];
  }

  private distanceToSegmentMeters(point: PointMeters, segmentStart: PointMeters, segmentEnd: PointMeters): number {
    const dx = segmentEnd.east - segmentStart.east;
    const dz = segmentEnd.north - segmentStart.north;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq <= Number.EPSILON) {
      const px = point.east - segmentStart.east;
      const pz = point.north - segmentStart.north;
      return Math.sqrt(px * px + pz * pz);
    }

    const projection =
      ((point.east - segmentStart.east) * dx + (point.north - segmentStart.north) * dz) / lengthSq;
    const clamped = Math.max(0, Math.min(1, projection));
    const nearestEast = segmentStart.east + dx * clamped;
    const nearestNorth = segmentStart.north + dz * clamped;
    const deltaEast = point.east - nearestEast;
    const deltaNorth = point.north - nearestNorth;
    return Math.sqrt(deltaEast * deltaEast + deltaNorth * deltaNorth);
  }

  private createEmptyBounds(): MutableBounds {
    return {
      minEast: Number.POSITIVE_INFINITY,
      minNorth: Number.POSITIVE_INFINITY,
      maxEast: Number.NEGATIVE_INFINITY,
      maxNorth: Number.NEGATIVE_INFINITY,
    };
  }

  private isValidBounds(bounds: MutableBounds): boolean {
    return (
      Number.isFinite(bounds.minEast) &&
      Number.isFinite(bounds.minNorth) &&
      Number.isFinite(bounds.maxEast) &&
      Number.isFinite(bounds.maxNorth) &&
      bounds.maxEast > bounds.minEast &&
      bounds.maxNorth > bounds.minNorth
    );
  }

  private extendBoundsWithPoints(bounds: MutableBounds, points: readonly PointMeters[]): void {
    for (const point of points) {
      bounds.minEast = Math.min(bounds.minEast, point.east);
      bounds.minNorth = Math.min(bounds.minNorth, point.north);
      bounds.maxEast = Math.max(bounds.maxEast, point.east);
      bounds.maxNorth = Math.max(bounds.maxNorth, point.north);
    }
  }

  private computeBounds(points: readonly PointMeters[]): MutableBounds | null {
    const bounds = this.createEmptyBounds();
    this.extendBoundsWithPoints(bounds, points);
    return this.isValidBounds(bounds) ? bounds : null;
  }

  private resolvePolygonBaseElevation(
    points: readonly PointMeters[],
    options: BuildingMesherBuildOptions,
  ): number {
    const sampleElevation = options.sampleElevationMeters;
    if (sampleElevation === undefined || points.length === 0) {
      return 0;
    }

    let sampledCount = 0;
    let sampledSum = 0;
    for (const point of points) {
      const sample = sampleElevation(point.east, point.north);
      if (!Number.isFinite(sample)) {
        continue;
      }
      sampledSum += sample;
      sampledCount += 1;
    }

    if (sampledCount === 0) {
      return 0;
    }
    return sampledSum / sampledCount;
  }
}
