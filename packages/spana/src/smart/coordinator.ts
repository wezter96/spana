import { Duration, Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { Element } from "../schemas/element.js";
import type { ExtendedSelector, Platform, Selector, TapMode } from "../schemas/selector.js";
import { isSystemUISelector } from "../schemas/selector.js";
import {
  buildDomActionabilityDiagScript,
  buildDomFindElementScript,
  buildDomFocusScript,
  buildDomSelectOptionScript,
  type DomWaitForMatchOptions,
  type SelectOptionInput,
} from "../channels/dom-channel.js";
import type { WaitTimeoutError } from "../errors.js";
import { DriverError, ElementNotFoundError, TextMismatchError } from "../errors.js";
import { splitGraphemes } from "../core/graphemes.js";
import { centerOf, findElements, formatSelector } from "./element-matcher.js";
import {
  waitForActionElement,
  waitForElement,
  waitForNotVisible,
  waitForResolvedElementResult,
  type WaitOptions,
} from "./auto-wait.js";
import { isInvalidSelectorError, resolveElementAcrossChannels } from "./channel-resolver.js";
import { domMatchToElement } from "../channels/dom-channel.js";
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
  /** Default tap mode ("native" real touch, or "dom" fast synthetic click). */
  tapMode?: TapMode;
  /** Platform hint for DOM-to-screen coordinate conversion. */
  platform?: Platform;
}

