import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import { AppiumClient } from "./client.js";
import { createAppiumIOSDriver } from "./ios.js";

const originalFetch = globalThis.fetch;

interface FetchResponse {
  status?: number;
  body: unknown;
}

function queueFetch(responses: FetchResponse[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input, init) => {
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }

    calls.push({ url: String(input), init });

    return new Response(
      typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      {
        status: response.status ?? 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Helper: create a client with an already-established session */
async function makeClient(): Promise<{
  client: AppiumClient;
  calls: ReturnType<typeof queueFetch>;
}> {
  queueFetch([
    {
      body: {
        value: {
          sessionId: "ios-test-session",
          capabilities: {
            platformName: "iOS",
            deviceName: "iPhone 15 Pro",
          },
        },
      },
    },
  ]);
  const client = new AppiumClient("http://localhost:4723");
  await client.createSession({ platformName: "iOS" });

  // Reset fetch for the actual test calls
  globalThis.fetch = originalFetch;
  const calls = queueFetch([]);
  return { client, calls };
}

describe("Appium iOS driver", () => {
  // ---------------------------------------------------------------------------
  // Hierarchy
  // ---------------------------------------------------------------------------
  test("dumpHierarchy calls GET /source", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: "<AppiumAUT><XCUIElementTypeWindow/></AppiumAUT>" } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    const result = await Effect.runPromise(driver.dumpHierarchy());

    expect(result).toBe("<AppiumAUT><XCUIElementTypeWindow/></AppiumAUT>");
  });

  // ---------------------------------------------------------------------------
  // Coordinate-level actions — W3C touch pointer actions
  // ---------------------------------------------------------------------------
  test("tapAtCoordinate sends W3C touch pointer action", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.tapAtCoordinate(150, 300));

    expect(calls[0]?.url).toContain("/actions");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].parameters.pointerType).toBe("touch");
    expect(body.actions[0].actions).toEqual([
      { type: "pointerMove", duration: 0, x: 150, y: 300 },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ]);
  });

  test("doubleTapAtCoordinate sends two tap sequences with pause", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.doubleTapAtCoordinate(50, 60));

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].parameters.pointerType).toBe("touch");
    expect(body.actions[0].actions).toEqual([
      { type: "pointerMove", duration: 0, x: 50, y: 60 },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
      { type: "pause", duration: 40 },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ]);
  });

  test("longPressAtCoordinate sends pointer down, pause, pointer up", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.longPressAtCoordinate(10, 20, 2000));

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].parameters.pointerType).toBe("touch");
    expect(body.actions[0].actions).toEqual([
      { type: "pointerMove", duration: 0, x: 10, y: 20 },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 2000 },
      { type: "pointerUp", button: 0 },
    ]);
  });

  test("swipe sends W3C touch pointer sequence", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.swipe(100, 200, 300, 400, 500));

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].type).toBe("pointer");
    expect(body.actions[0].parameters.pointerType).toBe("touch");
    expect(body.actions[0].actions).toEqual([
      { type: "pointerMove", duration: 0, x: 100, y: 200 },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 500, x: 300, y: 400 },
      { type: "pointerUp", button: 0 },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Text input
  // ---------------------------------------------------------------------------
  test("inputText sends W3C key actions and preserves grapheme clusters", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.inputText("H👨‍👩‍👧‍👦e\u0301"));

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].type).toBe("key");
    expect(body.actions[0].actions).toEqual([
      { type: "keyDown", value: "H" },
      { type: "keyUp", value: "H" },
      { type: "keyDown", value: "👨‍👩‍👧‍👦" },
      { type: "keyUp", value: "👨‍👩‍👧‍👦" },
      { type: "keyDown", value: "e\u0301" },
      { type: "keyUp", value: "e\u0301" },
    ]);
  });

  test("pressKey sends W3C key actions (not Android keycode)", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.pressKey("\uE007")); // Enter key

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].type).toBe("key");
    expect(body.actions[0].actions).toEqual([
      { type: "keyDown", value: "\uE007" },
      { type: "keyUp", value: "\uE007" },
    ]);
  });

  test("hideKeyboard calls Appium endpoint", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.hideKeyboard());

    expect(calls[0]?.url).toContain("/appium/device/hide_keyboard");
  });

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------
  test("takeScreenshot decodes base64 to Uint8Array", async () => {
    const { client } = await makeClient();
    const base64 = btoa(String.fromCharCode(1, 2, 3));
    queueFetch([{ body: { value: base64 } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    const screenshot = await Effect.runPromise(driver.takeScreenshot());

    expect(Array.from(screenshot)).toEqual([1, 2, 3]);
  });

  test("getDeviceInfo returns iOS platform info from session caps", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: { width: 1179, height: 2556 } } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(info).toEqual({
      platform: "ios",
      deviceId: "ios-test-session",
      name: "iPhone 15 Pro",
      isEmulator: false,
      screenWidth: 1179,
      screenHeight: 2556,
      driverType: "appium",
    });
  });

  test("getDeviceInfo falls back to window rect when window size is unavailable", async () => {
    const { client } = await makeClient();
    queueFetch([
      { status: 404, body: { value: { message: "missing /window/size" } } },
      { body: { value: { x: 0, y: 0, width: 1179, height: 2556 } } },
    ]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(info.screenWidth).toBe(1179);
    expect(info.screenHeight).toBe(2556);
  });

  // ---------------------------------------------------------------------------
  // App lifecycle
  // ---------------------------------------------------------------------------
  test("launchApp activates app through Appium", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.launchApp("com.example.app"));

    expect(calls[0]?.url).toContain("/appium/device/activate_app");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      appId: "com.example.app",
    });
  });

  test("launchApp with clearState terminates, clears app data, and activates", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([
      { body: { value: null } }, // terminate
      { body: { value: null } }, // clearApp
      { body: { value: null } }, // activate
    ]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.launchApp("com.example.app", { clearState: true }));

    expect(calls[0]?.url).toContain("/appium/device/terminate_app");
    expect(calls[1]?.url).toContain("/execute/sync");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      script: "mobile: clearApp",
      args: [{ bundleId: "com.example.app" }],
    });
    expect(calls[2]?.url).toContain("/appium/device/activate_app");
  });

  test("launchApp with deepLink opens URL after activation", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([
      { body: { value: null } }, // activate
      { body: { value: null } }, // url
    ]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.launchApp("com.example.app", { deepLink: "myapp://home" }));

    expect(calls[0]?.url).toContain("/appium/device/activate_app");
    expect(calls[1]?.url).toContain("/url");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      url: "myapp://home",
    });
  });

  test("launchApp with launchArguments and deviceState uses mobile: launchApp", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([
      { body: { value: null } }, // terminate
      { body: { value: null } }, // executeScript mobile: launchApp
    ]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(
      driver.launchApp("com.example.app", {
        launchArguments: { featureFlag: "on", retries: 2 },
        deviceState: {
          language: "ja",
          locale: "ja_JP",
          timeZone: "Asia/Tokyo",
        },
      }),
    );

    expect(calls[0]?.url).toContain("/appium/device/terminate_app");
    expect(calls[1]?.url).toContain("/execute/sync");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      script: "mobile: launchApp",
      args: [
        {
          bundleId: "com.example.app",
          arguments: [
            "-AppleLanguages",
            "(ja)",
            "-AppleLocale",
            "ja_JP",
            "-featureFlag",
            "on",
            "-retries",
            "2",
          ],
          environment: {
            TZ: "Asia/Tokyo",
          },
        },
      ],
    });
  });

  test("launchApp with clearKeychain warns but does not fail", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: null } }]);

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.launchApp("com.example.app", { clearKeychain: true }));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("clearKeychain"));
    warnSpy.mockRestore();
  });

  test("stopApp and killApp use terminate_app", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }, { body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.stopApp("com.example.app"));
    await Effect.runPromise(driver.killApp("com.example.app"));

    expect(calls[0]?.url).toContain("/appium/device/terminate_app");
    expect(calls[1]?.url).toContain("/appium/device/terminate_app");
  });

  test("clearAppState terminates then clears app data", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([
      { body: { value: null } }, // terminate
      { body: { value: null } }, // clearApp
    ]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.clearAppState("com.example.app"));

    expect(calls[0]?.url).toContain("/appium/device/terminate_app");
    expect(calls[1]?.url).toContain("/execute/sync");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      script: "mobile: clearApp",
      args: [{ bundleId: "com.example.app" }],
    });
  });

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  test("openLink sends URL to /url endpoint", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.openLink("https://example.com"));

    expect(calls[0]?.url).toContain("/url");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: "https://example.com",
    });
  });

  test("back() fails with DriverError (not supported on iOS)", async () => {
    const { client } = await makeClient();

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    const result = await Effect.runPromise(Effect.either(driver.back()));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("not supported on iOS");
    }
  });

  // ---------------------------------------------------------------------------
  // Scripting
  // ---------------------------------------------------------------------------
  test("evaluate delegates to execute/sync endpoint", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: "hello" } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    const result = await Effect.runPromise(driver.evaluate("return document.title"));

    expect(result).toBe("hello");
  });

  // ---------------------------------------------------------------------------
  // Network conditions
  // ---------------------------------------------------------------------------

  test("setNetworkConditions with offline sends connectivity command", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.setNetworkConditions!({ offline: true }));

    expect(calls[0]?.url).toContain("/execute/sync");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      script: "mobile: setConnectivity",
      args: [{ wifi: false, data: false, airplaneMode: true }],
    });
  });

  test("setNetworkConditions with empty object resets connectivity", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.setNetworkConditions!({}));

    expect(calls[0]?.url).toContain("/execute/sync");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      script: "mobile: setConnectivity",
      args: [{ wifi: true, data: true, airplaneMode: false }],
    });
  });

  test("setNetworkConditions with profile sets connectivity online", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.setNetworkConditions!({ profile: "3g" }));

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      script: "mobile: setConnectivity",
      args: [{ wifi: true, data: true, airplaneMode: false }],
    });
  });

  // ---------------------------------------------------------------------------
  // Error propagation
  // ---------------------------------------------------------------------------
  test("wraps client failures in DriverError", async () => {
    const { client } = await makeClient();
    queueFetch([
      {
        status: 500,
        body: { value: { error: "unknown error", message: "server crashed" } },
      },
    ]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    const result = await Effect.runPromise(Effect.either(driver.tapAtCoordinate(10, 20)));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Tap failed");
    }
  });

  test("all touch actions use pointerType touch (not mouse)", async () => {
    const { client } = await makeClient();
    // Queue responses for tap, double-tap, long-press, swipe
    const calls = queueFetch([
      { body: { value: null } },
      { body: { value: null } },
      { body: { value: null } },
      { body: { value: null } },
    ]);

    const driver = await Effect.runPromise(createAppiumIOSDriver(client));
    await Effect.runPromise(driver.tapAtCoordinate(1, 1));
    await Effect.runPromise(driver.doubleTapAtCoordinate(1, 1));
    await Effect.runPromise(driver.longPressAtCoordinate(1, 1, 500));
    await Effect.runPromise(driver.swipe(1, 1, 2, 2, 300));

    for (const call of calls) {
      const body = JSON.parse(String(call.init?.body));
      if (body.actions?.[0]?.parameters) {
        expect(body.actions[0].parameters.pointerType).toBe("touch");
      }
    }
  });
});
