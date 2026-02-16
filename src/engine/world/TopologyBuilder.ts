import type {
  RoadFeature,
  RoadProperties,
  RouteWeightingProfile,
} from '../data/Types';
import type {
  TileRoadTopologyLocal,
  TopologyBuildInput,
  TopologyEdgeLocal,
  TopologyEdgeRouting,
  TopologyNodeLocal,
  TopologyPointMeters,
} from './TopologyTypes';

interface TopologyBuilderConfig {
  readonly nodeMergeToleranceMeters: number;
  readonly minSegmentLengthMeters: number;
  readonly smoothingEnabled: boolean;
  readonly smoothingIterations: number;
  readonly intersectionCellSizeMeters: number;
  readonly intersectionEpsilon: number;
  readonly routeWeightingProfile: RouteWeightingProfile;
}

interface MutableBuildStats {
  inputRoads: number;
  droppedDegenerateRoads: number;
  droppedZeroLengthSegments: number;
  duplicateEdgesDropped: number;
  intersectionSplits: number;
  selfIntersectionRepairs: number;
}

interface RoadPolyline {
  readonly roadId: string;
  readonly properties: RoadProperties;
  readonly points: readonly TopologyPointMeters[];
}

interface SegmentRef {
  readonly roadIndex: number;
  readonly segmentIndex: number;
  readonly start: TopologyPointMeters;
  readonly end: TopologyPointMeters;
}

const defaultConfig: TopologyBuilderConfig = {
  nodeMergeToleranceMeters: 0.75,
  minSegmentLengthMeters: 0.5,
  smoothingEnabled: true,
  smoothingIterations: 1,
  intersectionCellSizeMeters: 32,
  intersectionEpsilon: 1e-5,
  routeWeightingProfile: {
    excludedCategories: ['service'],
    categoryWeightByKind: {
      street: 1,
      avenue: 0.95,
      route: 0.9,
      highway: 0.88,
      service: 1.25,
      path: 1.35,
      other: 1.1,
    },
    pavementWeightByKind: {
      paved: 0.95,
      unpaved: 1.3,
      unknown: 1,
    },
    minWeightMultiplier: 0.5,
    maxWeightMultiplier: 4,
  },
};

export class TopologyBuilder {
  private readonly config: TopologyBuilderConfig;

  public constructor(config: Partial<TopologyBuilderConfig> = {}) {
    this.config = {
      nodeMergeToleranceMeters: config.nodeMergeToleranceMeters ?? defaultConfig.nodeMergeToleranceMeters,
      minSegmentLengthMeters: config.minSegmentLengthMeters ?? defaultConfig.minSegmentLengthMeters,
      smoothingEnabled: config.smoothingEnabled ?? defaultConfig.smoothingEnabled,
      smoothingIterations: config.smoothingIterations ?? defaultConfig.smoothingIterations,
      intersectionCellSizeMeters: config.intersectionCellSizeMeters ?? defaultConfig.intersectionCellSizeMeters,
      intersectionEpsilon: config.intersectionEpsilon ?? defaultConfig.intersectionEpsilon,
      routeWeightingProfile: config.routeWeightingProfile ?? defaultConfig.routeWeightingProfile,
    };
  }

  public build(input: TopologyBuildInput): TileRoadTopologyLocal {
    const mutableStats: MutableBuildStats = {
      inputRoads: input.tileData.roads.length,
      droppedDegenerateRoads: 0,
      droppedZeroLengthSegments: 0,
      duplicateEdgesDropped: 0,
      intersectionSplits: 0,
      selfIntersectionRepairs: 0,
    };

    const normalizedRoads = this.normalizeRoads(input.tileData.roads, input.tileData.tileOriginGlobalMeters, mutableStats);
    const roadsWithIntersections = this.insertIntersectionVertices(normalizedRoads, mutableStats);
    return this.buildGraph(input.tileData.tileKey, roadsWithIntersections, mutableStats);
  }

