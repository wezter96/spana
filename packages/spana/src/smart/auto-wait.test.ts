import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Element } from "../schemas/element.js";
import { ElementNotFoundError, WaitTimeoutError } from "../errors.js";
import { waitForElement, waitForNotVisible } from "./auto-wait.js";

const deviceInfo: DeviceInfo = {
  platform: "web",
  deviceId: "playwright",
  name: "Chromium",
  isEmulator: false,
  screenWidth: 1280,
  screenHeight: 720,
  driverType: "playwright",
};

function createElement(overrides: Partial<Element> = {}): Element {
  return {
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    children: [],
    visible: true,
    clickable: true,
    ...overrides,
  };
}

function createDriver(hierarchies: Element[]) {
  let dumpCount = 0;

  const driver: RawDriverService = {
    dumpHierarchy: () => {
      const index = Math.min(dumpCount, hierarchies.length - 1);
      dumpCount += 1;
      return Effect.succeed(JSON.stringify(hierarchies[index]));
    },
    tapAtCoordinate: () => Effect.void,
    doubleTapAtCoordinate: () => Effect.void,
    longPressAtCoordinate: () => Effect.void,
    swipe: () => Effect.void,
    inputText: () => Effect.void,
    pressKey: () => Effect.void,
    hideKeyboard: () => Effect.void,
    takeScreenshot: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    getDeviceInfo: () => Effect.succeed(deviceInfo),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
  };

  return {
    driver,
    getDumpCount: () => dumpCount,
  };
}

const parse = (raw: string): Element => JSON.parse(raw) as Element;

describe("auto wait", () => {
  test("waitForElement polls until a matching element appears", async () => {
    const root = createElement();
    const target = createElement({ text: "Ready" });
    const { driver, getDumpCount } = createDriver([root, createElement({ children: [target] })]);

    const element = await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, {
        timeout: 50,
        pollInterval: 0,
      }),
    );

    expect(element.text).toBe("Ready");
    expect(getDumpCount()).toBe(2);
  });

  test("waitForElement fails with ElementNotFoundError after the timeout", async () => {
    const { driver } = createDriver([createElement()]);

    const result = await Effect.runPromise(
      Effect.either(
        waitForElement(driver, { text: "Missing" }, parse, {
          timeout: 5,
          pollInterval: 0,
        }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(ElementNotFoundError);
      expect(result.left).toMatchObject({
        selector: { text: "Missing" },
        timeoutMs: 5,
      });
    }
  });

  test("waitForNotVisible resolves once the matching element disappears", async () => {
    const target = createElement({ text: "Ready" });
    const { driver, getDumpCount } = createDriver([
      createElement({ children: [target] }),
      createElement(),
    ]);

    await Effect.runPromise(
      waitForNotVisible(driver, { text: "Ready" }, parse, {
        timeout: 50,
        pollInterval: 0,
      }),
    );

    expect(getDumpCount()).toBe(2);
  });

  test("waitForNotVisible fails with WaitTimeoutError when the element stays visible", async () => {
    const target = createElement({ text: "Ready" });
    const { driver } = createDriver([createElement({ children: [target] })]);

    const result = await Effect.runPromise(
      Effect.either(
        waitForNotVisible(driver, { text: "Ready" }, parse, {
          timeout: 5,
          pollInterval: 0,
        }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(WaitTimeoutError);
      expect(result.left).toMatchObject({
        selector: { text: "Ready" },
        timeoutMs: 5,
      });
    }
  });
});
