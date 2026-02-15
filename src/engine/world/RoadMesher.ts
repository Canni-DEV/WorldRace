import type { TopologyEdge, TopologyPointMeters, TileRoadTopology } from './TopologyTypes';
import type { RoadMeshStats, RoadTileMeshPayload } from './RoadMeshTypes';

interface RoadMesherConfig {
  readonly roadHeightMeters: number;
  readonly laneWidthMeters: number;
  readonly minRoadWidthMeters: number;
  readonly maxRoadWidthMeters: number;
  readonly uvScale: number;
  readonly miterLimitMultiplier: number;
  readonly minPointDistanceMeters: number;
  readonly minMiterProjection: number;
  readonly minTriangleSignedAreaY: number;
  readonly junctionHeightOffsetMeters: number;
  readonly junctionAcuteAngleDegrees: number;
  readonly junctionMaxMiterFactor: number;
  readonly junctionSeamSnapMeters: number;
  readonly junctionMinPolygonArea: number;
  readonly junctionTurnPocketFactor: number;
}

interface StripBuildResult {
  readonly leftPoints: readonly TopologyPointMeters[];
  readonly rightPoints: readonly TopologyPointMeters[];
  readonly accumulatedLengths: readonly number[];
}

interface JunctionBranch {
  readonly nodeId: string;
  readonly nodePoint: TopologyPointMeters;
  readonly direction: TopologyPointMeters;
  readonly angleRad: number;
  readonly halfWidthMeters: number;
  readonly leftPoint: TopologyPointMeters;
  readonly rightPoint: TopologyPointMeters;
}

interface JunctionCornerResult {
  readonly point: TopologyPointMeters;
  readonly style: 'miter' | 'bevel' | 'fallback';
}