  private normalizeRoads(
    roads: readonly RoadFeature[],
    tileOrigin: { readonly east: number; readonly north: number },
    stats: MutableBuildStats,
  ): RoadPolyline[] {
    const normalized: RoadPolyline[] = [];
    for (const road of roads) {
      const globalPoints: TopologyPointMeters[] = road.points.map((point) => ({
        east: point.east + tileOrigin.east,
        north: point.north + tileOrigin.north,
      }));
      const cleaned = this.removeConsecutiveNearDuplicates(globalPoints, this.config.nodeMergeToleranceMeters * 0.25);
      if (cleaned.length < 2) {
        stats.droppedDegenerateRoads += 1;
        continue;
      }

      normalized.push({
        roadId: road.id,
        properties: road.properties,
        points: cleaned,
      });
    }
    return normalized;
  }

  private insertIntersectionVertices(roads: readonly RoadPolyline[], stats: MutableBuildStats): RoadPolyline[] {
    const splitMarkers = new Map<string, Set<number>>();
    const segments: SegmentRef[] = [];

    roads.forEach((road, roadIndex) => {
      for (let segmentIndex = 0; segmentIndex < road.points.length - 1; segmentIndex += 1) {
        const startPoint = road.points[segmentIndex];
        const endPoint = road.points[segmentIndex + 1];
        if (startPoint === undefined || endPoint === undefined) {
          continue;
        }
        segments.push({
          roadIndex,
          segmentIndex,
          start: startPoint,
          end: endPoint,
        });
      }
    });

    const spatialBuckets = this.bucketizeSegments(segments);
    const visitedPairs = new Set<string>();

    for (const bucketSegments of spatialBuckets.values()) {
      for (let index = 0; index < bucketSegments.length; index += 1) {
        const segmentA = bucketSegments[index];
        if (segmentA === undefined) {
          continue;
        }

        for (let nextIndex = index + 1; nextIndex < bucketSegments.length; nextIndex += 1) {
          const segmentB = bucketSegments[nextIndex];
          if (segmentB === undefined) {
            continue;
          }

          const pairKey = segmentA < segmentB ? `${segmentA}|${segmentB}` : `${segmentB}|${segmentA}`;
          if (visitedPairs.has(pairKey)) {
            continue;
          }
          visitedPairs.add(pairKey);

          const refA = segments[segmentA];
          const refB = segments[segmentB];
          if (refA === undefined || refB === undefined) {
            continue;
          }

          if (refA.roadIndex === refB.roadIndex && Math.abs(refA.segmentIndex - refB.segmentIndex) <= 1) {
            continue;
          }

          const intersection = this.intersectSegments(refA.start, refA.end, refB.start, refB.end);
          if (intersection === null) {
            continue;
          }

          const insertedA = this.addSplitMarker(splitMarkers, refA.roadIndex, refA.segmentIndex, intersection.tA);
          const insertedB = this.addSplitMarker(splitMarkers, refB.roadIndex, refB.segmentIndex, intersection.tB);

          if (insertedA || insertedB) {
            if (refA.roadIndex === refB.roadIndex) {
              stats.selfIntersectionRepairs += 1;
            } else {
              stats.intersectionSplits += 1;
            }
          }
        }
      }
    }

    return roads.map((road, roadIndex) => {
      const expandedPoints: TopologyPointMeters[] = [];

      for (let segmentIndex = 0; segmentIndex < road.points.length - 1; segmentIndex += 1) {
        const startPoint = road.points[segmentIndex];
        const endPoint = road.points[segmentIndex + 1];
        if (startPoint === undefined || endPoint === undefined) {
          continue;
        }

        const markerSet = splitMarkers.get(this.getMarkerKey(roadIndex, segmentIndex));
        const markerList = markerSet === undefined ? [0, 1] : [...markerSet];
        markerList.sort((left, right) => left - right);

        if (segmentIndex === 0) {
          expandedPoints.push(startPoint);
        }

        for (const marker of markerList) {
          if (marker <= this.config.intersectionEpsilon) {
            continue;
          }

          const nextPoint = this.interpolatePoint(startPoint, endPoint, marker);
          expandedPoints.push(nextPoint);
        }
      }

      return {
        roadId: road.roadId,
        properties: road.properties,
        points: this.removeConsecutiveNearDuplicates(expandedPoints, this.config.nodeMergeToleranceMeters * 0.25),
      };
    });
  }

