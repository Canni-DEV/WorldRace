import type { RoadTileMeshPayload } from './RoadMeshTypes';
import type { TileRoadTopology } from './TopologyTypes';

export interface BuildRoadMeshWorkerRequest {
  readonly type: 'build-road-mesh';
  readonly requestId: number;
  readonly topology: TileRoadTopology;
}

export interface BuildRoadMeshWorkerSuccess {
  readonly type: 'build-road-mesh-success';
  readonly requestId: number;
  readonly payload: RoadTileMeshPayload;
  readonly buildTimeMs: number;
}

export interface BuildRoadMeshWorkerFailure {
  readonly type: 'build-road-mesh-failure';
  readonly requestId: number;
  readonly errorMessage: string;
  readonly buildTimeMs: number;
}

export type RoadMeshWorkerRequest = BuildRoadMeshWorkerRequest;
export type RoadMeshWorkerResponse = BuildRoadMeshWorkerSuccess | BuildRoadMeshWorkerFailure;
