import { AsyncLocalStorage } from "node:async_hooks";
import type { FlowConfig, FlowContext, FlowDefinition, FlowFn } from "./flow.js";
import type { StepRecorder } from "../core/step-recorder.js";

const activeStepRecorderStorage = new AsyncLocalStorage<StepRecorder>();

/** Run a flow body with an active `StepRecorder` bound so standalone `step(name, fn)` calls record cleanly. */
export function withActiveStepRecorder<A>(
  recorder: StepRecorder,
  fn: () => Promise<A>,
): Promise<A> {
  return activeStepRecorderStorage.run(recorder, fn);
}

/**
 * Group related actions & assertions inside a flow into a named step in reports and Trace Viewer.
 * Can be used standalone (`import { step } from "spana-test"`) or via `ctx.step(...)`.
 */
export async function step<A>(name: string, fn: () => Promise<A>): Promise<A> {
  const recorder = activeStepRecorderStorage.getStore();
  if (!recorder) {
    return fn();
  }
  return recorder.runStep(`step(${name})`, fn, { captureScreenshot: false });
}

export interface SuiteConfig<R extends string = string> extends FlowConfig<R> {
  /** Hook executed once before the first flow in this suite runs. */
  beforeAll?: (ctx: FlowContext<any, R>) => Promise<void>;
  /** Hook executed before every flow in this suite. */
  beforeEach?: (ctx: FlowContext<any, R>) => Promise<void>;
  /** Hook executed after every flow in this suite (even on failure). */
  afterEach?: (ctx: FlowContext<any, R>) => Promise<void>;
  /** Hook executed once after the last flow in this suite finishes. */
  afterAll?: (ctx: FlowContext<any, R>) => Promise<void>;
}

export interface SuiteBuilder<T extends string = string, R extends string = string> {
  flow(name: string, fn: FlowFn<T, R>): void;
  flow(name: string, config: FlowConfig<R>, fn: FlowFn<T, R>): void;
  skip(name: string, fn: FlowFn<T, R>): void;
  skip(name: string, config: FlowConfig<R>, fn: FlowFn<T, R>): void;
  only(name: string, fn: FlowFn<T, R>): void;
  only(name: string, config: FlowConfig<R>, fn: FlowFn<T, R>): void;
  fixme(name: string, fn: FlowFn<T, R>): void;
  fixme(name: string, config: FlowConfig<R>, fn: FlowFn<T, R>): void;
  beforeAll(fn: (ctx: FlowContext<T, R>) => Promise<void>): void;
  beforeEach(fn: (ctx: FlowContext<T, R>) => Promise<void>): void;
  afterEach(fn: (ctx: FlowContext<T, R>) => Promise<void>): void;
  afterAll(fn: (ctx: FlowContext<T, R>) => Promise<void>): void;
  suite(name: string, define: (nested: SuiteBuilder<T, R>) => void): void;
  suite(name: string, config: SuiteConfig<R>, define: (nested: SuiteBuilder<T, R>) => void): void;
}

function mergeFlowConfigs<R extends string>(
  parent: FlowConfig<R>,
  child: FlowConfig<R>,
): FlowConfig<R> {
  const mergedTags =
    parent.tags || child.tags
      ? Array.from(new Set([...(parent.tags ?? []), ...(child.tags ?? [])]))
      : undefined;
  return {
    ...parent,
    ...child,
    ...(mergedTags ? { tags: mergedTags } : {}),
    ...(parent.defaults || child.defaults
      ? { defaults: { ...parent.defaults, ...child.defaults } }
      : {}),
    ...(parent.artifacts || child.artifacts
      ? { artifacts: { ...parent.artifacts, ...child.artifacts } }
      : {}),
  };
}

/**
 * Group multiple related flows into a named suite with shared config, tags, nested suites,
 * and `beforeAll` / `beforeEach` / `afterEach` / `afterAll` lifecycle hooks.
 *
 * Export the returned `FlowDefinition[]` as the default export of a `.flow.ts` file:
 * ```ts
 * export default suite("Checkout", { tags: ["smoke"] }, (s) => {
 *   s.beforeEach(async ({ app }) => { await app.openLink("/cart"); });
 *   s.flow("applies promo code", async ({ app, expect }) => { ... });
 * });
 * ```
 */
