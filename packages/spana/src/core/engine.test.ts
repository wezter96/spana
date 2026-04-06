import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Element } from "../schemas/element.js";
import type { FlowDefinition } from "../api/flow.js";
import { executeFlow, type EngineConfig } from "./engine.js";

const tempDir = mkdtempSync(join(tmpdir(), "spana-engine-"));
let freshEngineImportCounter = 0;

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restore();
});

function createElement(overrides: Partial<Element> = {}): Element {
  return {
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    children: [],
    visible: true,
    clickable: true,
    ...overrides,
  };
}

function createDriver(hierarchy: Element) {
  const events: Array<[string, ...unknown[]]> = [];
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
    dumpHierarchy: () => Effect.succeed(JSON.stringify(hierarchy)),
    tapAtCoordinate: (x, y) => {
      events.push(["tapAtCoordinate", x, y]);
      return Effect.void;
    },
    doubleTapAtCoordinate: (x, y) => {
      events.push(["doubleTapAtCoordinate", x, y]);
      return Effect.void;
    },
    longPressAtCoordinate: (x, y, duration) => {
      events.push(["longPressAtCoordinate", x, y, duration]);
      return Effect.void;
    },
    swipe: (sx, sy, ex, ey, duration) => {
      events.push(["swipe", sx, sy, ex, ey, duration]);
      return Effect.void;
    },
    inputText: (text) => {
      events.push(["inputText", text]);
      return Effect.void;
    },
    pressKey: (key) => {
      events.push(["pressKey", key]);
      return Effect.void;
    },
    hideKeyboard: () => {
      events.push(["hideKeyboard"]);
      return Effect.void;
    },
    takeScreenshot: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    getDeviceInfo: () => Effect.succeed(deviceInfo),
    launchApp: (appId, opts) => {
      events.push(["launchApp", appId, opts]);
      return Effect.void;
    },
    stopApp: (appId) => {
      events.push(["stopApp", appId]);
      return Effect.void;
    },
    killApp: (appId) => {
      events.push(["killApp", appId]);
      return Effect.void;
    },
    clearAppState: (appId) => {
      events.push(["clearAppState", appId]);
      return Effect.void;
    },
    openLink: (url) => {
      events.push(["openLink", url]);
      return Effect.void;
    },
    back: () => {
      events.push(["back"]);
      return Effect.void;
    },
    evaluate: () => Effect.succeed(undefined as any),
  };

  return { driver, events };
}

const parse = (raw: string): Element => JSON.parse(raw) as Element;

function createConfig(outputDir: string): EngineConfig {
  return {
    appId: "com.example.app",
    platform: "web",
    coordinatorConfig: { parse },
    artifactConfig: {
      outputDir,
      captureOnFailure: false,
      captureOnSuccess: false,
      captureSteps: false,
    },
  };
}

async function importFreshEngine() {
  freshEngineImportCounter += 1;
  return (await import(
    new URL(`./engine.ts?case=${freshEngineImportCounter}`, import.meta.url).href
  )) as typeof import("./engine.js");
}

