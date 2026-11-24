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
