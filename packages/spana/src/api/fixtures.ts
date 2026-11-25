import type { DomClearStorageOptions, DomStorageEntries } from "../channels/dom-channel.js";
import type { FlowConfig, FlowContext, FlowDefinition } from "./flow.js";
import type { PromiseApp } from "./app.js";

/**
 * Declarative named setup state (e.g. `"admin"`, `"authenticated"`, `"seeded-cart"`).
 * Automatically uses `spana-bridge` storage injection on mobile/desktop/bridge-web
 * and Playwright `loadAuthState` / `evaluate` on web.
 */
export interface NamedSetupDefinition<T extends string = string, R extends string = string> {
  name: string;
  /** Clear storage before restoring state (default: true). */
  clearBefore?: boolean | DomClearStorageOptions;
  /** Storage entries injected via `app.setStorage(...)` (localStorage/sessionStorage/cookies/Preferences). */
  storage?: DomStorageEntries;
  /** Optional Playwright storageState JSON file path for web runs. */
  storageStatePath?: string;
  /** Optional URL/route to navigate to after injecting state (or `reload` when omitted and storage was injected). */
  navigateTo?: R;
  /** Whether to reload the WebView/page after injecting storage when `navigateTo` is omitted (default: true). */
  reloadAfterStorage?: boolean;
  /** Optional custom setup hook for seeding API state or performing extra actions. */
  run?: (ctx: FlowContext<T, R>) => Promise<void>;
}

/** Define a reusable named setup state for `{ session: "<name>" }` flows. */
export function defineSetup<T extends string = string, R extends string = string>(
  name: string,
  config: Omit<NamedSetupDefinition<T, R>, "name">,
): NamedSetupDefinition<T, R> {
  return { name, ...config };
}

/** Apply a named setup state to the active `FlowContext`. */
export async function applyNamedSetup<T extends string = string, R extends string = string>(
  setup: NamedSetupDefinition<T, R>,
  ctx: FlowContext<T, R>,
): Promise<void> {
  const app = ctx.app as PromiseApp<T, R>;

  if (setup.storageStatePath && ctx.platform === "web") {
    await app.loadAuthState(setup.storageStatePath);
  }

  if (setup.clearBefore !== false && setup.storage) {
    const clearOpts = typeof setup.clearBefore === "object" ? setup.clearBefore : undefined;
    try {
      await app.clearStorage(clearOpts);
    } catch {
      // Fallback for plain web without spana-bridge
      if (ctx.platform === "web") {
        await app.evaluate("localStorage.clear(); sessionStorage.clear();");
      }
    }
  }

  if (setup.storage) {
    try {
      await app.setStorage(setup.storage);
    } catch {
      // Fallback for web without spana-bridge
      if (ctx.platform === "web") {
        const serialized = JSON.stringify(setup.storage);
        await app.evaluate(
          `(() => { const entries = ${serialized}; if (entries.localStorage) { for (const [k, v] of Object.entries(entries.localStorage)) localStorage.setItem(k, v); } if (entries.sessionStorage) { for (const [k, v] of Object.entries(entries.sessionStorage)) sessionStorage.setItem(k, v); } })()`,
        );
      } else {
        throw new Error(
          `Named setup "${setup.name}" requires spana-bridge or a DOM channel to inject storage on ${ctx.platform}.`,
        );
      }
    }

    if (setup.navigateTo) {
      await app.openLink(setup.navigateTo);
    } else if (setup.reloadAfterStorage !== false) {
      try {
        await app.resetFast();
      } catch {
        if (ctx.platform === "web") {
          await app.evaluate("window.location.reload();");
        }
      }
    }
  } else if (setup.navigateTo) {
    await app.openLink(setup.navigateTo);
  }

  if (setup.run) {
    await setup.run(ctx);
  }
}

// ── Composable Lazy Fixtures ────────────────────────────────────────────────

