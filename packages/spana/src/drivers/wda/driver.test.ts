import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { DriverError } from "../../errors.js";

const wdaState = {
  events: [] as Array<[string, ...unknown[]]>,
  sessionId: "session-1",
  screenshot: new Uint8Array([1, 2, 3]),
  windowSize: { width: 390, height: 844 },
  createSessionError: undefined as Error | undefined,
  tapError: undefined as Error | undefined,
  openUrlErrors: [] as Error[],
  launchWithUrlErrors: [] as Error[],
  installedSchemes: [] as string[],
};

function resetWdaState() {
  wdaState.events = [];
  wdaState.sessionId = "session-1";
  wdaState.screenshot = new Uint8Array([1, 2, 3]);
  wdaState.windowSize = { width: 390, height: 844 };
  wdaState.createSessionError = undefined;
  wdaState.tapError = undefined;
  wdaState.openUrlErrors = [];
  wdaState.launchWithUrlErrors = [];
  wdaState.installedSchemes = [];
}

mock.module("./client.js", () => ({
  WDAClient: class FakeWDAClient {
    constructor(host: string, port: number) {
      wdaState.events.push(["client", host, port]);
    }

    async createSession(bundleId?: string) {
      wdaState.events.push(["createSession", bundleId]);
      if (wdaState.createSessionError) throw wdaState.createSessionError;
      return wdaState.sessionId;
    }

    async deleteSession() {
      wdaState.events.push(["deleteSession"]);
    }

    async disableQuiescence() {
      wdaState.events.push(["disableQuiescence"]);
    }

    async setSnapshotMaxDepth(depth: number) {
      wdaState.events.push(["setSnapshotMaxDepth", depth]);
    }

    async getSource() {
      return "<xml />";
    }

    async tap(x: number, y: number) {
      if (wdaState.tapError) throw wdaState.tapError;
      wdaState.events.push(["tap", x, y]);
    }

    async doubleTap(x: number, y: number) {
      wdaState.events.push(["doubleTap", x, y]);
    }

    async longPress(x: number, y: number, duration: number) {
      wdaState.events.push(["longPress", x, y, duration]);
    }

    async swipe(fromX: number, fromY: number, toX: number, toY: number, duration: number) {
      wdaState.events.push(["swipe", fromX, fromY, toX, toY, duration]);
    }

    async sendKeys(text: string) {
      wdaState.events.push(["sendKeys", text]);
    }

    async pressButton(button: string) {
      wdaState.events.push(["pressButton", button]);
    }

    async pressHome() {
      wdaState.events.push(["pressHome"]);
    }

    async getScreenshot() {
      wdaState.events.push(["getScreenshot"]);
      return wdaState.screenshot;
    }

    async getWindowSize() {
      wdaState.events.push(["getWindowSize"]);
      return wdaState.windowSize;
    }

    async openUrl(url: string) {
      wdaState.events.push(["openUrl", url]);
      const nextError = wdaState.openUrlErrors.shift();
      if (nextError) throw nextError;
    }

    async launchApp(bundleId: string) {
      wdaState.events.push(["launchApp", bundleId]);
    }

    async terminateApp(bundleId: string) {
      wdaState.events.push(["terminateApp", bundleId]);
    }

    async activateApp(bundleId: string) {
      wdaState.events.push(["activateApp", bundleId]);
    }
  },
}));