const defaultConfig: RoadMesherConfig = {
  roadHeightMeters: 0.02,
  laneWidthMeters: 3.25,
  minRoadWidthMeters: 3,
  maxRoadWidthMeters: 30,
  uvScale: 0.1,
  miterLimitMultiplier: 4,
  minPointDistanceMeters: 0.05,
  minMiterProjection: 0.2,
  minTriangleSignedAreaY: 1e-8,
  junctionHeightOffsetMeters: 0.002,
  junctionAcuteAngleDegrees: 35,
  junctionMaxMiterFactor: 3.5,
  junctionSeamSnapMeters: 0.25,
  junctionMinPolygonArea: 0.15,
  junctionTurnPocketFactor: 0.7,
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
      minPointDistanceMeters: config.minPointDistanceMeters ?? defaultConfig.minPointDistanceMeters,
      minMiterProjection: config.minMiterProjection ?? defaultConfig.minMiterProjection,
      minTriangleSignedAreaY:
        config.minTriangleSignedAreaY ?? defaultConfig.minTriangleSignedAreaY,
      junctionHeightOffsetMeters:
        config.junctionHeightOffsetMeters ?? defaultConfig.junctionHeightOffsetMeters,
      junctionAcuteAngleDegrees:
        config.junctionAcuteAngleDegrees ?? defaultConfig.junctionAcuteAngleDegrees,
      junctionMaxMiterFactor: config.junctionMaxMiterFactor ?? defaultConfig.junctionMaxMiterFactor,
      junctionSeamSnapMeters: config.junctionSeamSnapMeters ?? defaultConfig.junctionSeamSnapMeters,
      junctionMinPolygonArea: config.junctionMinPolygonArea ?? defaultConfig.junctionMinPolygonArea,
      junctionTurnPocketFactor:
        config.junctionTurnPocketFactor ?? defaultConfig.junctionTurnPocketFactor,
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
      junctionNodesConsidered: 0,
      junctionPolygonsBuilt: 0,
      junctionTriangles: 0,
      junctionMiterCorners: 0,
      junctionBevelCorners: 0,
      junctionFallbackCorners: 0,
      junctionTriangulationFailures: 0,
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

    const baseSurfaceTriangleCount = Math.floor(surfaceIndices.length / 3);
    this.appendJunctionMeshes(
      topology,
      surfacePositions,
      surfaceUvs,
      surfaceIndices,
      collisionPositions,
      collisionIndices,
      debugLinePositions,
      stats,
    );

    stats.triangleCount = Math.floor(surfaceIndices.length / 3);
    stats.collisionTriangleCount = Math.floor(collisionIndices.length / 3);
    stats.junctionTriangles = stats.triangleCount - baseSurfaceTriangleCount;
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
    const sanitizedCenterline = this.sanitizeCenterline(centerline);
    if (sanitizedCenterline.length < 2) {
      return null;
    }

    const halfWidth = widthMeters * 0.5;
    const leftPoints: TopologyPointMeters[] = [];
    const rightPoints: TopologyPointMeters[] = [];
    const accumulatedLengths: number[] = [0];

    for (let index = 0; index < sanitizedCenterline.length; index += 1) {
      const point = sanitizedCenterline[index];
      if (point === undefined) {
        return null;
      }

      if (index > 0) {
        const previousPoint = sanitizedCenterline[index - 1];
        if (previousPoint === undefined) {
          return null;
        }
        const distance = this.distance(point, previousPoint);
        accumulatedLengths.push((accumulatedLengths[accumulatedLengths.length - 1] ?? 0) + distance);
      }

      const previousPoint = index > 0 ? sanitizedCenterline[index - 1] : undefined;
      const nextPoint =
        index < sanitizedCenterline.length - 1 ? sanitizedCenterline[index + 1] : undefined;
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

    const fallbackOffset = {
      east: -forward.north * halfWidth,
      north: forward.east * halfWidth,
    };

    if (previous === undefined || next === undefined || isCollisionMode) {
      return fallbackOffset;
    }

    const prevDirection = this.safeDirection(previous, current);
    const nextDirection = this.safeDirection(current, next);
    if (prevDirection === null || nextDirection === null) {
      return fallbackOffset;
    }

    const normalPrev: TopologyPointMeters = { east: -prevDirection.north, north: prevDirection.east };
    const normalNext: TopologyPointMeters = { east: -nextDirection.north, north: nextDirection.east };
    const miter = this.normalize({
      east: normalPrev.east + normalNext.east,
      north: normalPrev.north + normalNext.north,
    });
    if (miter === null) {
      return fallbackOffset;
    }

    const projection = this.dot(miter, normalNext);
    if (projection <= this.config.minMiterProjection) {
      return fallbackOffset;
    }

    const miterLength = halfWidth / projection;
    const maxMiterLength = halfWidth * this.config.miterLimitMultiplier;
    if (!Number.isFinite(miterLength) || Math.abs(miterLength) > maxMiterLength) {
      return fallbackOffset;
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

      this.appendUpwardTriangle(positions, indices, leftCurrent, leftNext, rightCurrent);
      this.appendUpwardTriangle(positions, indices, rightCurrent, leftNext, rightNext);
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

      this.appendUpwardTriangle(positions, indices, leftCurrent, leftNext, rightCurrent);
      this.appendUpwardTriangle(positions, indices, rightCurrent, leftNext, rightNext);
    }
  }

  private appendJunctionMeshes(
    topology: TileRoadTopology,
    surfacePositions: number[],
    surfaceUvs: number[],
    surfaceIndices: number[],
    collisionPositions: number[],
    collisionIndices: number[],
    debugLinePositions: number[],
    stats: RoadMeshStats,
  ): void {
    const nodePointById = new Map<string, TopologyPointMeters>();
    for (const node of topology.nodes) {
      nodePointById.set(node.globalNodeId, { east: node.east, north: node.north });
    }

    const branchMap = new Map<string, JunctionBranch[]>();
    for (const edge of topology.edges) {
      const halfWidth = this.resolveRoadWidth(edge) * 0.5;
      this.appendBranchForEdgeEndpoint(edge, edge.fromNodeId, true, halfWidth, nodePointById, branchMap);
      this.appendBranchForEdgeEndpoint(edge, edge.toNodeId, false, halfWidth, nodePointById, branchMap);
    }

    for (const branches of branchMap.values()) {
      if (branches.length < 3) {
        continue;
      }

      stats.junctionNodesConsidered += 1;
      const sortedBranches = [...branches].sort((left, right) => left.angleRad - right.angleRad);
      const corners: TopologyPointMeters[] = [];

      for (let index = 0; index < sortedBranches.length; index += 1) {
        const branch = sortedBranches[index];
        const nextBranch = sortedBranches[(index + 1) % sortedBranches.length];
        if (branch === undefined || nextBranch === undefined) {
          continue;
        }

        const corner = this.computeJunctionCorner(branch, nextBranch);
        switch (corner.style) {
          case 'miter':
            stats.junctionMiterCorners += 1;
            break;
          case 'bevel':
            stats.junctionBevelCorners += 1;
            break;
          case 'fallback':
            stats.junctionFallbackCorners += 1;
            break;
        }
        corners.push(corner.point);
      }

      const polygon = this.cleanupJunctionPolygon(corners);
      if (polygon.length < 3) {
        stats.junctionTriangulationFailures += 1;
        continue;
      }

      const signedArea = this.computeSignedPolygonArea(polygon);
      if (Math.abs(signedArea) < this.config.junctionMinPolygonArea) {
        stats.junctionTriangulationFailures += 1;
        continue;
      }

      if (signedArea < 0) {
        polygon.reverse();
      }

      const surfaceTriangles = this.appendJunctionPolygonSurface(
        polygon,
        surfacePositions,
        surfaceUvs,
        surfaceIndices,
        this.config.roadHeightMeters + this.config.junctionHeightOffsetMeters,
      );
      if (surfaceTriangles <= 0) {
        stats.junctionTriangulationFailures += 1;
        continue;
      }

      this.appendJunctionPolygonCollision(
        polygon,
        collisionPositions,
        collisionIndices,
        this.config.roadHeightMeters,
      );
      this.appendClosedPolylineDebugLines(
        polygon,
        debugLinePositions,
        this.config.roadHeightMeters + this.config.junctionHeightOffsetMeters + 0.01,
      );
      stats.junctionPolygonsBuilt += 1;
    }
  }

  private appendBranchForEdgeEndpoint(
    edge: TopologyEdge,
    nodeId: string,
    atStart: boolean,
    halfWidthMeters: number,
    nodePointById: ReadonlyMap<string, TopologyPointMeters>,
    branchMap: Map<string, JunctionBranch[]>,
  ): void {
    const nodePoint = nodePointById.get(nodeId);
    if (nodePoint === undefined) {
      return;
    }

    const direction =
      this.extractDirectionFromPolyline(edge.visualPoints, nodePoint, atStart) ??
      this.extractDirectionFromPolyline(edge.canonicalPoints, nodePoint, atStart);
    if (direction === null) {
      return;
    }

    const normal = {
      east: -direction.north,
      north: direction.east,
    };
    const branch: JunctionBranch = {
      nodeId,
      nodePoint,
      direction,
      angleRad: Math.atan2(direction.north, direction.east),
      halfWidthMeters,
      leftPoint: {
        east: nodePoint.east + normal.east * halfWidthMeters,
        north: nodePoint.north + normal.north * halfWidthMeters,
      },
      rightPoint: {
        east: nodePoint.east - normal.east * halfWidthMeters,
        north: nodePoint.north - normal.north * halfWidthMeters,
      },
    };

    const existing = branchMap.get(nodeId);
    if (existing === undefined) {
      branchMap.set(nodeId, [branch]);
      return;
    }
    existing.push(branch);
  }

  private extractDirectionFromPolyline(
    polyline: readonly TopologyPointMeters[],
    nodePoint: TopologyPointMeters,
    atStart: boolean,
  ): TopologyPointMeters | null {
    const points = this.sanitizeCenterline(polyline);
    if (points.length < 2) {
      return null;
    }

    if (atStart) {
      for (let index = 1; index < points.length; index += 1) {
        const candidate = points[index];
        if (candidate === undefined) {
          continue;
        }
        const direction = this.safeDirection(nodePoint, candidate);
        if (direction !== null) {
          return direction;
        }
      }
      return null;
    }

    for (let index = points.length - 2; index >= 0; index -= 1) {
      const candidate = points[index];
      if (candidate === undefined) {
        continue;
      }
      const direction = this.safeDirection(nodePoint, candidate);
      if (direction !== null) {
        return direction;
      }
    }
    return null;
  }

  private computeJunctionCorner(
    branch: JunctionBranch,
    nextBranch: JunctionBranch,
  ): JunctionCornerResult {
    const gapAngle = this.normalizePositiveAngle(nextBranch.angleRad - branch.angleRad);
    const acuteThreshold = (this.config.junctionAcuteAngleDegrees * Math.PI) / 180;
    if (gapAngle <= acuteThreshold) {
      return {
        style: 'fallback',
        point: this.buildTurnPocketCorner(branch, nextBranch),
      };
    }

    const miter = this.intersectInfiniteLines(
      branch.leftPoint,
      branch.direction,
      nextBranch.rightPoint,
      nextBranch.direction,
    );

    if (miter !== null) {
      const maxMiterRadius =
        Math.max(branch.halfWidthMeters, nextBranch.halfWidthMeters) * this.config.junctionMaxMiterFactor;
      const distanceToNode = this.distance(branch.nodePoint, miter);
      if (distanceToNode <= maxMiterRadius && distanceToNode >= this.config.minPointDistanceMeters * 0.5) {
        return {
          style: 'miter',
          point: this.snapJunctionPoint(miter, branch.leftPoint, nextBranch.rightPoint),
        };
      }
    }

    return {
      style: 'bevel',
      point: this.snapJunctionPoint(this.midpoint(branch.leftPoint, nextBranch.rightPoint), branch.leftPoint, nextBranch.rightPoint),
    };
  }

  private buildTurnPocketCorner(branch: JunctionBranch, nextBranch: JunctionBranch): TopologyPointMeters {
    const midpoint = this.midpoint(branch.leftPoint, nextBranch.rightPoint);
    const outward =
      this.safeDirection(branch.nodePoint, midpoint) ??
      this.normalize({
        east: branch.direction.east + nextBranch.direction.east,
        north: branch.direction.north + nextBranch.direction.north,
      }) ??
      branch.direction;
    const pocketRadius =
      Math.min(branch.halfWidthMeters, nextBranch.halfWidthMeters) * this.config.junctionTurnPocketFactor;
    return this.snapJunctionPoint(
      {
        east: branch.nodePoint.east + outward.east * pocketRadius,
        north: branch.nodePoint.north + outward.north * pocketRadius,
      },
      branch.leftPoint,
      nextBranch.rightPoint,
    );
  }

  private snapJunctionPoint(
    point: TopologyPointMeters,
    firstBoundary: TopologyPointMeters,
    secondBoundary: TopologyPointMeters,
  ): TopologyPointMeters {
    if (this.distance(point, firstBoundary) <= this.config.junctionSeamSnapMeters) {
      return firstBoundary;
    }
    if (this.distance(point, secondBoundary) <= this.config.junctionSeamSnapMeters) {
      return secondBoundary;
    }
    return point;
  }

  private cleanupJunctionPolygon(
    points: readonly TopologyPointMeters[],
  ): TopologyPointMeters[] {
    const dedupeEpsilon = Math.max(this.config.minPointDistanceMeters * 0.5, 0.02);
    const cleaned: TopologyPointMeters[] = [];
    for (const point of points) {
      const previous = cleaned[cleaned.length - 1];
      if (previous === undefined || this.distance(previous, point) > dedupeEpsilon) {
        cleaned.push(point);
      }
    }

    if (cleaned.length >= 2) {
      const first = cleaned[0];
      const last = cleaned[cleaned.length - 1];
      if (first !== undefined && last !== undefined && this.distance(first, last) <= dedupeEpsilon) {
        cleaned.pop();
      }
    }
    return cleaned;
  }

  private computeSignedPolygonArea(points: readonly TopologyPointMeters[]): number {
    if (points.length < 3) {
      return 0;
    }

    let areaAccumulator = 0;
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      if (current === undefined || next === undefined) {
        continue;
      }
      areaAccumulator += current.east * next.north - next.east * current.north;
    }
    return areaAccumulator * 0.5;
  }

  private appendJunctionPolygonSurface(
    polygon: readonly TopologyPointMeters[],
    positions: number[],
    uvs: number[],
    indices: number[],
    heightMeters: number,
  ): number {
    const baseVertex = Math.floor(positions.length / 3);
    for (const point of polygon) {
      positions.push(point.east, heightMeters, point.north);
      uvs.push(point.east * this.config.uvScale, point.north * this.config.uvScale);
    }

    const indexCountBefore = indices.length;
    for (let index = 1; index < polygon.length - 1; index += 1) {
      this.appendUpwardTriangle(positions, indices, baseVertex, baseVertex + index, baseVertex + index + 1);
    }
    return Math.floor((indices.length - indexCountBefore) / 3);
  }

  private appendJunctionPolygonCollision(
    polygon: readonly TopologyPointMeters[],
    positions: number[],
    indices: number[],
    heightMeters: number,
  ): void {
    const baseVertex = Math.floor(positions.length / 3);
    for (const point of polygon) {
      positions.push(point.east, heightMeters, point.north);
    }

    for (let index = 1; index < polygon.length - 1; index += 1) {
      this.appendUpwardTriangle(positions, indices, baseVertex, baseVertex + index, baseVertex + index + 1);
    }
  }

  private appendClosedPolylineDebugLines(
    points: readonly TopologyPointMeters[],
    linePositions: number[],
    heightMeters: number,
  ): void {
    if (points.length < 2) {
      return;
    }

    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      const next = points[(index + 1) % points.length];
      if (current === undefined || next === undefined) {
        continue;
      }
      linePositions.push(
        current.east,
        heightMeters,
        current.north,
        next.east,
        heightMeters,
        next.north,
      );
    }
  }

  private sanitizeCenterline(
    centerline: readonly TopologyPointMeters[],
  ): readonly TopologyPointMeters[] {
    const sanitized: TopologyPointMeters[] = [];
    for (const point of centerline) {
      const previousPoint = sanitized[sanitized.length - 1];
      if (previousPoint === undefined) {
        sanitized.push(point);
        continue;
      }

      if (this.distance(previousPoint, point) >= this.config.minPointDistanceMeters) {
        sanitized.push(point);
      }
    }
    return sanitized;
  }

  private appendUpwardTriangle(
    positions: number[],
    indices: number[],
    indexA: number,
    indexB: number,
    indexC: number,
  ): void {
    const signedAreaY = this.computeTriangleSignedAreaY(positions, indexA, indexB, indexC);
    if (!Number.isFinite(signedAreaY) || Math.abs(signedAreaY) <= this.config.minTriangleSignedAreaY) {
      return;
    }

    if (signedAreaY < 0) {
      indices.push(indexA, indexC, indexB);
      return;
    }

    indices.push(indexA, indexB, indexC);
  }

  private computeTriangleSignedAreaY(
    positions: readonly number[],
    indexA: number,
    indexB: number,
    indexC: number,
  ): number {
    const aBase = indexA * 3;
    const bBase = indexB * 3;
    const cBase = indexC * 3;

    const ax = positions[aBase];
    const az = positions[aBase + 2];
    const bx = positions[bBase];
    const bz = positions[bBase + 2];
    const cx = positions[cBase];
    const cz = positions[cBase + 2];

    if (
      ax === undefined ||
      az === undefined ||
      bx === undefined ||
      bz === undefined ||
      cx === undefined ||
      cz === undefined
    ) {
      return 0;
    }

    const abX = bx - ax;
    const abZ = bz - az;
    const acX = cx - ax;
    const acZ = cz - az;
    return abZ * acX - abX * acZ;
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

  private normalizePositiveAngle(angleRad: number): number {
    const fullTurn = Math.PI * 2;
    const normalized = angleRad % fullTurn;
    return normalized < 0 ? normalized + fullTurn : normalized;
  }

  private intersectInfiniteLines(
    pointA: TopologyPointMeters,
    directionA: TopologyPointMeters,
    pointB: TopologyPointMeters,
    directionB: TopologyPointMeters,
  ): TopologyPointMeters | null {
    const denominator = this.cross(directionA, directionB);
    if (Math.abs(denominator) <= 1e-6) {
      return null;
    }

    const delta = {
      east: pointB.east - pointA.east,
      north: pointB.north - pointA.north,
    };
    const t = this.cross(delta, directionB) / denominator;
    return {
      east: pointA.east + directionA.east * t,
      north: pointA.north + directionA.north * t,
    };
  }

  private dot(pointA: TopologyPointMeters, pointB: TopologyPointMeters): number {
    return pointA.east * pointB.east + pointA.north * pointB.north;
  }

  private cross(pointA: TopologyPointMeters, pointB: TopologyPointMeters): number {
    return pointA.east * pointB.north - pointA.north * pointB.east;
  }

  private distance(pointA: TopologyPointMeters, pointB: TopologyPointMeters): number {
    return Math.hypot(pointB.east - pointA.east, pointB.north - pointA.north);
  }
}