export type FixtureFn<
  Value,
  Deps extends Record<string, unknown>,
  T extends string = string,
  R extends string = string,
> = (ctx: FlowContext<T, R> & Deps, use: (value: Value) => Promise<void>) => Promise<void>;

export type FixtureDefinition<
  Value,
  Deps extends Record<string, unknown>,
  T extends string = string,
  R extends string = string,
> =
  | FixtureFn<Value, Deps, T, R>
  | {
      setup: FixtureFn<Value, Deps, T, R>;
      /** When true, always runs for every flow even if not destructured. */
      auto?: boolean;
      /** Explicit fixture dependency names (optional — also inferred from parameter destructuring). */
      deps?: Array<keyof Deps & string>;
    };

export type FixtureMap<
  Fixtures extends Record<string, unknown>,
  T extends string = string,
  R extends string = string,
> = {
  [K in keyof Fixtures]: FixtureDefinition<Fixtures[K], Omit<Fixtures, K>, T, R>;
};

export interface ExtendedFlowConfig<
  R extends string = string,
  SessionName extends string = string,
> extends FlowConfig<R> {
  /** Optional named setup state applied before any lazy fixtures run. */
  session?: SessionName;
  /** Optional explicit fixture names to activate (in addition to destructured params). */
  uses?: string[];
}

/**
 * Extract top-level destructured parameter names from the first argument of a function:
 *   `async ({ app, project, task: t }) => ...` -> `["app", "project", "task"]`
 */
export function extractDestructuredParamNames(fn: (...args: any[]) => unknown): string[] {
  const src = fn.toString().trim();
  const openParen = src.indexOf("(");
  if (openParen < 0) return [];

  // Find first parameter token
  let i = openParen + 1;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  if (src[i] !== "{") return [];

  // Extract balanced `{ ... }`
  let depth = 0;
  const start = i + 1;
  let end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];

  const inner = src.slice(start, end);
  const names: string[] = [];
  // Split top-level commas only (ignore nested destructuring/defaults)
  let token = "";
  let nested = 0;
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j]!;
    if (ch === "{" || ch === "[" || ch === "(") nested++;
    else if (ch === "}" || ch === "]" || ch === ")") nested--;
    else if (ch === "," && nested === 0) {
      const parsed = parseDestructuredKey(token);
      if (parsed) names.push(parsed);
      token = "";
      continue;
    }
    token += ch;
  }
  const last = parseDestructuredKey(token);
  if (last) names.push(last);
  return names;
}

function parseDestructuredKey(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned || cleaned.startsWith("...")) return null;
  // Strip default value (`foo = 1`) and alias (`foo: bar`)
  const keyMatch = cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/);
  return keyMatch?.[1] ?? null;
}

interface NormalizedFixture<T extends string, R extends string> {
  name: string;
  setup: FixtureFn<unknown, Record<string, unknown>, T, R>;
  auto: boolean;
  deps: string[];
}

export interface CreateFixturesOptions<
  Fixtures extends Record<string, unknown>,
  SessionName extends string = string,
  T extends string = string,
  R extends string = string,
> {
  fixtures?: FixtureMap<Fixtures, T, R>;
  setups?: Record<SessionName, NamedSetupDefinition<T, R>>;
}

/**
 * Create a `flow()` builder enhanced with lazy composable fixtures and named
 * setup states (`{ session: "admin" }`), inspired by Playwright and `e2e`.
 *
 * - Fixtures only run when destructured by the flow (or marked `{ auto: true }`).
 * - Fixtures can depend on other fixtures; cycles are detected immediately.
 * - Teardown runs in strict reverse (LIFO) order even when the flow throws.
 */
export function createFlowWithFixtures<
  Fixtures extends Record<string, unknown> = Record<string, never>,
  SessionName extends string = string,
  T extends string = string,
  R extends string = string,
