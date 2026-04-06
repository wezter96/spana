import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { Element } from "../schemas/element.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import type { DriverError, ElementNotFoundError, WaitTimeoutError } from "../errors.js";
import { TextMismatchError } from "../errors.js";
import { centerOf } from "./element-matcher.js";
import { waitForElement, waitForNotVisible, type WaitOptions } from "./auto-wait.js";

export type Direction = "up" | "down" | "left" | "right";

type HierarchyParser = (raw: string) => Element;

export interface CoordinatorConfig {
  parse: HierarchyParser;
  defaults?: WaitOptions;
  screenWidth?: number;
  screenHeight?: number;
}

export function createCoordinator(driver: RawDriverService, config: CoordinatorConfig) {
  const { parse, defaults } = config;

  return {
    tap: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForElement(driver, selector, parse, { ...defaults, ...opts });
        const { x, y } = centerOf(element);
        yield* driver.tapAtCoordinate(x, y);
      }),

    tapXY: (x: number, y: number): Effect.Effect<void, DriverError> => driver.tapAtCoordinate(x, y),

    doubleTap: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForElement(driver, selector, parse, { ...defaults, ...opts });
        const { x, y } = centerOf(element);
        yield* driver.doubleTapAtCoordinate(x, y);
      }),

    longPress: (
      selector: ExtendedSelector,
      duration: number = 1000,
      opts?: WaitOptions,
    ): Effect.Effect<void, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      Effect.gen(function* () {
        const element = yield* waitForElement(driver, selector, parse, { ...defaults, ...opts });
        const { x, y } = centerOf(element);
        yield* driver.longPressAtCoordinate(x, y, duration);
      }),

    longPressXY: (
      x: number,
      y: number,
      duration: number = 1000,
    ): Effect.Effect<void, DriverError> => driver.longPressAtCoordinate(x, y, duration),

    inputText: (text: string): Effect.Effect<void, DriverError> => driver.inputText(text),

    pressKey: (key: string): Effect.Effect<void, DriverError> => driver.pressKey(key),

    hideKeyboard: (): Effect.Effect<void, DriverError> => driver.hideKeyboard(),

    swipe: (direction: Direction, opts?: { duration?: number }): Effect.Effect<void, DriverError> =>
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
      }),

    scroll: (direction: Direction): Effect.Effect<void, DriverError> =>
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
      }),

    assertVisible: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<Element, ElementNotFoundError | WaitTimeoutError | DriverError> =>
      waitForElement(driver, selector, parse, { ...defaults, ...opts }),

    assertHidden: (
      selector: ExtendedSelector,
      opts?: WaitOptions,
    ): Effect.Effect<void, WaitTimeoutError | DriverError> =>
      waitForNotVisible(driver, selector, parse, { ...defaults, ...opts }),

    assertText: (
      selector: ExtendedSelector,
      expected: string,
      opts?: WaitOptions,
    ): Effect.Effect<
      void,
      ElementNotFoundError | WaitTimeoutError | TextMismatchError | DriverError
    > =>
      Effect.gen(function* () {
        const element = yield* waitForElement(driver, selector, parse, { ...defaults, ...opts });
        if (element.text !== expected) {
          return yield* new TextMismatchError({
            message: `Expected text "${expected}" but got "${element.text ?? "(no text)"}"`,
            expected,
            actual: element.text,
            selector,
          });
        }
      }),
  };
}
