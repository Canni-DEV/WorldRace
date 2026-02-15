import type {
  BuildingFeature,
  BuildingPolygon,
  DecorationAreaKind,
  DecorationPointKind,
  PointMeters,
  RoadFeature,
  TileOSMData,
} from '../data/Types';
import type {
  DecorationKindInstancePayload,
  DecorationMeshStats,
  DecorationPropKind,
  DecorationTileMeshPayload,
} from './DecorationMeshTypes';

interface DecorationMesherConfig {
  readonly areaDensityPerSquareMeter: Readonly<Record<DecorationAreaKind, number>>;
  readonly areaMinSpacingMeters: Readonly<Record<DecorationAreaKind, number>>;
  readonly roadClearanceMetersByKind: Readonly<Record<DecorationPropKind, number>>;
  readonly maxAreaSamplesPerPolygon: number;
  readonly poissonAttemptsPerActivePoint: number;
}

interface PlacementPoint {
  readonly east: number;
  readonly north: number;
}

interface MutablePropInstance {
  readonly east: number;
  readonly north: number;
  readonly rotationY: number;
  readonly scale: number;
  readonly visibilityRank: number;
}

interface MutableBuildState {
  readonly tree: MutablePropInstance[];
  readonly lamp: MutablePropInstance[];
  readonly sign: MutablePropInstance[];
  readonly bench: MutablePropInstance[];
}

type RandomGenerator = () => number;

const defaultConfig: DecorationMesherConfig = {
  areaDensityPerSquareMeter: {
    forest: 0.0045,
    park: 0.002,
    scrub: 0.0028,
  },
  areaMinSpacingMeters: {
    forest: 5.2,
    park: 8,
    scrub: 6.4,
  },
  roadClearanceMetersByKind: {
    tree: 1.5,
    lamp: 0.6,
    sign: 0.9,
    bench: 1.1,
  },
  maxAreaSamplesPerPolygon: 280,
  poissonAttemptsPerActivePoint: 16,
};

const ROAD_WIDTH_FALLBACK_METERS: Readonly<Record<string, number>> = {
  motorway: 12,
  trunk: 10,
  primary: 9,
  secondary: 8,
  tertiary: 7,
  residential: 6,
  service: 5.5,
  living_street: 5,
  cycleway: 3,
  footway: 2.5,
  path: 2.2,
  unclassified: 6,
};

export class DecorationMesher {
  private readonly config: DecorationMesherConfig;

  public constructor(config: Partial<DecorationMesherConfig> = {}) {
    this.config = {
      areaDensityPerSquareMeter: config.areaDensityPerSquareMeter ?? defaultConfig.areaDensityPerSquareMeter,
      areaMinSpacingMeters: config.areaMinSpacingMeters ?? defaultConfig.areaMinSpacingMeters,
      roadClearanceMetersByKind: config.roadClearanceMetersByKind ?? defaultConfig.roadClearanceMetersByKind,
      maxAreaSamplesPerPolygon:
        config.maxAreaSamplesPerPolygon ?? defaultConfig.maxAreaSamplesPerPolygon,
      poissonAttemptsPerActivePoint:
        config.poissonAttemptsPerActivePoint ?? defaultConfig.poissonAttemptsPerActivePoint,
    };
  }

