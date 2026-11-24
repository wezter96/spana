import { Duration, Effect } from "effect";
import { type DriverError, ElementNotFoundError, WaitTimeoutError } from "../errors.js";
import type { Element } from "../schemas/element.js";
import type { ExtendedSelector, Platform, TapMode } from "../schemas/selector.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { formatSelector } from "./element-matcher.js";
import type { HierarchyCache } from "./hierarchy-cache.js";
import { diagnoseElementNotFound, formatDiagnostic } from "./diagnostics.js";
import { resolveElementAcrossChannels, type ResolvedElementResult } from "./channel-resolver.js";

export interface WaitOptions {
  timeout?: number; // default 5000ms
  pollInterval?: number; // default 200ms
  settleTimeout?: number; // default 0ms — wait for hierarchy to stabilize before returning
  /** Starting poll interval for adaptive polling. Default: 50ms. Set equal to pollInterval to disable adaptive backoff. */
  initialPollInterval?: number;
  /** Tap dispatch mode when resolved via DOM channel: "native" (default, real touch) or "dom" (fast synthetic click). */
  tapMode?: TapMode;
  /** Platform hint for coordinate scaling (android physical px vs ios logical pt). */
  platform?: Platform;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_POLL_INTERVAL = 200;
const DEFAULT_INITIAL_POLL_INTERVAL = 50;
const DEFAULT_SETTLE_TIMEOUT = 0;

/** Parse a raw hierarchy string (JSON from web, XML from native — caller provides parser) */
type HierarchyParser = (raw: string) => Element;

/** Get the hierarchy root — uses cache if provided, otherwise dumps fresh. */
function getHierarchy<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  parse: HierarchyParser,
  cache?: HierarchyCache,
): Effect.Effect<Element, DriverError> {
  if (cache) return cache.get(driver as unknown as RawDriverService, parse);
  return Effect.gen(function* () {
    const raw = yield* driver.dumpHierarchy();
    return parse(raw);
  });
}

/** Calculate next poll interval with linear backoff from initial to max. */
function nextInterval(elapsed: number, timeout: number, initial: number, max: number): number {
  if (initial >= max) return max;
  const rampDuration = timeout / 2;
  const progress = Math.min(elapsed / rampDuration, 1);
  return Math.round(initial + (max - initial) * progress);
}

/** Wait for `bridge.idle()` when a connected DOM channel supports it (non-fatal). */
function maybeWaitForBridgeIdle<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  timeout: number,
): Effect.Effect<void> {
  const domChannel = driver.domChannel;
  if (!domChannel || !domChannel.isConnected() || !domChannel.waitForIdle) {
    return Effect.void;
  }
  return Effect.tryPromise({
    try: () => domChannel.waitForIdle!({ timeout: Math.min(timeout, 2500) }),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void));
}

/** Poll until an element matching selector is resolved via DOM or native channel. */
function waitForResolvedAcrossChannels<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  forAction: boolean,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<ResolvedElementResult, ElementNotFoundError | WaitTimeoutError | DriverError> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const initialPollInterval = opts?.initialPollInterval ?? DEFAULT_INITIAL_POLL_INTERVAL;
  const settleTimeout = opts?.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT;

  return Effect.gen(function* () {
    const start = Date.now();
    // If spana-bridge is connected, wait for app idle before starting retry loops
    yield* maybeWaitForBridgeIdle(driver, timeout);

    let isFirstPoll = true;
    while (Date.now() - start < timeout) {
      if (!isFirstPoll && cache) cache.invalidate();
      isFirstPoll = false;

      const resolved = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
        forAction,
        tapMode: opts?.tapMode,
        platform: opts?.platform,
      });

      if (resolved) {
        if (settleTimeout > 0) {
          yield* Effect.sleep(Duration.millis(settleTimeout));
          if (cache) cache.invalidate();
          const settled = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
            forAction,
            tapMode: opts?.tapMode,
            platform: opts?.platform,
          });
          if (settled) return settled;
        } else {
          return resolved;
        }
      }
      const elapsed = Date.now() - start;
      const interval = nextInterval(elapsed, timeout, initialPollInterval, pollInterval);
      yield* Effect.sleep(Duration.millis(interval));
    }

    // Capture diagnostic info from the last hierarchy
    if (cache) cache.invalidate();
    const diagRoot = yield* getHierarchy(driver, parse, cache);
    const diagnostic = diagnoseElementNotFound(diagRoot, selector);
    const diagMessage = formatDiagnostic(diagnostic);

    return yield* new ElementNotFoundError({
      message: `Element not found within ${timeout}ms — selector: ${formatSelector(selector)}\n${diagMessage}`,
      selector,
      timeoutMs: timeout,
    });
  });
}

/** Poll until an element matching selector is found (returns resolved metadata). */
export function waitForResolvedElementResult<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  forAction: boolean,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<ResolvedElementResult, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedAcrossChannels(driver, selector, parse, forAction, opts, cache);
}

/** Poll until an element matching selector is found. */
export function waitForElement<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedAcrossChannels(driver, selector, parse, false, opts, cache).pipe(
    Effect.map((r) => r.element),
  );
}

/** Poll until an actionable element matching selector is found. */
export function waitForActionElement<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedAcrossChannels(driver, selector, parse, true, opts, cache).pipe(
    Effect.map((r) => r.element),
  );
}

/** Poll until element matching selector is NOT visible */
export function waitForNotVisible<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<void, WaitTimeoutError | DriverError> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const initialPollInterval = opts?.initialPollInterval ?? DEFAULT_INITIAL_POLL_INTERVAL;

  return Effect.gen(function* () {
    const start = Date.now();
    yield* maybeWaitForBridgeIdle(driver, timeout);

    let isFirstPoll = true;
    while (Date.now() - start < timeout) {
      if (!isFirstPoll && cache) cache.invalidate();
      isFirstPoll = false;

      const resolved = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
        forAction: false,
        platform: opts?.platform,
      });
      if (!resolved) return;

      const elapsed = Date.now() - start;
      const interval = nextInterval(elapsed, timeout, initialPollInterval, pollInterval);
      yield* Effect.sleep(Duration.millis(interval));
    }
    return yield* new WaitTimeoutError({
      message: `Element still visible after ${timeout}ms — selector: ${formatSelector(selector)}`,
      selector,
      timeoutMs: timeout,
    });
  });
}
