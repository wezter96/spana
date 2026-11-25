import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserMockResponse, BrowserRouteMatcher } from "../drivers/raw-driver.js";

export type NetworkCacheMode = "record" | "replay" | "auto";

export interface CachedNetworkEntry {
  version: 1;
  key: string;
  method: string;
  url: string;
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: string;
  recordedAt: string;
}

export interface NetworkReplayCacheOptions {
  /** Directory where recorded API responses are stored. Default: `.spana/network-cache`. */
  cacheDir?: string;
}

export function buildNetworkCacheKey(method: string, url: string): string {
  const normalizedMethod = method.toUpperCase();
  const hash = createHash("sha256").update(`${normalizedMethod} ${url}`).digest("hex").slice(0, 16);
  const slug = url
    .replace(/^https?:\/\//, "")
    .replaceAll(/[^a-zA-Z0-9-_]/g, "_")
    .replaceAll(/_+/g, "_")
    .slice(0, 48);
  return `${normalizedMethod.toLowerCase()}-${slug}-${hash}`;
}

/**
 * Deterministic local HTTP API response cache (`.spana/network-cache/`).
 * Eliminates real-world backend/DB round-trip latency (often 60–80% of suite wall time)
 * by recording read-only API responses once and replaying them in <1ms via `app.mockNetwork`.
 */
export class NetworkReplayCache {
  readonly cacheDir: string;

  constructor(options: NetworkReplayCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? join(process.cwd(), ".spana", "network-cache");
  }

  private entryPath(key: string): string {
    return join(this.cacheDir, `${key}.json`);
  }

  get(method: string, url: string): CachedNetworkEntry | null {
    const key = buildNetworkCacheKey(method, url);
    const filePath = this.entryPath(key);
    if (!existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CachedNetworkEntry;
      if (parsed && parsed.version === 1 && typeof parsed.body === "string") {
        return parsed;
      }
    } catch {
      // corrupt cache entry
    }
    return null;
  }

  set(entry: Omit<CachedNetworkEntry, "version" | "key" | "recordedAt">): CachedNetworkEntry {
    mkdirSync(this.cacheDir, { recursive: true });
    const key = buildNetworkCacheKey(entry.method, entry.url);
    const record: CachedNetworkEntry = {
      version: 1,
      key,
      method: entry.method.toUpperCase(),
      url: entry.url,
      status: entry.status,
      contentType: entry.contentType,
      ...(entry.headers ? { headers: entry.headers } : {}),
      body: entry.body,
      recordedAt: new Date().toISOString(),
    };
    writeFileSync(this.entryPath(key), JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  /**
   * Fetch an endpoint live on cache miss (in `"record"` or `"auto"` mode) or return
   * the cached response in <1ms on cache hit (in `"replay"` or `"auto"` mode).
   */
  async resolve(
    url: string,
    options?: {
      method?: string;
      mode?: NetworkCacheMode;
      headers?: Record<string, string>;
      fetchFn?: typeof fetch;
    },
  ): Promise<{ entry: CachedNetworkEntry; source: "cache" | "network" }> {
    const method = (options?.method ?? "GET").toUpperCase();
    const mode = options?.mode ?? "auto";
    if (mode !== "record") {
      const hit = this.get(method, url);
      if (hit) return { entry: hit, source: "cache" };
      if (mode === "replay") {
        throw new Error(`NetworkReplayCache miss in strict replay mode for ${method} ${url}`);
      }
    }

    const fetchFn = options?.fetchFn ?? fetch;
    const res = await fetchFn(url, { method, headers: options?.headers });
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "application/json";
    const entry = this.set({
      method,
      url,
      status: res.status,
      contentType,
      body,
    });
    return { entry, source: "network" };
  }
}

export interface AttachNetworkCacheOptions {
  /** URLs (and optional route matchers) to pre-warm/replay via `app.mockNetwork`. */
  routes: Array<{
    url: string;
    matcher?: BrowserRouteMatcher;
    method?: string;
    headers?: Record<string, string>;
  }>;
  mode?: NetworkCacheMode;
  cacheDir?: string;
  fetchFn?: typeof fetch;
}

export interface AttachNetworkCacheResult {
  cacheHits: number;
  networkFetches: number;
  totalRoutes: number;
}

/**
 * Attach deterministic recorded API mocks to any Spana `app` (`mockNetwork`-capable)
 * so read-only backend endpoints respond in <1ms locally instead of hitting live DBs.
 */
export async function attachNetworkReplayCache(
  app: {
    mockNetwork(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void>;
  },
  options: AttachNetworkCacheOptions,
): Promise<AttachNetworkCacheResult> {
  const cache = new NetworkReplayCache({ cacheDir: options.cacheDir });
  let cacheHits = 0;
  let networkFetches = 0;

  for (const route of options.routes) {
    const { entry, source } = await cache.resolve(route.url, {
      method: route.method,
      mode: options.mode,
      headers: route.headers,
      fetchFn: options.fetchFn,
    });
    if (source === "cache") cacheHits += 1;
    else networkFetches += 1;

    await app.mockNetwork(route.matcher ?? route.url, {
      status: entry.status,
      contentType: entry.contentType,
      headers: entry.headers,
      body: entry.body,
    });
  }

  return {
    cacheHits,
    networkFetches,
    totalRoutes: options.routes.length,
  };
}
