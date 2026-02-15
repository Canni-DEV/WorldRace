import type { TopologyPointMeters } from './TopologyTypes';

export interface RoadMeshStats {
  readonly edgeCountMeshed: number;
  readonly droppedEdges: number;
  readonly triangleCount: number;
  readonly collisionTriangleCount: number;
  readonly minResolvedWidthMeters: number;
  readonly maxResolvedWidthMeters: number;
}

export interface RoadTileMeshPayload {
  readonly tileKey: string;
  readonly surfacePositions: Float32Array;
  readonly surfaceUvs: Float32Array;
  readonly surfaceIndices: Uint32Array;
  readonly collisionPositions: Float32Array;
  readonly collisionIndices: Uint32Array;
  readonly debugLinePositions: Float32Array;
  readonly stats: RoadMeshStats;
}

export interface RoadWidthResolutionDebug {
  readonly edgeId: string;
  readonly resolvedWidthMeters: number;
  readonly centerline: readonly TopologyPointMeters[];
}