  private buildGraph(
    tileKey: string,
    roads: readonly RoadPolyline[],
    stats: MutableBuildStats,
  ): TileRoadTopologyLocal {
    const nodeKeyOccurrences = this.buildNodeOccurrences(roads);
    const nodesByKey = new Map<string, TopologyNodeLocal>();
    const edges: TopologyEdgeLocal[] = [];
    const edgeDedup = new Set<string>();
    let edgeCounter = 0;

    for (const road of roads) {
      if (road.points.length < 2) {
        stats.droppedDegenerateRoads += 1;
        continue;
      }

      const splitIndices: number[] = [0];
      for (let index = 1; index < road.points.length - 1; index += 1) {
        const point = road.points[index];
        if (point === undefined) {
          continue;
        }
        const key = this.quantizePoint(point);
        if ((nodeKeyOccurrences.get(key) ?? 0) > 1) {
          splitIndices.push(index);
        }
      }
      splitIndices.push(road.points.length - 1);

      for (let splitIndex = 0; splitIndex < splitIndices.length - 1; splitIndex += 1) {
        const fromIndex = splitIndices[splitIndex];
        const toIndex = splitIndices[splitIndex + 1];
        if (fromIndex === undefined || toIndex === undefined) {
          continue;
        }

        if (toIndex <= fromIndex) {
          continue;
        }

        const canonicalPoints = road.points.slice(fromIndex, toIndex + 1);
        const lengthMeters = this.computePolylineLength(canonicalPoints);
        if (lengthMeters < this.config.minSegmentLengthMeters) {
          stats.droppedZeroLengthSegments += 1;
          continue;
        }

        const fromPoint = canonicalPoints[0];
        const toPoint = canonicalPoints[canonicalPoints.length - 1];
        if (fromPoint === undefined || toPoint === undefined) {
          stats.droppedDegenerateRoads += 1;
          continue;
        }

        const fromNodeKey = this.quantizePoint(fromPoint);
        const toNodeKey = this.quantizePoint(toPoint);
        if (fromNodeKey === toNodeKey) {
          stats.droppedZeroLengthSegments += 1;
          continue;
        }

        const dedupKey = this.buildEdgeDedupKey(canonicalPoints, road.properties.highway);
        if (edgeDedup.has(dedupKey)) {
          stats.duplicateEdgesDropped += 1;
          continue;
        }
        edgeDedup.add(dedupKey);

        this.upsertNode(nodesByKey, fromNodeKey, fromPoint);
        this.upsertNode(nodesByKey, toNodeKey, toPoint);

        const visualPoints = this.config.smoothingEnabled
          ? this.smoothPolyline(canonicalPoints, this.config.smoothingIterations)
          : canonicalPoints;
        const routing = this.resolveEdgeRouting(road.properties, lengthMeters);

        edges.push({
          edgeId: `${tileKey}:edge:${edgeCounter}`,
          roadId: road.roadId,
          fromNodeKey,
          toNodeKey,
          canonicalPoints,
          visualPoints,
          properties: road.properties,
          routing,
          lengthMeters,
        });
        edgeCounter += 1;
      }
    }

    return {
      tileKey,
      nodes: [...nodesByKey.values()],
      edges,
      stats: {
        inputRoads: stats.inputRoads,
        droppedDegenerateRoads: stats.droppedDegenerateRoads,
        droppedZeroLengthSegments: stats.droppedZeroLengthSegments,
        duplicateEdgesDropped: stats.duplicateEdgesDropped,
        intersectionSplits: stats.intersectionSplits,
        selfIntersectionRepairs: stats.selfIntersectionRepairs,
      },
    };
  }

  private buildNodeOccurrences(roads: readonly RoadPolyline[]): Map<string, number> {
    const occurrences = new Map<string, number>();
    for (const road of roads) {
      for (const point of road.points) {
        const key = this.quantizePoint(point);
        occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      }
    }
    return occurrences;
  }

