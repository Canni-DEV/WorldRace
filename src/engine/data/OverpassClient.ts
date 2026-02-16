import type { GeoBoundsLatLon, TileFetchPriority } from './Types';

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
  readonly members?: readonly OverpassRelationMember[];
}

interface OverpassRelationMember {
  readonly type: 'node' | 'way' | 'relation';
  readonly ref: number;
  readonly role: string;
  readonly geometry?: readonly OverpassGeometryPoint[];
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
  readonly timeoutMsForeground: number;
  readonly timeoutMsBackground: number;
  readonly maxRetries: number;
  readonly baseBackoffMs: number;
  readonly circuitBreakerBaseCooldownMs: number;
  readonly circuitBreakerMaxCooldownMs: number;
  readonly stickyEndpointEnabled: boolean;
}

export interface OverpassFetchOptions {
  readonly signal?: AbortSignal;
  readonly priority?: TileFetchPriority;
}

interface EndpointHealthState {
  consecutiveFailures: number;
  cooldownUntilMs: number;
  avgLatencyMs: number;
}

const DEFAULT_OVERPASS_PROXY_BASE_URL = 'http://localhost:8080';
const PUBLIC_OVERPASS_ENDPOINTS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
]);

function toInterpreterEndpoint(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  if (trimmedBaseUrl.endsWith('/api/interpreter')) {
    return trimmedBaseUrl;
  }
  return `${trimmedBaseUrl}/api/interpreter`;
}

const configuredProxyBaseUrl = import.meta.env.VITE_OVERPASS_PROXY_URL?.trim();
const defaultProxyEndpoint = toInterpreterEndpoint(
  configuredProxyBaseUrl !== undefined && configuredProxyBaseUrl.length > 0
    ? configuredProxyBaseUrl
    : DEFAULT_OVERPASS_PROXY_BASE_URL,
);
const isProxyEnabledForDevelopment =
  import.meta.env.DEV && import.meta.env.VITE_OVERPASS_PROXY_ENABLED === 'true';

const defaultConfig: OverpassClientConfig = {
  endpoints: isProxyEnabledForDevelopment ? [defaultProxyEndpoint] : PUBLIC_OVERPASS_ENDPOINTS,
  timeoutMsForeground: 12000,
  timeoutMsBackground: 20000,
  maxRetries: 2,
  baseBackoffMs: 500,
  circuitBreakerBaseCooldownMs: 2000,
  circuitBreakerMaxCooldownMs: 30000,
  stickyEndpointEnabled: true,
};

export class OverpassClient {
  private readonly config: OverpassClientConfig;
  private stickyEndpointIndex = 0;
  private readonly endpointHealthByIndex = new Map<number, EndpointHealthState>();

  public constructor(config: Partial<OverpassClientConfig> = {}) {
    const endpoints = config.endpoints ?? defaultConfig.endpoints;
    this.config = {
      endpoints,
      timeoutMsForeground: config.timeoutMsForeground ?? defaultConfig.timeoutMsForeground,
      timeoutMsBackground: config.timeoutMsBackground ?? defaultConfig.timeoutMsBackground,
      maxRetries: config.maxRetries ?? defaultConfig.maxRetries,
      baseBackoffMs: config.baseBackoffMs ?? defaultConfig.baseBackoffMs,
      circuitBreakerBaseCooldownMs:
        config.circuitBreakerBaseCooldownMs ?? defaultConfig.circuitBreakerBaseCooldownMs,
      circuitBreakerMaxCooldownMs:
        config.circuitBreakerMaxCooldownMs ?? defaultConfig.circuitBreakerMaxCooldownMs,
      stickyEndpointEnabled: config.stickyEndpointEnabled ?? defaultConfig.stickyEndpointEnabled,
    };

    endpoints.forEach((_endpoint, index) => {
      this.endpointHealthByIndex.set(index, {
        consecutiveFailures: 0,
        cooldownUntilMs: 0,
        avgLatencyMs: 1000,
      });
    });
  }

  public fetchTileData(bounds: GeoBoundsLatLon, options: OverpassFetchOptions = {}): Promise<OverpassFetchResult> {
    return this.fetchTileDataWithRetry(bounds, options);
  }

  private async fetchTileDataWithRetry(
    bounds: GeoBoundsLatLon,
    options: OverpassFetchOptions,
  ): Promise<OverpassFetchResult> {
    const query = this.buildQuery(bounds);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (options.signal?.aborted === true) {
        throw this.createAbortError();
      }

      const endpointSelection = this.pickEndpoint();
      const endpoint = endpointSelection.endpoint;
      try {
        const startedAtMs = performance.now();
        const response = await this.executeRequest(endpoint, query, options);
        const latencyMs = performance.now() - startedAtMs;
        this.recordEndpointSuccess(endpointSelection.index, latencyMs);
        return {
          endpoint,
          response,
          fetchedAt: Date.now(),
        };
      } catch (error) {
        if (this.isAbortError(error)) {
          throw this.createAbortError();
        }

        this.recordEndpointFailure(endpointSelection.index);
        lastError = error instanceof Error ? error : new Error('Unknown Overpass error');
        console.error('[OverpassClient] Request failed.', {
          endpoint,
          attempt: attempt + 1,
          maxAttempts: this.config.maxRetries + 1,
          priority: options.priority ?? 'foreground',
          bounds,
          error: lastError.message,
        });
        const isLastAttempt = attempt >= this.config.maxRetries;
        if (isLastAttempt) {
          break;
        }

        const backoffMs = this.config.baseBackoffMs * 2 ** attempt + this.randomJitter(200);
        await this.delay(backoffMs, options.signal);
      }
    }

