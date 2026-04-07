import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Element } from "../schemas/element.js";
import type { StepRecorder } from "../core/step-recorder.js";
import { createPromiseApp } from "./app.js";

function createElement(overrides: Partial<Element> = {}): Element {
  return {
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    children: [],
    visible: true,
    clickable: true,
    ...overrides,
  };
}

function createDriver(hierarchy: Element | Element[]) {
  const events: Array<[string, ...unknown[]]> = [];
  const hierarchies = Array.isArray(hierarchy) ? hierarchy : [hierarchy];
  let dumpCount = 0;
  const consoleLogs = [{ type: "info", text: "web flow ready" }];
  const jsErrors: Array<{ name?: string; message: string; stack?: string }> = [];
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
    takeScreenshot: () => {
      events.push(["takeScreenshot"]);
      return Effect.succeed(new Uint8Array([1, 2, 3]));
    },
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
    evaluate: () => Effect.void as any,
    mockNetwork: (matcher, response) => {
      events.push(["mockNetwork", matcher, response]);
      return Effect.void;
    },
    blockNetwork: (matcher) => {
      events.push(["blockNetwork", matcher]);
      return Effect.void;
    },
    clearNetworkMocks: () => {
      events.push(["clearNetworkMocks"]);
      return Effect.void;
    },
    setNetworkConditions: (conditions) => {
      events.push(["setNetworkConditions", conditions]);
      return Effect.void;
    },
    saveCookies: (path) => {
      events.push(["saveCookies", path]);
      return Effect.void;
    },
    loadCookies: (path) => {
      events.push(["loadCookies", path]);
      return Effect.void;
    },
    saveAuthState: (path) => {
      events.push(["saveAuthState", path]);
      return Effect.void;
    },
    loadAuthState: (path) => {
      events.push(["loadAuthState", path]);
      return Effect.void;
    },
    getConsoleLogs: () => {
      events.push(["getConsoleLogs"]);
      return Effect.succeed(consoleLogs);
    },
    getJSErrors: () => {
      events.push(["getJSErrors"]);
      return Effect.succeed(jsErrors);
    },
  };

  return { driver, events };
}

function createRecorder() {
  const stepCalls: Array<{
    command: string;
    opts?: { selector?: unknown; captureScreenshot?: boolean };
  }> = [];
  const screenshotCalls: Array<{
    command: string;
    opts?: { selector?: unknown; name?: string };
  }> = [];

  const recorder: StepRecorder = {
    runStep: async (command, action, opts) => {
      stepCalls.push({ command, opts });
      return action();
    },
    runScreenshotStep: async (command, action, opts) => {
      screenshotCalls.push({ command, opts });
      return action();
    },
    getSteps: () => [],
  };

  return { recorder, stepCalls, screenshotCalls };
}

const parse = (raw: string): Element => JSON.parse(raw) as Element;

