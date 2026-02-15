/// <reference lib="webworker" />

import { RoadMesher } from './RoadMesher';
import type {
  BuildRoadMeshWorkerFailure,
  BuildRoadMeshWorkerRequest,
  BuildRoadMeshWorkerSuccess,
  RoadMeshWorkerRequest,
} from './RoadMeshBuildWorkerProtocol';

const roadMesher = new RoadMesher();
const workerScope: DedicatedWorkerGlobalScope = self;

const postSuccess = (
  scope: DedicatedWorkerGlobalScope,
  requestId: number,
  buildTimeMs: number,
  payload: ReturnType<RoadMesher['buildTileRoadMesh']>,
): void => {
  const response: BuildRoadMeshWorkerSuccess = {
    type: 'build-road-mesh-success',
    requestId,
    payload,
    buildTimeMs,
  };

  scope.postMessage(response, [
    payload.surfacePositions.buffer,
    payload.surfaceUvs.buffer,
    payload.surfaceIndices.buffer,
    payload.collisionPositions.buffer,
    payload.collisionIndices.buffer,
    payload.debugLinePositions.buffer,
  ]);
};

const postFailure = (
  scope: DedicatedWorkerGlobalScope,
  requestId: number,
  buildTimeMs: number,
  error: unknown,
): void => {
  const response: BuildRoadMeshWorkerFailure = {
    type: 'build-road-mesh-failure',
    requestId,
    errorMessage: error instanceof Error ? error.message : 'Unknown worker build error.',
    buildTimeMs,
  };
  scope.postMessage(response);
};

workerScope.addEventListener('message', (event: MessageEvent<RoadMeshWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'build-road-mesh') {
    return;
  }

  const startedAt = performance.now();
  const typedRequest: BuildRoadMeshWorkerRequest = request;

  try {
    const payload = roadMesher.buildTileRoadMesh(typedRequest.topology);
    const buildTimeMs = performance.now() - startedAt;
    postSuccess(workerScope, typedRequest.requestId, buildTimeMs, payload);
  } catch (error: unknown) {
    const buildTimeMs = performance.now() - startedAt;
    postFailure(workerScope, typedRequest.requestId, buildTimeMs, error);
  }
});