  public buildTileDecorationMesh(tileData: TileOSMData): DecorationTileMeshPayload {
    const mutableState: MutableBuildState = {
      tree: [],
      lamp: [],
      sign: [],
      bench: [],
    };
    const mutableStats = {
      sourcePointFeatures: tileData.decorationPoints.length,
      sourceAreaFeatures: tileData.decorationAreas.length,
      sampledAreaPoints: 0,
      rejectedByExclusion: 0,
    };

    for (const pointFeature of tileData.decorationPoints) {
      const pointSeed = this.hashString(
        `${tileData.tileKey}|point|${pointFeature.id}|${pointFeature.kind}`,
      );
      const random = this.createRandom(pointSeed);
      const accepted = this.tryPlacePoint(
        tileData,
        pointFeature.kind,
        pointFeature.point,
        random,
        mutableState,
      );
      if (!accepted) {
        mutableStats.rejectedByExclusion += 1;
      }
    }

    for (const areaFeature of tileData.decorationAreas) {
      const areaSeed = this.hashString(
        `${tileData.tileKey}|area|${areaFeature.id}|${areaFeature.kind}`,
      );
      const random = this.createRandom(areaSeed);
      for (const polygon of areaFeature.polygons) {
        const polygonSamples = this.samplePolygonPoisson(
          polygon,
          areaFeature.kind,
          random,
        );
        mutableStats.sampledAreaPoints += polygonSamples.length;
        for (const sample of polygonSamples) {
          const propKind = this.pickAreaPropKind(areaFeature.kind, random);
          const accepted = this.tryPlacePoint(tileData, propKind, sample, random, mutableState);
          if (!accepted) {
            mutableStats.rejectedByExclusion += 1;
          }
        }
      }
    }

    const instancesByKind = this.toInstancePayloads(tileData, mutableState);
    const treeCount = mutableState.tree.length;
    const lampCount = mutableState.lamp.length;
    const signCount = mutableState.sign.length;
    const benchCount = mutableState.bench.length;
    const totalInstances = treeCount + lampCount + signCount + benchCount;

    const stats: DecorationMeshStats = {
      sourcePointFeatures: mutableStats.sourcePointFeatures,
      sourceAreaFeatures: mutableStats.sourceAreaFeatures,
      sampledAreaPoints: mutableStats.sampledAreaPoints,
      rejectedByExclusion: mutableStats.rejectedByExclusion,
      totalInstances,
      treeCount,
      lampCount,
      signCount,
      benchCount,
    };

    return {
      tileKey: tileData.tileKey,
      tileCenter: {
        east: tileData.tileOriginGlobalMeters.east + tileData.tileSizeMeters * 0.5,
        north: tileData.tileOriginGlobalMeters.north + tileData.tileSizeMeters * 0.5,
      },
      instancesByKind,
      stats,
    };
  }

  private toInstancePayloads(
    tileData: TileOSMData,
    mutableState: MutableBuildState,
  ): DecorationKindInstancePayload[] {
    const originEast = tileData.tileOriginGlobalMeters.east;
    const originNorth = tileData.tileOriginGlobalMeters.north;
    const payloads: DecorationKindInstancePayload[] = [];
    const orderedKinds: DecorationPropKind[] = ['tree', 'lamp', 'sign', 'bench'];

    for (const kind of orderedKinds) {
      const sorted = [...mutableState[kind]].sort(
        (left, right) => left.visibilityRank - right.visibilityRank,
      );
      if (sorted.length === 0) {
        continue;
      }

      const transforms = new Float32Array(sorted.length * 4);
      for (let index = 0; index < sorted.length; index += 1) {
        const instance = sorted[index];
        if (instance === undefined) {
          continue;
        }

        const base = index * 4;
        transforms[base + 0] = originEast + instance.east;
        transforms[base + 1] = originNorth + instance.north;
        transforms[base + 2] = instance.rotationY;
        transforms[base + 3] = instance.scale;
      }

      payloads.push({
        kind,
        transforms,
      });
    }

    return payloads;
  }

  private tryPlacePoint(
    tileData: TileOSMData,
    kind: DecorationPointKind,
    point: PlacementPoint,
    random: RandomGenerator,
    mutableState: MutableBuildState,
  ): boolean {
    if (this.isInsideBuilding(point, tileData.buildings)) {
      return false;
    }

    if (this.intersectsRoadSurface(point, kind, tileData.roads)) {
      return false;
    }

    const instance = this.createInstance(kind, point, random);
    mutableState[kind].push(instance);
    return true;
  }

  private createInstance(
    kind: DecorationPropKind,
    point: PlacementPoint,
    random: RandomGenerator,
  ): MutablePropInstance {
    const scaleRange = this.getScaleRange(kind);
    return {
      east: point.east,
      north: point.north,
      rotationY: random() * Math.PI * 2,
      scale: scaleRange.min + (scaleRange.max - scaleRange.min) * random(),
      visibilityRank: random(),
    };
  }

