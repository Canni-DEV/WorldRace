import { RoadMesher } from './RoadMesher';
import type { RoadTileMeshPayload } from './RoadMeshTypes';
import type {
  BuildRoadMeshWorkerRequest,
  RoadMeshWorkerResponse,
} from './RoadMeshBuildWorkerProtocol';
import type { TileRoadTopology } from './TopologyTypes';

export interface RoadMeshBuildResult {
  readonly payload: RoadTileMeshPayload;
  readonly buildTimeMs: number;
}

export interface RoadMeshBuildServiceConfig {
  readonly useWorker: boolean;
}

interface PendingWorkerRequest {
  readonly resolve: (result: RoadMeshBuildResult) => void;
  readonly reject: (error: Error) => void;
}

const defaultConfig: RoadMeshBuildServiceConfig = {
  useWorker: true,
};

export class RoadMeshBuildService {
  private readonly roadMesher = new RoadMesher();
  private readonly worker: Worker | null;
  private readonly pendingRequests = new Map<number, PendingWorkerRequest>();
  private nextRequestId = 1;

  public constructor(config: Partial<RoadMeshBuildServiceConfig> = {}) {
    const mergedConfig = {
      ...defaultConfig,
      ...config,
    };

    this.worker = mergedConfig.useWorker ? this.createWorker() : null;
  }

  public getMode(): 'worker' | 'main-thread' {
    return this.worker === null ? 'main-thread' : 'worker';
  }

  public async build(topology: TileRoadTopology): Promise<RoadMeshBuildResult> {
    if (this.worker === null) {
      const startedAt = performance.now();
      const payload = this.roadMesher.buildTileRoadMesh(topology);
      return {
        payload,
        buildTimeMs: performance.now() - startedAt,
      };
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const request: BuildRoadMeshWorkerRequest = {
      type: 'build-road-mesh',
      requestId,
      topology,
    };

    return new Promise<RoadMeshBuildResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.worker?.postMessage(request);
    });
  }

  public dispose(): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('Road mesh build service disposed before completion.'));
    }
    this.pendingRequests.clear();
    this.worker?.terminate();
  }

  private createWorker(): Worker | null {
    try {
      const worker = new Worker(new URL('./roadMesh.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.addEventListener('message', (event: MessageEvent<RoadMeshWorkerResponse>) => {
        this.handleWorkerResponse(event.data);
      });
      worker.addEventListener('error', (event) => {
        const message = event.message || 'Unknown road mesh worker failure.';
        this.rejectAllPending(new Error(message));
      });
      return worker;
    } catch {
      return null;
    }
  }

  private handleWorkerResponse(response: RoadMeshWorkerResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(response.requestId);

    if (response.type === 'build-road-mesh-failure') {
      pending.reject(new Error(response.errorMessage));
      return;
    }

    pending.resolve({
      payload: response.payload,
      buildTimeMs: response.buildTimeMs,
    });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
