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
    evaluate: () => Effect.void as any,
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

  test("toBeEnabled passes for enabled element", async () => {
    const el = createElement({ children: [createElement({ text: "Button", enabled: true })] });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expectFor({ text: "Button" }).toBeEnabled();
  });

  test("toBeDisabled passes for disabled element", async () => {
    const el = createElement({ children: [createElement({ text: "Button", enabled: false })] });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expectFor({ text: "Button" }).toBeDisabled();
  });

  test("toContainText passes for partial match", async () => {
    const el = createElement({ children: [createElement({ text: "Hello World" })] });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expectFor({ text: "Hello World" }).toContainText("World");
  });

  test("toHaveValue passes for matching value", async () => {
    const el = createElement({
      children: [createElement({ text: "Email", value: "test@example.com" })],
    });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expectFor({ text: "Email" }).toHaveValue("test@example.com", { timeout: 100 });
  });

  test("toHaveValue fails for mismatched value", async () => {
    const el = createElement({
      children: [createElement({ text: "Email", value: "wrong" })],
    });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expect(
      expectFor({ text: "Email" }).toHaveValue("expected", { timeout: 50, pollInterval: 10 }),
    ).rejects.toThrow('Expected value "expected"');
  });

  test("toHaveAttribute passes when attribute exists with value", async () => {
    const el = createElement({
      children: [
        createElement({ text: "Submit", attributes: { role: "button", "aria-pressed": "true" } }),
      ],
    });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expectFor({ text: "Submit" }).toHaveAttribute("role", "button", { timeout: 100 });
  });

  test("toHaveAttribute passes for existence check", async () => {
    const el = createElement({
      children: [createElement({ text: "Submit", attributes: { disabled: "" } })],
    });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expectFor({ text: "Submit" }).toHaveAttribute("disabled", undefined, { timeout: 100 });
  });

  test("toMatchText passes for matching regex", async () => {
    const el = createElement({ children: [createElement({ text: "Price: $42.99" })] });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expectFor({ text: "Price: $42.99" }).toMatchText(/\$\d+\.\d{2}/);
  });

  test("toMatchText fails for non-matching regex", async () => {
    const el = createElement({ children: [createElement({ text: "No numbers here" })] });
    const { driver } = createDriver([el]);
    const expectFor = createPromiseExpect(driver, { parse });
    await expect(
      expectFor({ text: "No numbers here" }).toMatchText(/\d+/, { timeout: 50, pollInterval: 10 }),
    ).rejects.toThrow("Expected text to match");
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
