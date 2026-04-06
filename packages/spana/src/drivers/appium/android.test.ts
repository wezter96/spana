import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import { AppiumClient } from "./client.js";
import { createAppiumAndroidDriver } from "./android.js";

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
  // We pre-queue the session creation response, then swap to fresh queues per test
  const _sessionCalls = queueFetch([
    {
      body: {
        value: {
          sessionId: "test-session",
          capabilities: {
            platformName: "Android",
            deviceName: "Pixel 7",
          },
        },
      },
    },
  ]);
  const client = new AppiumClient("http://localhost:4723");
  await client.createSession({ platformName: "Android" });

  // Reset fetch for the actual test calls
  globalThis.fetch = originalFetch;
  const calls = queueFetch([]);
  return { client, calls };
}

describe("Appium Android driver", () => {
  test("dumpHierarchy calls GET /source", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: "<hierarchy><node/></hierarchy>" } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    const result = await Effect.runPromise(driver.dumpHierarchy());

    expect(result).toBe("<hierarchy><node/></hierarchy>");
  });

  test("tapAtCoordinate sends gesture click", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.tapAtCoordinate(150, 300));

    expect(calls[0]?.url).toBe("http://localhost:4723/session/test-session/appium/gestures/click");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      offset: { x: 150, y: 300 },
    });
  });

  test("doubleTapAtCoordinate sends gesture double_click", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.doubleTapAtCoordinate(50, 60));

    expect(calls[0]?.url).toContain("/appium/gestures/double_click");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      offset: { x: 50, y: 60 },
    });
  });

  test("longPressAtCoordinate sends gesture long_click with duration", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.longPressAtCoordinate(10, 20, 2000));

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      offset: { x: 10, y: 20 },
      duration: 2000,
    });
  });

  test("swipe sends W3C Actions pointer sequence", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.swipe(100, 200, 300, 400, 500));

    expect(calls[0]?.url).toContain("/actions");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].type).toBe("pointer");
    expect(body.actions[0].actions).toEqual([
      { type: "pointerMove", duration: 0, x: 100, y: 200 },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 500, x: 300, y: 400 },
      { type: "pointerUp", button: 0 },
    ]);
  });

  test("inputText sends W3C key actions", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.inputText("Hi"));

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.actions[0].type).toBe("key");
    expect(body.actions[0].actions).toEqual([
      { type: "keyDown", value: "H" },
      { type: "keyUp", value: "H" },
      { type: "keyDown", value: "i" },
      { type: "keyUp", value: "i" },
    ]);
  });

  test("pressKey sends press_keycode with parsed integer", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.pressKey("66"));

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ keycode: 66 });
  });

  test("pressKey defaults to 0 for non-numeric keys", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.pressKey("not-a-number"));

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ keycode: 0 });
  });

  test("hideKeyboard calls Appium endpoint", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.hideKeyboard());

    expect(calls[0]?.url).toContain("/appium/device/hide_keyboard");
  });

  test("takeScreenshot decodes base64 to Uint8Array", async () => {
    const { client } = await makeClient();
    const base64 = btoa(String.fromCharCode(1, 2, 3));
    queueFetch([{ body: { value: base64 } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    const screenshot = await Effect.runPromise(driver.takeScreenshot());

    expect(Array.from(screenshot)).toEqual([1, 2, 3]);
  });

  test("getDeviceInfo returns platform info from session caps", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: { width: 1080, height: 2400 } } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(info).toEqual({
      platform: "android",
      deviceId: "test-session",
      name: "Pixel 7",
      isEmulator: false,
      screenWidth: 1080,
      screenHeight: 2400,
      driverType: "appium",
    });
  });

  test("launchApp activates app through Appium", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
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

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.launchApp("com.example.app", { clearState: true }));

    expect(calls[0]?.url).toContain("/appium/device/terminate_app");
    expect(calls[1]?.url).toContain("/appium/execute_mobile/clearApp");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ appId: "com.example.app" });
    expect(calls[2]?.url).toContain("/appium/device/activate_app");
  });

  test("launchApp with deepLink opens URL after activation", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([
      { body: { value: null } }, // activate
      { body: { value: null } }, // url
    ]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.launchApp("com.example.app", { deepLink: "myapp://home" }));

    expect(calls[0]?.url).toContain("/appium/device/activate_app");
    expect(calls[1]?.url).toContain("/url");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      url: "myapp://home",
    });
  });

  test("stopApp and killApp use terminate_app", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }, { body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.stopApp("com.example.app"));
    await Effect.runPromise(driver.killApp("com.example.app"));

    expect(calls[0]?.url).toContain("/appium/device/terminate_app");
    expect(calls[1]?.url).toContain("/appium/device/terminate_app");
  });

  test("clearAppState terminates then clears app data without uninstalling", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([
      { body: { value: null } }, // terminate
      { body: { value: null } }, // clearApp
    ]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.clearAppState("com.example.app"));

    expect(calls[0]?.url).toContain("/appium/device/terminate_app");
    expect(calls[1]?.url).toContain("/appium/execute_mobile/clearApp");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ appId: "com.example.app" });
  });

  test("openLink sends URL to /url endpoint", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.openLink("https://example.com"));

    expect(calls[0]?.url).toContain("/url");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: "https://example.com",
    });
  });

  test("back sends POST to /back", async () => {
    const { client } = await makeClient();
    const calls = queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    await Effect.runPromise(driver.back());

    expect(calls[0]?.url).toContain("/back");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  test("evaluate fails with DriverError", async () => {
    const { client } = await makeClient();

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    const result = await Effect.runPromise(Effect.either(driver.evaluate("1+1")));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("not supported in Appium mode");
    }
  });

  test("launchApp with launchArguments fails with DriverError", async () => {
    const { client } = await makeClient();
    queueFetch([{ body: { value: null } }]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    const result = await Effect.runPromise(
      Effect.either(driver.launchApp("com.example.app", { launchArguments: { foo: "bar" } })),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("launchArguments are not supported");
    }
  });

  test("wraps client failures in DriverError", async () => {
    const { client } = await makeClient();
    queueFetch([
      {
        status: 500,
        body: { value: { error: "unknown error", message: "server crashed" } },
      },
    ]);

    const driver = await Effect.runPromise(createAppiumAndroidDriver(client));
    const result = await Effect.runPromise(Effect.either(driver.tapAtCoordinate(10, 20)));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Tap failed");
    }
  });
});
