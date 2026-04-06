import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { FlowDefinition } from "../api/flow.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import { orchestrate } from "./orchestrator.js";

function createDriver(platform: "android" | "ios"): RawDriverService {
  const deviceInfo: DeviceInfo = {
    platform,
    deviceId: `${platform}-device`,
    name: `${platform}-device`,
    isEmulator: true,
    screenWidth: 100,
    screenHeight: 200,
    driverType: platform === "android" ? "uiautomator2" : "wda",
  };

  return {
    dumpHierarchy: () => Effect.succeed("{}"),
    tapAtCoordinate: () => Effect.void,
    doubleTapAtCoordinate: () => Effect.void,
    longPressAtCoordinate: () => Effect.void,
    swipe: () => Effect.void,
    inputText: () => Effect.void,
    pressKey: () => Effect.void,
    hideKeyboard: () => Effect.void,
    takeScreenshot: () => Effect.succeed(new Uint8Array()),
    getDeviceInfo: () => Effect.succeed(deviceInfo),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
    evaluate: () => Effect.void as any,
  };
}

function createFlow(
  name: string,
  platforms?: Array<"android" | "ios">,
  shouldFail = false,
): FlowDefinition {
  return {
    name,
    config: platforms ? { platforms } : {},
    fn: async ({ app }) => {
      if (shouldFail) {
        throw new Error(`${name} failed`);
      }
      await app.inputText(name);
    },
  };
}