>(options: CreateFixturesOptions<Fixtures, SessionName, T, R>) {
  const fixtureMap = new Map<string, NormalizedFixture<T, R>>();
  const rawFixtures = options.fixtures ?? ({} as FixtureMap<Fixtures, T, R>);
  const setups = (options.setups ?? {}) as Record<string, NamedSetupDefinition<T, R>>;

  for (const [name, def] of Object.entries(rawFixtures)) {
    const fn = typeof def === "function" ? def : def.setup;
    const auto = typeof def === "function" ? false : Boolean(def.auto);
    const explicitDeps = typeof def === "function" ? undefined : def.deps;
    const inferredDeps = explicitDeps ?? extractDestructuredParamNames(fn);
    fixtureMap.set(name, { name, setup: fn, auto, deps: inferredDeps });
  }

  function resolveFixtureOrder(requested: string[]): NormalizedFixture<T, R>[] {
    const ordered: NormalizedFixture<T, R>[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      const fix = fixtureMap.get(name);
      if (!fix) return;
      if (visiting.has(name)) {
        throw new Error(`Circular fixture dependency detected involving "${name}"`);
      }
      visiting.add(name);
      for (const dep of fix.deps) {
        if (fixtureMap.has(dep)) {
          visit(dep);
        }
      }
      visiting.delete(name);
      visited.add(name);
      ordered.push(fix);
    };

    // Always run `auto: true` fixtures first
    for (const fix of fixtureMap.values()) {
      if (fix.auto) visit(fix.name);
    }
    for (const name of requested) {
      visit(name);
    }
    return ordered;
  }

  function extendedFlow(
    name: string,
    fn: (ctx: FlowContext<T, R> & Fixtures) => Promise<void>,
  ): FlowDefinition<T, R>;
  function extendedFlow(
    name: string,
    config: ExtendedFlowConfig<R, SessionName>,
    fn: (ctx: FlowContext<T, R> & Fixtures) => Promise<void>,
  ): FlowDefinition<T, R>;
  function extendedFlow(
    name: string,
    configOrFn:
      | ExtendedFlowConfig<R, SessionName>
      | ((ctx: FlowContext<T, R> & Fixtures) => Promise<void>),
    maybeFn?: (ctx: FlowContext<T, R> & Fixtures) => Promise<void>,
  ): FlowDefinition<T, R> {
    const isFnOnly = typeof configOrFn === "function";
    const extConfig: ExtendedFlowConfig<R, SessionName> = isFnOnly ? {} : configOrFn;
    const userFn = isFnOnly ? configOrFn : maybeFn!;

    const requestedNames = [
      ...(extConfig.uses ?? []),
      ...extractDestructuredParamNames(userFn).filter((n) => fixtureMap.has(n)),
    ];

    const wrappedFn = async (baseCtx: FlowContext<T, R>): Promise<void> => {
      // 1. Restore named session setup before fixtures run
      if (extConfig.session) {
        const setup = setups[extConfig.session];
        if (!setup) {
          throw new Error(
            `Unknown setup session "${extConfig.session}". Registered setups: ${
              Object.keys(setups).join(", ") || "(none)"
            }`,
          );
        }
        await applyNamedSetup(setup, baseCtx);
      }

      // 2. Resolve lazy fixture graph & run nested setup -> use -> LIFO teardown
      const orderedFixtures = resolveFixtureOrder(requestedNames);
      const mergedCtx: Record<string, unknown> = { ...baseCtx };

      const runChain = async (idx: number): Promise<void> => {
        if (idx >= orderedFixtures.length) {
          await userFn(mergedCtx as FlowContext<T, R> & Fixtures);
          return;
        }
        const fix = orderedFixtures[idx]!;
        let useCalled = false;
        let flowError: unknown;
        let hasFlowError = false;

        await fix.setup(mergedCtx as FlowContext<T, R> & Record<string, unknown>, async (val) => {
          useCalled = true;
          mergedCtx[fix.name] = val;
          try {
            await runChain(idx + 1);
          } catch (err) {
            flowError = err;
            hasFlowError = true;
          }
        });

        if (!useCalled) {
          throw new Error(`Fixture "${fix.name}" finished without calling use(value).`);
        }
        if (hasFlowError) {
          throw flowError;
        }
      };

      await runChain(0);
    };

    const { session: _session, uses: _uses, ...baseFlowConfig } = extConfig;
    return {
      name,
      config: baseFlowConfig,
      fn: wrappedFn,
    };
  }

  return extendedFlow;
}