    console.error('[OverpassClient] Exhausted retries.', {
      maxAttempts: this.config.maxRetries + 1,
      priority: options.priority ?? 'foreground',
      bounds,
      error: lastError?.message ?? 'Unknown Overpass error',
    });
    throw lastError ?? new Error('Overpass request failed without details.');
  }

  private async executeRequest(
    endpoint: string,
    query: string,
    options: OverpassFetchOptions,
  ): Promise<OverpassResponse> {
    const abortController = new AbortController();
    const timeoutMs = this.getTimeoutMs(options.priority ?? 'foreground');
    const timeoutHandle = window.setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const externalSignal = options.signal;
    const onExternalAbort = (): void => {
      abortController.abort();
    };
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        abortController.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

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
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private buildQuery(bounds: GeoBoundsLatLon): string {
    const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
    return `[out:json][timeout:25];
(
  way["highway"](${bbox});
  way["building"](${bbox});
  relation["building"](${bbox});
  node["natural"="tree"](${bbox});
  node["highway"="street_lamp"](${bbox});
  node["amenity"="bench"](${bbox});
  node["traffic_sign"](${bbox});
  way["landuse"="forest"](${bbox});
  way["natural"~"^(wood|scrub)$"](${bbox});
  way["leisure"="park"](${bbox});
  way["natural"~"^(water|wetland)$"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["landuse"~"^(reservoir|residential|commercial|industrial|retail|forest|farmland|meadow|grass)$"](${bbox});
  way["natural"~"^(wood|scrub|grassland)$"](${bbox});
  way["leisure"~"^(park|garden|golf_course)$"](${bbox});
  relation["landuse"="forest"](${bbox});
  relation["natural"~"^(wood|scrub)$"](${bbox});
  relation["leisure"="park"](${bbox});
  relation["natural"~"^(water|wetland)$"](${bbox});
  relation["waterway"="riverbank"](${bbox});
  relation["landuse"~"^(reservoir|residential|commercial|industrial|retail|forest|farmland|meadow|grass)$"](${bbox});
  relation["natural"~"^(wood|scrub|grassland)$"](${bbox});
  relation["leisure"~"^(park|garden|golf_course)$"](${bbox});
);
out geom tags;`;
  }

  private pickEndpoint(): { readonly endpoint: string; readonly index: number } {
    const endpoints = this.config.endpoints;
    if (endpoints.length === 0) {
      throw new Error('Overpass client requires at least one endpoint.');
    }

    const nowMs = Date.now();
    if (this.config.stickyEndpointEnabled) {
      const stickyState = this.endpointHealthByIndex.get(this.stickyEndpointIndex);
      const stickyEndpoint = endpoints[this.stickyEndpointIndex];
      if (stickyState !== undefined && stickyEndpoint !== undefined && nowMs >= stickyState.cooldownUntilMs) {
        return {
          endpoint: stickyEndpoint,
          index: this.stickyEndpointIndex,
        };
      }
    }

    let selectedIndex = 0;
    let selectedScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < endpoints.length; index += 1) {
      const health = this.endpointHealthByIndex.get(index);
      const endpoint = endpoints[index];
      if (health === undefined || endpoint === undefined) {
        continue;
      }

      const inCooldown = nowMs < health.cooldownUntilMs;
      const cooldownPenalty = inCooldown ? 1_000_000 : 0;
      const score = cooldownPenalty + health.avgLatencyMs + health.consecutiveFailures * 1000;
      if (score < selectedScore) {
        selectedScore = score;
        selectedIndex = index;
      }
    }

    return {
      endpoint: endpoints[selectedIndex] ?? endpoints[0] ?? '',
      index: selectedIndex,
    };
  }

  private recordEndpointSuccess(endpointIndex: number, latencyMs: number): void {
    const state = this.endpointHealthByIndex.get(endpointIndex);
    if (state === undefined) {
      return;
    }

    state.consecutiveFailures = 0;
    state.cooldownUntilMs = 0;
    state.avgLatencyMs = state.avgLatencyMs * 0.7 + latencyMs * 0.3;
    this.stickyEndpointIndex = endpointIndex;
  }

  private recordEndpointFailure(endpointIndex: number): void {
    const state = this.endpointHealthByIndex.get(endpointIndex);
    if (state === undefined) {
      return;
    }

    state.consecutiveFailures += 1;
    const exponentialCooldown =
      this.config.circuitBreakerBaseCooldownMs * 2 ** Math.max(0, state.consecutiveFailures - 1);
    const cooldownMs = Math.min(this.config.circuitBreakerMaxCooldownMs, exponentialCooldown);
    state.cooldownUntilMs = Date.now() + cooldownMs;
  }

  private getTimeoutMs(priority: TileFetchPriority): number {
    return priority === 'foreground'
      ? this.config.timeoutMsForeground
      : this.config.timeoutMsBackground;
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return true;
    }
    return error instanceof Error && error.name === 'AbortError';
  }

  private createAbortError(): DOMException {
    return new DOMException('Request aborted.', 'AbortError');
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

  private delay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(this.createAbortError());
        return;
      }

      const timeoutHandle = window.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);

      const onAbort = (): void => {
        window.clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onAbort);
        reject(this.createAbortError());
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export type { OverpassElement, OverpassGeometryPoint, OverpassResponse, OverpassWay };
