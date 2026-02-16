import type { TopologyPointMeters } from './TopologyTypes';

export interface RoadMeshStats {
  readonly edgeCountMeshed: number;
  readonly droppedEdges: number;
  readonly triangleCount: number;
  readonly collisionTriangleCount: number;
  readonly minResolvedWidthMeters: number;
  readonly maxResolvedWidthMeters: number;
  readonly junctionNodesConsidered: number;
  readonly junctionPolygonsBuilt: number;
  readonly junctionTriangles: number;
  readonly junctionMiterCorners: number;
  readonly junctionBevelCorners: number;
  readonly junctionFallbackCorners: number;
  readonly junctionTriangulationFailures: number;
}

export type RoadSurfaceKind = 'asphalt' | 'dirt';

export interface RoadSurfaceChunkPayload {
  readonly kind: RoadSurfaceKind;
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

export interface RoadTileMeshPayload {
  readonly tileKey: string;
  readonly surfaceChunks: readonly RoadSurfaceChunkPayload[];
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