function isRelativeSelectorLike(selector: ExtendedSelector): boolean {
  if (typeof selector !== "object" || selector === null) return false;
  return (
    "below" in selector ||
    "above" in selector ||
    "leftOf" in selector ||
    "rightOf" in selector ||
    "childOf" in selector
  );
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

  /** Invalidate cache after any mutation action (and apply explicit waitForIdleTimeout if configured) */
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
      // On mobile, settle scroll momentum reactively when a DOM channel is live,
      // otherwise use a compact 100ms settle instead of a long fixed sleep; web scrollBy is synchronous.
      if (config.platform !== "web") {
        if (driver.domChannel?.isConnected() && driver.domChannel.waitForIdle) {
          yield* Effect.tryPromise({
            try: () => driver.domChannel!.waitForIdle!({ timeout: 150, quietPeriodMs: 30 }),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.void));
        } else {
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 100)));
        }
      }
      yield* afterMutation();
    });

  const probeVisible = (
    selector: ExtendedSelector,
    opts?: WaitOptions & { probeTimeout?: number },
  ): Effect.Effect<boolean, DriverError> =>
    Effect.gen(function* () {
      cache.invalidate();
      const domChannel = driver.domChannel;
      if (
        !isSystemUISelector(selector) &&
        !isRelativeSelectorLike(selector) &&
        domChannel?.isConnected()
      ) {
        const matches = yield* Effect.tryPromise({
          try: () => domChannel.query(selector as Selector),
          catch: (err) =>
            isInvalidSelectorError(err)
              ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
              : null,
        }).pipe(
          Effect.catch((err) =>
            err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
          ),
        );
        if (matches) {
          return matches.some((m) => m.visible && m.rect.width > 0 && m.rect.height > 0);
        }
      }
      const probeTimeout = opts?.probeTimeout ?? 1;
      const result = yield* Effect.result(
        waitForElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts, timeout: probeTimeout },
          cache,
        ),
      );

      if (result._tag === "Success") {
        return true;
      }

      if (
        result.failure._tag === "ElementNotFoundError" ||
        result.failure._tag === "WaitTimeoutError"
      ) {
        return false;
      }

      return yield* result.failure;
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

  const normalizeWhitespace = (s: string): string => s.replaceAll(/\s+/g, " ").trim();

  const collectContainerText = (el: Element): string => {
    if (el.text) return el.text;
    const parts: string[] = [];
    const stack: Element[] = [...(el.children ?? [])].toReversed();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.visible === false) continue;
      if (node.text) parts.push(node.text);
      if (node.children) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i]!);
        }
      }
    }
    return parts.join(" ").trim();
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
    domMatchSpec?: Omit<DomWaitForMatchOptions, "timeoutMs">,
    negate: boolean = false,
  ): Effect.Effect<
    void,
    ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
  > =>
    Effect.gen(function* () {
      const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
      const pollInterval = opts?.pollInterval ?? defaults?.pollInterval ?? 200;
      const start = Date.now();
      let lastActual: string | undefined;

      // Single-round-trip MutationObserver assertion wait on web/DOM channels (0 runner polling)
      const domChannel = driver.domChannel;
      if (
        domMatchSpec &&
        (config.platform === "web" || !config.platform) &&
        !isSystemUISelector(selector) &&
        !isRelativeSelectorLike(selector) &&
        domChannel?.isConnected() &&
        domChannel.waitForMatch
      ) {
        const reactive = yield* Effect.tryPromise({
          try: () =>
            domChannel.waitForMatch!(selector as Selector, {
              ...domMatchSpec,
              ...(negate ? { negate: true } : {}),
              timeoutMs: timeout,
            }),
          catch: (err) =>
            isInvalidSelectorError(err)
              ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
              : null,
        }).pipe(
          Effect.catch((err) =>
            err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
          ),
        );

        if (reactive) {
          if (reactive.matched) return;
          lastActual = reactive.actual;
          const err = formatError(lastActual, timeout);
          return yield* new TextMismatchError({
            message: err.message,
            expected: err.expected,
            actual: lastActual,
            selector,
          });
        }
      }

      const allowHiddenDom =
        domMatchSpec?.kind === "text" ||
        domMatchSpec?.kind === "containsText" ||
        domMatchSpec?.kind === "matchesText" ||
        domMatchSpec?.kind === "value" ||
        domMatchSpec?.kind === "attribute" ||
        domMatchSpec?.kind === "attached";

      while (Date.now() - start < timeout) {
        if (cache) cache.invalidate();
        let element: Element | undefined;
        if (
          allowHiddenDom &&
          !isSystemUISelector(selector) &&
          !isRelativeSelectorLike(selector) &&
          domChannel?.isConnected()
        ) {
          const domMatches = yield* Effect.tryPromise({
            try: () => domChannel.query(selector as Selector),
            catch: (err) =>
              isInvalidSelectorError(err)
                ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
                : null,
          }).pipe(
            Effect.catch((err) =>
              err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
            ),
          );
          if (domMatches && domMatches.length > 0) {
            const match = domMatches[domMatches.length - 1]!;
            element = domMatchToElement(match);
          }
        }
        if (!element) {
          const resolved = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
            forAction: false,
            platform: config.platform,
          });
          element = resolved?.element;
        }
        if (element) {
          const result = check(element);
          if (negate ? !result.matched : result.matched) return;
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
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > => {
      const normalizedExpected = normalizeWhitespace(expected);
      return pollUntilMatch(
        selector,
        opts,
        (el) => {
          const raw = el.textContent ?? el.text;
          const actual = raw !== undefined ? normalizeWhitespace(raw) : undefined;
          return { matched: actual === normalizedExpected, actual };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected text NOT to be "${expected}" after ${timeout}ms`
            : `Expected text "${expected}" but got "${actual ?? "(no text)"}" after ${timeout}ms`,
          expected: negate ? `not ${expected}` : expected,
        }),
        { kind: "text", expected },
        negate,
      );
    },

    assertContainsText: (
      selector: ExtendedSelector,
      expected: string,
      opts?: WaitOptions & { ignoreCase?: boolean },
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > => {
      const ignoreCase = Boolean(opts?.ignoreCase);
      const normalizedExpected = ignoreCase
        ? normalizeWhitespace(expected).toLowerCase()
        : normalizeWhitespace(expected);
      return pollUntilMatch(
        selector,
        opts,
        (el) => {
          const raw = el.textContent ?? el.text ?? "";
          const actual = normalizeWhitespace(raw);
          const matched = ignoreCase
            ? actual.toLowerCase().includes(normalizedExpected)
            : actual.includes(normalizedExpected);
          return { matched, actual };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected text NOT to contain "${expected}" but got "${actual ?? "(no text)"}" after ${timeout}ms`
            : `Expected text to contain "${expected}" but got "${actual ?? "(no text)"}" after ${timeout}ms`,
          expected: negate ? `not containing ${expected}` : expected,
        }),
        { kind: "containsText", expected, ...(ignoreCase ? { ignoreCase: true } : {}) },
        negate,
      );
    },

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
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        return collectContainerText(element);
      }),

    count: (
      selector: ExtendedSelector,
      opts?: WaitOptions & { visible?: boolean },
    ): Effect.Effect<number, DriverError> =>
      Effect.gen(function* () {
        cache.invalidate();
        const visibleOnly = Boolean(opts?.visible);
        const domChannel = driver.domChannel;
        if (
          !isSystemUISelector(selector) &&
          !isRelativeSelectorLike(selector) &&
          domChannel?.isConnected()
        ) {
          const matches = yield* Effect.tryPromise({
            try: () => domChannel.query(selector as Selector),
            catch: (err) =>
              isInvalidSelectorError(err)
                ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
                : null,
          }).pipe(
            Effect.catch((err) =>
              err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
            ),
          );
          if (matches) {
            return visibleOnly ? matches.filter((m) => m.visible).length : matches.length;
          }
        }
        const raw = yield* driver.dumpHierarchy();
        const root = parse(raw);
        if (isRelativeSelectorLike(selector)) {
          const resolved = yield* resolveElementAcrossChannels(driver, selector, parse, cache, {
            forAction: false,
            platform: opts?.platform ?? config.platform,
          });
          return resolved ? 1 : 0;
        }
        const matched = findElements(root, selector as Selector);
        return visibleOnly ? matched.filter((el) => el.visible !== false).length : matched.length;
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
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        return element.enabled !== false;
      }),

    assertValue: (
      selector: ExtendedSelector,
      expected: string | number | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > => {
      const isRe = expected instanceof RegExp;
      const expectedStr = isRe ? String(expected) : String(expected);
      return pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.value ?? "";
          const matched = isRe ? expected.test(actual) : actual === expectedStr;
          return { matched, actual };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected value NOT to ${isRe ? "match" : "be"} ${isRe ? expectedStr : JSON.stringify(expectedStr)} after ${timeout}ms`
            : `Expected value ${isRe ? expectedStr : JSON.stringify(expectedStr)} but got "${actual ?? "(no value)"}" after ${timeout}ms`,
          expected: negate ? `not ${expectedStr}` : expectedStr,
        }),
        isRe
          ? { kind: "value", patternSource: expected.source, patternFlags: expected.flags }
          : { kind: "value", expected: expectedStr },
        negate,
      );
    },

    assertAttribute: (
      selector: ExtendedSelector,
      name: string,
      expectedValue?: string | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > => {
      const isRe = expectedValue instanceof RegExp;
      return pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.attributes?.[name];
          if (expectedValue === undefined) {
            return { matched: actual !== undefined, actual };
          }
          const matched = isRe
            ? actual !== undefined && expectedValue.test(actual)
            : actual === expectedValue;
          return { matched, actual };
        },
        (actual, timeout) =>
          negate
            ? expectedValue === undefined
              ? {
                  message: `Expected attribute "${name}" NOT to exist but got "${actual ?? ""}" after ${timeout}ms`,
                  expected: `not ${name}`,
                }
              : {
                  message: `Expected attribute "${name}" NOT to ${isRe ? "match" : "be"} ${isRe ? String(expectedValue) : JSON.stringify(expectedValue)} after ${timeout}ms`,
                  expected: `not ${String(expectedValue)}`,
                }
            : expectedValue === undefined
              ? {
                  message: `Expected attribute "${name}" to exist but it was not found after ${timeout}ms`,
                  expected: name,
                }
              : {
                  message: `Expected attribute "${name}" to ${isRe ? "match" : "be"} ${isRe ? String(expectedValue) : JSON.stringify(expectedValue)} but got "${actual ?? "(not found)"}" after ${timeout}ms`,
                  expected: String(expectedValue),
                },
        isRe
          ? {
              kind: "attribute",
              attributeName: name,
              patternSource: expectedValue.source,
              patternFlags: expectedValue.flags,
            }
          : { kind: "attribute", attributeName: name, expected: expectedValue },
        negate,
      );
    },

    assertAttached: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<void, TextMismatchError | DriverError> =>
      Effect.gen(function* () {
        const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const pollInterval = opts?.pollInterval ?? defaults?.pollInterval ?? 100;
        const start = Date.now();
        const domChannel = driver.domChannel;
        if (
          (config.platform === "web" || !config.platform) &&
          !isSystemUISelector(selector) &&
          !isRelativeSelectorLike(selector) &&
          domChannel?.isConnected() &&
          domChannel.waitForMatch
        ) {
          const reactive = yield* Effect.tryPromise({
            try: () =>
              domChannel.waitForMatch!(selector as Selector, {
                kind: "attached",
                ...(negate ? { negate: true } : {}),
                timeoutMs: timeout,
              }),
            catch: (err) =>
              isInvalidSelectorError(err)
                ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
                : null,
          }).pipe(
            Effect.catch((err) =>
              err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
            ),
          );
          if (reactive) {
            if (reactive.matched) return;
            return yield* new TextMismatchError({
              message: negate
                ? `Expected element NOT to be attached after ${timeout}ms — selector: ${formatSelector(selector)}`
                : `Expected element to be attached after ${timeout}ms — selector: ${formatSelector(selector)}`,
              expected: negate ? "detached" : "attached",
              actual: reactive.actual ?? (negate ? "attached" : "detached"),
              selector,
            });
          }
        }

        while (Date.now() - start < timeout) {
          cache.invalidate();
          let attached = false;
          if (
            !isSystemUISelector(selector) &&
            !isRelativeSelectorLike(selector) &&
            domChannel?.isConnected()
          ) {
            const matches = yield* Effect.tryPromise({
              try: () => domChannel.query(selector as Selector),
              catch: (err) =>
                isInvalidSelectorError(err)
                  ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
                  : null,
            }).pipe(
              Effect.catch((err) =>
                err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
              ),
            );
            if (matches) {
              attached = matches.length > 0;
            }
          } else {
            const raw = yield* driver.dumpHierarchy();
            const root = parse(raw);
            attached = findElements(root, selector as Selector).length > 0;
          }
          if (negate ? !attached : attached) return;
          yield* Effect.sleep(Duration.millis(pollInterval));
        }

        return yield* new TextMismatchError({
          message: negate
            ? `Expected element NOT to be attached after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected element to be attached after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? "detached" : "attached",
          actual: negate ? "attached" : "detached",
          selector,
        });
      }),

    assertInViewport: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const vpW = config.screenWidth ?? 1280;
          const vpH = config.screenHeight ?? 720;
          const b = el.bounds;
          const inVp =
            b.width > 0 &&
            b.height > 0 &&
            b.x + b.width > 0 &&
            b.y + b.height > 0 &&
            b.x < vpW &&
            b.y < vpH;
          return { matched: inVp, actual: inVp ? "in viewport" : "outside viewport" };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected element NOT to be in viewport after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected element to be in viewport but it was "${actual ?? "outside viewport"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? "outside viewport" : "in viewport",
        }),
        { kind: "inViewport" },
        negate,
      ),

    assertJSProperty: (
      selector: ExtendedSelector,
      propertyName: string,
      expectedValue: unknown,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const raw = (el as unknown as Record<string, unknown>)[propertyName];
          const matched = JSON.stringify(raw) === JSON.stringify(expectedValue);
          return {
            matched,
            actual: typeof raw === "string" ? raw : JSON.stringify(raw),
          };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected JS property "${propertyName}" NOT to equal ${JSON.stringify(expectedValue)} after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected JS property "${propertyName}" to equal ${JSON.stringify(expectedValue)} but got ${actual ?? "undefined"} after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? `not ${JSON.stringify(expectedValue)}` : JSON.stringify(expectedValue),
        }),
        { kind: "jsProperty", propertyName, expectedValue },
        negate,
      ),

    assertMatchesText: (
      selector: ExtendedSelector,
      pattern: RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = normalizeWhitespace(el.textContent ?? el.text ?? "");
          return { matched: pattern.test(actual), actual };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected text NOT to match ${pattern} but got "${actual ?? "(no text)"}" after ${timeout}ms`
            : `Expected text to match ${pattern} but got "${actual ?? "(no text)"}" after ${timeout}ms`,
          expected: negate ? `not ${String(pattern)}` : String(pattern),
        }),
        { kind: "matchesText", patternSource: pattern.source, patternFlags: pattern.flags },
        negate,
      ),

    getAttribute: (
      selector: ExtendedSelector,
      name: string,
      opts?: WaitOptions,
    ): Effect.Effect<string | undefined, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const pollInterval = opts?.pollInterval ?? defaults?.pollInterval ?? 100;
        const domChannel = driver.domChannel;

        // On web/DOM channels, allow reading attributes from any attached element
        // (including display:none, <input type="hidden">, or zero-size elements without a layout box).
        if (
          !isSystemUISelector(selector) &&
          !isRelativeSelectorLike(selector) &&
          domChannel?.isConnected()
        ) {
          const start = Date.now();
          while (true) {
            const matches = yield* Effect.tryPromise({
              try: () => domChannel.query(selector as Selector),
              catch: () => null,
            }).pipe(Effect.catch(() => Effect.succeed(null)));
            if (matches && matches.length > 0) {
              const target = matches[matches.length - 1]!;
              return target.attributes?.[name];
            }
            if (Date.now() - start >= timeout) {
              return yield* new ElementNotFoundError({
                message: `Element not found within ${timeout}ms — selector: ${formatSelector(selector)}`,
                selector,
                timeoutMs: timeout,
              });
            }
            yield* Effect.sleep(Duration.millis(Math.min(pollInterval, 100)));
          }
        }

        const element = yield* waitForElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
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
        maskSelectors?: ExtendedSelector[];
        fullPage?: boolean;
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

        // 1. Take screenshot (optionally full-page when supported by driver)
        const raw =
          options.fullPage && driver.takeFullPageScreenshot
            ? yield* driver.takeFullPageScreenshot()
            : yield* driver.takeScreenshot();

        // Resolve mask selectors to pixel bounds if provided (3.2)
        const resolvedMasks: Array<{ x: number; y: number; width: number; height: number }> = [
          ...(options.mask ?? []),
        ];
        let cropOriginX = 0;
        let cropOriginY = 0;
        if (options.maskSelectors && options.maskSelectors.length > 0) {
          for (const maskSel of options.maskSelectors) {
            const found = yield* resolveElementAcrossChannels(driver, maskSel, parse, cache, {
              forAction: false,
              platform: config.platform,
            });
            if (found?.element?.bounds) {
              resolvedMasks.push(found.element.bounds);
            }
          }
        }

        // 2. Optionally crop to element bounds
        let screenshotBuf: Buffer;
        if (selector !== undefined) {
          const element = yield* waitForElement(driver, selector, parse, { ...defaults }, cache);
          cropOriginX = element.bounds.x;
          cropOriginY = element.bounds.y;
          screenshotBuf = yield* Effect.promise(() => cropToElement(raw, element.bounds));
        } else {
          screenshotBuf = Buffer.from(raw);
        }

        // Adjust mask coordinates relative to cropped element origin
        const effectiveMasks =
          selector !== undefined
            ? resolvedMasks.map((m) => ({
                x: Math.max(0, m.x - cropOriginX),
                y: Math.max(0, m.y - cropOriginY),
                width: m.width,
                height: m.height,
              }))
            : resolvedMasks;

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
          const toWrite =
            effectiveMasks.length > 0
              ? yield* Effect.promise(() => applyMask(screenshotBuf, effectiveMasks))
              : screenshotBuf;
          yield* Effect.promise(() => Promise.resolve(writeBaseline(baselinePath, toWrite)));
          return;
        }

        // 5. If no baseline exists (first run): write baseline and return
        const existing = readBaseline(baselinePath);
        if (existing === null) {
          const toWrite =
            effectiveMasks.length > 0
              ? yield* Effect.promise(() => applyMask(screenshotBuf, effectiveMasks))
              : screenshotBuf;
          yield* Effect.promise(() => Promise.resolve(writeBaseline(baselinePath, toWrite)));
          return;
        }

        // 6. Apply masks if provided
        let actualBuf: Buffer = screenshotBuf;
        let expectedBuf: Buffer = existing;
        if (effectiveMasks.length > 0) {
          actualBuf = yield* Effect.promise(() => applyMask(screenshotBuf, effectiveMasks));
          expectedBuf = yield* Effect.promise(() => applyMask(existing, effectiveMasks));
        }

        // 7. Compare
        const result = compareScreenshots(expectedBuf, actualBuf, {
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
        { kind: "accessibilityLabel", expected },
      ),

    assertAccessibleName: (
      selector: ExtendedSelector,
      expected: string | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.accessibilityLabel || el.text || "";
          const matched =
            expected instanceof RegExp ? expected.test(actual) : actual.trim() === expected.trim();
          return { matched, actual };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected accessible name NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? "(none)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected accessible name ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? "(none)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? `not ${String(expected)}` : String(expected),
        }),
        expected instanceof RegExp
          ? {
              kind: "accessibleName",
              patternSource: expected.source,
              patternFlags: expected.flags,
            }
          : { kind: "accessibleName", expected },
        negate,
      ),

    assertAccessibleDescription: (
      selector: ExtendedSelector,
      expected: string | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.accessibleDescription ?? el.attributes?.["aria-description"] ?? "";
          const matched =
            expected instanceof RegExp ? expected.test(actual) : actual.trim() === expected.trim();
          return { matched, actual };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected accessible description NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? "(none)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected accessible description ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? "(none)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? `not ${String(expected)}` : String(expected),
        }),
        expected instanceof RegExp
          ? {
              kind: "accessibleDescription",
              patternSource: expected.source,
              patternFlags: expected.flags,
            }
          : { kind: "accessibleDescription", expected },
        negate,
      ),

    assertFocused: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => ({
          matched: el.focused === true,
          actual: el.focused ? "focused" : "not focused",
        }),
        (actual, timeout) => ({
          message: negate
            ? `Expected element NOT to be focused but it was "${actual ?? "focused"}" after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected element to be focused but it was "${actual ?? "not focused"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? "not focused" : "focused",
        }),
        { kind: "focused" },
        negate,
      ),

    assertChecked: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => ({
          matched: el.checked === true || el.attributes?.["aria-checked"] === "true",
          actual: el.checked ? "checked" : "unchecked",
        }),
        (actual, timeout) => ({
          message: negate
            ? `Expected element NOT to be checked but it was "${actual ?? "checked"}" after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected element to be checked but it was "${actual ?? "unchecked"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? "unchecked" : "checked",
        }),
        { kind: "checked" },
        negate,
      ),

    assertEditable: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => ({
          matched: el.editable === true,
          actual: el.editable ? "editable" : "not editable",
        }),
        (actual, timeout) => ({
          message: negate
            ? `Expected element NOT to be editable but it was "${actual ?? "editable"}" after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected element to be editable but it was "${actual ?? "not editable"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? "not editable" : "editable",
        }),
        { kind: "editable" },
        negate,
      ),

    assertEmpty: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const isEmpty =
            el.empty !== undefined
              ? el.empty
              : (el.value ?? el.textContent ?? el.text ?? "").trim().length === 0;
          return {
            matched: isEmpty,
            actual: isEmpty ? "empty" : (el.value ?? el.text ?? "non-empty"),
          };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected element NOT to be empty after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected element to be empty but got "${actual ?? "(non-empty)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? "non-empty" : "empty",
        }),
        { kind: "empty" },
        negate,
      ),

    assertClass: (
      selector: ExtendedSelector,
      expected: string | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const cls = el.className ?? el.attributes?.["class"] ?? "";
          const matched =
            expected instanceof RegExp
              ? expected.test(cls)
              : expected
                  .trim()
                  .split(/\s+/)
                  .filter(Boolean)
                  .every((tok) => cls.trim().split(/\s+/).includes(tok));
          return { matched, actual: cls };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected class NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? ""}" after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected class ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? ""}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? `not ${String(expected)}` : String(expected),
        }),
        expected instanceof RegExp
          ? { kind: "class", patternSource: expected.source, patternFlags: expected.flags }
          : { kind: "class", expected },
        negate,
      ),

    assertCss: (
      selector: ExtendedSelector,
      property: string,
      expected: string | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      pollUntilMatch(
        selector,
        opts,
        (el) => {
          const actual = el.attributes?.[`style:${property}`] ?? "";
          const matched =
            expected instanceof RegExp ? expected.test(actual) : actual.trim() === expected.trim();
          return { matched, actual };
        },
        (actual, timeout) => ({
          message: negate
            ? `Expected CSS "${property}" NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? ""}" after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected CSS "${property}" to be ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got "${actual ?? ""}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? `not ${String(expected)}` : String(expected),
        }),
        expected instanceof RegExp
          ? {
              kind: "css",
              cssProperty: property,
              patternSource: expected.source,
              patternFlags: expected.flags,
            }
          : { kind: "css", cssProperty: property, expected },
        negate,
      ),

    waitForTitle: (
      expected: string | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<void, TextMismatchError | DriverError> =>
      Effect.gen(function* () {
        const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const pollInterval = opts?.pollInterval ?? defaults?.pollInterval ?? 100;
        const start = Date.now();
        let lastTitle = "";
        const matchesTitle = (t: string): boolean =>
          expected instanceof RegExp ? expected.test(t) : t === expected;

        const domChannel = driver.domChannel;
        if (
          (config.platform === "web" || !config.platform) &&
          domChannel?.isConnected() &&
          domChannel.waitForMatch
        ) {
          const reactive = yield* Effect.tryPromise({
            try: () =>
              domChannel.waitForMatch!("", {
                kind: "title",
                ...(expected instanceof RegExp
                  ? { patternSource: expected.source, patternFlags: expected.flags }
                  : { expected }),
                ...(negate ? { negate: true } : {}),
                timeoutMs: timeout,
              }),
            catch: () => null,
          }).pipe(Effect.catch(() => Effect.succeed(null)));

          if (reactive) {
            if (reactive.matched) return;
            return yield* new TextMismatchError({
              message: negate
                ? `Expected title NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(reactive.actual ?? "")} after ${timeout}ms`
                : `Expected title ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(reactive.actual ?? "")} after ${timeout}ms`,
              expected: negate ? `not ${String(expected)}` : String(expected),
              actual: reactive.actual ?? "",
              selector: "title",
            });
          }
        }

        while (Date.now() - start < timeout) {
          const title = yield* driver
            .evaluate<string>("typeof document !== 'undefined' ? String(document.title || '') : ''")
            .pipe(Effect.catch(() => Effect.succeed("")));
          lastTitle = title;
          if (negate ? !matchesTitle(title) : matchesTitle(title)) return;
          yield* Effect.sleep(Duration.millis(pollInterval));
        }

        return yield* new TextMismatchError({
          message: negate
            ? `Expected title NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(lastTitle)} after ${timeout}ms`
            : `Expected title ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(lastTitle)} after ${timeout}ms`,
          expected: negate ? `not ${String(expected)}` : String(expected),
          actual: lastTitle,
          selector: "title",
        });
      }),

    assertCount: (
      selector: ExtendedSelector,
      expectedCount: number,
      opts?: WaitOptions & { visible?: boolean },
      negate: boolean = false,
    ): Effect.Effect<void, TextMismatchError | DriverError> =>
      Effect.gen(function* () {
        const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const pollInterval = opts?.pollInterval ?? defaults?.pollInterval ?? 200;
        const visibleOnly = Boolean(opts?.visible);
        const start = Date.now();
        let lastCount = -1;

        const domChannel = driver.domChannel;
        if (
          config.platform === "web" &&
          !isSystemUISelector(selector) &&
          !isRelativeSelectorLike(selector) &&
          domChannel?.isConnected() &&
          domChannel.waitForMatch
        ) {
          const reactive = yield* Effect.tryPromise({
            try: () =>
              domChannel.waitForMatch!(selector as Selector, {
                kind: "count",
                expectedCount,
                ...(visibleOnly ? { visibleOnly: true } : {}),
                ...(negate ? { negate: true } : {}),
                timeoutMs: timeout,
              }),
            catch: (err) =>
              isInvalidSelectorError(err)
                ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
                : null,
          }).pipe(
            Effect.catch((err) =>
              err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
            ),
          );

          if (reactive) {
            if (reactive.matched) return;
            return yield* new TextMismatchError({
              message: negate
                ? `Expected count NOT to be ${expectedCount} after ${timeout}ms — selector: ${formatSelector(selector)}`
                : `Expected count ${expectedCount} but got ${reactive.actual ?? "0"} after ${timeout}ms — selector: ${formatSelector(selector)}`,
              expected: negate ? `not ${expectedCount}` : String(expectedCount),
              actual: reactive.actual ?? "0",
              selector,
            });
          }
        }

        while (Date.now() - start < timeout) {
          cache.invalidate();
          if (
            !isSystemUISelector(selector) &&
            !isRelativeSelectorLike(selector) &&
            domChannel?.isConnected()
          ) {
            const matches = yield* Effect.tryPromise({
              try: () => domChannel.query(selector as Selector),
              catch: (err) =>
                isInvalidSelectorError(err)
                  ? new DriverError({ message: err instanceof Error ? err.message : String(err) })
                  : null,
            }).pipe(
              Effect.catch((err) =>
                err instanceof DriverError ? Effect.fail(err) : Effect.succeed(null),
              ),
            );
            if (matches) {
              const count = visibleOnly ? matches.filter((m) => m.visible).length : matches.length;
              lastCount = count;
              if (negate ? count !== expectedCount : count === expectedCount) return;
              yield* Effect.sleep(Duration.millis(pollInterval));
              continue;
            }
          }

          const raw = yield* driver.dumpHierarchy();
          const root = parse(raw);
          const matched = findElements(root, selector as Selector);
          const count = visibleOnly
            ? matched.filter((el) => el.visible !== false).length
            : matched.length;
          lastCount = count;
          if (negate ? count !== expectedCount : count === expectedCount) return;
          yield* Effect.sleep(Duration.millis(pollInterval));
        }

        return yield* new TextMismatchError({
          message: negate
            ? `Expected count NOT to be ${expectedCount} after ${timeout}ms — selector: ${formatSelector(selector)}`
            : `Expected count ${expectedCount} but got ${lastCount >= 0 ? lastCount : 0} after ${timeout}ms — selector: ${formatSelector(selector)}`,
          expected: negate ? `not ${expectedCount}` : String(expectedCount),
          actual: String(lastCount >= 0 ? lastCount : 0),
          selector,
        });
      }),

    waitForURL: (
      expected: string | RegExp,
      opts?: WaitOptions,
      negate: boolean = false,
    ): Effect.Effect<void, TextMismatchError | DriverError> =>
      Effect.gen(function* () {
        const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const pollInterval = opts?.pollInterval ?? defaults?.pollInterval ?? 100;
        const start = Date.now();
        let lastUrl = "";

        const matchesUrl = (url: string): boolean =>
          expected instanceof RegExp
            ? expected.test(url)
            : url === expected || url.includes(expected);

        const domChannel = driver.domChannel;
        if (
          (config.platform === "web" || !config.platform) &&
          domChannel?.isConnected() &&
          domChannel.waitForMatch
        ) {
          const reactive = yield* Effect.tryPromise({
            try: () =>
              domChannel.waitForMatch!("", {
                kind: "url",
                ...(expected instanceof RegExp
                  ? { patternSource: expected.source, patternFlags: expected.flags }
                  : { expected }),
                ...(negate ? { negate: true } : {}),
                timeoutMs: timeout,
              }),
            catch: () => null,
          }).pipe(Effect.catch(() => Effect.succeed(null)));

          if (reactive) {
            if (reactive.matched) return;
            return yield* new TextMismatchError({
              message: negate
                ? `Expected URL NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(reactive.actual ?? "")} after ${timeout}ms`
                : `Expected URL ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(reactive.actual ?? "")} after ${timeout}ms`,
              expected: negate ? `not ${String(expected)}` : String(expected),
              actual: reactive.actual ?? "",
              selector: "url",
            });
          }
        }

        while (Date.now() - start < timeout) {
          if (!negate && driver.getNavigationUrls) {
            const recentUrls = driver.getNavigationUrls();
            if (recentUrls.some((u) => matchesUrl(u))) return;
          }
          const url = driver.getUrl
            ? yield* driver.getUrl()
            : yield* driver
                .evaluate<string>(
                  "typeof window !== 'undefined' && window.location ? window.location.href : ''",
                )
                .pipe(Effect.catch(() => Effect.succeed("")));
          lastUrl = url;
          if (negate ? !matchesUrl(url) : matchesUrl(url)) return;
          yield* Effect.sleep(Duration.millis(pollInterval));
        }

        return yield* new TextMismatchError({
          message: negate
            ? `Expected URL NOT to match ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(lastUrl)} after ${timeout}ms`
            : `Expected URL ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)} but got ${JSON.stringify(lastUrl)} after ${timeout}ms`,
          expected: negate ? `not ${String(expected)}` : String(expected),
          actual: lastUrl,
          selector: "url",
        });
      }),

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
      negate: boolean = false,
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
            message: negate
              ? `Expected role NOT to be "${expectedRole}" after ${timeout}ms — selector: ${formatSelector(selector)}`
              : `Expected role "${expectedRole}" but got "${actual ?? "(unknown)"}" after ${timeout}ms — selector: ${formatSelector(selector)}`,
            expected: negate ? `not ${expectedRole}` : expectedRole,
          }),
          undefined,
          negate,
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

    runAccessibilityAudit: (
      platform: string,
      options: {
        rules?: string[];
        disableRules?: string[];
        tags?: string[];
        targetSelector?: string;
        includeSelectors?: string[];
        excludeSelectors?: string[];
      } = {},
    ): Effect.Effect<
      { violations: import("../core/accessibility-audit.js").AccessibilityViolation[] },
      DriverError
    > =>
      Effect.gen(function* () {
        if (platform !== "web") {
          return yield* new DriverError({
            message: `accessibilityAudit() is only supported on web — platform "${platform}" is not supported`,
          });
        }

        const { readFileSync } = yield* Effect.promise(() => import("node:fs"));
        const { createRequire } = yield* Effect.promise(() => import("node:module"));
        const require = createRequire(import.meta.url);
        const axePath: string = require.resolve("axe-core/axe.js");
        const axeSource = readFileSync(axePath, "utf-8");

        const axeContext: Record<string, string[][]> = {};
        const includes = [
          ...(options.targetSelector ? [options.targetSelector] : []),
          ...(options.includeSelectors ?? []),
        ];
        if (includes.length > 0) {
          axeContext["include"] = includes.map((s) => [s]);
        }
        if (options.excludeSelectors && options.excludeSelectors.length > 0) {
          axeContext["exclude"] = options.excludeSelectors.map((s) => [s]);
        }
        const serializedContext =
          Object.keys(axeContext).length > 0 ? JSON.stringify(axeContext) : "document";

        const axeOptions: Record<string, unknown> = {};
        const rulesConfig: Record<string, { enabled: boolean }> = {};
        for (const r of options.rules ?? []) rulesConfig[r] = { enabled: true };
        for (const r of options.disableRules ?? []) rulesConfig[r] = { enabled: false };
        if (Object.keys(rulesConfig).length > 0) {
          axeOptions["rules"] = rulesConfig;
        }
        if (options.tags && options.tags.length > 0) {
          axeOptions["runOnly"] = { type: "tag", values: options.tags };
        }

        const script = `
          (function() {
            if (typeof axe === "undefined") {
              ${axeSource}
            }
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
        const violations = (axeResult?.violations ?? []).map((v) => ({
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
        return { violations };
      }),

    assertAccessibilityAudit: (
      platform: string,
      options: {
        severity?: "critical" | "serious" | "moderate" | "minor";
        rules?: string[];
        disableRules?: string[];
        tags?: string[];
        targetSelector?: string;
        includeSelectors?: string[];
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
        const includes = [
          ...(options.targetSelector ? [options.targetSelector] : []),
          ...(options.includeSelectors ?? []),
        ];
        if (includes.length > 0) {
          axeContext["include"] = includes.map((s) => [s]);
        }
        if (options.excludeSelectors && options.excludeSelectors.length > 0) {
          axeContext["exclude"] = options.excludeSelectors.map((s) => [s]);
        }
        const serializedContext =
          Object.keys(axeContext).length > 0 ? JSON.stringify(axeContext) : "document";

        const axeOptions: Record<string, unknown> = {};
        const rulesConfig: Record<string, { enabled: boolean }> = {};
        for (const r of options.rules ?? []) rulesConfig[r] = { enabled: true };
        for (const r of options.disableRules ?? []) rulesConfig[r] = { enabled: false };
        if (Object.keys(rulesConfig).length > 0) {
          axeOptions["rules"] = rulesConfig;
        }
        if (options.tags && options.tags.length > 0) {
          axeOptions["runOnly"] = { type: "tag", values: options.tags };
        }

        const script = `
          (function() {
            if (typeof axe === "undefined") {
              ${axeSource}
            }
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

        const violations = (axeResult?.violations ?? []).map((v) => ({
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
        const effectiveTapMode: TapMode = opts?.tapMode ?? config.tapMode ?? "native";
        const totalTimeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const deadline = Date.now() + totalTimeout;
        const mergedOpts: WaitOptions = {
          ...defaults,
          ...opts,
          tapMode: effectiveTapMode,
          platform: opts?.platform ?? config.platform,
        };
        let attempts = 0;
        while (true) {
          attempts += 1;
          const remaining = Math.max(50, deadline - Date.now());
          const resolved = yield* waitForResolvedElementResult(
            driver,
            selector,
            parse,
            true,
            { ...mergedOpts, timeout: remaining },
            cache,
          );
          if (resolved.channel === "dom" && effectiveTapMode === "dom" && driver.domChannel) {
            const tapped = yield* Effect.tryPromise({
              try: () => driver.domChannel!.tapDom(selector as Selector),
              catch: (e) => new DriverError({ message: `DOM tap failed: ${e}` }),
            });
            if (tapped) {
              yield* afterMutation();
              return;
            }
          }
          const { x, y } = centerOf(resolved.element);
          const guardActive =
            !opts?.force &&
            resolved.channel === "dom" &&
            !isRelativeSelectorLike(selector) &&
            !isSystemUISelector(selector) &&
            !(
              typeof selector === "object" &&
              selector !== null &&
              "frame" in selector &&
              selector.frame
            ) &&
            driver.domChannel?.isConnected();

          if (guardActive) {
            // Moving-target protection (1.11): arm a capture-phase click/pointerdown guard
            // targeting the resolved element at (x, y). If the element shifts before the native
            // mouse event lands, suppress the misdirected click and retry!
            const armed = yield* Effect.tryPromise({
              try: () =>
                driver.domChannel!.evaluate<boolean>(
                  `((tx, ty) => {
                    try {
                      const expected = document.elementFromPoint(tx, ty);
                      if (!expected) return false;
                      if (window.__spanaTapGuardCleanup) window.__spanaTapGuardCleanup();
                      window.__spanaTapMissed = false;
                      const match = (t) => t === expected || (expected.contains && expected.contains(t)) || (t && t.contains && t.contains(expected));
                      const onEvt = (e) => {
                        if (!e.isTrusted) return;
                        const hit = document.elementFromPoint(e.clientX, e.clientY) || e.target;
                        if (!match(hit) && !match(e.target)) {
                          e.stopImmediatePropagation();
                          e.preventDefault();
                          window.__spanaTapMissed = true;
                        }
                      };
                      window.addEventListener("pointerdown", onEvt, true);
                      window.addEventListener("mousedown", onEvt, true);
                      window.addEventListener("click", onEvt, true);
                      window.__spanaTapGuardCleanup = () => {
                        window.removeEventListener("pointerdown", onEvt, true);
                        window.removeEventListener("mousedown", onEvt, true);
                        window.removeEventListener("click", onEvt, true);
                        delete window.__spanaTapGuardCleanup;
                      };
                      return true;
                    } catch { return false; }
                  })(${x}, ${y})`,
                ),
              catch: () => false,
            }).pipe(Effect.catch(() => Effect.succeed(false)));

            yield* driver.tapAtCoordinate(x, y);

            if (armed) {
              const missed = yield* Effect.tryPromise({
                try: () =>
                  driver.domChannel!.evaluate<boolean>(
                    `(() => {
                      const m = Boolean(window.__spanaTapMissed);
                      if (window.__spanaTapGuardCleanup) window.__spanaTapGuardCleanup();
                      delete window.__spanaTapMissed;
                      return m;
                    })()`,
                  ),
                catch: () => false,
              }).pipe(Effect.catch(() => Effect.succeed(false)));

              if (missed) {
                if (Date.now() < deadline && attempts < 20) {
                  yield* Effect.sleep(Duration.millis(25));
                  continue;
                }
                return yield* new DriverError({
                  message: `Element moved before tap could land (suppressed misdirected click after ${attempts} attempt(s) within ${totalTimeout}ms) — selector: ${formatSelector(selector)}`,
                });
              }
            }
          } else {
            yield* driver.tapAtCoordinate(x, y);
          }
          yield* afterMutation();
          return;
        }
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
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
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
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
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

    /**
     * Hover the pointer over an actionable element (moves pointer to its center).
     */
    hover: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const mergedOpts: WaitOptions = {
          ...defaults,
          ...opts,
          platform: opts?.platform ?? config.platform,
        };
        const resolved = yield* waitForResolvedElementResult(
          driver,
          selector,
          parse,
          true,
          mergedOpts,
          cache,
        );
        const { x, y } = centerOf(resolved.element);
        if (driver.hoverAtCoordinate) {
          yield* driver.hoverAtCoordinate(x, y);
        } else if (config.platform === "web") {
          yield* driver.evaluate(
            `(() => {
              const el = document.elementFromPoint(${x}, ${y});
              if (!el) return;
              const init = { bubbles: true, cancelable: true, composed: true, clientX: ${x}, clientY: ${y} };
              try { el.dispatchEvent(new PointerEvent("pointerover", init)); } catch {}
              try { el.dispatchEvent(new PointerEvent("pointerenter", { ...init, bubbles: false })); } catch {}
              try { el.dispatchEvent(new MouseEvent("mouseover", init)); } catch {}
              try { el.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false })); } catch {}
              try { el.dispatchEvent(new MouseEvent("mousemove", init)); } catch {}
            })()`,
          );
        } else {
          return yield* new DriverError({
            message: "hover() is not supported on this driver/platform",
          });
        }
        yield* afterMutation();
      }),

    /**
     * Atomic 1-round-trip form fill: on web/DOM channels, waits for actionability,
     * focuses, clears, sets the React/Vue-safe value, verifies the value survived
     * React re-render/remount, and retries up to 3x. For contenteditable editors
     * (TipTap/ProseMirror/Lexical/Slate) or stubborn controlled inputs, falls back
     * seamlessly to native tap + SelectAll + Backspace + keyboard input.
     */
    fill: (
      selector: ExtendedSelector,
      text: string,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const timeout = opts?.timeout ?? defaults?.timeout ?? 5000;
        const fillStart = Date.now();
        const domChannel = driver.domChannel;
        if (
          !isSystemUISelector(selector) &&
          !isRelativeSelectorLike(selector) &&
          domChannel?.isConnected() &&
          domChannel.fillDom
        ) {
          const fillAttempt = yield* Effect.result(
            Effect.tryPromise({
              try: () => domChannel.fillDom!(selector as Selector, text, { timeoutMs: timeout }),
              catch: (e) => new DriverError({ message: `DOM fill failed: ${e}` }),
            }),
          );
          if (fillAttempt._tag === "Success" && fillAttempt.success) {
            yield* afterMutation();
            return;
          }

          // Fallback for contenteditable editors (TipTap/ProseMirror/Lexical) or
          // stubborn React controlled inputs that rejected/reset synthetic DOM writes:
          // check if an actionable element is actually present, then tap + SelectAll + Backspace + inputText.
          const remaining = Math.max(50, timeout - (Date.now() - fillStart));
          const fallbackEl = yield* Effect.result(
            waitForActionElement(
              driver,
              selector,
              parse,
              {
                ...defaults,
                ...opts,
                timeout: Math.min(remaining, 1500),
                platform: opts?.platform ?? config.platform,
              },
              cache,
            ),
          );
          if (fallbackEl._tag === "Success") {
            const { x, y } = centerOf(fallbackEl.success);
            yield* driver.tapAtCoordinate(x, y);
            const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
            yield* Effect.result(driver.pressKey(selectAllKey));
            yield* Effect.result(driver.pressKey("Backspace"));
            if (text.length > 0) {
              yield* driver.inputText(text);
            }
            yield* afterMutation();
            return;
          }

          const actionDiag = yield* Effect.tryPromise({
            try: () =>
              domChannel.evaluate<{
                found?: boolean;
                visible?: boolean;
                enabled?: boolean;
                obstructedBy?: string;
              }>(buildDomActionabilityDiagScript(selector as Selector)),
            catch: () => null,
          }).pipe(Effect.catch(() => Effect.succeed(null)));

          if (actionDiag?.found && actionDiag.obstructedBy) {
            return yield* new ElementNotFoundError({
              message: `Element is covered by ${actionDiag.obstructedBy} (not fillable within ${timeout}ms) — selector: ${formatSelector(selector)}`,
              selector,
              timeoutMs: timeout,
            });
          }
          if (actionDiag?.found && actionDiag.visible && actionDiag.enabled === false) {
            return yield* new ElementNotFoundError({
              message: `Element is disabled (not fillable within ${timeout}ms) — selector: ${formatSelector(selector)}`,
              selector,
              timeoutMs: timeout,
            });
          }

          return yield* new ElementNotFoundError({
            message: `Element not fillable within ${timeout}ms — selector: ${formatSelector(selector)}`,
            selector,
            timeoutMs: timeout,
          });
        }

        // Native mobile fallback: tap to focus, then input text
        const element = yield* waitForActionElement(
          driver,
          selector,
          parse,
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        const { x, y } = centerOf(element);
        yield* driver.tapAtCoordinate(x, y);
        yield* driver.inputText(text);
        yield* afterMutation();
      }),

    pressKey: (key: string): Effect.Effect<void, DriverError> =>
      Effect.gen(function* () {
        yield* driver.pressKey(key);
        cache.invalidate();
      }),

    check: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const resolved = yield* waitForResolvedElementResult(
          driver,
          selector,
          parse,
          true,
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        const alreadyChecked =
          resolved.element.checked === true ||
          resolved.element.attributes?.["aria-checked"] === "true";
        if (alreadyChecked) return;
        const { x, y } = centerOf(resolved.element);
        yield* driver.tapAtCoordinate(x, y);
        yield* afterMutation();
      }),

    uncheck: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const resolved = yield* waitForResolvedElementResult(
          driver,
          selector,
          parse,
          true,
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        const currentlyChecked =
          resolved.element.checked === true ||
          resolved.element.attributes?.["aria-checked"] === "true";
        if (!currentlyChecked) return;
        const { x, y } = centerOf(resolved.element);
        yield* driver.tapAtCoordinate(x, y);
        yield* afterMutation();
      }),

    blur: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        yield* waitForResolvedElementResult(
          driver,
          selector,
          parse,
          false,
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        if (!isRelativeSelectorLike(selector) && !isSystemUISelector(selector)) {
          const script = `(() => {
            const el = ${buildDomFindElementScript(selector as Selector)};
            if (el && typeof el.blur === "function") { el.blur(); return true; }
            if (document.activeElement && typeof document.activeElement.blur === "function") {
              document.activeElement.blur();
              return true;
            }
            return false;
          })()`;
          if (driver.domChannel?.isConnected()) {
            yield* Effect.tryPromise({
              try: () => driver.domChannel!.evaluate<boolean>(script),
              catch: () => false,
            }).pipe(Effect.catch(() => Effect.succeed(false)));
          } else {
            yield* driver.evaluate<boolean>(script).pipe(Effect.catch(() => Effect.succeed(false)));
          }
        }
        yield* afterMutation();
      }),

    selectOption: (
      selector: ExtendedSelector,
      option: SelectOptionInput,
      opts?: WaitOptions,
    ): Effect.Effect<string[], ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        yield* waitForResolvedElementResult(
          driver,
          selector,
          parse,
          true,
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        if (isRelativeSelectorLike(selector) || isSystemUISelector(selector)) {
          return yield* new DriverError({
            message: "selectOption() requires a DOM selector targeting a <select> element",
          });
        }
        const script = buildDomSelectOptionScript(selector as Selector, option);
        const res = driver.domChannel?.isConnected()
          ? yield* Effect.tryPromise({
              try: () =>
                driver.domChannel!.evaluate<{ ok: boolean; selected?: string[]; error?: string }>(
                  script,
                ),
              catch: (e) => new DriverError({ message: `selectOption() failed: ${e}` }),
            })
          : yield* driver.evaluate<{ ok: boolean; selected?: string[]; error?: string }>(script);
        if (!res?.ok) {
          return yield* new DriverError({
            message: `selectOption() failed for ${formatSelector(selector)}: ${res?.error ?? "unknown error"}`,
          });
        }
        yield* afterMutation();
        return res.selected ?? [];
      }),

    focus: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const resolved = yield* waitForResolvedElementResult(
          driver,
          selector,
          parse,
          false,
          { ...defaults, ...opts, platform: opts?.platform ?? config.platform },
          cache,
        );
        if (!isRelativeSelectorLike(selector) && !isSystemUISelector(selector)) {
          const script = buildDomFocusScript(selector as Selector);
          const ok = driver.domChannel?.isConnected()
            ? yield* Effect.tryPromise({
                try: () => driver.domChannel!.evaluate<boolean>(script),
                catch: () => false,
              }).pipe(Effect.catch(() => Effect.succeed(false)))
            : yield* driver
                .evaluate<boolean>(script)
                .pipe(Effect.catch(() => Effect.succeed(false)));
          if (ok) {
            yield* afterMutation();
            return;
          }
        }
        const { x, y } = centerOf(resolved.element);
        yield* driver.tapAtCoordinate(x, y);
        yield* afterMutation();
      }),

    dragTo: (
      source: ExtendedSelector,
      target: ExtendedSelector,
      opts?: WaitOptions & { steps?: number },
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const merged = { ...defaults, ...opts, platform: opts?.platform ?? config.platform };
        const src = yield* waitForActionElement(driver, source, parse, merged, cache);
        const dst = yield* waitForActionElement(driver, target, parse, merged, cache);
        const from = centerOf(src);
        const to = centerOf(dst);
        if (driver.dragAndDrop) {
          yield* driver.dragAndDrop(from.x, from.y, to.x, to.y, opts?.steps ?? 10);
        } else {
          yield* driver.swipe(from.x, from.y, to.x, to.y, 400);
        }
        yield* afterMutation();
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
        const hideKeyboardResult = yield* Effect.result(driver.hideKeyboard());
        if (hideKeyboardResult._tag === "Success") {
          yield* afterMutation();
          return;
        }

        if (platform === "android") {
          const backResult = yield* Effect.result(driver.back());
          if (backResult._tag === "Success") {
            yield* afterMutation();
            return;
          }

          return yield* new DriverError({
            message: `dismissKeyboard() failed with strategy "auto" on android. hideKeyboard(): ${hideKeyboardResult.failure.message}. back(): ${backResult.failure.message}`,
          });
        }

        return yield* new DriverError({
          message: `dismissKeyboard() failed with strategy "auto" on ${platform}. hideKeyboard(): ${hideKeyboardResult.failure.message}`,
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

          const backResult = yield* Effect.result(driver.back());
          if (backResult._tag === "Failure") {
            return yield* new DriverError({
              message: `backUntilVisible() failed on back attempt ${backCount + 1}: ${backResult.failure.message}`,
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
