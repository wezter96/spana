import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Element } from "../schemas/element.js";
import type { StepRecorder } from "../core/step-recorder.js";
import { createPromiseExpect } from "./expect.js";

function createElement(overrides: Partial<Element> = {}): Element {
  return {
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    children: [],
    visible: true,
    clickable: true,
    ...overrides,
  };
}

function createDriver(hierarchies: Element[]) {
  let dumpCount = 0;
  const deviceInfo: DeviceInfo = {
    platform: "web",
    deviceId: "playwright",
    name: "Chromium",
    isEmulator: false,
    screenWidth: 1280,
    screenHeight: 720,
    driverType: "playwright",
  };

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

function createRecorder() {
  const stepCalls: Array<{
    command: string;
    selector: unknown;
    captureScreenshot: boolean;
  }> = [];

  const recorder: StepRecorder = {
    runStep: async (command, action, opts) => {
      stepCalls.push({
        command,
        selector: opts?.selector,
        captureScreenshot: opts?.captureScreenshot ?? false,
      });
      return action();
    },
    runScreenshotStep: async (_command, action) => action(),
    getSteps: () => [],
  };

  return { recorder, stepCalls };
}

const parse = (raw: string): Element => JSON.parse(raw) as Element;

describe("promise expect", () => {
  test("records expectation commands without enabling screenshots", async () => {
    const ready = createElement({ children: [createElement({ text: "Ready" })] });
    const { driver } = createDriver([ready, ready, ready, createElement()]);
    const { recorder, stepCalls } = createRecorder();
    const expectFor = createPromiseExpect(driver, { parse }, recorder);

    await expectFor({ text: "Ready" }).toBeVisible();
    await expectFor({ text: "Ready" }).toHaveText("Ready");
    await expectFor({ text: "Ready" }).toBeHidden({ timeout: 20, pollInterval: 0 });

    expect(stepCalls).toEqual([
      {
        command: "expect.toBeVisible",
        selector: { text: "Ready" },
        captureScreenshot: false,
      },
      {
        command: 'expect.toHaveText("Ready")',
        selector: { text: "Ready" },
        captureScreenshot: false,
      },
      {
        command: "expect.toBeHidden",
        selector: { text: "Ready" },
        captureScreenshot: false,
      },
    ]);
  });

  test("works without a recorder", async () => {
    const { driver, getDumpCount } = createDriver([
      createElement({ children: [createElement({ text: "Ready" })] }),
    ]);
    const expectFor = createPromiseExpect(driver, { parse });

    await expectFor({ text: "Ready" }).toBeVisible();

    expect(getDumpCount()).toBe(1);
  });
});
