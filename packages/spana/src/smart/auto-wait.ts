import { Duration, Effect } from "effect";
import { type DriverError, ElementNotFoundError, WaitTimeoutError } from "../errors.js";
import type { Element } from "../schemas/element.js";
import type { Selector } from "../schemas/selector.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { findElement } from "./element-matcher.js";

export interface WaitOptions {
  timeout?: number; // default 5000ms
  pollInterval?: number; // default 200ms
  settleTimeout?: number; // default 500ms — wait for hierarchy to stabilize
}

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_POLL_INTERVAL = 200;

/** Parse a raw hierarchy string (JSON from web, XML from native — caller provides parser) */
type HierarchyParser = (raw: string) => Element;

/** Poll until an element matching selector is found */
export function waitForElement(
  driver: RawDriverService,
  selector: Selector,
  parse: HierarchyParser,
  opts?: WaitOptions,
): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;

  return Effect.gen(function* () {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const raw = yield* driver.dumpHierarchy();
      const root = parse(raw);
      const element = findElement(root, selector);
      if (element) return element;
      yield* Effect.sleep(Duration.millis(pollInterval));
    }
    return yield* new ElementNotFoundError({
      message: `Element not found within ${timeout}ms — selector: ${JSON.stringify(selector)}`,
      selector,
      timeoutMs: timeout,
    });
  });
}

/** Poll until element matching selector is NOT visible */
export function waitForNotVisible(
  driver: RawDriverService,
  selector: Selector,
  parse: HierarchyParser,
  opts?: WaitOptions,
): Effect.Effect<void, WaitTimeoutError | DriverError> {
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const pollInterval = opts?.pollInterval ?? DEFAULT_POLL_INTERVAL;

  return Effect.gen(function* () {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const raw = yield* driver.dumpHierarchy();
      const root = parse(raw);
      const element = findElement(root, selector);
      if (!element) return;
      yield* Effect.sleep(Duration.millis(pollInterval));
    }
    return yield* new WaitTimeoutError({
      message: `Element still visible after ${timeout}ms — selector: ${JSON.stringify(selector)}`,
      selector,
      timeoutMs: timeout,
    });
  });
}