describe("engine", () => {
  test("executeFlow auto-launches by default and records app/expect steps", async () => {
    const { driver, events } = createDriver(
      createElement({
        children: [createElement({ text: "Ready" })],
      }),
    );

    const flow: FlowDefinition = {
      name: "Happy path",
      config: {},
      fn: async ({ app, expect }) => {
        await app.inputText("hello");
        await expect({ text: "Ready" }).toHaveText("Ready");
      },
    };

    const result = await executeFlow(flow, driver, createConfig(join(tempDir, "happy")));

    expect(result.status).toBe("passed");
    expect(events).toEqual([
      ["launchApp", "com.example.app", undefined],
      ["inputText", "hello"],
    ]);
    expect(result.steps?.map((step) => step.command)).toEqual([
      "launch",
      "inputText",
      'expect.toHaveText("Ready")',
    ]);
  });

  test("executeFlow respects flow-level autoLaunch overrides", async () => {
    const { driver, events } = createDriver(createElement());

    const flow: FlowDefinition = {
      name: "Manual launch",
      config: { autoLaunch: false },
      fn: async () => {},
    };

    const result = await executeFlow(flow, driver, {
      ...createConfig(join(tempDir, "manual")),
      autoLaunch: true,
    });

    expect(result.status).toBe("passed");
    expect(events).toEqual([]);
    expect(result.steps).toEqual([]);
  });

  test("executeFlow reports flow timeouts as failures", async () => {
    const { driver } = createDriver(createElement());

    const flow: FlowDefinition = {
      name: "Slow flow",
      config: { autoLaunch: false, timeout: 5 },
      fn: async () => await new Promise<void>(() => {}),
    };

    const result = await executeFlow(flow, driver, createConfig(join(tempDir, "timeout")));

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain('Flow "Slow flow" timed out after 5ms');
  });

  test("executeFlow wraps non-Error failures into an Error object", async () => {
    const { driver } = createDriver(createElement());

    const flow: FlowDefinition = {
      name: "Throw string",
      config: { autoLaunch: false },
      fn: async () => {
        throw "boom";
      },
    };

    const result = await executeFlow(flow, driver, createConfig(join(tempDir, "string-error")));

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("boom");
  });

  test("calls beforeEach and afterEach hooks", async () => {
    const { driver } = createDriver(createElement());
    const calls: string[] = [];

    const flow: FlowDefinition = {
      name: "Hooks order",
      config: { autoLaunch: false },
      fn: async () => {
        calls.push("flow");
      },
    };

    const config: EngineConfig = {
      ...createConfig(join(tempDir, "hooks-order")),
      hooks: {
        beforeEach: async () => {
          calls.push("beforeEach");
        },
        afterEach: async () => {
          calls.push("afterEach");
        },
      },
    };

    const result = await executeFlow(flow, driver, config);

    expect(result.status).toBe("passed");
    expect(calls).toEqual(["beforeEach", "flow", "afterEach"]);
  });

  test("afterEach runs even when flow fails", async () => {
    const { driver } = createDriver(createElement());
    const calls: string[] = [];

    const flow: FlowDefinition = {
      name: "Failing flow",
      config: { autoLaunch: false },
      fn: async () => {
        calls.push("flow");
        throw new Error("flow error");
      },
    };

    const config: EngineConfig = {
      ...createConfig(join(tempDir, "hooks-after-fail")),
      hooks: {
        afterEach: async () => {
          calls.push("afterEach");
        },
      },
    };

    const result = await executeFlow(flow, driver, config);

    expect(result.status).toBe("failed");
    expect(calls).toEqual(["flow", "afterEach"]);
  });

  test("beforeEach failure skips flow and marks as failed", async () => {
    const { driver } = createDriver(createElement());
    const calls: string[] = [];

    const flow: FlowDefinition = {
      name: "Skipped flow",
      config: { autoLaunch: false },
      fn: async () => {
        calls.push("flow");
      },
    };

    const config: EngineConfig = {
      ...createConfig(join(tempDir, "hooks-before-fail")),
      hooks: {
        beforeEach: async () => {
          calls.push("beforeEach");
          throw new Error("setup failed");
        },
        afterEach: async () => {
          calls.push("afterEach");
        },
      },
    };

    const result = await executeFlow(flow, driver, config);

    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("setup failed");
    expect(calls).toEqual(["beforeEach"]);
  });

  test("executeFlow enters the debug REPL on failure when enabled", async () => {
    const debugCalls: Array<{ flowName: string; platform: string }> = [];
    mock.module("./debug-repl.js", () => ({
      runDebugReplOnce: async (context: { flowName: string; platform: string }) => {
        debugCalls.push(context);
        return true;
      },
    }));

    const { executeFlow: executeFlowFresh } = await importFreshEngine();
    const { driver } = createDriver(createElement());
    const flow: FlowDefinition = {
      name: "Debug me",
      config: { autoLaunch: false },
      fn: async () => {
        throw new Error("boom");
      },
    };

    const result = await executeFlowFresh(flow, driver, {
      ...createConfig(join(tempDir, "debug-on-failure")),
      debugOnFailure: true,
    });

    expect(result.status).toBe("failed");
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0]?.flowName).toBe("Debug me");
    expect(debugCalls[0]?.platform).toBe("web");
  });
});
