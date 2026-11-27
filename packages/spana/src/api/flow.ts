import type { Platform } from "../schemas/selector.js";
import type { ArtifactConfig, WebViewportConfig } from "../schemas/config.js";
import type { LaunchOptions } from "../drivers/raw-driver.js";
import type { PromiseApp } from "./app.js";
import type { PromiseExpectFn } from "./expect.js";
import type { FlowAgent } from "./agent-fixture.js";
import type { Sessions } from "../core/session-manager.js";

/**
 * Thrown by runtime `ctx.skip(reason?)` / `flow.skip(reason?)` inside a flow body.
 * Caught by the runner and reported cleanly as `status: "skipped"` (not failed or passed).
 */
export class FlowSkippedError extends Error {
  readonly _tag = "FlowSkippedError" as const;
  readonly reason?: string;

  constructor(reason?: string) {
    super(reason ? `Flow skipped: ${reason}` : "Flow skipped");
    this.name = "FlowSkippedError";
    this.reason = reason;
  }
}

export function isFlowSkippedError(error: unknown): error is FlowSkippedError {
  return (
    error instanceof FlowSkippedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { _tag?: unknown })._tag === "FlowSkippedError")
  );
}

export interface WhenCondition {
  /** Only run on these platforms */
  platform?: Platform | Platform[];
  /** Only run when this environment variable is set */
  env?: string;
}

export type FlowSkipCondition = boolean | (WhenCondition & { reason?: string });

export interface FlowDefaults {
  waitTimeout?: number;
  pollInterval?: number;
  settleTimeout?: number;
  waitForIdleTimeout?: number;
  typingDelay?: number;
  /** Starting poll interval for adaptive backoff. Default: 50ms. */
  initialPollInterval?: number;
  /** Hierarchy cache TTL in ms. Default: 100. Set to 0 to disable. */
  hierarchyCacheTtl?: number;
}

export interface FlowAnnotation {
  type: string;
  description?: string;
}

export interface FlowConfig<R extends string = string> {
  tags?: string[];
  /** Optional structured annotations included in JSON and JUnit reports. */
  annotations?: FlowAnnotation[];
  platforms?: Platform[];
  timeout?: number;
  autoLaunch?: boolean; // default true
  /** Per-flow launch defaults. Merged with project launchOptions and manual app.launch() calls. */
  launchOptions?: LaunchOptions<R>;
  /** Per-flow base URL overriding `apps.web.url` for relative paths in this flow. */
  baseUrl?: string;
  /** Per-flow viewport (with optional mobile/DPR/touch fields) applied before the first navigation on web. */
  viewport?: WebViewportConfig;
  /** Per-flow device pixel ratio override on web. */
  deviceScaleFactor?: number;
  /** Per-flow mobile emulation flag on web (`mobile` alias also supported in `viewport`). */
  isMobile?: boolean;
  /** Per-flow touch emulation flag on web. */
  hasTouch?: boolean;
  /** Per-flow locale applied before the first navigation on web (e.g. `"sv-SE"`). */
  locale?: string;
  /** Per-flow User-Agent override applied before the first navigation on web. */
  userAgent?: string;
  artifacts?: ArtifactConfig;
  when?: WhenCondition;
  skip?: FlowSkipCondition;
  fixme?: FlowSkipCondition;
  /** Mark this flow as expected to fail (Playwright `test.fail()`). Fails the run if the flow passes unexpectedly. */
  fail?: FlowSkipCondition;
  only?: boolean;
  retries?: number;
  /** Per-flow overrides for timing defaults. Merged with global defaults. */
  defaults?: FlowDefaults;
  /** Internal serial suite identifier (set by `suite.serial()` / `suite(name, { mode: "serial" })`). */
  serialGroup?: string;
}

export interface FlowContext<T extends string = string, R extends string = string> {
  app: PromiseApp<T, R>;
  expect: PromiseExpectFn<T>;
  platform: Platform;
  sessions: Sessions;
  /** Zero-based unique worker index across all workers/processes in the run (like Playwright `testInfo.workerIndex`). */
  workerIndex: number;
  /** Zero-based slot index within active parallel workers (`0..workers-1`, like Playwright `testInfo.parallelIndex`). */
  parallelIndex: number;
  /** First-class verified replay-cache AI agent fixture (`agent.act()`, `agent.verify()`, `agent.extract()`). */
  agent?: FlowAgent;
  /** Group related actions into a named nested step in reports and Trace Viewer. */
  step?: <A>(name: string, fn: () => Promise<A>) => Promise<A>;
  /**
   * Dynamically skip the current flow at runtime (reported cleanly as `skipped`, not failed or passed).
   * - `ctx.skip("reason")` — skip immediately with an optional reason.
   * - `ctx.skip(condition, "reason")` — skip only when `condition` is true (Playwright `test.skip` ergonomics).
   */
  skip: {
    (reason?: string): never;
    (condition: boolean, reason?: string): void;
  };
}

