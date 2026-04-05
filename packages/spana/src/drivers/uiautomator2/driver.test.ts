import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { DriverError } from "../../errors.js";

const uiaState = {
  events: [] as Array<[string, ...unknown[]]>,
  sessionId: "session-1",
  screenshotBase64: Buffer.from([4, 5, 6]).toString("base64"),
  windowSize: { width: 1080, height: 1920 },
  createSessionError: undefined as Error | undefined,
  tapError: undefined as Error | undefined,
};

function resetUiaState() {
  uiaState.events = [];
  uiaState.sessionId = "session-1";
  uiaState.screenshotBase64 = Buffer.from([4, 5, 6]).toString("base64");
  uiaState.windowSize = { width: 1080, height: 1920 };
  uiaState.createSessionError = undefined;
  uiaState.tapError = undefined;
}

mock.module("./client.js", () => ({
  UiAutomator2Client: class FakeUiAutomator2Client {
    constructor(host: string, port: number) {
      uiaState.events.push(["client", host, port]);
    }

    async createSession(appPackage?: string) {
      uiaState.events.push(["createSession", appPackage]);
      if (uiaState.createSessionError) throw uiaState.createSessionError;
      return uiaState.sessionId;
    }

    async getSource() {
      return "<xml />";
    }

    async performTap(x: number, y: number) {
      if (uiaState.tapError) throw uiaState.tapError;
      uiaState.events.push(["performTap", x, y]);
    }

    async performDoubleTap(x: number, y: number) {
      uiaState.events.push(["performDoubleTap", x, y]);
    }

    async performLongPress(x: number, y: number, duration: number) {
      uiaState.events.push(["performLongPress", x, y, duration]);
    }

    async performSwipe(
      startX: number,
      startY: number,
      endX: number,
      endY: number,
      duration: number,
    ) {
      uiaState.events.push(["performSwipe", startX, startY, endX, endY, duration]);
    }

    async sendKeys(text: string) {
      uiaState.events.push(["sendKeys", text]);
    }

    async pressKeyCode(keyCode: number) {
      uiaState.events.push(["pressKeyCode", keyCode]);
    }

    async hideKeyboard() {
      uiaState.events.push(["hideKeyboard"]);
    }

    async getScreenshot() {
      uiaState.events.push(["getScreenshot"]);
      return uiaState.screenshotBase64;
    }

    async getWindowSize() {
      uiaState.events.push(["getWindowSize"]);
      return uiaState.windowSize;
    }
  },
}));

mock.module("../../device/android.js", () => ({
  adbLaunchApp(serial: string, packageName: string) {
    uiaState.events.push(["adbLaunchApp", serial, packageName]);
  },
  adbForceStop(serial: string, packageName: string) {
    uiaState.events.push(["adbForceStop", serial, packageName]);
  },
  adbClearApp(serial: string, packageName: string) {
    uiaState.events.push(["adbClearApp", serial, packageName]);
  },
  adbOpenLink(serial: string, url: string, packageName?: string) {
    uiaState.events.push(["adbOpenLink", serial, url, packageName]);
  },
}));

let importCounter = 0;

async function importFreshDriver() {
  importCounter += 1;
  return import(new URL(`./driver.ts?case=${importCounter}`, import.meta.url).href) as Promise<
    typeof import("./driver.js")
  >;
}

async function withImmediateTimeout<T>(action: () => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;
  const immediateSetTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === "function") {
      handler();
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.setTimeout = immediateSetTimeout;
  try {
    return await action();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

beforeEach(() => {
  resetUiaState();
});

describe("UiAutomator2 driver adapter", () => {
  test("maps key codes, decodes screenshots, and reports device info", async () => {
    const { createUiAutomator2Driver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createUiAutomator2Driver("127.0.0.1", 4723, "SERIAL", "com.example.app"),
    );

    await Effect.runPromise(driver.pressKey("66"));
    await Effect.runPromise(driver.pressKey("not-a-number"));
    const screenshot = await Effect.runPromise(driver.takeScreenshot());
    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(uiaState.events).toContainEqual(["createSession", "com.example.app"]);
    expect(uiaState.events).toContainEqual(["pressKeyCode", 66]);
    expect(uiaState.events).toContainEqual(["pressKeyCode", 0]);
    expect(Array.from(screenshot)).toEqual([4, 5, 6]);
    expect(info).toEqual({
      platform: "android",
      deviceId: "127.0.0.1:4723",
      name: "Android Device",
      isEmulator: true,
      screenWidth: 1080,
      screenHeight: 1920,
      driverType: "uiautomator2",
    });
  });

  test("uses adb helpers for lifecycle and deep-link operations", async () => {
    const { createUiAutomator2Driver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createUiAutomator2Driver("127.0.0.1", 4723, "SERIAL", "com.example.app"),
    );

    await withImmediateTimeout(() =>
      Effect.runPromise(driver.launchApp("com.example.app", { deepLink: "spana://home" })),
    );
    await withImmediateTimeout(() => Effect.runPromise(driver.launchApp("com.example.app")));
    await Effect.runPromise(driver.clearAppState("com.example.app"));
    await withImmediateTimeout(() => Effect.runPromise(driver.openLink("https://example.com")));
    await Effect.runPromise(driver.back());

    expect(uiaState.events).toContainEqual(["adbForceStop", "SERIAL", "com.example.app"]);
    expect(uiaState.events).toContainEqual([
      "adbOpenLink",
      "SERIAL",
      "spana://home",
      "com.example.app",
    ]);
    expect(uiaState.events).toContainEqual(["adbLaunchApp", "SERIAL", "com.example.app"]);
    expect(uiaState.events).toContainEqual(["adbClearApp", "SERIAL", "com.example.app"]);
    expect(uiaState.events).toContainEqual([
      "adbOpenLink",
      "SERIAL",
      "https://example.com",
      "com.example.app",
    ]);
    expect(uiaState.events).toContainEqual(["pressKeyCode", 4]);
  });

  test("wraps client failures in DriverError", async () => {
    uiaState.tapError = new Error("tap exploded");

    const { createUiAutomator2Driver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createUiAutomator2Driver("127.0.0.1", 4723, "SERIAL", "com.example.app"),
    );
    const result = await Effect.runPromise(Effect.either(driver.tapAtCoordinate(10, 20)));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Tap failed: Error: tap exploded");
    }
  });

  test("wraps session initialization failures in DriverError", async () => {
    uiaState.createSessionError = new Error("session exploded");

    const { createUiAutomator2Driver } = await importFreshDriver();
    const result = await Effect.runPromise(
      Effect.either(createUiAutomator2Driver("127.0.0.1", 4723, "SERIAL", "com.example.app")),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain(
        "Failed to create UiAutomator2 session: Error: session exploded",
      );
    }
  });
});