// ── First-Class API Setup Client & Per-Persona Auth Cache ───────────────────

export interface ApiClientOptions {
  /** Base URL for API/test-control endpoints (e.g. `"http://localhost:3000/api"`). */
  baseUrl: string;
  /** Default headers attached to every request (e.g. `{ Authorization: "Bearer ..." }`). */
  headers?: Record<string, string>;
  /** Optional custom fetch implementation for testing. */
  fetchFn?: typeof fetch;
}

export interface ApiRequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
}

export interface ApiClient {
  get<T = unknown>(path: string, opts?: ApiRequestOptions): Promise<ApiResponse<T>>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    opts?: ApiRequestOptions,
  ): Promise<ApiResponse<T>>;
  put<T = unknown>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<ApiResponse<T>>;
  patch<T = unknown>(
    path: string,
    body?: unknown,
    opts?: ApiRequestOptions,
  ): Promise<ApiResponse<T>>;
  delete<T = unknown>(path: string, opts?: ApiRequestOptions): Promise<ApiResponse<T>>;
  /** Register an automatic teardown callback (runs in strict LIFO order on `cleanup()`). */
  onCleanup(fn: () => Promise<void> | void): void;
  /** Run all registered cleanup callbacks in reverse (LIFO) order and clear the queue. */
  cleanup(): Promise<void>;
}

/**
 * First-class HTTP client for seeding and tearing down test data via API/test-control
 * endpoints inside Spana flows and lazy fixtures (far faster than UI setup).
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const defaultHeaders = options.headers ?? {};
  const fetchFn = options.fetchFn ?? fetch;
  const cleanups: Array<() => Promise<void> | void> = [];

  const request = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> => {
    const cleanPath =
      path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `${baseUrl}/${path.replace(/^\/+/, "")}`;
    const url = new URL(cleanPath);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      ...defaultHeaders,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts?.headers,
    };

    const res = await fetchFn(url.toString(), {
      method,
      headers,
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    const contentType = res.headers.get("content-type") ?? "";
    let data: unknown;
    if (contentType.includes("application/json")) {
      data = await res.json().catch(() => null);
    } else {
      const text = await res.text().catch(() => "");
      try {
        data = text ? JSON.parse(text) : text;
      } catch {
        data = text;
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data: data as T,
    };
  };

  return {
    get: <T = unknown>(path: string, opts?: ApiRequestOptions) =>
      request<T>("GET", path, undefined, opts),
    post: <T = unknown>(path: string, body?: unknown, opts?: ApiRequestOptions) =>
      request<T>("POST", path, body, opts),
    put: <T = unknown>(path: string, body?: unknown, opts?: ApiRequestOptions) =>
      request<T>("PUT", path, body, opts),
    patch: <T = unknown>(path: string, body?: unknown, opts?: ApiRequestOptions) =>
      request<T>("PATCH", path, body, opts),
    delete: <T = unknown>(path: string, opts?: ApiRequestOptions) =>
      request<T>("DELETE", path, undefined, opts),
    onCleanup: (fn) => {
      cleanups.push(fn);
    },
    cleanup: async () => {
      const pending = cleanups.splice(0, cleanups.length).toReversed();
      const errors: unknown[] = [];
      for (const fn of pending) {
        try {
          await fn();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) {
        throw errors[0];
      }
    },
  };
}

/**
 * Convenience lazy fixture builder for `createFlowWithFixtures`:
 * provides a fresh `ApiClient` to each flow and automatically executes all
 * `api.onCleanup(...)` hooks in LIFO order even when the flow throws.
 */