export function suite<T extends string = string, R extends string = string>(
  name: string,
  define: (s: SuiteBuilder<T, R>) => void,
): FlowDefinition<T, R>[];
export function suite<T extends string = string, R extends string = string>(
  name: string,
  config: SuiteConfig<R>,
  define: (s: SuiteBuilder<T, R>) => void,
): FlowDefinition<T, R>[];
export function suite<T extends string = string, R extends string = string>(
  name: string,
  configOrDefine: SuiteConfig<R> | ((s: SuiteBuilder<T, R>) => void),
  maybeDefine?: (s: SuiteBuilder<T, R>) => void,
): FlowDefinition<T, R>[] {
  const suiteConfig: SuiteConfig<R> = typeof configOrDefine === "function" ? {} : configOrDefine;
  const define = typeof configOrDefine === "function" ? configOrDefine : maybeDefine!;

  const {
    beforeAll: cfgBeforeAll,
    beforeEach: cfgBeforeEach,
    afterEach: cfgAfterEach,
    afterAll: cfgAfterAll,
    ...baseFlowConfig
  } = suiteConfig;

  const beforeAllHooks: Array<(ctx: FlowContext<T, R>) => Promise<void>> = cfgBeforeAll
    ? [cfgBeforeAll]
    : [];
  const beforeEachHooks: Array<(ctx: FlowContext<T, R>) => Promise<void>> = cfgBeforeEach
    ? [cfgBeforeEach]
    : [];
  const afterEachHooks: Array<(ctx: FlowContext<T, R>) => Promise<void>> = cfgAfterEach
    ? [cfgAfterEach]
    : [];
  const afterAllHooks: Array<(ctx: FlowContext<T, R>) => Promise<void>> = cfgAfterAll
    ? [cfgAfterAll]
    : [];

  const rawFlows: FlowDefinition<T, R>[] = [];

  const registerFlow = (
    flowName: string,
    configOrFn: FlowConfig<R> | FlowFn<T, R>,
    maybeFn?: FlowFn<T, R>,
    modifier?: "skip" | "only" | "fixme",
  ) => {
    const childCfg: FlowConfig<R> = typeof configOrFn === "function" ? {} : configOrFn;
    const fn = typeof configOrFn === "function" ? configOrFn : maybeFn!;
    const mergedCfg = mergeFlowConfigs(baseFlowConfig, {
      ...childCfg,
      ...(modifier ? { [modifier]: childCfg[modifier] ?? true } : {}),
    });
    rawFlows.push({
      name: `${name} > ${flowName}`,
      config: mergedCfg,
      fn,
    });
  };

  const builder: SuiteBuilder<T, R> = {
    flow(flowName: string, a: FlowConfig<R> | FlowFn<T, R>, b?: FlowFn<T, R>) {
      registerFlow(flowName, a, b);
    },
    skip(flowName: string, a: FlowConfig<R> | FlowFn<T, R>, b?: FlowFn<T, R>) {
      registerFlow(flowName, a, b, "skip");
    },
    only(flowName: string, a: FlowConfig<R> | FlowFn<T, R>, b?: FlowFn<T, R>) {
      registerFlow(flowName, a, b, "only");
    },
    fixme(flowName: string, a: FlowConfig<R> | FlowFn<T, R>, b?: FlowFn<T, R>) {
      registerFlow(flowName, a, b, "fixme");
    },
    beforeAll(fn) {
      beforeAllHooks.push(fn);
    },
    beforeEach(fn) {
      beforeEachHooks.push(fn);
    },
    afterEach(fn) {
      afterEachHooks.push(fn);
    },
    afterAll(fn) {
      afterAllHooks.push(fn);
    },
    suite(
      nestedName: string,
      a: SuiteConfig<R> | ((s: SuiteBuilder<T, R>) => void),
      b?: (s: SuiteBuilder<T, R>) => void,
    ) {
      const nestedFlows =
        typeof a === "function" ? suite<T, R>(nestedName, a) : suite<T, R>(nestedName, a, b!);
      for (const nf of nestedFlows) {
        rawFlows.push({
          ...nf,
          name: `${name} > ${nf.name}`,
          config: mergeFlowConfigs(baseFlowConfig, nf.config),
        });
      }
    },
  };

  define(builder);

  let ranBeforeAll = false;
  let completedCount = 0;
  const totalRunnable = rawFlows.filter((f) => !f.config.skip && !f.config.fixme).length;

  return rawFlows.map((entry) => {
    const innerFn = entry.fn;
    const wrappedFn: FlowFn<T, R> = async (ctx) => {
      if (!ranBeforeAll && beforeAllHooks.length > 0) {
        ranBeforeAll = true;
        for (const hook of beforeAllHooks) {
          await hook(ctx);
        }
      }
      for (const hook of beforeEachHooks) {
        await hook(ctx);
      }
      let flowError: unknown;
      let threw = false;
      try {
        await innerFn(ctx);
      } catch (err) {
        threw = true;
        flowError = err;
      } finally {
        for (const hook of afterEachHooks) {
          await hook(ctx);
        }
        completedCount += 1;
        if (completedCount >= Math.max(1, totalRunnable) && afterAllHooks.length > 0) {
          for (const hook of afterAllHooks) {
            await hook(ctx);
          }
        }
      }
      if (threw) throw flowError;
    };

    return {
      ...entry,
      fn: wrappedFn,
    };
  });
}
