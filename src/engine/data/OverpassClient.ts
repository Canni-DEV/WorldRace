import type { GeoBoundsLatLon } from './Types';

interface OverpassResponse {
  readonly version?: number;
  readonly generator?: string;
  readonly osm3s?: unknown;
  readonly elements: readonly OverpassElement[];
}

interface OverpassNode {
  readonly type: 'node';
  readonly id: number;
  readonly lat: number;
  readonly lon: number;
  readonly tags?: Record<string, string>;
}

interface OverpassWay {
  readonly type: 'way';
  readonly id: number;
  readonly geometry?: readonly OverpassGeometryPoint[];
  readonly tags?: Record<string, string>;
}

interface OverpassRelation {
  readonly type: 'relation';
  readonly id: number;
  readonly tags?: Record<string, string>;
}

type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;

interface OverpassGeometryPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface OverpassFetchResult {
  readonly endpoint: string;
  readonly response: OverpassResponse;
  readonly fetchedAt: number;
}

export interface OverpassClientConfig {
  readonly endpoints: readonly string[];
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
}

const defaultConfig: OverpassClientConfig = {
  endpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
  ],
  timeoutMs: 18000,
  maxRetries: 2,
  baseBackoffMs: 500,
};

export class OverpassClient {
  private readonly config: OverpassClientConfig;
  private endpointCursor = 0;
  private requestQueue: Promise<void> = Promise.resolve();

  public constructor(config: Partial<OverpassClientConfig> = {}) {
    const endpoints = config.endpoints ?? defaultConfig.endpoints;
    this.config = {
      endpoints,
      timeoutMs: config.timeoutMs ?? defaultConfig.timeoutMs,
      maxRetries: config.maxRetries ?? defaultConfig.maxRetries,
      baseBackoffMs: config.baseBackoffMs ?? defaultConfig.baseBackoffMs,
    };
  }

  public fetchTileData(bounds: GeoBoundsLatLon): Promise<OverpassFetchResult> {
    return this.enqueue(async () => this.fetchTileDataWithRetry(bounds));
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const runOperation = this.requestQueue.then(operation, operation);
    this.requestQueue = runOperation.then(
      () => undefined,
      () => undefined,
    );
    return runOperation;
  }

  private async fetchTileDataWithRetry(bounds: GeoBoundsLatLon): Promise<OverpassFetchResult> {
    const query = this.buildQuery(bounds);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      const endpoint = this.pickEndpoint();
      try {
        const response = await this.executeRequest(endpoint, query);
        return {
          endpoint,
          response,
          fetchedAt: Date.now(),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown Overpass error');
        const isLastAttempt = attempt >= this.config.maxRetries;
        if (isLastAttempt) {
          break;
        }

        const backoffMs = this.config.baseBackoffMs * 2 ** attempt + this.randomJitter(200);
        await this.delay(backoffMs);
      }
    }

    throw lastError ?? new Error('Overpass request failed without details.');
  }

  private async executeRequest(endpoint: string, query: string): Promise<OverpassResponse> {
    const abortController = new AbortController();
    const timeoutHandle = window.setTimeout(() => {
      abortController.abort();
    }, this.config.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Overpass HTTP ${response.status}`);
      }

      const json = (await response.json()) as unknown;
      if (!this.isOverpassResponse(json)) {
        throw new Error('Invalid Overpass payload shape.');
      }

      return json;
    } finally {
      window.clearTimeout(timeoutHandle);
    }
  }

  private buildQuery(bounds: GeoBoundsLatLon): string {
    const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    return `[out:json][timeout:25];
(
  way["highway"](${bbox});
  way["building"](${bbox});
  relation["building"](${bbox});
);
out geom tags;`;
  }

  private pickEndpoint(): string {
    const endpoints = this.config.endpoints;
    if (endpoints.length === 0) {
      throw new Error('Overpass client requires at least one endpoint.');
    }

    const endpoint = endpoints[this.endpointCursor % endpoints.length];
    this.endpointCursor = (this.endpointCursor + 1) % endpoints.length;
    return endpoint;
  }

  private isOverpassResponse(value: unknown): value is OverpassResponse {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as { elements?: unknown };
    if (!Array.isArray(candidate.elements)) {
      return false;
    }

    return true;
  }

  private randomJitter(maxMs: number): number {
    return Math.floor(Math.random() * maxMs);
  }

  private delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, delayMs);
    });
  }
}

export type { OverpassElement, OverpassGeometryPoint, OverpassResponse, OverpassWay };