  private getScaleRange(kind: DecorationPropKind): { readonly min: number; readonly max: number } {
    switch (kind) {
      case 'tree':
        return { min: 0.82, max: 1.45 };
      case 'lamp':
        return { min: 0.95, max: 1.12 };
      case 'sign':
        return { min: 0.9, max: 1.12 };
      case 'bench':
      default:
        return { min: 0.92, max: 1.2 };
    }
  }

  private samplePolygonPoisson(
    polygon: BuildingPolygon,
    areaKind: DecorationAreaKind,
    random: RandomGenerator,
  ): PlacementPoint[] {
    const outer = this.toOpenRing(polygon.outer);
    if (outer.length < 3) {
      return [];
    }

    const holes = polygon.holes.map((hole) => this.toOpenRing(hole)).filter((hole) => hole.length >= 3);
    const outerArea = Math.abs(this.computeRingSignedArea(outer));
    const holeArea = holes.reduce((sum, hole) => sum + Math.abs(this.computeRingSignedArea(hole)), 0);
    const area = Math.max(0, outerArea - holeArea);
    if (area <= 1) {
      return [];
    }

    const density = this.config.areaDensityPerSquareMeter[areaKind];
    const targetCount = Math.max(
      0,
      Math.min(this.config.maxAreaSamplesPerPolygon, Math.floor(area * density)),
    );
    if (targetCount === 0) {
      return [];
    }

    const minSpacing = Math.max(1, this.config.areaMinSpacingMeters[areaKind]);
    return this.poissonSamplePolygon({
      outer,
      holes,
      minSpacingMeters: minSpacing,
      targetCount,
      random,
    });
  }

  private poissonSamplePolygon(input: {
    readonly outer: readonly PlacementPoint[];
    readonly holes: readonly (readonly PlacementPoint[])[];
    readonly minSpacingMeters: number;
    readonly targetCount: number;
    readonly random: RandomGenerator;
  }): PlacementPoint[] {
    const bounds = this.computeBounds(input.outer);
    if (bounds === null) {
      return [];
    }

    const cellSize = input.minSpacingMeters / Math.SQRT2;
    const grid = new Map<string, PlacementPoint[]>();
    const points: PlacementPoint[] = [];
    const active: PlacementPoint[] = [];

    const firstPoint = this.pickInitialPoint(input.outer, input.holes, bounds, input.random);
    if (firstPoint === null) {
      return [];
    }

    points.push(firstPoint);
    active.push(firstPoint);
    this.insertPointIntoGrid(grid, firstPoint, cellSize);

    while (active.length > 0 && points.length < input.targetCount) {
      const activeIndex = Math.floor(input.random() * active.length);
      const center = active[activeIndex];
      if (center === undefined) {
        active.splice(activeIndex, 1);
        continue;
      }

      let acceptedCandidate = false;
      for (let attempt = 0; attempt < this.config.poissonAttemptsPerActivePoint; attempt += 1) {
        const radius = input.minSpacingMeters * (1 + input.random());
        const angle = input.random() * Math.PI * 2;
        const candidate: PlacementPoint = {
          east: center.east + Math.cos(angle) * radius,
          north: center.north + Math.sin(angle) * radius,
        };

        if (!this.pointInsideBounds(candidate, bounds)) {
          continue;
        }
        if (!this.isPointInsidePolygonWithHoles(candidate, input.outer, input.holes)) {
          continue;
        }
        if (!this.isFarEnoughFromNeighbors(candidate, grid, cellSize, input.minSpacingMeters)) {
          continue;
        }

        points.push(candidate);
        active.push(candidate);
        this.insertPointIntoGrid(grid, candidate, cellSize);
        acceptedCandidate = true;
        if (points.length >= input.targetCount) {
          break;
        }
      }

      if (!acceptedCandidate) {
        active.splice(activeIndex, 1);
      }
    }

    return points;
  }

