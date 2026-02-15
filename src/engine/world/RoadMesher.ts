import type { TopologyEdge, TopologyPointMeters, TileRoadTopology } from './TopologyTypes';
import type { RoadMeshStats, RoadTileMeshPayload } from './RoadMeshTypes';

interface RoadMesherConfig {
  readonly roadHeightMeters: number;
  readonly laneWidthMeters: number;
  readonly minRoadWidthMeters: number;
  readonly maxRoadWidthMeters: number;
  readonly uvScale: number;
  readonly miterLimitMultiplier: number;
}

interface StripBuildResult {
  readonly leftPoints: readonly TopologyPointMeters[];
  readonly rightPoints: readonly TopologyPointMeters[];
  readonly accumulatedLengths: readonly number[];
}

const defaultConfig: RoadMesherConfig = {
  roadHeightMeters: 0.02,
  laneWidthMeters: 3.25,
  minRoadWidthMeters: 3,
  maxRoadWidthMeters: 30,
  uvScale: 0.1,
  miterLimitMultiplier: 4,
};

export class RoadMesher {
  private readonly config: RoadMesherConfig;

  public constructor(config: Partial<RoadMesherConfig> = {}) {
    this.config = {
      roadHeightMeters: config.roadHeightMeters ?? defaultConfig.roadHeightMeters,
      laneWidthMeters: config.laneWidthMeters ?? defaultConfig.laneWidthMeters,
      minRoadWidthMeters: config.minRoadWidthMeters ?? defaultConfig.minRoadWidthMeters,
      maxRoadWidthMeters: config.maxRoadWidthMeters ?? defaultConfig.maxRoadWidthMeters,
      uvScale: config.uvScale ?? defaultConfig.uvScale,
      miterLimitMultiplier: config.miterLimitMultiplier ?? defaultConfig.miterLimitMultiplier,
    };
  }

  public buildTileRoadMesh(topology: TileRoadTopology): RoadTileMeshPayload {
    const surfacePositions: number[] = [];
    const surfaceUvs: number[] = [];
    const surfaceIndices: number[] = [];
    const collisionPositions: number[] = [];
    const collisionIndices: number[] = [];
    const debugLinePositions: number[] = [];
    const stats: RoadMeshStats = {
      edgeCountMeshed: 0,
      droppedEdges: 0,
      triangleCount: 0,
      collisionTriangleCount: 0,
      minResolvedWidthMeters: Number.POSITIVE_INFINITY,
      maxResolvedWidthMeters: 0,
    };

    for (const edge of topology.edges) {
      const resolvedWidth = this.resolveRoadWidth(edge);
      const visualStrip = this.buildOffsetStrip(edge.visualPoints, resolvedWidth, false);
      const collisionStrip = this.buildOffsetStrip(edge.canonicalPoints, resolvedWidth, true);

      if (visualStrip === null || collisionStrip === null) {
        stats.droppedEdges += 1;
        continue;
      }

      stats.edgeCountMeshed += 1;
      stats.minResolvedWidthMeters = Math.min(stats.minResolvedWidthMeters, resolvedWidth);
      stats.maxResolvedWidthMeters = Math.max(stats.maxResolvedWidthMeters, resolvedWidth);

      this.appendRibbonSurface(
        visualStrip,
        surfacePositions,
        surfaceUvs,
        surfaceIndices,
        this.config.roadHeightMeters,
      );
      this.appendRibbonCollision(
        collisionStrip,
        collisionPositions,
        collisionIndices,
        this.config.roadHeightMeters,
      );
      this.appendRibbonDebugLines(visualStrip, debugLinePositions, this.config.roadHeightMeters + 0.01);
    }

    stats.triangleCount = Math.floor(surfaceIndices.length / 3);
    stats.collisionTriangleCount = Math.floor(collisionIndices.length / 3);
    if (!Number.isFinite(stats.minResolvedWidthMeters)) {
      stats.minResolvedWidthMeters = 0;
    }

    return {
      tileKey: topology.tileKey,
      surfacePositions: new Float32Array(surfacePositions),
      surfaceUvs: new Float32Array(surfaceUvs),
      surfaceIndices: new Uint32Array(surfaceIndices),
      collisionPositions: new Float32Array(collisionPositions),
      collisionIndices: new Uint32Array(collisionIndices),
      debugLinePositions: new Float32Array(debugLinePositions),
      stats,
    };
  }

