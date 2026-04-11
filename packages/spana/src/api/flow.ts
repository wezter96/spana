import type { ExtendedSelector, Platform } from "../schemas/selector.js";
import type { ArtifactConfig } from "../schemas/config.js";
import type { LaunchOptions } from "../drivers/raw-driver.js";
import type { PromiseApp } from "./app.js";
import type { PromiseExpectation } from "./expect.js";

export interface WhenCondition {
  /** Only run on these platforms */
  platform?: Platform | Platform[];
  /** Only run when this environment variable is set */
  env?: string;
}

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

export interface FlowConfig<R extends string = string> {
  tags?: string[];
  platforms?: Platform[];
  timeout?: number;
  autoLaunch?: boolean; // default true
  /** Per-flow launch defaults. Merged with project launchOptions and manual app.launch() calls. */
  launchOptions?: LaunchOptions<R>;
  artifacts?: ArtifactConfig;
  when?: WhenCondition;
  /** Per-flow overrides for timing defaults. Merged with global defaults. */
  defaults?: FlowDefaults;
}

export interface FlowContext<T extends string = string, R extends string = string> {
  app: PromiseApp<T, R>;
  expect: (selector: ExtendedSelector<T>) => PromiseExpectation<T>;
  platform: Platform;
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

/** Helper to create a typed flow function for your project. */
export function createFlow<T extends string = string, R extends string = string>() {
  return flow<T, R>;
}