  private pickInitialPoint(
    outer: readonly PlacementPoint[],
    holes: readonly (readonly PlacementPoint[])[],
    bounds: {
      readonly minEast: number;
      readonly maxEast: number;
      readonly minNorth: number;
      readonly maxNorth: number;
    },
    random: RandomGenerator,
  ): PlacementPoint | null {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate: PlacementPoint = {
        east: bounds.minEast + (bounds.maxEast - bounds.minEast) * random(),
        north: bounds.minNorth + (bounds.maxNorth - bounds.minNorth) * random(),
      };
      if (this.isPointInsidePolygonWithHoles(candidate, outer, holes)) {
        return candidate;
      }
    }
    return null;
  }

  private insertPointIntoGrid(grid: Map<string, PlacementPoint[]>, point: PlacementPoint, cellSize: number): void {
    const key = this.getGridKey(point, cellSize);
    const cell = grid.get(key);
    if (cell === undefined) {
      grid.set(key, [point]);
      return;
    }
    cell.push(point);
  }

  private isFarEnoughFromNeighbors(
    candidate: PlacementPoint,
    grid: Map<string, PlacementPoint[]>,
    cellSize: number,
    minSpacingMeters: number,
  ): boolean {
    const cellX = Math.floor(candidate.east / cellSize);
    const cellY = Math.floor(candidate.north / cellSize);
    const minDistanceSq = minSpacingMeters * minSpacingMeters;

    for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
      for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
        const neighborKey = `${cellX + offsetX}:${cellY + offsetY}`;
        const neighborPoints = grid.get(neighborKey);
        if (neighborPoints === undefined) {
          continue;
        }

        for (const neighbor of neighborPoints) {
          const deltaEast = candidate.east - neighbor.east;
          const deltaNorth = candidate.north - neighbor.north;
          const distanceSq = deltaEast * deltaEast + deltaNorth * deltaNorth;
          if (distanceSq < minDistanceSq) {
            return false;
          }
        }
      }
    }

    return true;
  }

  private getGridKey(point: PlacementPoint, cellSize: number): string {
    const cellX = Math.floor(point.east / cellSize);
    const cellY = Math.floor(point.north / cellSize);
    return `${cellX}:${cellY}`;
  }

  private pointInsideBounds(
    point: PlacementPoint,
    bounds: {
      readonly minEast: number;
      readonly maxEast: number;
      readonly minNorth: number;
      readonly maxNorth: number;
    },
  ): boolean {
    return (
      point.east >= bounds.minEast &&
      point.east <= bounds.maxEast &&
      point.north >= bounds.minNorth &&
      point.north <= bounds.maxNorth
    );
  }

  private pickAreaPropKind(areaKind: DecorationAreaKind, random: RandomGenerator): DecorationPropKind {
    const value = random();
    if (areaKind === 'forest') {
      if (value < 0.9) {
        return 'tree';
      }
      if (value < 0.965) {
        return 'sign';
      }
      return 'bench';
    }

    if (areaKind === 'park') {
      if (value < 0.56) {
        return 'tree';
      }
      if (value < 0.73) {
        return 'bench';
      }
      if (value < 0.88) {
        return 'lamp';
      }
      return 'sign';
    }

    if (value < 0.82) {
      return 'tree';
    }
    return 'sign';
  }

  private intersectsRoadSurface(
    point: PlacementPoint,
    kind: DecorationPropKind,
    roads: readonly RoadFeature[],
  ): boolean {
    const clearanceMeters = this.config.roadClearanceMetersByKind[kind];
    for (const road of roads) {
      const halfWidth = this.resolveRoadHalfWidthMeters(road);
      const threshold = halfWidth + clearanceMeters;
      const thresholdSq = threshold * threshold;
      const points = road.points;
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        if (start === undefined || end === undefined) {
          continue;
        }
        const distanceSq = this.distanceSqPointToSegment(point, start, end);
        if (distanceSq <= thresholdSq) {
          return true;
        }
      }
    }
    return false;
  }

  private resolveRoadHalfWidthMeters(road: RoadFeature): number {
    const widthTag = road.properties.widthMeters;
    if (widthTag !== null && Number.isFinite(widthTag) && widthTag > 0) {
      return widthTag * 0.5;
    }

    const lanes = road.properties.lanes;
    if (lanes !== null && lanes > 0) {
      return lanes * 1.6;
    }

    return (ROAD_WIDTH_FALLBACK_METERS[road.properties.highway] ?? 6) * 0.5;
  }

  private distanceSqPointToSegment(point: PlacementPoint, start: PointMeters, end: PointMeters): number {
    const segmentEast = end.east - start.east;
    const segmentNorth = end.north - start.north;
    const segmentLengthSq = segmentEast * segmentEast + segmentNorth * segmentNorth;
    if (segmentLengthSq <= Number.EPSILON) {
      const deltaEast = point.east - start.east;
      const deltaNorth = point.north - start.north;
      return deltaEast * deltaEast + deltaNorth * deltaNorth;
    }

    const projected =
      ((point.east - start.east) * segmentEast + (point.north - start.north) * segmentNorth) /
      segmentLengthSq;
    const t = Math.max(0, Math.min(1, projected));
    const nearestEast = start.east + segmentEast * t;
    const nearestNorth = start.north + segmentNorth * t;
    const deltaEast = point.east - nearestEast;
    const deltaNorth = point.north - nearestNorth;
    return deltaEast * deltaEast + deltaNorth * deltaNorth;
  }

  private isInsideBuilding(point: PlacementPoint, buildings: readonly BuildingFeature[]): boolean {
    for (const building of buildings) {
      for (const polygon of building.polygons) {
        if (!this.isPointInsidePolygonWithHoles(point, this.toOpenRing(polygon.outer), polygon.holes.map((hole) => this.toOpenRing(hole)))) {
          continue;
        }
        return true;
      }
    }
    return false;
  }

  private isPointInsidePolygonWithHoles(
    point: PlacementPoint,
    outerRing: readonly PlacementPoint[],
    holes: readonly (readonly PlacementPoint[])[],
  ): boolean {
    if (!this.pointInRing(point, outerRing)) {
      return false;
    }

    for (const hole of holes) {
      if (this.pointInRing(point, hole)) {
        return false;
      }
    }

    return true;
  }

  private pointInRing(point: PlacementPoint, ring: readonly PlacementPoint[]): boolean {
    if (ring.length < 3) {
      return false;
    }

    let inside = false;
    const pointCount = ring.length;
    for (let index = 0, prev = pointCount - 1; index < pointCount; prev = index, index += 1) {
      const current = ring[index];
      const previous = ring[prev];
      if (current === undefined || previous === undefined) {
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
    }

    return inside;
  }

  private toOpenRing(ring: readonly PointMeters[]): PlacementPoint[] {
    if (ring.length < 3) {
      return [];
    }

    const points = ring.map((point) => ({
      east: point.east,
      north: point.north,
    }));
    const first = points[0];
    const last = points[points.length - 1];
    if (first?.east === last?.east && first?.north === last?.north) {
      points.pop();
    }
    return points.length >= 3 ? points : [];
  }

  private computeRingSignedArea(ring: readonly PlacementPoint[]): number {
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

  private computeBounds(
    ring: readonly PlacementPoint[],
  ): { readonly minEast: number; readonly maxEast: number; readonly minNorth: number; readonly maxNorth: number } | null {
    if (ring.length === 0) {
      return null;
    }

    let minEast = Number.POSITIVE_INFINITY;
    let maxEast = Number.NEGATIVE_INFINITY;
    let minNorth = Number.POSITIVE_INFINITY;
    let maxNorth = Number.NEGATIVE_INFINITY;
    for (const point of ring) {
      minEast = Math.min(minEast, point.east);
      maxEast = Math.max(maxEast, point.east);
      minNorth = Math.min(minNorth, point.north);
      maxNorth = Math.max(maxNorth, point.north);
    }

    return {
      minEast,
      maxEast,
      minNorth,
      maxNorth,
    };
  }

  private hashString(input: string): number {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private createRandom(seed: number): RandomGenerator {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
      mixed = mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }
}
