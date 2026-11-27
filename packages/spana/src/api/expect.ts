import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { Effect } from "effect";
import { assertDataSnapshot, type DataSnapshotOptions } from "./snapshots.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { isRelativeSelector, type ExtendedSelector } from "../schemas/selector.js";
import { createCoordinator, type CoordinatorConfig } from "../smart/coordinator.js";
import type { WaitOptions } from "../smart/auto-wait.js";
import type { StepRecorder } from "../core/step-recorder.js";
import {
  formatByteSize,
  isWasmTrapError,
  parseByteSize,
  type WasmMetrics,
  type WasmTrap,
} from "../drivers/wasm-utils.js";

export interface FlowContext {
  flowFilePath: string;
  flowName: string;
  platform: string;
  updateBaselines?: boolean;
  /** Remaining flow deadline timestamp (ms since epoch) used as default timeout for `toPass()` / `expect.poll()`. */
  flowDeadlineMs?: number;
  /** Explicit default timeout for `toPass()` / `expect.poll()`. */
  toPassTimeout?: number;
  recordSoftFailure?: (error: unknown) => void;
}

export interface NegatedPromiseExpectation {
  toBeVisible(opts?: WaitOptions): Promise<void>;
  toBeHidden(opts?: WaitOptions): Promise<void>;
  toBeAttached(opts?: WaitOptions): Promise<void>;
  toBeInViewport(opts?: WaitOptions): Promise<void>;
  toHaveText(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  toMatchText(pattern: RegExp, opts?: WaitOptions): Promise<void>;
  toHaveValue(expected: string | number | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveAttribute(name: string, value?: string | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveJSProperty(name: string, value: unknown, opts?: WaitOptions): Promise<void>;
  toBeEnabled(opts?: WaitOptions): Promise<void>;
  toBeDisabled(opts?: WaitOptions): Promise<void>;
  toContainText(expected: string, opts?: WaitOptions & { ignoreCase?: boolean }): Promise<void>;
  toHaveCount(expected: number, opts?: WaitOptions & { visible?: boolean }): Promise<void>;
  toHaveVisibleCount(expected: number, opts?: WaitOptions): Promise<void>;
  toBeFocused(opts?: WaitOptions): Promise<void>;
  toBeChecked(opts?: WaitOptions): Promise<void>;
  toBeEditable(opts?: WaitOptions): Promise<void>;
  toBeEmpty(opts?: WaitOptions): Promise<void>;
  toHaveClass(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveCSS(property: string, expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveAccessibleName(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveAccessibleDescription(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveRole(expected: string, opts?: WaitOptions): Promise<void>;
}

export interface PromiseExpectation<T extends string = string> {
  toBeVisible(opts?: WaitOptions): Promise<void>;
  toBeHidden(opts?: WaitOptions): Promise<void>;
  /** Assert that at least one matching element is attached to the DOM (visible or hidden). */
  toBeAttached(opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element intersects the current viewport. */
  toBeInViewport(opts?: WaitOptions): Promise<void>;
  toHaveText(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  toMatchText(pattern: RegExp, opts?: WaitOptions): Promise<void>;
  toHaveValue(expected: string | number | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveAttribute(name: string, value?: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Assert that the matched DOM element's JS property equals `value`. */
  toHaveJSProperty(name: string, value: unknown, opts?: WaitOptions): Promise<void>;
  toBeEnabled(opts?: WaitOptions): Promise<void>;
  toBeDisabled(opts?: WaitOptions): Promise<void>;
  /** Case-sensitive substring match on whitespace-normalized text (pass `{ ignoreCase: true }` for case-insensitive). */
  toContainText(expected: string, opts?: WaitOptions & { ignoreCase?: boolean }): Promise<void>;
  /** Assert that the total number of matching elements (visible + hidden, or visible-only with `{ visible: true }`) equals `expected`. */
  toHaveCount(expected: number, opts?: WaitOptions & { visible?: boolean }): Promise<void>;
  /** Assert that the number of visible matching elements equals `expected`. */
  toHaveVisibleCount(expected: number, opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element currently has focus (`document.activeElement`). */
  toBeFocused(opts?: WaitOptions): Promise<void>;
  /** Assert that a checkbox/radio/switch element is checked. */
  toBeChecked(opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element is enabled and editable. */
  toBeEditable(opts?: WaitOptions): Promise<void>;
  /** Assert that the matched input/container has empty value/text. */
  toBeEmpty(opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element has the expected CSS class token(s) or matches a RegExp. */
  toHaveClass(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element's computed CSS property matches expected value or RegExp. */
  toHaveCSS(property: string, expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element's computed accessible name matches string or RegExp. */
  toHaveAccessibleName(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element's computed accessible description matches string or RegExp. */
  toHaveAccessibleDescription(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Negated assertion chain (`expect(selector).not.*`). */
  readonly not: NegatedPromiseExpectation;
  toMatchAriaSnapshot(
    expected: string | { path: string },
    opts?: RetryAssertionOptions,
  ): Promise<void>;

  // Visual regression
  toMatchScreenshot(
    name: string,
    options?: {
      threshold?: number;
      maxDiffPixelRatio?: number;
      mask?: ExtendedSelector<T>[];
      fullPage?: boolean;
    },
  ): Promise<void>;

  // Accessibility
  toPassAccessibilityAudit(options?: {
    severity?: "critical" | "serious" | "moderate" | "minor";
    rules?: string[];
    disableRules?: string[];
    tags?: string[];
    include?: ExtendedSelector<T>[];
    exclude?: ExtendedSelector<T>[];
  }): Promise<void>;

  toHaveAccessibilityLabel(expected?: string): Promise<void>;
  toBeFocusable(): Promise<void>;
  toHaveRole(expected: string, opts?: WaitOptions): Promise<void>;
  toHaveMinTouchTarget(size?: number): Promise<void>;
}

export interface RetryAssertionOptions {
  /** Total timeout in ms before failing. Default: 5000. */
  timeout?: number;
  /** Backoff intervals in ms between retries. Default: [50, 100, 250, 500]. */
  intervals?: number[];
}

export interface ToPassExpectation {
  /** Retry the callback until it completes without throwing (Playwright `expect(fn).toPass()`). */
  toPass(opts?: RetryAssertionOptions): Promise<void>;
}

export interface PollMatchers<V> {
  toBe(expected: V): Promise<void>;
  toEqual(expected: V): Promise<void>;
  toContain(expected: unknown): Promise<void>;
  toMatch(pattern: string | RegExp): Promise<void>;
  toBeGreaterThan(expected: number): Promise<void>;
  toBeLessThan(expected: number): Promise<void>;
  toBeGreaterThanOrEqual(expected: number): Promise<void>;
  toBeLessThanOrEqual(expected: number): Promise<void>;
  toBeTruthy(): Promise<void>;
  toBeFalsy(): Promise<void>;
  toBeDefined(): Promise<void>;
  toBeUndefined(): Promise<void>;
  toBeNull(): Promise<void>;
  toHaveLength(expected: number): Promise<void>;
}

export interface PollExpectation<V> extends PollMatchers<V> {
  readonly not: PollMatchers<V>;
}

/** Callable `expect(selector)` / `expect(fn).toPass()` helper with `expect.poll(...)` and `expect.toHaveURL(...)`. */
export interface PromiseExpectFn<T extends string = string> {
  (selector: ExtendedSelector<T>): PromiseExpectation<T>;
  (fn: () => unknown | Promise<unknown>): ToPassExpectation;
  soft: ((selector: ExtendedSelector<T>) => PromiseExpectation<T>) & {
    toHaveURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
    toHaveTitle(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
    noWasmTraps(): Promise<void>;
    wasmMemoryBelow(limit: number | string): Promise<void>;
    minFps(minFps: number, opts?: { durationMs?: number }): Promise<void>;
  };
  /** Assert that the current page URL matches a substring/exact string or RegExp. */
  toHaveURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Assert that the current document title matches exact string or RegExp. */
  toHaveTitle(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Assert that zero WebAssembly traps occurred on main thread or any attached Web Worker. */
  noWasmTraps(): Promise<void>;
  /** Assert that live WebAssembly linear memory usage is below `limit` (bytes or e.g. `"64MB"`, `"128MiB"`). */
  wasmMemoryBelow(limit: number | string): Promise<void>;
  /** Sample `requestAnimationFrame` cadence over `durationMs` (default 500ms) and assert FPS >= `minFps`. */
  minFps(minFps: number, opts?: { durationMs?: number }): Promise<void>;
  /** Negated page-level matchers (`expect.not.toHaveURL(...)`, `expect.not.toHaveTitle(...)`). */
  readonly not: {
    toHaveURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
    toHaveTitle(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  };
  /** Poll an async/sync getter until the chained matcher passes (Playwright `expect.poll(fn)`). */
  poll<V>(fn: () => V | Promise<V>, opts?: RetryAssertionOptions): PollExpectation<V>;
  /** Assert that a string or JSON-serializable object matches a persisted disk snapshot. */
  toMatchSnapshot(actual: unknown, name: string, opts?: DataSnapshotOptions): Promise<void>;
}

function selectorToCss<T extends string = string>(sel: ExtendedSelector<T>): string {
  if (typeof sel === "string") return sel;
  if (typeof sel === "object" && sel !== null && "css" in sel && sel.css) return sel.css;
  if (typeof sel === "object" && sel !== null && "testID" in sel && sel.testID)
    return `[data-testid="${sel.testID}"]`;
  if (
    typeof sel === "object" &&
    sel !== null &&
    "accessibilityLabel" in sel &&
    sel.accessibilityLabel
  )
    return `[aria-label="${sel.accessibilityLabel}"]`;
  return "";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof RegExp && b instanceof RegExp)
    return a.source === b.source && a.flags === b.flags;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(b, k) ||
      !deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    ) {
      return false;
    }
  }
  return true;
}

const retryScope = new AsyncLocalStorage<boolean>();
const defaultRetryIntervals = [50, 100, 250, 500] as const;

function normalizeAriaSnapshot(snapshot: string): string {
  const lines = snapshot.replaceAll("\r\n", "\n").trimEnd().split("\n");
  while (lines[0]?.trim() === "" && lines.length > 1) lines.shift();
  const indentation = lines.reduce(
    (minimum, line) => (line.trim() ? Math.min(minimum, /^ */.exec(line)![0].length) : minimum),
    Infinity,
  );
  return lines.map((line) => line.slice(indentation)).join("\n");
}

async function retryAssertion(
  check: () => unknown,
  timeout: number,
  intervals: readonly number[] = defaultRetryIntervals,
): Promise<void> {
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    intervals.some((ms) => !Number.isFinite(ms) || ms < 0)
  ) {
    throw new RangeError("Assertion timeout and intervals must be finite, non-negative numbers");
  }
  if (intervals.length === 0) intervals = defaultRetryIntervals;
  let lastFailure: unknown;
  let expired = false;
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      expired = true;
      const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
      reject(
        new Error(
          `Assertion timed out after ${timeout}ms${lastFailure === undefined ? "" : `: ${detail}`}`,
          { cause: lastFailure },
        ),
      );
    }, timeout);
  });
  const attempts = async () => {
    for (let attempt = 0; ; attempt++) {
      if (expired) return;
      try {
        await retryScope.run(true, check);
        return;
      } catch (error) {
        if (expired) return;
        lastFailure = error;
        const interval = intervals[Math.min(attempt, intervals.length - 1)]!;
        await new Promise<void>((resolve) => {
          delayTimer = setTimeout(resolve, interval);
        });
      }
    }
  };
  try {
    await Promise.race([deadline, attempts()]);
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(delayTimer);
  }
}

export function createPromiseExpect<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  config: CoordinatorConfig,
  recorder?: StepRecorder,
  flowContext?: FlowContext,
  visualRegression?: {
    threshold?: number;
    maxDiffPixelRatio?: number;
    baselinesDir?: string;
  },
): PromiseExpectFn<T> {
  const ctx: FlowContext = flowContext ?? {
    flowFilePath: "",
    flowName: "unknown",
    platform: "web",
  };

  const coord = createCoordinator<T, R>(driver, config);
  const defaultTimeout = config.defaults?.timeout ?? 5000;
  const resolveRetryTimeout = (explicit?: number): number => {
    if (explicit !== undefined) return explicit;
    if (ctx.toPassTimeout !== undefined) return ctx.toPassTimeout;
    if (ctx.flowDeadlineMs !== undefined) {
      return Math.max(100, ctx.flowDeadlineMs - Date.now());
    }
    return defaultTimeout;
  };

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const recordSoft = async (action: () => Promise<void>) => {
    if (!ctx.recordSoftFailure || retryScope.getStore()) return action();
    try {
      await action();
    } catch (error) {
      ctx.recordSoftFailure(error);
    }
  };

  const recordStep = (
    command: string,
    action: () => Promise<void>,
    selector?: ExtendedSelector<T>,
  ) =>
    recorder && !retryScope.getStore()
      ? recorder.runStep(command, action, { selector, captureScreenshot: false })
      : action();

  const runSelectorStep = (
    command: string,
    selector: ExtendedSelector<T>,
    action: () => Promise<void>,
  ) => recordStep(command, action, selector);
  const runSoftSelectorStep: typeof runSelectorStep = (command, selector, action) =>
    recordSoft(() => runSelectorStep(command, selector, action));

  const buildNegatedExpectation = (
    selector: ExtendedSelector<T>,
    runStep: typeof runSelectorStep,
  ): NegatedPromiseExpectation => ({
    toBeVisible: (opts) =>
      runStep("expect.not.toBeVisible", selector, () => run(coord.assertHidden(selector, opts))),
    toBeHidden: (opts) =>
      runStep("expect.not.toBeHidden", selector, () =>
        run(coord.assertVisible(selector, opts)).then(() => {}),
      ),
    toBeAttached: (opts) =>
      runStep("expect.not.toBeAttached", selector, () =>
        run(coord.assertAttached(selector, opts, true)),
      ),
    toBeInViewport: (opts) =>
      runStep("expect.not.toBeInViewport", selector, () =>
        run(coord.assertInViewport(selector, opts, true)),
      ),
    toHaveText: (expected, opts) =>
      runStep(
        `expect.not.toHaveText(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertText(selector, expected, opts, true)),
      ),
    toMatchText: (pattern, opts) =>
      runStep(`expect.not.toMatchText(${pattern})`, selector, () =>
        run(coord.assertMatchesText(selector, pattern, opts, true)),
      ),
    toHaveValue: (expected, opts) =>
      runStep(
        `expect.not.toHaveValue(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertValue(selector, expected, opts, true)),
      ),
    toHaveAttribute: (name, value, opts) =>
      runStep(`expect.not.toHaveAttribute(${JSON.stringify(name)})`, selector, () =>
        run(coord.assertAttribute(selector, name, value, opts, true)),
      ),
    toHaveJSProperty: (name, value, opts) =>
      runStep(`expect.not.toHaveJSProperty(${JSON.stringify(name)})`, selector, () =>
        run(coord.assertJSProperty(selector, name, value, opts, true)),
      ),
    toBeEnabled: (opts) =>
      runStep("expect.not.toBeEnabled", selector, () => run(coord.assertDisabled(selector, opts))),
    toBeDisabled: (opts) =>
      runStep("expect.not.toBeDisabled", selector, () => run(coord.assertEnabled(selector, opts))),
    toContainText: (expected, opts) =>
      runStep(`expect.not.toContainText(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertContainsText(selector, expected, opts, true)),
      ),
    toHaveCount: (expected, opts) =>
      runStep(`expect.not.toHaveCount(${expected})`, selector, () =>
        run(coord.assertCount(selector, expected, opts, true)),
      ),
    toHaveVisibleCount: (expected, opts) =>
      runStep(`expect.not.toHaveVisibleCount(${expected})`, selector, () =>
        run(coord.assertCount(selector, expected, { ...opts, visible: true }, true)),
      ),
    toBeFocused: (opts) =>
      runStep("expect.not.toBeFocused", selector, () =>
        run(coord.assertFocused(selector, opts, true)),
      ),
    toBeChecked: (opts) =>
      runStep("expect.not.toBeChecked", selector, () =>
        run(coord.assertChecked(selector, opts, true)),
      ),
    toBeEditable: (opts) =>
      runStep("expect.not.toBeEditable", selector, () =>
        run(coord.assertEditable(selector, opts, true)),
      ),
    toBeEmpty: (opts) =>
      runStep("expect.not.toBeEmpty", selector, () => run(coord.assertEmpty(selector, opts, true))),
    toHaveClass: (expected, opts) =>
      runStep(
        `expect.not.toHaveClass(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertClass(selector, expected, opts, true)),
      ),
    toHaveCSS: (property, expected, opts) =>
      runStep(
        `expect.not.toHaveCSS(${JSON.stringify(property)}, ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertCss(selector, property, expected, opts, true)),
      ),
    toHaveAccessibleName: (expected, opts) =>
      runStep(
        `expect.not.toHaveAccessibleName(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertAccessibleName(selector, expected, opts, true)),
      ),
    toHaveAccessibleDescription: (expected, opts) =>
      runStep(
        `expect.not.toHaveAccessibleDescription(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertAccessibleDescription(selector, expected, opts, true)),
      ),
    toHaveRole: (expected, opts) =>
      runStep(`expect.not.toHaveRole(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertRole(selector, expected, ctx.platform, opts, true)),
      ),
  });

  const buildPollMatchers = <V>(
    fn: () => V | Promise<V>,
    opts: RetryAssertionOptions | undefined,
    negate: boolean,
  ): PollMatchers<V> => {
    const check = (
      label: string,
      predicate: (val: V) => boolean,
      describeFail: (val: V) => string,
    ): Promise<void> =>
      recordStep(`expect.poll.${negate ? "not." : ""}${label}`, () =>
        retryAssertion(
          async () => {
            const val = await fn();
            const ok = predicate(val);
            if (negate ? ok : !ok) {
              throw new Error(describeFail(val));
            }
          },
          resolveRetryTimeout(opts?.timeout),
          opts?.intervals,
        ),
      );

    return {
      toBe: (expected) =>
        check(
          `toBe(${JSON.stringify(expected)})`,
          (v) => Object.is(v, expected),
          (v) =>
            negate
              ? `Expected polled value NOT to be ${JSON.stringify(expected)}`
              : `Expected polled value to be ${JSON.stringify(expected)}, received ${JSON.stringify(v)}`,
        ),
      toEqual: (expected) =>
        check(
          `toEqual(${JSON.stringify(expected)})`,
          (v) => deepEqual(v, expected),
          (v) =>
            negate
              ? `Expected polled value NOT to equal ${JSON.stringify(expected)}`
              : `Expected polled value to equal ${JSON.stringify(expected)}, received ${JSON.stringify(v)}`,
        ),
      toContain: (expected) =>
        check(
          `toContain(${JSON.stringify(expected)})`,
          (v) => {
            if (typeof v === "string") return v.includes(String(expected));
            if (Array.isArray(v)) return v.some((item) => deepEqual(item, expected));
            return false;
          },
          (v) =>
            negate
              ? `Expected polled value NOT to contain ${JSON.stringify(expected)}, received ${JSON.stringify(v)}`
              : `Expected polled value to contain ${JSON.stringify(expected)}, received ${JSON.stringify(v)}`,
        ),
      toMatch: (pattern) =>
        check(
          `toMatch(${pattern instanceof RegExp ? String(pattern) : JSON.stringify(pattern)})`,
          (v) => {
            const str = String(v ?? "");
            return pattern instanceof RegExp ? pattern.test(str) : str.includes(pattern);
          },
          (v) =>
            negate
              ? `Expected polled value NOT to match ${String(pattern)}, received ${JSON.stringify(v)}`
              : `Expected polled value to match ${String(pattern)}, received ${JSON.stringify(v)}`,
        ),
      toBeGreaterThan: (expected) =>
        check(
          `toBeGreaterThan(${expected})`,
          (v) => typeof v === "number" && v > expected,
          (v) =>
            negate
              ? `Expected polled value NOT to be > ${expected}, received ${String(v)}`
              : `Expected polled value > ${expected}, received ${String(v)}`,
        ),
      toBeLessThan: (expected) =>
        check(
          `toBeLessThan(${expected})`,
          (v) => typeof v === "number" && v < expected,
          (v) =>
            negate
              ? `Expected polled value NOT to be < ${expected}, received ${String(v)}`
              : `Expected polled value < ${expected}, received ${String(v)}`,
        ),
      toBeGreaterThanOrEqual: (expected) =>
        check(
          `toBeGreaterThanOrEqual(${expected})`,
          (v) => typeof v === "number" && v >= expected,
          (v) =>
            negate
              ? `Expected polled value NOT to be >= ${expected}, received ${String(v)}`
              : `Expected polled value >= ${expected}, received ${String(v)}`,
        ),
      toBeLessThanOrEqual: (expected) =>
        check(
          `toBeLessThanOrEqual(${expected})`,
          (v) => typeof v === "number" && v <= expected,
          (v) =>
            negate
              ? `Expected polled value NOT to be <= ${expected}, received ${String(v)}`
              : `Expected polled value <= ${expected}, received ${String(v)}`,
        ),
      toBeTruthy: () =>
        check(
          "toBeTruthy",
          (v) => Boolean(v),
          (v) =>
            negate
              ? `Expected polled value NOT to be truthy, received ${JSON.stringify(v)}`
              : `Expected polled value to be truthy, received ${JSON.stringify(v)}`,
        ),
      toBeFalsy: () =>
        check(
          "toBeFalsy",
          (v) => !v,
          (v) =>
            negate
              ? `Expected polled value NOT to be falsy, received ${JSON.stringify(v)}`
              : `Expected polled value to be falsy, received ${JSON.stringify(v)}`,
        ),
      toBeDefined: () =>
        check(
          "toBeDefined",
          (v) => v !== undefined,
          () =>
            negate
              ? `Expected polled value to be undefined`
              : `Expected polled value to be defined`,
        ),
      toBeUndefined: () =>
        check(
          "toBeUndefined",
          (v) => v === undefined,
          (v) =>
            negate
              ? `Expected polled value NOT to be undefined`
              : `Expected polled value to be undefined, received ${JSON.stringify(v)}`,
        ),
      toBeNull: () =>
        check(
          "toBeNull",
          (v) => v === null,
          (v) =>
            negate
              ? `Expected polled value NOT to be null`
              : `Expected polled value to be null, received ${JSON.stringify(v)}`,
        ),
      toHaveLength: (expected) =>
        check(
          `toHaveLength(${expected})`,
          (v) =>
            v !== null &&
            v !== undefined &&
            typeof (v as unknown as { length?: unknown }).length === "number" &&
            (v as unknown as { length: number }).length === expected,
          (v) =>
            negate
              ? `Expected polled value NOT to have length ${expected}`
              : `Expected polled value to have length ${expected}, received ${JSON.stringify(v)}`,
        ),
    };
  };

  const buildSelectorExpectation = (
    selector: ExtendedSelector<T>,
    runStep: typeof runSelectorStep,
  ): PromiseExpectation<T> => ({
    toBeVisible: (opts) =>
      runStep("expect.toBeVisible", selector, () =>
        run(coord.assertVisible(selector, opts)).then(() => {}),
      ),
    toBeHidden: (opts) =>
      runStep("expect.toBeHidden", selector, () => run(coord.assertHidden(selector, opts))),
    toBeAttached: (opts) =>
      runStep("expect.toBeAttached", selector, () => run(coord.assertAttached(selector, opts))),
    toBeInViewport: (opts) =>
      runStep("expect.toBeInViewport", selector, () => run(coord.assertInViewport(selector, opts))),
    toHaveText: (expected, opts) =>
      runStep(
        `expect.toHaveText(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertText(selector, expected, opts)),
      ),
    toMatchText: (pattern, opts) =>
      runStep(`expect.toMatchText(${pattern})`, selector, () =>
        run(coord.assertMatchesText(selector, pattern, opts)),
      ),
    toHaveValue: (expected, opts) =>
      runStep(
        `expect.toHaveValue(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertValue(selector, expected, opts)),
      ),
    toHaveAttribute: (name, value, opts) =>
      runStep(`expect.toHaveAttribute(${JSON.stringify(name)})`, selector, () =>
        run(coord.assertAttribute(selector, name, value, opts)),
      ),
    toHaveJSProperty: (name, value, opts) =>
      runStep(`expect.toHaveJSProperty(${JSON.stringify(name)})`, selector, () =>
        run(coord.assertJSProperty(selector, name, value, opts)),
      ),
    toBeEnabled: (opts) =>
      runStep("expect.toBeEnabled", selector, () => run(coord.assertEnabled(selector, opts))),
    toBeDisabled: (opts) =>
      runStep("expect.toBeDisabled", selector, () => run(coord.assertDisabled(selector, opts))),
    toContainText: (expected, opts) =>
      runStep(`expect.toContainText(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertContainsText(selector, expected, opts)),
      ),
    toHaveCount: (expected, opts) =>
      runStep(`expect.toHaveCount(${expected})`, selector, () =>
        run(coord.assertCount(selector, expected, opts)),
      ),
    toHaveVisibleCount: (expected, opts) =>
      runStep(`expect.toHaveVisibleCount(${expected})`, selector, () =>
        run(coord.assertCount(selector, expected, { ...opts, visible: true })),
      ),
    toBeFocused: (opts) =>
      runStep("expect.toBeFocused", selector, () => run(coord.assertFocused(selector, opts))),
    toBeChecked: (opts) =>
      runStep("expect.toBeChecked", selector, () => run(coord.assertChecked(selector, opts))),
    toBeEditable: (opts) =>
      runStep("expect.toBeEditable", selector, () => run(coord.assertEditable(selector, opts))),
    toBeEmpty: (opts) =>
      runStep("expect.toBeEmpty", selector, () => run(coord.assertEmpty(selector, opts))),
    toHaveClass: (expected, opts) =>
      runStep(
        `expect.toHaveClass(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertClass(selector, expected, opts)),
      ),
    toHaveCSS: (property, expected, opts) =>
      runStep(
        `expect.toHaveCSS(${JSON.stringify(property)}, ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertCss(selector, property, expected, opts)),
      ),
    toHaveAccessibleName: (expected, opts) =>
      runStep(
        `expect.toHaveAccessibleName(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertAccessibleName(selector, expected, opts)),
      ),
    toHaveAccessibleDescription: (expected, opts) =>
      runStep(
        `expect.toHaveAccessibleDescription(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        selector,
        () => run(coord.assertAccessibleDescription(selector, expected, opts)),
      ),
    not: buildNegatedExpectation(selector, runStep),

    toMatchAriaSnapshot: (expected, opts) =>
      runStep("expect.toMatchAriaSnapshot", selector, async () => {
        if (!driver.getAriaSnapshot) {
          throw new Error(
            `toMatchAriaSnapshot() is not supported on ${ctx.platform} with the current driver`,
          );
        }
        if (isRelativeSelector(selector))
          throw new Error("ARIA snapshots require a locator, not a relative selector");
        const timeout = opts?.timeout ?? defaultTimeout;
        const path =
          typeof expected === "string"
            ? undefined
            : resolvePath(dirname(ctx.flowFilePath), expected.path);
        if (path && ctx.updateBaselines) {
          const actual = await run(driver.getAriaSnapshot(selector, timeout));
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, `${normalizeAriaSnapshot(actual)}\n`, "utf8");
          return;
        }
        const baseline = normalizeAriaSnapshot(
          typeof expected === "string" ? expected : await readFile(path!, "utf8"),
        );
        await retryAssertion(
          async () => {
            const actual = normalizeAriaSnapshot(
              await run(driver.getAriaSnapshot!(selector, timeout)),
            );
            if (actual !== baseline)
              throw new Error(
                `ARIA snapshot did not match.\nExpected:\n${baseline}\nReceived:\n${actual}`,
              );
          },
          timeout,
          opts?.intervals,
        );
      }),

    toMatchScreenshot: (name, options) =>
      runStep(`expect.toMatchScreenshot(${JSON.stringify(name)})`, selector, () =>
        run(
          coord.assertScreenshot(selector, name, ctx.flowFilePath, ctx.flowName, ctx.platform, {
            threshold: options?.threshold ?? visualRegression?.threshold,
            maxDiffPixelRatio: options?.maxDiffPixelRatio ?? visualRegression?.maxDiffPixelRatio,
            mask: [],
            maskSelectors: options?.mask,
            fullPage: options?.fullPage,
            updateBaselines: ctx.updateBaselines,
            baselinesDir: visualRegression?.baselinesDir,
          }),
        ),
      ),

    toPassAccessibilityAudit: (options) => {
      const includeCss = options?.include?.map(selectorToCss).filter(Boolean) ?? [];
      const excludeCss = options?.exclude?.map(selectorToCss).filter(Boolean) ?? [];
      const targetCss = selectorToCss(selector);
      return runStep("expect.toPassAccessibilityAudit", selector, () =>
        run(
          coord.assertAccessibilityAudit(ctx.platform, {
            severity: options?.severity,
            rules: options?.rules,
            disableRules: options?.disableRules,
            tags: options?.tags,
            targetSelector: targetCss || undefined,
            includeSelectors: includeCss,
            excludeSelectors: excludeCss,
          }),
        ),
      );
    },

    toHaveAccessibilityLabel: (expected) =>
      runStep(
        `expect.toHaveAccessibilityLabel(${expected !== undefined ? JSON.stringify(expected) : ""})`,
        selector,
        () => run(coord.assertAccessibilityLabel(selector, expected)),
      ),

    toBeFocusable: () =>
      runStep("expect.toBeFocusable", selector, () =>
        run(coord.assertFocusable(selector, ctx.platform)),
      ),

    toHaveRole: (expected, opts) =>
      runStep(`expect.toHaveRole(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertRole(selector, expected, ctx.platform, opts)),
      ),

    toHaveMinTouchTarget: (size = 44) =>
      runStep(`expect.toHaveMinTouchTarget(${size})`, selector, () =>
        run(coord.assertMinTouchTarget(selector, size)),
      ),
  });

  const expectFn = ((
    selectorOrFn: ExtendedSelector<T> | (() => unknown | Promise<unknown>),
  ): PromiseExpectation<T> | ToPassExpectation => {
    if (typeof selectorOrFn !== "function") {
      return buildSelectorExpectation(selectorOrFn, runSelectorStep);
    }
    return {
      toPass: (opts?: RetryAssertionOptions) =>
        recordStep("expect.toPass", () =>
          retryAssertion(selectorOrFn, resolveRetryTimeout(opts?.timeout), opts?.intervals),
        ),
    };
  }) as PromiseExpectFn<T>;

  const toHaveURL = (expected: string | RegExp, opts?: WaitOptions) => {
    const label = `expect.toHaveURL(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
    return recordStep(label, () => run(coord.waitForURL(expected, opts)));
  };
  const toHaveTitle = (expected: string | RegExp, opts?: WaitOptions) => {
    const label = `expect.toHaveTitle(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
    return recordStep(label, () => run(coord.waitForTitle(expected, opts)));
  };
  const noWasmTraps = () =>
    recordStep("expect.noWasmTraps()", async () => {
      let traps: WasmTrap[] = [];
      if (driver.getWasmTraps) {
        traps = await run(driver.getWasmTraps());
      } else if (driver.getJSErrors) {
        const errs = await run(driver.getJSErrors());
        traps = errs
          .filter((e) => isWasmTrapError(e))
          .map((e) => ({
            name: e.name ?? "WebAssembly.RuntimeError",
            message: e.message,
            source: "main" as const,
            stack: e.stack,
            timestamp: Date.now(),
          }));
      }
      if (traps.length > 0) {
        const summary = traps.map((t) => `[${t.source}] ${t.name}: ${t.message}`).join("\n  - ");
        throw new Error(
          `Expected zero WebAssembly traps, but captured ${traps.length}:\n  - ${summary}`,
        );
      }
    });
  const wasmMemoryBelow = (limit: number | string) =>
    recordStep(`expect.wasmMemoryBelow(${JSON.stringify(limit)})`, async () => {
      const limitBytes = parseByteSize(limit);
      let metrics: WasmMetrics;
      if (driver.getWasmMetrics) {
        metrics = await run(driver.getWasmMetrics());
      } else if (driver.evaluate) {
        metrics = await run(
          driver.evaluate<WasmMetrics>(
            `(() => globalThis.__spanaWasm ? globalThis.__spanaWasm.getMetrics() : {
              moduleCount: 0,
              pendingCount: 0,
              wasmMemoryBytes: 0,
              wasmMemoryPages: 0,
              peakWasmMemoryBytes: 0,
              crossOriginIsolated: false,
              sharedArrayBufferAvailable: false,
              traps: [],
              modules: []
            })()`,
          ),
        );
      } else {
        throw new Error("Driver does not support WebAssembly memory inspection");
      }
      if (metrics.wasmMemoryBytes > limitBytes) {
        throw new Error(
          `Expected WebAssembly linear memory to be below ${formatByteSize(limitBytes)}, but measured ${formatByteSize(metrics.wasmMemoryBytes)} (${metrics.wasmMemoryPages} pages, peak ${formatByteSize(metrics.peakWasmMemoryBytes)})`,
        );
      }
    });
  const minFps = (requiredFps: number, opts?: { durationMs?: number }) =>
    recordStep(`expect.minFps(${requiredFps})`, async () => {
      const durationMs = Math.max(100, Math.round(opts?.durationMs ?? 500));
      if (!driver.evaluate) {
        throw new Error("Driver does not support FPS sampling");
      }
      const measured = await run(
        driver.evaluate<number>(
          `(() => new Promise((resolve) => {
            if (typeof requestAnimationFrame !== "function") { resolve(0); return; }
            let frames = 0;
            const start = performance.now();
            function tick(now) {
              frames++;
              const elapsed = now - start;
              if (elapsed >= ${durationMs}) {
                resolve(Math.round((frames * 1000) / Math.max(1, elapsed)));
                return;
              }
              requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
          }))()`,
        ),
      );
      if (measured < requiredFps) {
        throw new Error(
          `Expected frame rate >= ${requiredFps} FPS over ${durationMs}ms, but measured ${measured} FPS`,
        );
      }
    });
  expectFn.toHaveURL = toHaveURL;
  expectFn.toHaveTitle = toHaveTitle;
  expectFn.noWasmTraps = noWasmTraps;
  expectFn.wasmMemoryBelow = wasmMemoryBelow;
  expectFn.minFps = minFps;
  expectFn.soft = Object.assign(
    (selector: ExtendedSelector<T>) => buildSelectorExpectation(selector, runSoftSelectorStep),
    {
      toHaveURL: (expected: string | RegExp, opts?: WaitOptions) =>
        recordSoft(() => toHaveURL(expected, opts)),
      toHaveTitle: (expected: string | RegExp, opts?: WaitOptions) =>
        recordSoft(() => toHaveTitle(expected, opts)),
      noWasmTraps: () => recordSoft(() => noWasmTraps()),
      wasmMemoryBelow: (limit: number | string) => recordSoft(() => wasmMemoryBelow(limit)),
      minFps: (requiredFps: number, opts?: { durationMs?: number }) =>
        recordSoft(() => minFps(requiredFps, opts)),
    },
  );

  Object.defineProperty(expectFn, "not", {
    enumerable: true,
    value: {
      toHaveURL: (expected: string | RegExp, opts?: WaitOptions) => {
        const label = `expect.not.toHaveURL(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
        return recordStep(label, () => run(coord.waitForURL(expected, opts, true)));
      },
      toHaveTitle: (expected: string | RegExp, opts?: WaitOptions) => {
        const label = `expect.not.toHaveTitle(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
        return recordStep(label, () => run(coord.waitForTitle(expected, opts, true)));
      },
    },
  });

  expectFn.poll = <V>(
    fn: () => V | Promise<V>,
    opts?: RetryAssertionOptions,
  ): PollExpectation<V> => ({
    ...buildPollMatchers(fn, opts, false),
    not: buildPollMatchers(fn, opts, true),
  });

  expectFn.toMatchSnapshot = (actual: unknown, name: string, opts?: DataSnapshotOptions) =>
    recordStep(`expect.toMatchSnapshot(${JSON.stringify(name)})`, async () => {
      assertDataSnapshot(actual, name, {
        ...opts,
        updateBaselines: opts?.updateBaselines ?? ctx.updateBaselines,
      });
    });

  return expectFn;
}