mock.module("../../device/ios.js", () => ({
  installedUrlSchemesOnSimulator(udid: string, bundleId: string) {
    wdaState.events.push(["installedUrlSchemesOnSimulator", udid, bundleId]);
    return [...wdaState.installedSchemes];
  },
  launchOnSimulator(udid: string, bundleId: string) {
    wdaState.events.push(["launchOnSimulator", udid, bundleId]);
  },
  launchWithUrlOnSimulator(udid: string, bundleId: string, url: string) {
    wdaState.events.push(["launchWithUrlOnSimulator", udid, bundleId, url]);
    const nextError = wdaState.launchWithUrlErrors.shift();
    if (nextError) throw nextError;
  },
  terminateOnSimulator(udid: string, bundleId: string) {
    wdaState.events.push(["terminateOnSimulator", udid, bundleId]);
  },
  resetSimulatorKeychain(udid: string) {
    wdaState.events.push(["resetSimulatorKeychain", udid]);
  },
  pfctlSetOffline(enable: boolean) {
    wdaState.events.push(["pfctlSetOffline", enable]);
  },
  pfctlSetThrottle(throughputKbps: number, delayMs: number) {
    wdaState.events.push(["pfctlSetThrottle", throughputKbps, delayMs]);
  },
  pfctlResetNetwork() {
    wdaState.events.push(["pfctlResetNetwork"]);
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
  resetWdaState();
});

describe("WDA driver adapter", () => {
  test("converts durations, maps button presses, and reports device info", async () => {
    const { createWDADriver } = await importFreshDriver();
    const driver = await Effect.runPromise(createWDADriver("127.0.0.1", 8100, "com.example.app"));

    await Effect.runPromise(driver.longPressAtCoordinate(1, 2, 1500));
    await Effect.runPromise(driver.swipe(1, 2, 3, 4, 250));
    await Effect.runPromise(driver.pressKey("volumeUp"));
    await Effect.runPromise(driver.pressKey("enter"));
    await Effect.runPromise(driver.hideKeyboard());
    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(wdaState.events).toContainEqual(["createSession", "com.example.app"]);
    expect(wdaState.events).toContainEqual(["disableQuiescence"]);
    expect(wdaState.events).toContainEqual(["setSnapshotMaxDepth", 100]);
    expect(wdaState.events).toContainEqual(["longPress", 1, 2, 1.5]);
    // Swipe Y coords are clamped to 15–85% of screen height (844) to avoid iOS system gestures
    expect(wdaState.events).toContainEqual(["swipe", 1, 844 * 0.15, 3, 844 * 0.15, 0.25]);
    expect(wdaState.events).toContainEqual(["pressButton", "volumeUp"]);
    expect(wdaState.events.filter(([type]) => type === "pressButton")).toHaveLength(1);
    // hideKeyboard taps a neutral coordinate instead of pressing Home
    expect(wdaState.events).toContainEqual(["getWindowSize"]);
    expect(wdaState.events).toContainEqual(["tap", 390 / 2, Math.round(844 * 0.2)]);
    expect(info).toEqual({
      platform: "ios",
      deviceId: "127.0.0.1:8100",
      name: "iOS Device",
      isEmulator: true,
      screenWidth: 390,
      screenHeight: 844,
      driverType: "wda",
    });
  });

  test("uses simulator deep-link helpers and recreates the WDA session after opening URLs", async () => {
    wdaState.installedSchemes = ["myapp"];
    wdaState.openUrlErrors = [
      new Error("wda openUrl failed"),
      new Error("wda openUrl retry failed"),
    ];
    wdaState.launchWithUrlErrors = [new Error("first launch attempt failed")];

    const { createWDADriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createWDADriver("localhost", 8100, "com.example.app", "SIM-1"),
    );

    await withImmediateTimeout(() =>
      Effect.runPromise(driver.openLink("https://example.com/home")),
    );

    expect(wdaState.events.filter(([type]) => type === "openUrl")).toEqual([
      ["openUrl", "https://example.com/home"],
      ["openUrl", "https://example.com/home"],
    ]);
    expect(
      wdaState.events
        .filter(([type]) => type === "launchWithUrlOnSimulator")
        .map(([, , , url]) => url),
    ).toEqual(["https://example.com/home", "myapp://example.com/home"]);
    expect(wdaState.events).toContainEqual([
      "installedUrlSchemesOnSimulator",
      "SIM-1",
      "com.example.app",
    ]);
    expect(wdaState.events.filter(([type]) => type === "deleteSession")).toHaveLength(2);
    expect(wdaState.events.filter(([type]) => type === "createSession")).toEqual([
      ["createSession", "com.example.app"],
      ["createSession", "com.example.app"],
      ["createSession", "com.example.app"],
    ]);
    expect(wdaState.events.filter(([type]) => type === "activateApp")).toEqual([
      ["activateApp", "com.example.app"],
      ["activateApp", "com.example.app"],
      ["activateApp", "com.example.app"],
    ]);
  });

  test("wraps client action failures in DriverError", async () => {
    wdaState.tapError = new Error("tap exploded");

    const { createWDADriver } = await importFreshDriver();
    const driver = await Effect.runPromise(createWDADriver("127.0.0.1", 8100, "com.example.app"));
    const result = await Effect.runPromise(Effect.either(driver.tapAtCoordinate(10, 20)));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Tap failed: Error: tap exploded");
    }
  });

  test("setNetworkConditions with offline on simulator calls pfctlSetOffline", async () => {
    const { createWDADriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createWDADriver("localhost", 8100, "com.example.app", "SIM-1"),
    );

    await Effect.runPromise(driver.setNetworkConditions!({ offline: true }));

    expect(wdaState.events).toContainEqual(["pfctlSetOffline", true]);
  });

  test("setNetworkConditions with profile on simulator calls pfctlSetThrottle", async () => {
    const { createWDADriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createWDADriver("localhost", 8100, "com.example.app", "SIM-1"),
    );

    await Effect.runPromise(driver.setNetworkConditions!({ profile: "3g" }));

    expect(wdaState.events).toContainEqual(["pfctlSetThrottle", 1500, 100]);
  });

  test("setNetworkConditions on physical device throws", async () => {
    const { createWDADriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createWDADriver("192.168.1.10", 8100, "com.example.app"),
    );

    const result = await Effect.runPromise(
      Effect.either(driver.setNetworkConditions!({ profile: "3g" })),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("not supported on physical iOS devices");
    }
  });

  test("setNetworkConditions with empty object resets network", async () => {
    const { createWDADriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      createWDADriver("localhost", 8100, "com.example.app", "SIM-1"),
    );

    await Effect.runPromise(driver.setNetworkConditions!({}));

    expect(wdaState.events).toContainEqual(["pfctlResetNetwork"]);
  });

  test("wraps session initialization failures in DriverError", async () => {
    wdaState.createSessionError = new Error("session exploded");

    const { createWDADriver } = await importFreshDriver();
    const result = await Effect.runPromise(
      Effect.either(createWDADriver("127.0.0.1", 8100, "com.example.app")),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain(
        "Failed to create WDA session: Error: session exploded",
      );
    }
  });
});