describe("orchestrate", () => {
  test("filters flows per platform and aggregates pass and fail counts", async () => {
    const result = await orchestrate(
      [
        createFlow("shared"),
        createFlow("android-only", ["android"]),
        createFlow("ios-only", ["ios"]),
        createFlow("fail-both", ["android", "ios"], true),
      ],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example.android",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
        {
          platform: "ios",
          driver: createDriver("ios"),
          engineConfig: {
            appId: "com.example.ios",
            platform: "ios",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
    );

    expect(result.results).toHaveLength(6);
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.results.map((entry) => `${entry.platform}:${entry.name}`).sort()).toEqual([
      "android:android-only",
      "android:fail-both",
      "android:shared",
      "ios:fail-both",
      "ios:ios-only",
      "ios:shared",
    ]);
  });

  test("retries failed flows and marks flaky when passing on retry", async () => {
    let callCount = 0;
    const flakyFlow: FlowDefinition = {
      name: "flaky",
      config: {},
      fn: async () => {
        callCount++;
        if (callCount <= 1) throw new Error("first attempt fails");
      },
    };

    const result = await orchestrate(
      [flakyFlow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { retries: 2 },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe("passed");
    expect(result.results[0]!.flaky).toBe(true);
    expect(result.results[0]!.attempts).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.flaky).toBe(1);
  });

  test("retries exhausted — still marks as failed with attempt count", async () => {
    const alwaysFails: FlowDefinition = {
      name: "always-fails",
      config: {},
      fn: async () => {
        throw new Error("nope");
      },
    };

    const result = await orchestrate(
      [alwaysFails],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { retries: 2 },
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe("failed");
    expect(result.results[0]!.flaky).toBeUndefined();
    expect(result.results[0]!.attempts).toBe(3); // 1 initial + 2 retries
    expect(result.failed).toBe(1);
    expect(result.flaky).toBe(0);
  });

  test("bails after the configured number of failed flows and skips the rest", async () => {
    const result = await orchestrate(
      [createFlow("first-fail", undefined, true), createFlow("second"), createFlow("third")],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { bail: 1 },
    );

    expect(result.results.map((entry) => entry.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.bailedOut).toBe(true);
    expect(result.bailLimit).toBe(1);
  });

  test("applies bail after retries are exhausted", async () => {
    const alwaysFails: FlowDefinition = {
      name: "retry-then-bail",
      config: {},
      fn: async () => {
        throw new Error("still failing");
      },
    };

    const result = await orchestrate(
      [alwaysFails, createFlow("never-runs")],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { retries: 1, bail: 1 },
    );

    expect(result.results[0]!.status).toBe("failed");
    expect(result.results[0]!.attempts).toBe(2);
    expect(result.results[1]!.status).toBe("skipped");
    expect(result.bailedOut).toBe(true);
  });

  test("calls beforeAll and afterAll hooks", async () => {
    const order: string[] = [];

    const flow: FlowDefinition = {
      name: "my-flow",
      config: {},
      fn: async () => {
        order.push("flow");
      },
    };

    await orchestrate(
      [flow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
            hooks: {
              beforeAll: async () => {
                order.push("beforeAll");
              },
              afterAll: async () => {
                order.push("afterAll");
              },
            },
          },
        },
      ],
    );

    expect(order).toEqual(["beforeAll", "flow", "afterAll"]);
  });

  test("runs platforms serially", async () => {
    const order: string[] = [];

    const flow: FlowDefinition = {
      name: "serial-platforms",
      config: {},
      fn: async ({ platform }) => {
        order.push(`start:${platform}`);
        await new Promise((resolve) => setTimeout(resolve, platform === "android" ? 20 : 0));
        order.push(`end:${platform}`);
      },
    };

    await orchestrate(
      [flow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example.android",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
        {
          platform: "ios",
          driver: createDriver("ios"),
          engineConfig: {
            appId: "com.example.ios",
            platform: "ios",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
    );

    expect(order).toEqual(["start:android", "end:android", "start:ios", "end:ios"]);
  });

  test("beforeAll failure skips all flows on that platform", async () => {
    let flowCalled = false;

    const flow: FlowDefinition = {
      name: "should-not-run",
      config: {},
      fn: async () => {
        flowCalled = true;
      },
    };

    const result = await orchestrate(
      [flow, createFlow("also-skipped")],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
            hooks: {
              beforeAll: async () => {
                throw new Error("setup failed");
              },
            },
          },
        },
      ],
    );

    expect(flowCalled).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === "failed")).toBe(true);
    expect(result.results[0]!.error?.message).toBe("setup failed");
    expect(result.failed).toBe(2);
  });

  test("afterAll failure does not affect results", async () => {
    const result = await orchestrate(
      [createFlow("passing-flow")],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
            hooks: {
              afterAll: async () => {
                throw new Error("teardown failed");
              },
            },
          },
        },
      ],
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe("passed");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  });

  test("no retries by default", async () => {
    let callCount = 0;
    const failFlow: FlowDefinition = {
      name: "fail",
      config: {},
      fn: async () => {
        callCount++;
        throw new Error("fail");
      },
    };

    await orchestrate(
      [failFlow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
    );

    expect(callCount).toBe(1);
  });

  test("parallelPlatforms runs platforms concurrently", async () => {
    const order: string[] = [];

    const flow: FlowDefinition = {
      name: "parallel-test",
      config: {},
      fn: async ({ platform }) => {
        order.push(`start:${platform}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(`end:${platform}`);
      },
    };

    const result = await orchestrate(
      [flow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example.android",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
        {
          platform: "ios",
          driver: createDriver("ios"),
          engineConfig: {
            appId: "com.example.ios",
            platform: "ios",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { parallelPlatforms: true },
    );

    // Both should have started before either finished
    expect(order[0]).toBe("start:android");
    expect(order[1]).toBe("start:ios");
    expect(result.passed).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  test("parallelPlatforms=false preserves serial behavior", async () => {
    const order: string[] = [];

    const flow: FlowDefinition = {
      name: "serial-check",
      config: {},
      fn: async ({ platform }) => {
        order.push(`start:${platform}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end:${platform}`);
      },
    };

    await orchestrate(
      [flow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example.android",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
        {
          platform: "ios",
          driver: createDriver("ios"),
          engineConfig: {
            appId: "com.example.ios",
            platform: "ios",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { parallelPlatforms: false },
    );

    expect(order).toEqual(["start:android", "end:android", "start:ios", "end:ios"]);
  });

  test("retryDelay adds delay between retry attempts", async () => {
    let callCount = 0;
    const timestamps: number[] = [];

    const flakyFlow: FlowDefinition = {
      name: "delayed-retry",
      config: {},
      fn: async () => {
        timestamps.push(Date.now());
        callCount++;
        if (callCount <= 1) throw new Error("first attempt fails");
      },
    };

    const result = await orchestrate(
      [flakyFlow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { retries: 1, retryDelay: 50 },
    );

    expect(result.results[0]!.status).toBe("passed");
    expect(result.results[0]!.flaky).toBe(true);
    // Verify the delay was applied between attempts
    expect(timestamps).toHaveLength(2);
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(40); // Allow some timer imprecision
  });

  test("retryDelay=0 (default) retries immediately", async () => {
    let callCount = 0;
    const timestamps: number[] = [];

    const flakyFlow: FlowDefinition = {
      name: "immediate-retry",
      config: {},
      fn: async () => {
        timestamps.push(Date.now());
        callCount++;
        if (callCount <= 1) throw new Error("first attempt fails");
      },
    };

    await orchestrate(
      [flakyFlow],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
      { retries: 1 },
    );

    // Without retryDelay, gap should be minimal
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeLessThan(30);
  });

  test("delegates to runParallel when additionalWorkers provided", async () => {
    const result = await orchestrate(
      [createFlow("a"), createFlow("b"), createFlow("c")],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
          additionalWorkers: [
            {
              id: "worker-b",
              name: "Pixel 8",
              driver: createDriver("android"),
              engineConfig: {
                appId: "com.example",
                platform: "android",
                autoLaunch: false,
                coordinatorConfig: {
                  parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
                },
              },
            },
          ],
        },
      ],
    );

    expect(result.results).toHaveLength(3);
    expect(result.passed).toBe(3);
    expect(result.workerStats).toBeDefined();
    expect(result.workerStats!.size).toBe(2);
  });

  test("single-worker platform uses serial path (no workerStats)", async () => {
    const result = await orchestrate(
      [createFlow("a")],
      [
        {
          platform: "android",
          driver: createDriver("android"),
          engineConfig: {
            appId: "com.example",
            platform: "android",
            autoLaunch: false,
            coordinatorConfig: {
              parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
            },
          },
        },
      ],
    );

    expect(result.results).toHaveLength(1);
    expect(result.passed).toBe(1);
    expect(result.workerStats).toBeUndefined();
  });
});
