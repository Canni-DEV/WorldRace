import type { RoadProperties, TileOSMData } from '../data/Types';

export interface TopologyPointMeters {
  readonly east: number;
  readonly north: number;
}

export interface TopologyNodeLocal {
  readonly nodeKey: string;
  readonly east: number;
  readonly north: number;
}

export interface TopologyNode {
  readonly globalNodeId: string;
  readonly nodeKey: string;
  readonly east: number;
  readonly north: number;
}

export interface TopologyEdgeLocal {
  readonly edgeId: string;
  readonly roadId: string;
  readonly fromNodeKey: string;
  readonly toNodeKey: string;
  readonly canonicalPoints: readonly TopologyPointMeters[];
  readonly visualPoints: readonly TopologyPointMeters[];
  readonly properties: RoadProperties;
  readonly lengthMeters: number;
}

export interface TopologyEdge {
  readonly edgeId: string;
  readonly roadId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly fromNodeKey: string;
  readonly toNodeKey: string;
  readonly canonicalPoints: readonly TopologyPointMeters[];
  readonly visualPoints: readonly TopologyPointMeters[];
  readonly properties: RoadProperties;
  readonly lengthMeters: number;
}

export interface TopologyBuildStats {
  readonly inputRoads: number;
  readonly droppedDegenerateRoads: number;
  readonly droppedZeroLengthSegments: number;
  readonly duplicateEdgesDropped: number;
  readonly intersectionSplits: number;
  readonly selfIntersectionRepairs: number;
}

export interface TileRoadTopologyLocal {
  readonly tileKey: string;
  readonly nodes: readonly TopologyNodeLocal[];
  readonly edges: readonly TopologyEdgeLocal[];
  readonly stats: TopologyBuildStats;
}

export interface TileRoadTopologyStats extends TopologyBuildStats {
  readonly stitchedNodes: number;
}

export interface TileRoadTopology {
  readonly tileKey: string;
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly stats: TileRoadTopologyStats;
}

export interface TopologyBuildInput {
  readonly tileData: TileOSMData;
}