  private upsertNode(
    map: Map<string, TopologyNodeLocal>,
    nodeKey: string,
    point: TopologyPointMeters,
  ): void {
    if (map.has(nodeKey)) {
      return;
    }

    map.set(nodeKey, {
      nodeKey,
      east: point.east,
      north: point.north,
    });
  }

  private bucketizeSegments(segments: readonly SegmentRef[]): Map<string, number[]> {
    const bucketMap = new Map<string, number[]>();
    const cellSize = this.config.intersectionCellSizeMeters;

    segments.forEach((segment, segmentRefIndex) => {
      const minEast = Math.min(segment.start.east, segment.end.east);
      const maxEast = Math.max(segment.start.east, segment.end.east);
      const minNorth = Math.min(segment.start.north, segment.end.north);
      const maxNorth = Math.max(segment.start.north, segment.end.north);

      const minCellX = Math.floor(minEast / cellSize);
      const maxCellX = Math.floor(maxEast / cellSize);
      const minCellY = Math.floor(minNorth / cellSize);
      const maxCellY = Math.floor(maxNorth / cellSize);

      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
          const key = `${cellX}:${cellY}`;
          const entry = bucketMap.get(key);
          if (entry === undefined) {
            bucketMap.set(key, [segmentRefIndex]);
            continue;
          }
          entry.push(segmentRefIndex);
        }
      }
    });

    return bucketMap;
  }

  private addSplitMarker(
    markerMap: Map<string, Set<number>>,
    roadIndex: number,
    segmentIndex: number,
    marker: number,
  ): boolean {
    if (marker <= this.config.intersectionEpsilon || marker >= 1 - this.config.intersectionEpsilon) {
      return false;
    }

    const key = this.getMarkerKey(roadIndex, segmentIndex);
    const current = markerMap.get(key) ?? new Set<number>([0, 1]);
    markerMap.set(key, current);
    const previousSize = current.size;
    current.add(marker);
    return current.size > previousSize;
  }

  private getMarkerKey(roadIndex: number, segmentIndex: number): string {
    return `${roadIndex}:${segmentIndex}`;
  }

  private intersectSegments(
    startA: TopologyPointMeters,
    endA: TopologyPointMeters,
    startB: TopologyPointMeters,
    endB: TopologyPointMeters,
  ): { readonly tA: number; readonly tB: number } | null {
    const epsilon = this.config.intersectionEpsilon;
    const dirAx = endA.east - startA.east;
    const dirAy = endA.north - startA.north;
    const dirBx = endB.east - startB.east;
    const dirBy = endB.north - startB.north;
    const determinant = dirAx * dirBy - dirAy * dirBx;
    if (Math.abs(determinant) < epsilon) {
      return null;
    }

    const offsetX = startB.east - startA.east;
    const offsetY = startB.north - startA.north;
    const tA = (offsetX * dirBy - offsetY * dirBx) / determinant;
    const tB = (offsetX * dirAy - offsetY * dirAx) / determinant;

    if (tA < -epsilon || tA > 1 + epsilon || tB < -epsilon || tB > 1 + epsilon) {
      return null;
    }

    const aAtEndpoint = tA <= epsilon || tA >= 1 - epsilon;
    const bAtEndpoint = tB <= epsilon || tB >= 1 - epsilon;
    if (aAtEndpoint && bAtEndpoint) {
      return null;
    }

    return {
      tA: Math.max(0, Math.min(1, tA)),
      tB: Math.max(0, Math.min(1, tB)),
    };
  }

  private interpolatePoint(
    start: TopologyPointMeters,
    end: TopologyPointMeters,
    t: number,
  ): TopologyPointMeters {
    return {
      east: start.east + (end.east - start.east) * t,
      north: start.north + (end.north - start.north) * t,
    };
  }

  private quantizePoint(point: TopologyPointMeters): string {
    const tolerance = this.config.nodeMergeToleranceMeters;
    const qEast = Math.round(point.east / tolerance);
    const qNorth = Math.round(point.north / tolerance);
    return `${qEast}:${qNorth}`;
  }

  private removeConsecutiveNearDuplicates(
    points: readonly TopologyPointMeters[],
    tolerance: number,
  ): TopologyPointMeters[] {
    if (points.length === 0) {
      return [];
    }

    const firstPoint = points[0];
    if (firstPoint === undefined) {
      return [];
    }

    const deduped: TopologyPointMeters[] = [firstPoint];
    for (let index = 1; index < points.length; index += 1) {
      const previous = deduped[deduped.length - 1];
      const current = points[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      if (this.distance(previous, current) <= tolerance) {
        continue;
      }
      deduped.push(current);
    }
    return deduped;
  }

  private computePolylineLength(points: readonly TopologyPointMeters[]): number {
    if (points.length < 2) {
      return 0;
    }

    let length = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const pointA = points[index];
      const pointB = points[index + 1];
      if (pointA === undefined || pointB === undefined) {
        continue;
      }
      length += this.distance(pointA, pointB);
    }
    return length;
  }

  private smoothPolyline(
    points: readonly TopologyPointMeters[],
    iterations: number,
  ): readonly TopologyPointMeters[] {
    if (points.length < 3 || iterations <= 0) {
      return points;
    }

    let current = [...points];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      if (current.length < 3) {
        break;
      }

      const firstPoint = current[0];
      if (firstPoint === undefined) {
        break;
      }

      const next: TopologyPointMeters[] = [firstPoint];
      for (let index = 0; index < current.length - 1; index += 1) {
        const pointA = current[index];
        const pointB = current[index + 1];
        if (pointA === undefined || pointB === undefined) {
          continue;
        }
        const q: TopologyPointMeters = {
          east: pointA.east * 0.75 + pointB.east * 0.25,
          north: pointA.north * 0.75 + pointB.north * 0.25,
        };
        const r: TopologyPointMeters = {
          east: pointA.east * 0.25 + pointB.east * 0.75,
          north: pointA.north * 0.25 + pointB.north * 0.75,
        };
        next.push(q, r);
      }
      const lastPoint = current[current.length - 1];
      if (lastPoint !== undefined) {
        next.push(lastPoint);
      }
      current = next;
    }

    return current;
  }

  private buildEdgeDedupKey(points: readonly TopologyPointMeters[], highway: string): string {
    const forward = points.map((point) => this.quantizePoint(point)).join(';');
    const reverse = [...points]
      .reverse()
      .map((point) => this.quantizePoint(point))
      .join(';');
    const canonical = forward < reverse ? forward : reverse;
    return `${highway}|${canonical}`;
  }

  private resolveEdgeRouting(properties: RoadProperties, lengthMeters: number): TopologyEdgeRouting {
    const profile = this.config.routeWeightingProfile;
    const isRoutable = !profile.excludedCategories.includes(properties.category);
    const categoryWeight = profile.categoryWeightByKind[properties.category] ?? 1;
    const pavementWeight = profile.pavementWeightByKind[properties.pavement] ?? 1;
    const rawWeightMultiplier = categoryWeight * pavementWeight;
    const weightMultiplier = this.clampRouteWeightMultiplier(rawWeightMultiplier);

    return {
      isRoutable,
      weightMultiplier,
      weightedCostMeters: lengthMeters * weightMultiplier,
      exclusionReason: isRoutable ? null : 'category-excluded',
    };
  }

  private clampRouteWeightMultiplier(multiplier: number): number {
    const profile = this.config.routeWeightingProfile;
    const minMultiplier = Math.max(0.01, profile.minWeightMultiplier);
    const maxMultiplier = Math.max(minMultiplier, profile.maxWeightMultiplier);
    const safeMultiplier = Number.isFinite(multiplier) ? multiplier : 1;
    return Math.max(minMultiplier, Math.min(maxMultiplier, safeMultiplier));
  }

  private distance(pointA: TopologyPointMeters, pointB: TopologyPointMeters): number {
    return Math.hypot(pointB.east - pointA.east, pointB.north - pointA.north);
  }
}