export type FlowFn<T extends string = string, R extends string = string> = (
  ctx: FlowContext<T, R>,
) => Promise<void>;

export interface FlowDefinition<T extends string = string, R extends string = string> {
  name: string;
  fn: FlowFn<T, R>;
  config: FlowConfig<R>;
  sourcePath?: string;
}

// Overloads: flow(name, fn) and flow(name, config, fn)
export function flow<T extends string = string, R extends string = string>(
  name: string,
  fn: FlowFn<T, R>,
): FlowDefinition<T, R>;
export function flow<T extends string = string, R extends string = string>(
  name: string,
  config: FlowConfig<R>,
  fn: FlowFn<T, R>,
): FlowDefinition<T, R>;
export function flow<T extends string = string, R extends string = string>(
  name: string,
  configOrFn: FlowConfig<R> | FlowFn<T, R>,
  maybeFn?: FlowFn<T, R>,
): FlowDefinition<T, R> {
  if (typeof configOrFn === "function") {
    return { name, fn: configOrFn, config: {} };
  }
  return { name, fn: maybeFn!, config: configOrFn };
}

function modifyFlow(modifier: "skip" | "fixme" | "only" | "fail") {
  function modified<T extends string = string, R extends string = string>(
    name: string,
    fn: FlowFn<T, R>,
  ): FlowDefinition<T, R>;
  function modified<T extends string = string, R extends string = string>(
    name: string,
    config: FlowConfig<R>,
    fn: FlowFn<T, R>,
  ): FlowDefinition<T, R>;
  function modified<T extends string = string, R extends string = string>(
    name: string,
    configOrFn: FlowConfig<R> | FlowFn<T, R>,
    maybeFn?: FlowFn<T, R>,
  ) {
    const config = typeof configOrFn === "function" ? {} : configOrFn;
    const fn = typeof configOrFn === "function" ? configOrFn : maybeFn!;
    return flow(name, { ...config, [modifier]: config[modifier] ?? true }, fn);
  }
  return modified;
}

function skipModifierOrRuntime<T extends string = string, R extends string = string>(
  name: string,
  fn: FlowFn<T, R>,
): FlowDefinition<T, R>;
function skipModifierOrRuntime<T extends string = string, R extends string = string>(
  name: string,
  config: FlowConfig<R>,
  fn: FlowFn<T, R>,
): FlowDefinition<T, R>;
function skipModifierOrRuntime(reason?: string): never;
function skipModifierOrRuntime(condition: boolean, reason?: string): void;
function skipModifierOrRuntime<T extends string = string, R extends string = string>(
  nameOrCondition?: string | boolean,
  configOrFnOrReason?: FlowConfig<R> | FlowFn<T, R> | string,
  maybeFn?: FlowFn<T, R>,
): FlowDefinition<T, R> | void {
  // Runtime call inside a flow body:
  //   flow.skip()
  //   flow.skip("reason")
  //   flow.skip(condition, "reason")
  if (typeof nameOrCondition === "boolean") {
    if (nameOrCondition) {
      throw new FlowSkippedError(
        typeof configOrFnOrReason === "string" ? configOrFnOrReason : undefined,
      );
    }
    return;
  }
  if (nameOrCondition === undefined || configOrFnOrReason === undefined) {
    throw new FlowSkippedError(nameOrCondition);
  }
  // Static flow definition modifier: flow.skip(name, fn) or flow.skip(name, config, fn)
  const config =
    typeof configOrFnOrReason === "function" ? {} : (configOrFnOrReason as FlowConfig<R>);
  const fn =
    typeof configOrFnOrReason === "function" ? (configOrFnOrReason as FlowFn<T, R>) : maybeFn!;
  return flow(nameOrCondition, { ...config, skip: config.skip ?? true }, fn);
}

export namespace flow {
  export const skip = skipModifierOrRuntime;
  export const fixme = modifyFlow("fixme");
  export const only = modifyFlow("only");
  export const fail = modifyFlow("fail");
}

/** Helper to create a typed flow function for your project. */
export function createFlow<T extends string = string, R extends string = string>() {
  return flow<T, R>;
}