  private resolveRoadWidth(edge: TopologyEdge): number {
    const widthTag = edge.properties.widthMeters;
    if (widthTag !== null && Number.isFinite(widthTag)) {
      return this.clampWidth(widthTag);
    }

    const lanes = edge.properties.lanes;
    if (lanes !== null && lanes > 0) {
      return this.clampWidth(lanes * this.config.laneWidthMeters);
    }

    return this.clampWidth(this.getHighwayDefaultWidth(edge.properties.highway));
  }

  private clampWidth(widthMeters: number): number {
    return Math.max(this.config.minRoadWidthMeters, Math.min(this.config.maxRoadWidthMeters, widthMeters));
  }

  private getHighwayDefaultWidth(highway: string): number {
    switch (highway) {
      case 'motorway':
      case 'motorway_link':
        return 12;
      case 'trunk':
      case 'trunk_link':
      case 'primary':
      case 'primary_link':
        return 9;
      case 'secondary':
      case 'secondary_link':
      case 'tertiary':
      case 'tertiary_link':
        return 7;
      case 'residential':
      case 'unclassified':
      case 'road':
      default:
        return 6;
    }
  }

  private buildOffsetStrip(
    centerline: readonly TopologyPointMeters[],
    widthMeters: number,
    isCollisionMode: boolean,
  ): StripBuildResult | null {
    if (centerline.length < 2) {
      return null;
    }

    const halfWidth = widthMeters * 0.5;
    const leftPoints: TopologyPointMeters[] = [];
    const rightPoints: TopologyPointMeters[] = [];
    const accumulatedLengths: number[] = [0];

    for (let index = 0; index < centerline.length; index += 1) {
      const point = centerline[index];
      if (point === undefined) {
        return null;
      }

      if (index > 0) {
        const previousPoint = centerline[index - 1];
        if (previousPoint === undefined) {
          return null;
        }
        const distance = this.distance(point, previousPoint);
        accumulatedLengths.push((accumulatedLengths[accumulatedLengths.length - 1] ?? 0) + distance);
      }

      const previousPoint = index > 0 ? centerline[index - 1] : undefined;
      const nextPoint = index < centerline.length - 1 ? centerline[index + 1] : undefined;
      const offset = this.computeOffsetVector(point, previousPoint, nextPoint, halfWidth, isCollisionMode);
      if (offset === null) {
        return null;
      }

      leftPoints.push({
        east: point.east + offset.east,
        north: point.north + offset.north,
      });
      rightPoints.push({
        east: point.east - offset.east,
        north: point.north - offset.north,
      });
    }

    return {
      leftPoints,
      rightPoints,
      accumulatedLengths,
    };
  }

  private computeOffsetVector(
    current: TopologyPointMeters,
    previous: TopologyPointMeters | undefined,
    next: TopologyPointMeters | undefined,
    halfWidth: number,
    isCollisionMode: boolean,
  ): TopologyPointMeters | null {
    const forward = this.safeDirection(previous ?? current, next ?? current);
    if (forward === null) {
      return null;
    }

    if (previous === undefined || next === undefined || isCollisionMode) {
      return {
        east: -forward.north * halfWidth,
        north: forward.east * halfWidth,
      };
    }

    const prevDirection = this.safeDirection(previous, current);
    const nextDirection = this.safeDirection(current, next);
    if (prevDirection === null || nextDirection === null) {
      return {
        east: -forward.north * halfWidth,
        north: forward.east * halfWidth,
      };
    }

    const normalPrev: TopologyPointMeters = { east: -prevDirection.north, north: prevDirection.east };
    const normalNext: TopologyPointMeters = { east: -nextDirection.north, north: nextDirection.east };
    const miter = this.normalize({
      east: normalPrev.east + normalNext.east,
      north: normalPrev.north + normalNext.north,
    });
    if (miter === null) {
      return {
        east: normalNext.east * halfWidth,
        north: normalNext.north * halfWidth,
      };
    }

    const projection = this.dot(miter, normalNext);
    if (Math.abs(projection) < 0.2) {
      return {
        east: normalNext.east * halfWidth,
        north: normalNext.north * halfWidth,
      };
    }

    const miterLength = halfWidth / projection;
    const maxMiterLength = halfWidth * this.config.miterLimitMultiplier;
    if (Math.abs(miterLength) > maxMiterLength) {
      return {
        east: normalNext.east * halfWidth,
        north: normalNext.north * halfWidth,
      };
    }

    return {
      east: miter.east * miterLength,
      north: miter.north * miterLength,
    };
  }

