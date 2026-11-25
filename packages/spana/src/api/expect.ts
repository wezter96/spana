import { AsyncLocalStorage } from "node:async_hooks";
import { inspect, isDeepStrictEqual } from "node:util";
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
  recordSoftFailure?: (error: unknown) => void;
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
  timeout?: number;
  intervals?: readonly number[];
}

export interface PollExpectation<T> {
  toBe(expected: T): Promise<void>;
  toEqual(expected: T): Promise<void>;
  toBeTruthy(): Promise<void>;
  toBeFalsy(): Promise<void>;
  toContain(expected: unknown): Promise<void>;
  toMatch(expected: string | RegExp): Promise<void>;
  toBeGreaterThan(expected: number): Promise<void>;
  toBeLessThan(expected: number): Promise<void>;
}

export interface PromiseExpectFn<T extends string = string> {
  (selector: ExtendedSelector<T>): PromiseExpectation<T>;
  (check: () => unknown): { toPass(options?: RetryAssertionOptions): Promise<void> };
  soft: ((selector: ExtendedSelector<T>) => PromiseExpectation<T>) & {
    toHaveURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  };
  poll<A>(probe: () => A, options?: RetryAssertionOptions): PollExpectation<Awaited<A>>;
  /** Assert that the current page URL matches a substring/exact string or RegExp. */
  toHaveURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
}

const retryScope = new AsyncLocalStorage<boolean>();
const defaultRetryIntervals = [100, 250, 500, 1000] as const;

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

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const record = (command: string, action: () => Promise<void>, selector?: ExtendedSelector<T>) =>
    recorder && !retryScope.getStore()
      ? recorder.runStep(command, action, { selector, captureScreenshot: false })
      : action();

  const recordSoft = async (action: () => Promise<void>) => {
    if (!ctx.recordSoftFailure || retryScope.getStore()) return action();
    try {
      await action();
    } catch (error) {
      ctx.recordSoftFailure(error);
    }
  };

  const hardRunStep = (
    command: string,
    selector: ExtendedSelector<T>,
    action: () => Promise<void>,
  ) => record(command, action, selector);
  const softRunStep: typeof hardRunStep = (command, selector, action) =>
    recordSoft(() => hardRunStep(command, selector, action));

  const matchSelector = (
    selector: ExtendedSelector<T>,
    runStep: typeof hardRunStep,
  ): PromiseExpectation<T> => ({
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
  });

  const expectFn = ((selector: ExtendedSelector<T> | (() => unknown)) =>
    typeof selector === "function"
      ? {
          toPass: (options?: RetryAssertionOptions) =>
            record("expect.toPass", () =>
              retryAssertion(
                selector,
                options?.timeout ?? config.defaults?.timeout ?? 5000,
                options?.intervals,
              ),
            ),
        }
      : matchSelector(selector, hardRunStep)) as PromiseExpectFn<T>;

  const toHaveURL = (expected: string | RegExp, opts?: WaitOptions) => {
    const label = `expect.toHaveURL(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`;
    return record(label, () => run(coord.waitForURL(expected, opts)));
  };
  expectFn.toHaveURL = toHaveURL;
  expectFn.soft = Object.assign(
    (selector: ExtendedSelector<T>) => matchSelector(selector, softRunStep),
    {
      toHaveURL: (expected: string | RegExp, opts?: WaitOptions) =>
        recordSoft(() => toHaveURL(expected, opts)),
    },
  );
  expectFn.poll = <A>(
    probe: () => A,
    options?: RetryAssertionOptions,
  ): PollExpectation<Awaited<A>> => {
    const match = (name: string, predicate: (actual: Awaited<A>) => boolean, expected?: unknown) =>
      record(`expect.poll.${name}`, () =>
        retryAssertion(
          async () => {
            const actual = await probe();
            if (!predicate(actual)) {
              throw new Error(`Expected ${inspect(actual)} ${name} ${inspect(expected)}`);
            }
          },
          options?.timeout ?? config.defaults?.timeout ?? 5000,
          options?.intervals,
        ),
      );
    return {
      toBe: (expected) => match("toBe", (actual) => Object.is(actual, expected), expected),
      toEqual: (expected) =>
        match("toEqual", (actual) => isDeepStrictEqual(actual, expected), expected),
      toBeTruthy: () => match("toBeTruthy", Boolean),
      toBeFalsy: () => match("toBeFalsy", (actual) => !actual),
      toContain: (expected) =>
        match(
          "toContain",
          (actual) =>
            (typeof actual === "string" &&
              typeof expected === "string" &&
              actual.includes(expected)) ||
            (Array.isArray(actual) && actual.includes(expected)),
          expected,
        ),
      toMatch: (expected) =>
        match(
          "toMatch",
          (actual) =>
            typeof actual === "string" &&
            (typeof expected === "string"
              ? actual.includes(expected)
              : new RegExp(expected).test(actual)),
          expected,
        ),
      toBeGreaterThan: (expected) =>
        match(
          "toBeGreaterThan",
          (actual) => typeof actual === "number" && actual > expected,
          expected,
        ),
      toBeLessThan: (expected) =>
        match(
          "toBeLessThan",
          (actual) => typeof actual === "number" && actual < expected,
          expected,
        ),
    };
  };

  return expectFn;
}
