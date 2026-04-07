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

export interface ScrollUntilVisibleOptions extends WaitOptions {
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

export interface BackUntilVisibleOptions extends WaitOptions {
  /** Max number of back actions to attempt before failing. Default: 3. */
  maxBacks?: number;
}

const DEFAULT_SCROLL_SEARCH_DIRECTION: Direction = "down";
const DEFAULT_MAX_SCROLLS = 5;
const DEFAULT_DISMISS_KEYBOARD_STRATEGY: KeyboardDismissStrategy = "auto";
const DEFAULT_MAX_BACKS = 3;

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
}

export function createCoordinator(driver: RawDriverService, config: CoordinatorConfig) {
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

  const swipeEffect = (
    direction: Direction,
    opts?: { duration?: number },
  ): Effect.Effect<void, DriverError> =>
    Effect.gen(function* () {
      const w = config.screenWidth ?? 1080;
      const h = config.screenHeight ?? 1920;
      const cx = w / 2;
      const cy = h / 2;
      const dur = opts?.duration ?? 300;
      const dist = Math.min(w, h) * 0.4;

      const coords = {
        up: { startX: cx, startY: cy + dist / 2, endX: cx, endY: cy - dist / 2 },
        down: { startX: cx, startY: cy - dist / 2, endX: cx, endY: cy + dist / 2 },
        left: { startX: cx + dist / 2, startY: cy, endX: cx - dist / 2, endY: cy },
        right: { startX: cx - dist / 2, startY: cy, endX: cx + dist / 2, endY: cy },
      }[direction];

      yield* driver.swipe(coords.startX, coords.startY, coords.endX, coords.endY, dur);
      yield* afterMutation();
    });

  const scrollEffect = (direction: Direction): Effect.Effect<void, DriverError> =>
    Effect.gen(function* () {
      const w = config.screenWidth ?? 1080;
      const h = config.screenHeight ?? 1920;
      const cx = w / 2;
      const cy = h / 2;
      const dist = Math.min(w, h) * 0.3;

      const coords = {
        up: { startX: cx, startY: cy + dist, endX: cx, endY: cy - dist },
        down: { startX: cx, startY: cy - dist, endX: cx, endY: cy + dist },
        left: { startX: cx + dist, startY: cy, endX: cx - dist, endY: cy },
        right: { startX: cx - dist, startY: cy, endX: cx + dist, endY: cy },
      }[direction];

      yield* driver.swipe(coords.startX, coords.startY, coords.endX, coords.endY, 500);
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
        yield* driver.doubleTapAtCoordinate(x, y);
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
            if (element.text === expected) return;
            lastActual = element.text;
          }
          yield* Effect.sleep(Duration.millis(pollInterval));
        }

        return yield* new TextMismatchError({
          message: `Expected text "${expected}" but got "${lastActual ?? "(no text)"}" after ${timeout}ms`,
          expected,
          actual: lastActual,
          selector,
        });
      }),

    assertContainsText: (
      selector: ExtendedSelector,
      expected: string,
      opts?: WaitOptions,
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
            const actual = element.text ?? "";
            if (actual.toLowerCase().includes(expected.toLowerCase())) return;
            lastActual = element.text;
          }
          yield* Effect.sleep(Duration.millis(pollInterval));
        }

        return yield* new TextMismatchError({
          message: `Expected text to contain "${expected}" but got "${lastActual ?? "(no text)"}" after ${timeout}ms`,
          expected,
          actual: lastActual,
          selector,
        });
      }),

    assertEnabled: (
      selector: ExtendedSelector,
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
        if (element.enabled === false) {
          return yield* new TextMismatchError({
            message: `Expected element to be enabled but it is disabled — selector: ${formatSelector(selector)}`,
            expected: "enabled",
            actual: "disabled",
            selector,
          });
        }
      }),

    assertDisabled: (
      selector: ExtendedSelector,
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
        if (element.enabled !== false) {
          return yield* new TextMismatchError({
            message: `Expected element to be disabled but it is enabled — selector: ${formatSelector(selector)}`,
            expected: "disabled",
            actual: "enabled",
            selector,
          });
        }
      }),

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
  };
}