  private appendRibbonSurface(
    strip: StripBuildResult,
    positions: number[],
    uvs: number[],
    indices: number[],
    heightMeters: number,
  ): void {
    const baseVertex = Math.floor(positions.length / 3);
    const pointCount = strip.leftPoints.length;

    for (let index = 0; index < pointCount; index += 1) {
      const left = strip.leftPoints[index];
      const right = strip.rightPoints[index];
      const length = strip.accumulatedLengths[index] ?? 0;
      if (left === undefined || right === undefined) {
        continue;
      }

      positions.push(left.east, heightMeters, left.north, right.east, heightMeters, right.north);
      const u = length * this.config.uvScale;
      uvs.push(u, 0, u, 1);
    }

    for (let index = 0; index < pointCount - 1; index += 1) {
      const leftCurrent = baseVertex + index * 2;
      const rightCurrent = leftCurrent + 1;
      const leftNext = baseVertex + (index + 1) * 2;
      const rightNext = leftNext + 1;

      indices.push(leftCurrent, leftNext, rightCurrent);
      indices.push(rightCurrent, leftNext, rightNext);
    }
  }

  private appendRibbonCollision(
    strip: StripBuildResult,
    positions: number[],
    indices: number[],
    heightMeters: number,
  ): void {
    const baseVertex = Math.floor(positions.length / 3);
    const pointCount = strip.leftPoints.length;

    for (let index = 0; index < pointCount; index += 1) {
      const left = strip.leftPoints[index];
      const right = strip.rightPoints[index];
      if (left === undefined || right === undefined) {
        continue;
      }
      positions.push(left.east, heightMeters, left.north, right.east, heightMeters, right.north);
    }

    for (let index = 0; index < pointCount - 1; index += 1) {
      const leftCurrent = baseVertex + index * 2;
      const rightCurrent = leftCurrent + 1;
      const leftNext = baseVertex + (index + 1) * 2;
      const rightNext = leftNext + 1;

      indices.push(leftCurrent, leftNext, rightCurrent);
      indices.push(rightCurrent, leftNext, rightNext);
    }
  }

  private appendRibbonDebugLines(
    strip: StripBuildResult,
    linePositions: number[],
    heightMeters: number,
  ): void {
    for (let index = 0; index < strip.leftPoints.length - 1; index += 1) {
      const leftCurrent = strip.leftPoints[index];
      const leftNext = strip.leftPoints[index + 1];
      const rightCurrent = strip.rightPoints[index];
      const rightNext = strip.rightPoints[index + 1];
      if (
        leftCurrent === undefined ||
        leftNext === undefined ||
        rightCurrent === undefined ||
        rightNext === undefined
      ) {
        continue;
      }

      const centerCurrent = this.midpoint(leftCurrent, rightCurrent);
      const centerNext = this.midpoint(leftNext, rightNext);

      linePositions.push(
        centerCurrent.east,
        heightMeters,
        centerCurrent.north,
        centerNext.east,
        heightMeters,
        centerNext.north,
      );
      linePositions.push(
        leftCurrent.east,
        heightMeters,
        leftCurrent.north,
        leftNext.east,
        heightMeters,
        leftNext.north,
      );
      linePositions.push(
        rightCurrent.east,
        heightMeters,
        rightCurrent.north,
        rightNext.east,
        heightMeters,
        rightNext.north,
      );
    }
  }

  private midpoint(pointA: TopologyPointMeters, pointB: TopologyPointMeters): TopologyPointMeters {
    return {
      east: (pointA.east + pointB.east) * 0.5,
      north: (pointA.north + pointB.north) * 0.5,
    };
  }

  private safeDirection(from: TopologyPointMeters, to: TopologyPointMeters): TopologyPointMeters | null {
    const deltaEast = to.east - from.east;
    const deltaNorth = to.north - from.north;
    const length = Math.hypot(deltaEast, deltaNorth);
    if (length <= 1e-6) {
      return null;
    }
    return {
      east: deltaEast / length,
      north: deltaNorth / length,
    };
  }

  private normalize(vector: TopologyPointMeters): TopologyPointMeters | null {
    const length = Math.hypot(vector.east, vector.north);
    if (length <= 1e-6) {
      return null;
    }
    return {
      east: vector.east / length,
      north: vector.north / length,
    };
  }

  private dot(pointA: TopologyPointMeters, pointB: TopologyPointMeters): number {
    return pointA.east * pointB.east + pointA.north * pointB.north;
  }

  private distance(pointA: TopologyPointMeters, pointB: TopologyPointMeters): number {
    return Math.hypot(pointB.east - pointA.east, pointB.north - pointA.north);
  }
}