describe("promise app", () => {
  test("records wrapped commands with selectors, screenshots, and app lifecycle metadata", async () => {
    const { driver, events } = createDriver(
      createElement({ children: [createElement({ text: "Ready" })] }),
    );
    const { recorder, stepCalls, screenshotCalls } = createRecorder();
    const app = createPromiseApp(driver, "com.example.app", { parse }, recorder);

    await app.tap({ text: "Ready" });
    await app.tapXY(7, 9);
    await app.doubleTap({ text: "Ready" });
    await app.longPress({ text: "Ready" }, { duration: 1200 });
    await app.longPressXY(1, 2, { duration: 400 });
    await app.inputText("hello");
    await app.pressKey("Enter");
    await app.hideKeyboard();
    await app.swipe("left", { duration: 250 });
    await app.scroll("down");
    await app.launch({ deepLink: "app://home" });
    await app.stop();
    await app.kill();
    await app.clearState();
    await app.openLink("https://example.com");
    await app.back();
    await app.mockNetwork(/\/api\/user$/, { json: { ok: true } });
    await app.blockNetwork("**/ads");
    await app.clearNetworkMocks();
    await app.setNetworkConditions({ offline: true });
    await app.saveCookies("./cookies.json");
    await app.loadCookies("./cookies.json");
    await app.saveAuthState("./auth.json");
    await app.loadAuthState("./auth.json");
    const consoleLogs = await app.getConsoleLogs();
    const jsErrors = await app.getJSErrors();
    const screenshot = await app.takeScreenshot("home");

    expect(screenshot).toEqual(new Uint8Array([1, 2, 3]));
    expect(consoleLogs).toEqual([{ type: "info", text: "web flow ready" }]);
    expect(jsErrors).toEqual([]);
    expect(stepCalls.map((call) => call.command)).toEqual([
      "tap",
      "tapXY",
      "doubleTap",
      "longPress",
      "longPressXY",
      "inputText",
      "pressKey(Enter)",
      "hideKeyboard",
      "swipe(left)",
      "scroll(down)",
      "launch",
      "stop",
      "kill",
      "clearState",
      "openLink",
      "back",
      "mockNetwork",
      "blockNetwork",
      "clearNetworkMocks",
      "setNetworkConditions",
      "saveCookies",
      "loadCookies",
      "saveAuthState",
      "loadAuthState",
      "getConsoleLogs",
      "getJSErrors",
    ]);
    expect(stepCalls[0]?.opts).toEqual({
      selector: { text: "Ready" },
      captureScreenshot: true,
    });
    expect(stepCalls[1]?.opts).toEqual({
      selector: { point: { x: 7, y: 9 } },
      captureScreenshot: true,
    });
    expect(stepCalls[10]?.opts).toEqual({
      selector: { deepLink: "app://home" },
      captureScreenshot: true,
    });
    expect(stepCalls[14]?.opts).toEqual({
      selector: { url: "https://example.com" },
      captureScreenshot: true,
    });
    expect(stepCalls[16]?.opts).toEqual({
      selector: { matcher: "/\\/api\\/user$/", response: { json: { ok: true } } },
    });
    expect(stepCalls[17]?.opts).toEqual({
      selector: { matcher: "**/ads" },
    });
    expect(stepCalls[19]?.opts).toEqual({
      selector: { offline: true },
    });
    expect(stepCalls[20]?.opts).toEqual({
      selector: { path: "./cookies.json" },
    });
    expect(stepCalls[23]?.opts).toEqual({
      selector: { path: "./auth.json" },
    });
    expect(screenshotCalls).toEqual([
      {
        command: "takeScreenshot(home)",
        opts: { name: "home" },
      },
    ]);
    expect(events).toContainEqual(["tapAtCoordinate", 25, 40]);
    expect(events.filter((event) => event[0] === "tapAtCoordinate")).toHaveLength(4);
    expect(events).toContainEqual(["longPressAtCoordinate", 25, 40, 1200]);
    expect(events).toContainEqual(["longPressAtCoordinate", 1, 2, 400]);
    expect(events).toContainEqual(["launchApp", "com.example.app", { deepLink: "app://home" }]);
    expect(events).toContainEqual(["stopApp", "com.example.app"]);
    expect(events).toContainEqual(["killApp", "com.example.app"]);
    expect(events).toContainEqual(["clearAppState", "com.example.app"]);
    expect(events).toContainEqual(["openLink", "https://example.com"]);
    expect(events).toContainEqual(["back"]);
    expect(events).toContainEqual(["mockNetwork", /\/api\/user$/, { json: { ok: true } }]);
    expect(events).toContainEqual(["blockNetwork", "**/ads"]);
    expect(events).toContainEqual(["clearNetworkMocks"]);
    expect(events).toContainEqual(["setNetworkConditions", { offline: true }]);
    expect(events).toContainEqual(["saveCookies", "./cookies.json"]);
    expect(events).toContainEqual(["loadCookies", "./cookies.json"]);
    expect(events).toContainEqual(["saveAuthState", "./auth.json"]);
    expect(events).toContainEqual(["loadAuthState", "./auth.json"]);
    expect(events).toContainEqual(["getConsoleLogs"]);
    expect(events).toContainEqual(["getJSErrors"]);
    expect(events).toContainEqual(["takeScreenshot"]);
  });

  test("scrollUntilVisible records a targeted helper step and stops once the element appears", async () => {
    const { driver, events } = createDriver([
      createElement({ children: [createElement({ text: "Top" })] }),
      createElement({ children: [createElement({ id: "target-card" })] }),
    ]);
    const { recorder, stepCalls } = createRecorder();
    const app = createPromiseApp(
      driver,
      "com.example.app",
      { parse, screenWidth: 100, screenHeight: 200 },
      recorder,
    );

    await app.scrollUntilVisible({ testID: "target-card" });

    expect(stepCalls).toEqual([
      {
        command: "scrollUntilVisible(down)",
        opts: {
          selector: {
            target: { testID: "target-card" },
            direction: "down",
            maxScrolls: 5,
          },
          captureScreenshot: true,
        },
      },
    ]);
    expect(events.filter((event) => event[0] === "swipe")).toEqual([
      ["swipe", 50, 130, 50, 70, 500],
    ]);
  });

  test("dismissKeyboard records the requested strategy and delegates to back when asked", async () => {
    const { driver, events } = createDriver(createElement());
    const { recorder, stepCalls } = createRecorder();
    const app = createPromiseApp(driver, "com.example.app", { parse }, recorder);

    await app.dismissKeyboard({ strategy: "back" });

    expect(stepCalls).toEqual([
      {
        command: "dismissKeyboard(back)",
        opts: {
          selector: { strategy: "back" },
          captureScreenshot: true,
        },
      },
    ]);
    expect(events).toEqual([["back"]]);
  });

  test("backUntilVisible records a targeted helper step and stops once the target screen appears", async () => {
    const { driver, events } = createDriver([
      createElement({ children: [createElement({ text: "Modal title" })] }),
      createElement({ children: [createElement({ id: "home-title" })] }),
    ]);
    const { recorder, stepCalls } = createRecorder();
    const app = createPromiseApp(driver, "com.example.app", { parse }, recorder);

    await app.backUntilVisible({ testID: "home-title" }, { maxBacks: 2 });

    expect(stepCalls).toEqual([
      {
        command: "backUntilVisible(2)",
        opts: {
          selector: {
            target: { testID: "home-title" },
            maxBacks: 2,
          },
          captureScreenshot: true,
        },
      },
    ]);
    expect(events).toEqual([["back"]]);
  });

  test("works without a step recorder", async () => {
    const { driver, events } = createDriver(createElement());
    const app = createPromiseApp(driver, "com.example.app", { parse });

    await app.back();
    const screenshot = await app.takeScreenshot();

    expect(screenshot).toEqual(new Uint8Array([1, 2, 3]));
    expect(events).toEqual([["back"], ["takeScreenshot"]]);
  });

  test("web-only browser helpers fail cleanly when the driver does not support them", async () => {
    const { driver } = createDriver(createElement());
    const app = createPromiseApp(
      { ...driver, saveCookies: undefined, getConsoleLogs: undefined } as RawDriverService,
      "com.example.app",
      { parse },
    );

    await expect(app.saveCookies("./cookies.json")).rejects.toThrow(
      "saveCookies() is only supported on the web platform",
    );
    await expect(app.getConsoleLogs()).rejects.toThrow(
      "getConsoleLogs() is only supported on the web platform",
    );
  });
});
