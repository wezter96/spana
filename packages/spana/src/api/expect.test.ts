import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
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

function createDriver(hierarchies: Element[], screenshots?: Uint8Array[]) {
  let dumpCount = 0;
  let screenshotCount = 0;
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
    takeScreenshot: () => {
      if (!screenshots || screenshots.length === 0) {
        return Effect.succeed(new Uint8Array([1, 2, 3]));
      }
      const index = Math.min(screenshotCount, screenshots.length - 1);
      screenshotCount += 1;
      return Effect.succeed(screenshots[index]!);
    },
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

test("ARIA snapshots compare inline YAML and update or read golden files", async () => {
  const root = makeTempDir();
  const { driver } = createDriver([createElement()]);
  const flowContext = {
    flowName: "aria",
    flowFilePath: join(root, "aria.flow.ts"),
    platform: "web",
  };
  const expected = '- navigation "Menu":\n  - link "Home"';
  const ariaDriver = { ...driver, getAriaSnapshot: () => Effect.succeed(expected) };
  const browserExpect = createPromiseExpect(ariaDriver, { parse }, undefined, flowContext);
  await browserExpect({ css: "nav" }).toMatchAriaSnapshot(
    `\n    - navigation "Menu":\n      - link "Home"\n  `,
  );
  const snapshot = { path: "snapshots/menu.aria.yml" };
  const update = createPromiseExpect(ariaDriver, { parse }, undefined, {
    ...flowContext,
    updateBaselines: true,
  });
  await update({ css: "nav" }).toMatchAriaSnapshot(snapshot);
  expect(readFileSync(join(root, snapshot.path), "utf8")).toBe(`${expected}\n`);
  await browserExpect({ css: "nav" }).toMatchAriaSnapshot(snapshot);
  await expect(
    browserExpect({ css: "nav" }).toMatchAriaSnapshot('- navigation "Other"', { timeout: 10 }),
  ).rejects.toThrow("ARIA snapshot did not match");
});

test("poll retries an asynchronous probe and records the final result as one step", async () => {
  const { driver } = createDriver([createElement()]);
  const { recorder, stepCalls } = createRecorder();
  const browserExpect = createPromiseExpect(driver, { parse }, recorder);
  let attempts = 0;
  await browserExpect
    .poll(async () => ({ ready: ++attempts === 3 }), { intervals: [1] })
    .toEqual({ ready: true });
  expect(attempts).toBe(3);
  expect(stepCalls.map((step) => step.command)).toEqual(['expect.poll.toEqual({"ready":true})']);
});

test("toPass retries throwing callbacks and reports the last failure at the deadline", async () => {
  const { driver } = createDriver([createElement()]);
  const browserExpect = createPromiseExpect(driver, { parse });
  let attempts = 0;
  await browserExpect(() => {
    if (++attempts < 2) throw new Error("not ready");
  }).toPass({ timeout: 100, intervals: [1] });
  expect(attempts).toBe(2);
  await expect(
    browserExpect(() => {
      throw new Error("still not ready");
    }).toPass({ timeout: 20, intervals: [1] }),
  ).rejects.toThrow("Assertion timed out after 20ms: still not ready");
});

test("negated polling and toPass record no inner steps across attempts", async () => {
  const { driver } = createDriver([createElement()]);
  const { recorder, stepCalls } = createRecorder();
  const browserExpect = createPromiseExpect(driver, { parse }, recorder);
  let attempts = 0;
  await browserExpect(async () => {
    await browserExpect.poll(() => ++attempts).not.toBeUndefined();
    if (attempts < 2) throw new Error("not ready");
  }).toPass({ timeout: 100, intervals: [1] });
  expect(attempts).toBe(2);
  expect(stepCalls.map((step) => step.command)).toEqual(["expect.toPass"]);

  let polls = 0;
  await browserExpect.poll(() => ++polls, { intervals: [1] }).not.toBe(1);
  expect(polls).toBe(2);
  expect(stepCalls.map((step) => step.command)).toEqual([
    "expect.toPass",
    "expect.poll.not.toBe(1)",
  ]);
});

test("poll and toPass enforce the deadline even when a callback stalls", async () => {
  const { driver } = createDriver([createElement()]);
  const browserExpect = createPromiseExpect(driver, { parse });
  const stall = () => new Promise<number>(() => {});
  await expect(browserExpect(stall).toPass({ timeout: 20 })).rejects.toThrow(
    "Assertion timed out after 20ms",
  );
  await expect(browserExpect.poll(stall, { timeout: 20 }).not.toBe(1)).rejects.toThrow(
    "Assertion timed out after 20ms",
  );
});

test("soft negated assertions record the failure instead of throwing", async () => {
  const { driver } = createDriver([createElement({ text: "Ready" })]);
  const failures: unknown[] = [];
  const browserExpect = createPromiseExpect(driver, { parse }, undefined, {
    flowFilePath: "",
    flowName: "soft",
    platform: "web",
    recordSoftFailure: (failure) => failures.push(failure),
  });
  await browserExpect.soft({ text: "Ready" }).not.toHaveText("Ready", { timeout: 20 });
  expect(failures).toHaveLength(1);
});

let tempDir = "";

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "spana-expect-"));
  return tempDir;
}

function makePng(
  width: number,
  height: number,
  fillColor: { r: number; g: number; b: number },
): Uint8Array {
  const png = new PNG({ width, height });
  const { r, g, b } = fillColor;
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

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

  test("toMatchScreenshot uses flow metadata and visual regression defaults", async () => {
    const dir = makeTempDir();
    const red = makePng(20, 20, { r: 255, g: 0, b: 0 });
    const blue = makePng(20, 20, { r: 0, g: 0, b: 255 });
    const target = createElement({ text: "Target", bounds: { x: 0, y: 0, width: 10, height: 10 } });
    const root = createElement({
      bounds: { x: 0, y: 0, width: 20, height: 20 },
      children: [target],
    });
    const { driver } = createDriver([root, root], [red, blue]);
    const expectFor = createPromiseExpect(
      driver,
      { parse },
      undefined,
      {
        flowFilePath: join(dir, "flows", "sample.flow.ts"),
        flowName: "Sample Flow",
        platform: "web",
      },
      {
        baselinesDir: join(dir, "baselines"),
        threshold: 0,
        maxDiffPixelRatio: 1,
      },
    );

    await expectFor({ text: "Target" }).toMatchScreenshot("card");
    await expectFor({ text: "Target" }).toMatchScreenshot("card");
  });

  test("toPassAccessibilityAudit scopes axe to the target selector and excludes", async () => {
    const { driver: baseDriver } = createDriver([createElement()]);
    let evaluateScript = "";
    const driver: RawDriverService = {
      ...baseDriver,
      evaluate: ((script: string) => {
        evaluateScript = script;
        return Effect.succeed({ violations: [] });
      }) as RawDriverService["evaluate"],
    };

    const expectFor = createPromiseExpect(driver, { parse });

    await expectFor({ testID: "playground-content" }).toPassAccessibilityAudit({
      exclude: [{ testID: "playground-details-hidden" }],
    });

    expect(evaluateScript).toContain('"include":[["[data-testid=\\"playground-content\\"]"]]');
    expect(evaluateScript).toContain(
      '"exclude":[["[data-testid=\\"playground-details-hidden\\"]"]]',
    );
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
