import { Duration, Effect } from "effect";
import { type DriverError, ElementNotFoundError, WaitTimeoutError } from "../errors.js";
import type { Element } from "../schemas/element.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import {
  findActionElementExtended,
  findElementExtended,
  formatSelector,
} from "./element-matcher.js";
import type { HierarchyCache } from "./hierarchy-cache.js";
import { diagnoseElementNotFound, formatDiagnostic } from "./diagnostics.js";

export interface WaitOptions {
  timeout?: number; // default 5000ms
  pollInterval?: number; // default 200ms
  settleTimeout?: number; // default 0ms — wait for hierarchy to stabilize before returning
  /** Starting poll interval for adaptive polling. Default: 50ms. Set equal to pollInterval to disable adaptive backoff. */
  initialPollInterval?: number;
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_POLL_INTERVAL = 200;
const DEFAULT_INITIAL_POLL_INTERVAL = 50;
const DEFAULT_SETTLE_TIMEOUT = 0;

/** Parse a raw hierarchy string (JSON from web, XML from native — caller provides parser) */
type HierarchyParser = (raw: string) => Element;

/** Get the hierarchy root — uses cache if provided, otherwise dumps fresh. */
// Generic on `<T, R>` so the wait helpers can be called from typed flow code
// without widening errors. None of the body actually uses T/R — we only need
// the parameters so `RawDriverService<T, R>` passes assignability checks.
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
  // Linear ramp from initial to max over the first half of the timeout
  const rampDuration = timeout / 2;
  const progress = Math.min(elapsed / rampDuration, 1);
  return Math.round(initial + (max - initial) * progress);
}

/** Poll until an element matching selector is found */
function waitForResolvedElement<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  resolveElement: (root: Element, selector: ExtendedSelector<T>) => Element | undefined,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const initialPollInterval = opts?.initialPollInterval ?? DEFAULT_INITIAL_POLL_INTERVAL;
  const settleTimeout = opts?.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT;

  return Effect.gen(function* () {
    const start = Date.now();
    // First iteration: use cache if available (element may already be visible)
    let isFirstPoll = true;
    while (Date.now() - start < timeout) {
      // After the first poll, invalidate cache so subsequent polls get fresh data
      if (!isFirstPoll && cache) cache.invalidate();
      isFirstPoll = false;

      const root = yield* getHierarchy(driver, parse, cache);
      const element = resolveElement(root, selector);
      if (element) {
        if (settleTimeout > 0) {
          // Wait, then re-check with fresh data to ensure the element is stable
          yield* Effect.sleep(Duration.millis(settleTimeout));
          if (cache) cache.invalidate();
          const settledRoot = yield* getHierarchy(driver, parse, cache);
          const settledElement = resolveElement(settledRoot, selector);
          if (settledElement) return settledElement;
          // Element disappeared during settle — keep polling
        } else {
          return element;
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

/** Poll until an element matching selector is found. */
export function waitForElement<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedElement(driver, selector, parse, findElementExtended, opts, cache);
}

/** Poll until an actionable element matching selector is found. */
export function waitForActionElement<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  selector: ExtendedSelector<T>,
  parse: HierarchyParser,
  opts?: WaitOptions,
  cache?: HierarchyCache,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  return waitForResolvedElement(driver, selector, parse, findActionElementExtended, opts, cache);
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
    let isFirstPoll = true;
    while (Date.now() - start < timeout) {
      if (!isFirstPoll && cache) cache.invalidate();
      isFirstPoll = false;

      const root = yield* getHierarchy(driver, parse, cache);
      const element = findElementExtended(root, selector);
      if (!element) return;
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
