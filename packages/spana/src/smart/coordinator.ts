import { Duration, Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { Element } from "../schemas/element.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import type { WaitTimeoutError } from "../errors.js";
import { DriverError, ElementNotFoundError, TextMismatchError } from "../errors.js";
import { splitGraphemes } from "../core/graphemes.js";
import { centerOf, findElementExtended, formatSelector } from "./element-matcher.js";
import {
  waitForActionElement,
  waitForElement,
  waitForNotVisible,
  type WaitOptions,
} from "./auto-wait.js";
import {
  createHierarchyCache,
  type HierarchyCacheConfig,
  type HierarchyCache,
} from "./hierarchy-cache.js";

export type Direction = "up" | "down" | "left" | "right";

type HierarchyParser = (raw: string) => Element;

// The `_T` type parameter is reserved for typed-testID projects that want to
// thread a testID union through options. It's unused in the interface body
// but enabled at the type level so `ScrollUntilVisibleOptions<"foo"|"bar">`
// works when called from a typed app.
export interface ScrollUntilVisibleOptions<_T extends string = string> extends WaitOptions {
  /** Where the target is relative to the current viewport. Default: "down". */
  direction?: Direction;
  /** Max number of scroll gestures to attempt before failing. Default: 5. */
  maxScrolls?: number;
}

export type KeyboardDismissStrategy = "auto" | "driver" | "back";

export interface DismissKeyboardOptions {
  /** Default: "auto" (driver hideKeyboard, then Android back fallback). */
  strategy?: KeyboardDismissStrategy;
}

export interface BackUntilVisibleOptions<_T extends string = string> extends WaitOptions {
  /** Max number of back actions to attempt before failing. Default: 3. */
  maxBacks?: number;
}

const DEFAULT_SCROLL_SEARCH_DIRECTION: Direction = "down";
const DEFAULT_MAX_SCROLLS = 5;
const DEFAULT_DISMISS_KEYBOARD_STRATEGY: KeyboardDismissStrategy = "auto";
const DEFAULT_MAX_BACKS = 3;

function computeSwipeCoords(
  direction: Direction,
  screenW: number,
  screenH: number,
  offsetFraction: number,
): { startX: number; startY: number; endX: number; endY: number } {
  const cx = screenW / 2;
  const cy = screenH / 2;
  const offset = Math.min(screenW, screenH) * offsetFraction;

  return {
    up: { startX: cx, startY: cy + offset, endX: cx, endY: cy - offset },
    down: { startX: cx, startY: cy - offset, endX: cx, endY: cy + offset },
    left: { startX: cx + offset, startY: cy, endX: cx - offset, endY: cy },
    right: { startX: cx - offset, startY: cy, endX: cx + offset, endY: cy },
  }[direction];
}

type PollMatchResult = { matched: boolean; actual?: string };

export interface CoordinatorConfig {
  parse: HierarchyParser;
  defaults?: WaitOptions;
  screenWidth?: number;
  screenHeight?: number;
  /** Pause after each action (tap, scroll) to let the UI settle. */
  waitForIdleTimeout?: number;
  /** Delay between each character when typing. */
  typingDelay?: number;
  /** Hierarchy cache TTL in ms. Default: 100. Set to 0 to disable caching. */
  hierarchyCacheTtl?: number;
  /** Default output directory for screenshot diffs. */
  outputDir?: string;
}

export function createCoordinator<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  config: CoordinatorConfig,
) {
  const { parse, defaults } = config;

  const cacheConfig: HierarchyCacheConfig = {
    hierarchyCacheTtl: config.hierarchyCacheTtl,
  };
  const cache: HierarchyCache = createHierarchyCache(cacheConfig);

  const idleWait = (): Effect.Effect<void> => {
    const ms = config.waitForIdleTimeout;
    return ms && ms > 0 ? Effect.sleep(Duration.millis(ms)) : Effect.void;
  };

  /** Invalidate cache after any mutation action */
  const afterMutation = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      cache.invalidate();
      yield* idleWait();
    });

  // Clamp Y to avoid iOS system gesture zones (home indicator, notification center).
  // Uses screen dimensions from coordinator config (fetched once at init).
  const screenH = config.screenHeight ?? 1920;
  const safeMinY = screenH * 0.15;
  const safeMaxY = screenH * 0.85;
  const clampY = (y: number): number => Math.max(safeMinY, Math.min(safeMaxY, y));

  const swipeEffect = (
    direction: Direction,
    opts?: { duration?: number },
  ): Effect.Effect<void, DriverError> =>
    Effect.gen(function* () {
      const w = config.screenWidth ?? 1080;
      const h = config.screenHeight ?? 1920;
      const coords = computeSwipeCoords(direction, w, h, 0.2);
      yield* driver.swipe(
        coords.startX,
        clampY(coords.startY),
        coords.endX,
        clampY(coords.endY),
        opts?.duration ?? 300,
      );
      yield* afterMutation();
    });

  const scrollEffect = (direction: Direction): Effect.Effect<void, DriverError> =>
    Effect.gen(function* () {
      const w = config.screenWidth ?? 1080;
      const h = config.screenHeight ?? 1920;
      const coords = computeSwipeCoords(direction, w, h, 0.3);
      yield* driver.swipe(
        coords.startX,
        clampY(coords.startY),
        coords.endX,
        clampY(coords.endY),
        500,
      );
      // Wait for scroll animation to settle before probing hierarchy
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 300)));
      yield* afterMutation();
    });

  const probeVisible = (
    selector: ExtendedSelector,
    opts?: WaitOptions & { probeTimeout?: number },
  ): Effect.Effect<boolean, DriverError> =>
    Effect.gen(function* () {
      cache.invalidate();
      const probeTimeout = opts?.probeTimeout ?? 1;
      const result = yield* Effect.either(
        waitForElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts, timeout: probeTimeout },
          cache,
        ),
      );

      if (result._tag === "Right") {
        return true;
      }

      if (result.left._tag === "ElementNotFoundError" || result.left._tag === "WaitTimeoutError") {
        return false;
      }

      return yield* result.left;
    });

  const gestureDirectionForSearch = (direction: Direction): Direction => {
    const directionMap: Record<Direction, Direction> = {
      up: "down",
      down: "up",
      left: "right",
      right: "left",
    };

    return directionMap[direction];
  };

  const pollUntilMatch = (
    selector: ExtendedSelector,
    opts: WaitOptions | undefined,
    check: (el: Element) => PollMatchResult,
    formatError: (
      actual: string | undefined,
      timeout: number,
    ) => {
      message: string;
      expected: string;
    },
  ): Effect.Effect<
    void,
    ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
  > =>
    Effect.gen(function* () {
      const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
      const pollInterval = opts?.pollInterval ?? defaults?.pollInterval ?? 200;
      const start = Date.now();
      let lastActual: string | undefined;

      while (Date.now() - start < timeout) {
        if (cache) cache.invalidate();
        const raw = yield* driver.dumpHierarchy();
        const root = parse(raw);
        const element = findElementExtended(root, selector);
        if (element) {
          const result = check(element);
          if (result.matched) return;
          lastActual = result.actual;
        }
        yield* Effect.sleep(Duration.millis(pollInterval));
      }

      const err = formatError(lastActual, timeout);
      return yield* new TextMismatchError({
        message: err.message,
        expected: err.expected,
        actual: lastActual,
        selector,
      });
    });

  const dismissKeyboardWithDriver = (): Effect.Effect<void, DriverError> =>
    Effect.gen(function* () {
      yield* driver.hideKeyboard();
      yield* afterMutation();
    });

  const dismissKeyboardWithBack = (): Effect.Effect<void, DriverError> =>
    Effect.gen(function* () {
      yield* driver.back();
      yield* afterMutation();
    });

  const scaleGesture = (
    methodName: "pinch" | "zoom",
    selector: ExtendedSelector,
    opts?: { scale?: number; duration?: number } & WaitOptions,
  ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
    Effect.gen(function* () {
      const element = yield* waitForActionElement(
        driver,
        selector,
        parse,
        { ...defaults, ...opts },
        cache,
      );
      const { x, y } = centerOf(element);
      const scale = opts?.scale ?? 0.5;
      const duration = opts?.duration ?? 1500;
      const fn = methodName === "pinch" ? driver.pinch : driver.zoom;
      if (!fn) {
        return yield* new DriverError({
          message: `${methodName}() is only supported on mobile platforms (Android/iOS)`,
        });
      }
      yield* fn.call(driver, x, y, scale, duration);
      yield* afterMutation();
    });

  const assertEnabledState = (
    selector: ExtendedSelector,
    expectedEnabled: boolean,
    opts?: WaitOptions,
  ): Effect.Effect<
    void,
    ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
  > =>
    Effect.gen(function* () {
      const element = yield* waitForElement(
        driver,
        selector,
        parse,
        { ...defaults, ...opts },
        cache,
      );
      const isEnabled = element.enabled !== false;
      if (isEnabled !== expectedEnabled) {
        const state = expectedEnabled ? "enabled" : "disabled";
        const actual = expectedEnabled ? "disabled" : "enabled";
        return yield* new TextMismatchError({
          message: `Expected element to be ${state} but it is ${actual} — selector: ${formatSelector(selector)}`,
          expected: state,
          actual,
          selector,
        });
      }
    });

  const createAssertions = () => ({
    assertVisible: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      waitForElement(driver, selector, parse, { ...defaults, ...opts }, cache),

    assertHidden: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, WaitTimeoutError | DriverError> =>
      waitForNotVisible(driver, selector, parse, { ...defaults, ...opts }, cache),

    assertText: (
      selector: ExtendedSelector,
      expected: string,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => ({ matched: el.text === expected, actual: el.text }),
        (actual, timeout) => ({
          message: `Expected text "${expected}" but got "${actual ?? "(no text)"}" after ${timeout}ms`,
          expected,
        }),
      ),

    assertContainsText: (
      selector: ExtendedSelector,
      expected: string,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.text ?? "";
          return {
            matched: actual.toLowerCase().includes(expected.toLowerCase()),
            actual: el.text,
          };
        },
        (actual, timeout) => ({
          message: `Expected text to contain "${expected}" but got "${actual ?? "(no text)"}" after ${timeout}ms`,
          expected,
        }),
      ),

    assertEnabled: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > => assertEnabledState(selector, true, opts),

    assertDisabled: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > => assertEnabledState(selector, false, opts),

    getText: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<string, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts },
          cache,
        );
        return element.text ?? "";
      }),

    isElementEnabled: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<boolean, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts },
          cache,
        );
        return element.enabled !== false;
      }),

    assertValue: (
      selector: ExtendedSelector,
      expected: string | number,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > => {
      const expectedStr = String(expected);
      return pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.value ?? "";
          return { matched: actual === expectedStr, actual };
        },
        (actual, timeout) => ({
          message: `Expected value "${expectedStr}" but got "${actual ?? "(no value)"}" after ${timeout}ms`,
          expected: expectedStr,
        }),
      );
    },

    assertAttribute: (
      selector: ExtendedSelector,
      name: string,
      expectedValue?: string,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.attributes?.[name];
          if (expectedValue === undefined) {
            return { matched: actual !== undefined, actual };
          }
          return { matched: actual === expectedValue, actual };
        },
        (actual, timeout) =>
          expectedValue === undefined
            ? {
                message: `Expected attribute "${name}" to exist but it was not found after ${timeout}ms`,
                expected: name,
              }
            : {
                message: `Expected attribute "${name}" to be "${expectedValue}" but got "${actual ?? "(not found)"}" after ${timeout}ms`,
                expected: expectedValue,
              },
      ),

    assertMatchesText: (
      selector: ExtendedSelector,
      pattern: RegExp,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.text ?? "";
          return { matched: pattern.test(actual), actual };
        },
        (actual, timeout) => ({
          message: `Expected text to match ${pattern} but got "${actual ?? "(no text)"}" after ${timeout}ms`,
          expected: String(pattern),
        }),
      ),

    getAttribute: (
      selector: ExtendedSelector,
      name: string,
      opts?: WaitOptions,
    ): Effect.Effect<string | undefined, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts },
          cache,
        );
        return element.attributes?.[name];
      }),

    assertScreenshot: (
      selector: ExtendedSelector | undefined,
      name: string,
      flowFilePath: string,
      flowName: string,
      platform: string,
      options: {
        threshold?: number;
        maxDiffPixelRatio?: number;
        mask?: Array<{ x: number; y: number; width: number; height: number }>;
        updateBaselines?: boolean;
        outputDir?: string;
        baselinesDir?: string;
      },
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const { resolveBaselinePath, readBaseline, writeBaseline } = yield* Effect.promise(
          () => import("../core/baseline-manager.js"),
        );
        const { cropToElement, applyMask, compareScreenshots } = yield* Effect.promise(
          () => import("../core/screenshot-compare.js"),
        );

        // 1. Take screenshot
        const raw = yield* driver.takeScreenshot();

        // 2. Optionally crop to element bounds
        let screenshotBuf: Buffer;
        if (selector !== undefined) {
          const element = yield* waitForElement(driver, selector, parse, { ...defaults }, cache);
          screenshotBuf = yield* Effect.promise(() => cropToElement(raw, element.bounds));
        } else {
          screenshotBuf = Buffer.from(raw);
        }

        // 3. Resolve baseline path
        const baselinePath = resolveBaselinePath(
          flowFilePath,
          flowName,
          platform,
          name,
          options.baselinesDir,
        );

        // 4. If updateBaselines: write baseline and return
        if (options.updateBaselines) {
          yield* Effect.promise(() => Promise.resolve(writeBaseline(baselinePath, screenshotBuf)));
          return;
        }

        // 5. If no baseline exists (first run): write baseline and return
        const existing = readBaseline(baselinePath);
        if (existing === null) {
          yield* Effect.promise(() => Promise.resolve(writeBaseline(baselinePath, screenshotBuf)));
          return;
        }

        // 6. Apply masks if provided
        let actualBuf: Buffer = screenshotBuf;
        if (options.mask && options.mask.length > 0) {
          actualBuf = yield* Effect.promise(() => applyMask(screenshotBuf, options.mask!));
        }

        // 7. Compare
        const result = compareScreenshots(existing, actualBuf, {
          threshold: options.threshold,
          maxDiffPixelRatio: options.maxDiffPixelRatio,
        });

        // 8. If mismatch: write output images and fail
        if (!result.match) {
          const { writeFileSync, mkdirSync } = yield* Effect.promise(() => import("node:fs"));
          const { join } = yield* Effect.promise(() => import("node:path"));
          const outDir = options.outputDir ?? config.outputDir ?? "spana-output";
          mkdirSync(outDir, { recursive: true });
          const safeFlowName = flowName
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, "-")
            .replaceAll(/^-|-$/g, "");
          const prefix = join(outDir, `${safeFlowName}-${platform}-${name}`);
          writeFileSync(`${prefix}-expected.png`, existing);
          writeFileSync(`${prefix}-actual.png`, actualBuf);
          if (result.diffImage) {
            writeFileSync(`${prefix}-diff.png`, result.diffImage);
          }
          const detail = result.sizeMismatch
            ? "image dimensions differ"
            : `${result.diffPixelCount} differing pixels (ratio: ${(result.diffPixelRatio * 100).toFixed(2)}%)`;
          return yield* new DriverError({
            message: `Screenshot mismatch for "${name}": ${detail}. Expected: ${prefix}-expected.png, Actual: ${prefix}-actual.png${result.diffImage ? `, Diff: ${prefix}-diff.png` : ""}`,
          });
        }
      }),

    assertAccessibilityLabel: (
      selector: ExtendedSelector,
      expected?: string,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const label = el.accessibilityLabel;
          if (expected === undefined) {
            return { matched: label !== undefined && label.length > 0, actual: label };
          }
          return { matched: label === expected, actual: label };
        },
        (actual, timeout) =>
          expected === undefined
            ? {
                message: `Expected element to have a non-empty accessibilityLabel but got "${actual ?? "(none)"}" after ${timeout}ms`,
                expected: "(non-empty)",
              }
            : {
                message: `Expected accessibilityLabel "${expected}" but got "${actual ?? "(none)"}" after ${timeout}ms`,
                expected,
              },
      ),

    assertFocusable: (
      selector: ExtendedSelector,
      platform: string,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      Effect.gen(function* () {
        const { isFocusable } = yield* Effect.promise(
          () => import("../core/accessibility-audit.js"),
        );
        yield* pollUntilMatch(
          selector,
          opts,
          (el) => {
            const focusable = isFocusable(el as unknown as Record<string, unknown>, {
              platform: platform as import("../schemas/selector.js").Platform,
            });
            return { matched: focusable, actual: focusable ? "focusable" : "not focusable" };
          },
          (actual, timeout) => ({
            message: `Expected element to be focusable but it was "${actual ?? "not focusable"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
            expected: "focusable",
          }),
        );
      }),

    assertRole: (
      selector: ExtendedSelector,
      expectedRole: string,
      platform: string,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      Effect.gen(function* () {
        const { normalizeRole } = yield* Effect.promise(
          () => import("../core/accessibility-audit.js"),
        );
        yield* pollUntilMatch(
          selector,
          opts,
          (el) => {
            const actual = normalizeRole(
              platform as import("../schemas/selector.js").Platform,
              el.elementType ?? "",
              el.attributes ?? {},
            );
            return { matched: actual === expectedRole, actual };
          },
          (actual, timeout) => ({
            message: `Expected role "${expectedRole}" but got "${actual ?? "(unknown)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
            expected: expectedRole,
          }),
        );
      }),

    assertMinTouchTarget: (
      selector: ExtendedSelector,
      minSize: number,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const { width, height } = el.bounds;
          const passed = width >= minSize && height >= minSize;
          const actual = `${width}x${height}`;
          return { matched: passed, actual };
        },
        (actual, timeout) => ({
          message: `Expected touch target to be at least ${minSize}x${minSize}px but got "${actual ?? "(unknown)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: `${minSize}x${minSize}`,
        }),
      ),

    assertAccessibilityAudit: (
      platform: string,
      options: {
        severity?: "critical" | "serious" | "moderate" | "minor";
        rules?: string[];
        targetSelector?: string;
        excludeSelectors?: string[];
      } = {},
    ): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        if (platform !== "web") {
          return yield* new DriverError({
            message: `assertAccessibilityAudit() is only supported on web — platform "${platform}" is not supported`,
          });
        }

        const { readFileSync } = yield* Effect.promise(() => import("node:fs"));
        const { createRequire } = yield* Effect.promise(() => import("node:module"));
        const require = createRequire(import.meta.url);
        const axePath: string = require.resolve("axe-core/axe.js");
        const axeSource = readFileSync(axePath, "utf-8");

        const { filterViolations, formatViolationSummary } = yield* Effect.promise(
          () => import("../core/accessibility-audit.js"),
        );

        const axeContext: Record<string, string[][]> = {};
        if (options.targetSelector) {
          axeContext["include"] = [[options.targetSelector]];
        }
        if (options.excludeSelectors && options.excludeSelectors.length > 0) {
          axeContext["exclude"] = options.excludeSelectors.map((s) => [s]);
        }
        const serializedContext =
          Object.keys(axeContext).length > 0 ? JSON.stringify(axeContext) : "document";

        const axeOptions: Record<string, unknown> = {};
        if (options.rules && options.rules.length > 0) {
          const rulesConfig: Record<string, { enabled: boolean }> = {};
          for (const r of options.rules) rulesConfig[r] = { enabled: true };
          axeOptions["rules"] = rulesConfig;
        }

        // Inject axe-core and run
        const script = `
          (function() {
            ${axeSource}
            return axe.run(${serializedContext}, ${JSON.stringify(axeOptions)});
          })()
        `;

        type AxeResult = {
          violations: Array<{
            id: string;
            impact: string;
            description: string;
            helpUrl: string;
            tags: string[];
            nodes: Array<{
              target: string[];
              html: string;
              failureSummary: string;
            }>;
          }>;
        };

        const axeResult = yield* driver.evaluate<AxeResult>(script);

        const violations = axeResult.violations.map((v) => ({
          ruleId: v.id,
          severity: (v.impact ?? "minor") as "critical" | "serious" | "moderate" | "minor",
          description: v.description,
          helpUrl: v.helpUrl,
          wcagCriteria: v.tags.filter((t) => t.startsWith("wcag")),
          elements: v.nodes.map((n) => ({
            selector: n.target.join(", "),
            html: n.html,
            failureSummary: n.failureSummary,
          })),
        }));

        const minSeverity = options.severity ?? "serious";
        const filtered = filterViolations(violations, minSeverity);

        if (filtered.length > 0) {
          const summary = formatViolationSummary(filtered);
          return yield* new DriverError({ message: summary });
        }
      }),
  });

  return {
    tap: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForActionElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts },
          cache,
        );
        const { x, y } = centerOf(element);
        yield* driver.tapAtCoordinate(x, y);
        yield* afterMutation();
      }),

    tapXY: (x: number, y: number): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        yield* driver.tapAtCoordinate(x, y);
        yield* afterMutation();
      }),

    doubleTap: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForActionElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts },
          cache,
        );
        const { x, y } = centerOf(element);
        yield* driver.tapAtCoordinate(x, y);
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 200)));
        yield* driver.tapAtCoordinate(x, y);
        yield* afterMutation();
      }),

    longPress: (
      selector: ExtendedSelector,
      duration: number = 1000,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForActionElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts },
          cache,
        );
        const { x, y } = centerOf(element);
        yield* driver.longPressAtCoordinate(x, y, duration);
        yield* afterMutation();
      }),

    longPressXY: (
      x: number,
      y: number,
      duration: number = 1000,
    ): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        yield* driver.longPressAtCoordinate(x, y, duration);
        yield* afterMutation();
      }),

    inputText: (text: string): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        const delay = config.typingDelay;
        if (delay && delay > 0) {
          for (const segment of splitGraphemes(text)) {
            yield* driver.inputText(segment);
            yield* Effect.sleep(Duration.millis(delay));
          }
        } else {
          yield* driver.inputText(text);
        }
        yield* afterMutation();
      }),

    pressKey: (key: string): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        yield* driver.pressKey(key);
        cache.invalidate();
      }),

    hideKeyboard: (): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        yield* driver.hideKeyboard();
        cache.invalidate();
      }),

    dismissKeyboard: (opts?: DismissKeyboardOptions): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        const strategy = opts?.strategy ?? DEFAULT_DISMISS_KEYBOARD_STRATEGY;
        if (strategy === "driver") {
          return yield* dismissKeyboardWithDriver();
        }
        if (strategy === "back") {
          return yield* dismissKeyboardWithBack();
        }

        const platform = (yield* driver.getDeviceInfo()).platform;
        const hideKeyboardResult = yield* Effect.either(driver.hideKeyboard());
        if (hideKeyboardResult._tag === "Right") {
          yield* afterMutation();
          return;
        }

        if (platform === "android") {
          const backResult = yield* Effect.either(driver.back());
          if (backResult._tag === "Right") {
            yield* afterMutation();
            return;
          }

          return yield* new DriverError({
            message: `dismissKeyboard() failed with strategy "auto" on android. hideKeyboard(): ${hideKeyboardResult.left.message}. back(): ${backResult.left.message}`,
          });
        }

        return yield* new DriverError({
          message: `dismissKeyboard() failed with strategy "auto" on ${platform}. hideKeyboard(): ${hideKeyboardResult.left.message}`,
        });
      }),

    swipe: (direction: Direction, opts?: { duration?: number }): Effect.Effect<void, DriverError> =>
      swipeEffect(direction, opts),

    scroll: (direction: Direction): Effect.Effect<void, DriverError> => scrollEffect(direction),

    scrollUntilVisible: (
      selector: ExtendedSelector,
      opts?: ScrollUntilVisibleOptions,
    ): Effect.Effect<void, ElementNotFoundError | DriverError> =>
      Effect.gen(function* () {
        const searchDirection = opts?.direction ?? DEFAULT_SCROLL_SEARCH_DIRECTION;
        const gestureDirection = gestureDirectionForSearch(searchDirection);
        const maxScrolls = Math.max(0, opts?.maxScrolls ?? DEFAULT_MAX_SCROLLS);
        const totalTimeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const deadline = Date.now() + totalTimeout;
        let scrollCount = 0;

        while (scrollCount <= maxScrolls && Date.now() <= deadline) {
          const found = yield* probeVisible(selector, opts);
          if (found) {
            return;
          }

          if (scrollCount === maxScrolls) {
            break;
          }

          yield* scrollEffect(gestureDirection);
          scrollCount += 1;
        }

        return yield* new ElementNotFoundError({
          message: `Element not found after ${scrollCount} scroll(s) toward ${searchDirection} — selector: ${formatSelector(selector)}`,
          selector,
          timeoutMs: totalTimeout,
        });
      }),

    backUntilVisible: (
      selector: ExtendedSelector,
      opts?: BackUntilVisibleOptions,
    ): Effect.Effect<void, ElementNotFoundError | DriverError> =>
      Effect.gen(function* () {
        const maxBacks = Math.max(0, opts?.maxBacks ?? DEFAULT_MAX_BACKS);
        const totalTimeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const deadline = Date.now() + totalTimeout;
        let backCount = 0;

        while (backCount <= maxBacks && Date.now() <= deadline) {
          const found = yield* probeVisible(selector, opts);
          if (found) {
            return;
          }

          if (backCount === maxBacks) {
            break;
          }

          const backResult = yield* Effect.either(driver.back());
          if (backResult._tag === "Left") {
            return yield* new DriverError({
              message: `backUntilVisible() failed on back attempt ${backCount + 1}: ${backResult.left.message}`,
            });
          }

          yield* afterMutation();
          backCount += 1;
        }

        return yield* new ElementNotFoundError({
          message: `Element not found after ${backCount} back action(s) — selector: ${formatSelector(selector)}. If this screen uses an in-app close or back control, tap that element instead of relying on system back.`,
          selector,
          timeoutMs: totalTimeout,
        });
      }),

    pinch: (
      selector: ExtendedSelector,
      opts?: { scale?: number; duration?: number } & WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      scaleGesture("pinch", selector, opts),

    zoom: (
      selector: ExtendedSelector,
      opts?: { scale?: number; duration?: number } & WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      scaleGesture("zoom", selector, opts),

    multiTouch: (
      sequences: import("../drivers/raw-driver.js").TouchSequence[],
    ): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        if (!driver.multiTouch) {
          return yield* new DriverError({
            message: "multiTouch() is only supported on mobile platforms (Android/iOS)",
          });
        }
        yield* driver.multiTouch(sequences);
        yield* afterMutation();
      }),

    ...createAssertions(),
  };
}
