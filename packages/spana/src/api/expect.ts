import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import { createCoordinator, type CoordinatorConfig } from "../smart/coordinator.js";
import type { WaitOptions } from "../smart/auto-wait.js";
import type { StepRecorder } from "../core/step-recorder.js";

export interface FlowContext {
  flowFilePath: string;
  flowName: string;
  platform: string;
  updateBaselines?: boolean;
}

export interface NegatedPromiseExpectation {
  toBeVisible(opts?: WaitOptions): Promise<void>;
  toBeHidden(opts?: WaitOptions): Promise<void>;
  toHaveText(expected: string, opts?: WaitOptions): Promise<void>;
  toMatchText(pattern: RegExp, opts?: WaitOptions): Promise<void>;
  toHaveValue(expected: string | number, opts?: WaitOptions): Promise<void>;
  toHaveAttribute(name: string, value?: string, opts?: WaitOptions): Promise<void>;
  toBeEnabled(opts?: WaitOptions): Promise<void>;
  toBeDisabled(opts?: WaitOptions): Promise<void>;
  toContainText(expected: string, opts?: WaitOptions): Promise<void>;
  toHaveCount(expected: number, opts?: WaitOptions): Promise<void>;
  toBeFocused(opts?: WaitOptions): Promise<void>;
  toHaveAccessibleName(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  toHaveAccessibleDescription(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
}

export interface PromiseExpectation<T extends string = string> {
  toBeVisible(opts?: WaitOptions): Promise<void>;
  toBeHidden(opts?: WaitOptions): Promise<void>;
  toHaveText(expected: string, opts?: WaitOptions): Promise<void>;
  toMatchText(pattern: RegExp, opts?: WaitOptions): Promise<void>;
  toHaveValue(expected: string | number, opts?: WaitOptions): Promise<void>;
  toHaveAttribute(name: string, value?: string, opts?: WaitOptions): Promise<void>;
  toBeEnabled(opts?: WaitOptions): Promise<void>;
  toBeDisabled(opts?: WaitOptions): Promise<void>;
  toContainText(expected: string, opts?: WaitOptions): Promise<void>;
  /** Assert that the number of visible matching elements equals `expected`. */
  toHaveCount(expected: number, opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element currently has focus (`document.activeElement`). */
  toBeFocused(opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element's computed accessible name matches string or RegExp. */
  toHaveAccessibleName(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Assert that the matched element's computed accessible description matches string or RegExp. */
  toHaveAccessibleDescription(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Negated assertion chain (`expect(selector).not.*`). */
  readonly not: NegatedPromiseExpectation;

  // Visual regression
  toMatchScreenshot(
    name: string,
    options?: {
      threshold?: number;
      maxDiffPixelRatio?: number;
      mask?: ExtendedSelector<T>[];
    },
  ): Promise<void>;

  // Accessibility
  toPassAccessibilityAudit(options?: {
    severity?: "critical" | "serious" | "moderate" | "minor";
    rules?: string[];
    exclude?: ExtendedSelector<T>[];
  }): Promise<void>;

  toHaveAccessibilityLabel(expected?: string): Promise<void>;
  toBeFocusable(): Promise<void>;
  toHaveRole(expected: string): Promise<void>;
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
  toHaveLength(expected: number): Promise<void>;
}

export interface PollExpectation<V> extends PollMatchers<V> {
  readonly not: PollMatchers<V>;
}

/** Callable `expect(selector)` / `expect(fn).toPass()` helper with `expect.poll(...)` and `expect.toHaveURL(...)`. */
export interface PromiseExpectFn<T extends string = string> {
  (selector: ExtendedSelector<T>): PromiseExpectation<T>;
  (fn: () => unknown | Promise<unknown>): ToPassExpectation;
  /** Assert that the current page URL matches a substring/exact string or RegExp. */
  toHaveURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Negated page-level matchers (`expect.not.toHaveURL(...)`). */
  readonly not: {
    toHaveURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  };
  /** Poll an async/sync getter until the chained matcher passes (Playwright `expect.poll(fn)`). */
  poll<V>(fn: () => V | Promise<V>, opts?: RetryAssertionOptions): PollExpectation<V>;
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

async function retryUntilPass(
  fn: () => unknown | Promise<unknown>,
  opts: RetryAssertionOptions | undefined,
  defaultTimeout: number,
): Promise<void> {
  const timeout = opts?.timeout ?? defaultTimeout;
  const intervals =
    opts?.intervals && opts.intervals.length > 0 ? opts.intervals : [50, 100, 250, 500];
  const deadline = Date.now() + timeout;
  let attempt = 0;
  let lastError: unknown;
  while (true) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const delay = intervals[Math.min(attempt, intervals.length - 1)] ?? 250;
      attempt += 1;
      await new Promise((r) => setTimeout(r, Math.min(delay, remaining)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`expect(fn).toPass() timed out after ${timeout}ms: ${String(lastError)}`);
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

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const runStep = <A>(command: string, selector: ExtendedSelector<T>, action: () => Promise<A>) =>
    recorder ? recorder.runStep(command, action, { selector, captureScreenshot: false }) : action();

  const runPageStep = <A>(command: string, action: () => Promise<A>) =>
    recorder ? recorder.runStep(command, action, { captureScreenshot: false }) : action();

  const buildNegatedExpectation = (selector: ExtendedSelector<T>): NegatedPromiseExpectation => ({
    toBeVisible: (opts) =>
      runStep("expect.not.toBeVisible", selector, () => run(coord.assertHidden(selector, opts))),
    toBeHidden: (opts) =>
      runStep("expect.not.toBeHidden", selector, () =>
        run(coord.assertVisible(selector, opts)).then(() => {}),
      ),
    toHaveText: (expected, opts) =>
      runStep(`expect.not.toHaveText(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertText(selector, expected, opts, true)),
      ),
    toMatchText: (pattern, opts) =>
      runStep(`expect.not.toMatchText(${pattern})`, selector, () =>
        run(coord.assertMatchesText(selector, pattern, opts, true)),
      ),
    toHaveValue: (expected, opts) =>
      runStep(`expect.not.toHaveValue(${JSON.stringify(expected)})`, selector, () =>
        run(coord.assertValue(selector, expected, opts, true)),
      ),
    toHaveAttribute: (name, value, opts) =>
      runStep(`expect.not.toHaveAttribute(${JSON.stringify(name)})`, selector, () =>
        run(coord.assertAttribute(selector, name, value, opts, true)),
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
    toBeFocused: (opts) =>
      runStep("expect.not.toBeFocused", selector, () =>
        run(coord.assertFocused(selector, opts, true)),
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
      runPageStep(`expect.poll.${negate ? "not." : ""}${label}`, () =>
        retryUntilPass(
          async () => {
            const val = await fn();
            const ok = predicate(val);
            if (negate ? ok : !ok) {
              throw new Error(describeFail(val));
            }
          },
          opts,
          defaultTimeout,
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

  const expectFn = ((
    selectorOrFn: ExtendedSelector<T> | (() => unknown | Promise<unknown>),
  ): PromiseExpectation<T> | ToPassExpectation => {
    if (typeof selectorOrFn === "function") {
      return {
        toPass: (opts?: RetryAssertionOptions) =>
          runPageStep("expect.toPass", () => retryUntilPass(selectorOrFn, opts, defaultTimeout)),
      };
    }
    const selector = selectorOrFn;
    return {
      toBeVisible: (opts) =>
        runStep("expect.toBeVisible", selector, () =>
          run(coord.assertVisible(selector, opts)).then(() => {}),
        ),
      toBeHidden: (opts) =>
        runStep("expect.toBeHidden", selector, () => run(coord.assertHidden(selector, opts))),
      toHaveText: (expected, opts) =>
        runStep(`expect.toHaveText(${JSON.stringify(expected)})`, selector, () =>
          run(coord.assertText(selector, expected, opts)),
        ),
      toMatchText: (pattern, opts) =>
        runStep(`expect.toMatchText(${pattern})`, selector, () =>
          run(coord.assertMatchesText(selector, pattern, opts)),
        ),
      toHaveValue: (expected, opts) =>
        runStep(`expect.toHaveValue(${JSON.stringify(expected)})`, selector, () =>
          run(coord.assertValue(selector, expected, opts)),
        ),
      toHaveAttribute: (name, value, opts) =>
        runStep(`expect.toHaveAttribute(${JSON.stringify(name)})`, selector, () =>
          run(coord.assertAttribute(selector, name, value, opts)),
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
      toBeFocused: (opts) =>
        runStep("expect.toBeFocused", selector, () => run(coord.assertFocused(selector, opts))),
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
      not: buildNegatedExpectation(selector),

      toMatchScreenshot: (name, options) =>
        runStep(`expect.toMatchScreenshot(${JSON.stringify(name)})`, selector, () =>
          run(
            coord.assertScreenshot(selector, name, ctx.flowFilePath, ctx.flowName, ctx.platform, {
              threshold: options?.threshold ?? visualRegression?.threshold,
              maxDiffPixelRatio: options?.maxDiffPixelRatio ?? visualRegression?.maxDiffPixelRatio,
              mask: [],
              updateBaselines: ctx.updateBaselines,
              baselinesDir: visualRegression?.baselinesDir,
            }),
          ),
        ),

      toPassAccessibilityAudit: (options) => {
        const excludeCss = options?.exclude?.map(selectorToCss).filter(Boolean) ?? [];
        const targetCss = selectorToCss(selector);
        return runStep("expect.toPassAccessibilityAudit", selector, () =>
          run(
            coord.assertAccessibilityAudit(ctx.platform, {
              severity: options?.severity,
              rules: options?.rules,
              targetSelector: targetCss || undefined,
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

      toHaveRole: (expected) =>
        runStep(`expect.toHaveRole(${JSON.stringify(expected)})`, selector, () =>
          run(coord.assertRole(selector, expected, ctx.platform)),
        ),

      toHaveMinTouchTarget: (size = 44) =>
        runStep(`expect.toHaveMinTouchTarget(${size})`, selector, () =>
          run(coord.assertMinTouchTarget(selector, size)),
        ),
    };
  }) as PromiseExpectFn<T>;

  expectFn.toHaveURL = (expected: string | RegExp, opts?: WaitOptions) => {
    const label = `expect.toHaveURL(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
    return runPageStep(label, () => run(coord.waitForURL(expected, opts)));
  };

  Object.defineProperty(expectFn, "not", {
    enumerable: true,
    value: {
      toHaveURL: (expected: string | RegExp, opts?: WaitOptions) => {
        const label = `expect.not.toHaveURL(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
        return runPageStep(label, () => run(coord.waitForURL(expected, opts, true)));
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

  return expectFn;
}