export function createApiFixture<
  Deps extends Record<string, unknown> = Record<string, never>,
  T extends string = string,
  R extends string = string,
>(
  options: ApiClientOptions | ((ctx: FlowContext<T, R> & Deps) => ApiClientOptions),
): FixtureFn<ApiClient, Deps, T, R> {
  return async (ctx, use) => {
    const resolved = typeof options === "function" ? options(ctx) : options;
    const api = createApiClient(resolved);
    try {
      await use(api);
    } finally {
      await api.cleanup();
    }
  };
}

export interface PersonaDefinition<T extends string = string, R extends string = string> {
  name: string;
  /** Sign in once (via API, virtual passkey, or UI) and return storage entries or a saved storageStatePath. */
  signIn: (
    ctx: FlowContext<T, R>,
  ) => Promise<{ storage?: DomStorageEntries; storageStatePath?: string } | void>;
  /** Optional cache key discriminator (e.g. base URL or tenant ID). */
  cacheKey?: string;
  /** Optional route to navigate to after restoring cached auth state. */
  navigateTo?: R;
}

/** Define a reusable authenticated persona for `PersonaAuthCache`. */
export function definePersona<T extends string = string, R extends string = string>(
  name: string,
  config: Omit<PersonaDefinition<T, R>, "name">,
): PersonaDefinition<T, R> {
  return { name, ...config };
}

export interface CachedPersonaState {
  storage?: DomStorageEntries;
  storageStatePath?: string;
  cachedAt: number;
}

/**
 * In-memory per-persona auth state cache (single-flight safe across parallel workers).
 * Signs a persona in ONCE (including passkey / WebAuthn flows), caches its auth state,
 * and restores it in milliseconds across all remaining flows.
 */
export class PersonaAuthCache {
  private readonly cache = new Map<string, CachedPersonaState>();
  private readonly inflight = new Map<string, Promise<CachedPersonaState>>();

  private keyFor(persona: PersonaDefinition<any, any>): string {
    return `${persona.name}::${persona.cacheKey ?? "default"}`;
  }

  get(name: string, cacheKey = "default"): CachedPersonaState | undefined {
    return this.cache.get(`${name}::${cacheKey}`);
  }

  invalidate(name?: string, cacheKey = "default"): void {
    if (!name) {
      this.cache.clear();
      return;
    }
    this.cache.delete(`${name}::${cacheKey}`);
  }

  /**
   * Ensure `persona` is authenticated in `ctx`. On cache miss, executes `persona.signIn(ctx)`
   * once (coalescing concurrent callers); on cache hit, restores cookies/storageState directly.
   */
  async authenticate<T extends string = string, R extends string = string>(
    persona: PersonaDefinition<T, R>,
    ctx: FlowContext<T, R>,
  ): Promise<CachedPersonaState> {
    const key = this.keyFor(persona);
    let state = this.cache.get(key);
    let wasMiss = false;

    if (!state) {
      wasMiss = true;
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = (async () => {
          const produced = (await persona.signIn(ctx)) ?? {};
          const entry: CachedPersonaState = {
            storage: produced.storage,
            storageStatePath: produced.storageStatePath,
            cachedAt: Date.now(),
          };
          this.cache.set(key, entry);
          return entry;
        })().finally(() => {
          this.inflight.delete(key);
        });
        this.inflight.set(key, pending);
      }
      state = await pending;
    }

    const app = ctx.app as PromiseApp<T, R>;
    if (!wasMiss) {
      if (state.storageStatePath && ctx.platform === "web") {
        await app.loadAuthState(state.storageStatePath);
      }
      if (state.storage) {
        await app.setStorage(state.storage);
      }
    }
    if (persona.navigateTo) {
      await app.openLink(persona.navigateTo);
    }
    return state;
  }
}
