import { describe, test, expect, mock } from "bun:test";
import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { Session } from "./session.js";

function mockDriver(overrides: Partial<RawDriverService> = {}): RawDriverService {
  const noop = () => Effect.void;
  return {
    dumpHierarchy: () =>
      Effect.succeed(
        JSON.stringify({
          tag: "div",
          id: "btn",
          text: "Click me",
          bounds: { x: 50, y: 50, width: 100, height: 40 },
          visible: true,
          enabled: true,
          children: [],
        }),
      ),
    tapAtCoordinate: noop,
    doubleTapAtCoordinate: noop,
    longPressAtCoordinate: noop,
    swipe: noop,
    inputText: noop,
    pressKey: noop,
    hideKeyboard: noop,
    takeScreenshot: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    getDeviceInfo: () =>
      Effect.succeed({
        platform: "web" as const,
        deviceId: "test",
        name: "Test",
        isEmulator: false,
        screenWidth: 1280,
        screenHeight: 720,
        driverType: "playwright" as const,
      }),
    launchApp: noop,
    stopApp: noop,
    killApp: noop,
    clearAppState: noop,
    openLink: noop,
    back: noop,
    evaluate: () => Effect.succeed("evaluated" as any),
    mockNetwork: noop,
    blockNetwork: noop,
    clearNetworkMocks: noop,
    setNetworkConditions: noop,
    saveCookies: noop,
    loadCookies: noop,
    saveAuthState: noop,
    loadAuthState: noop,
    ...overrides,
  } as RawDriverService;
}

function parseHierarchy(raw: string) {
  return JSON.parse(raw);
}

describe("Session", () => {
  test("hierarchy returns parsed element tree", async () => {
    const session = new Session(mockDriver(), "web", parseHierarchy);
    const root = await session.hierarchy();
    expect(root.text).toBe("Click me");
    expect(root.id).toBe("btn");
  });

  test("tap calls tapAtCoordinate with element center", async () => {
    const tapFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ tapAtCoordinate: tapFn as any }),
      "web",
      parseHierarchy,
    );
    await session.tap({ testID: "btn" });
    expect(tapFn).toHaveBeenCalledWith(100, 70);
  });

  test("tap prefers clickable ancestor coordinates for nested label targets", async () => {
    const tapFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({
        dumpHierarchy: () =>
          Effect.succeed(
            JSON.stringify({
              id: "root",
              bounds: { x: 0, y: 0, width: 300, height: 200 },
              visible: true,
              enabled: true,
              children: [
                {
                  id: "card",
                  bounds: { x: 40, y: 30, width: 160, height: 100 },
                  visible: true,
                  enabled: true,
                  clickable: true,
                  children: [
                    {
                      text: "Nested label",
                      bounds: { x: 60, y: 60, width: 80, height: 20 },
                      visible: true,
                      enabled: true,
                      clickable: false,
                      children: [],
                    },
                  ],
                },
              ],
            }),
          ),
        tapAtCoordinate: tapFn as any,
      }),
      "web",
      parseHierarchy,
    );

    await session.tap({ text: "Nested label" });

    expect(tapFn).toHaveBeenCalledWith(120, 80);
  });

  test(
    "tap throws when element not found",
    async () => {
      const session = new Session(mockDriver(), "web", parseHierarchy);
      await expect(session.tap({ testID: "nonexistent" })).rejects.toThrow("Element not found");
    },
    { timeout: 10_000 },
  );

  test("tapXY calls tapAtCoordinate directly", async () => {
    const tapFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ tapAtCoordinate: tapFn as any }),
      "web",
      parseHierarchy,
    );
    await session.tapXY(10, 20);
    expect(tapFn).toHaveBeenCalledWith(10, 20);
  });

  test("doubleTap finds element and double taps center", async () => {
    const dtFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ doubleTapAtCoordinate: dtFn as any }),
      "web",
      parseHierarchy,
    );
    await session.doubleTap({ testID: "btn" });
    expect(dtFn).toHaveBeenCalledWith(100, 70);
  });

  test("longPress finds element and long presses with default duration", async () => {
    const lpFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ longPressAtCoordinate: lpFn as any }),
      "web",
      parseHierarchy,
    );
    await session.longPress({ testID: "btn" });
    expect(lpFn).toHaveBeenCalledWith(100, 70, 1000);
  });

  test("longPress supports custom duration", async () => {
    const lpFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ longPressAtCoordinate: lpFn as any }),
      "web",
      parseHierarchy,
    );
    await session.longPress({ testID: "btn" }, { duration: 2000 });
    expect(lpFn).toHaveBeenCalledWith(100, 70, 2000);
  });

  test("longPressXY calls driver directly", async () => {
    const lpFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ longPressAtCoordinate: lpFn as any }),
      "web",
      parseHierarchy,
    );
    await session.longPressXY(10, 20, { duration: 500 });
    expect(lpFn).toHaveBeenCalledWith(10, 20, 500);
  });

  test("inputText calls driver", async () => {
    const itFn = mock(() => Effect.void);
    const session = new Session(mockDriver({ inputText: itFn as any }), "web", parseHierarchy);
    await session.inputText("hello");
    expect(itFn).toHaveBeenCalledWith("hello");
  });

  test("pressKey calls driver", async () => {
    const pkFn = mock(() => Effect.void);
    const session = new Session(mockDriver({ pressKey: pkFn as any }), "web", parseHierarchy);
    await session.pressKey("Enter");
    expect(pkFn).toHaveBeenCalledWith("Enter");
  });

  test("dismissKeyboard supports the explicit back strategy", async () => {
    const backFn = mock(() => Effect.void);
    const session = new Session(mockDriver({ back: backFn as any }), "android", parseHierarchy);

    await session.dismissKeyboard({ strategy: "back" });

    expect(backFn).toHaveBeenCalled();
  });

  test("scrollUntilVisible swipes until the target appears", async () => {
    const swipeFn = mock(() => Effect.void);
    let dumpCount = 0;
    const session = new Session(
      mockDriver({
        dumpHierarchy: () =>
          Effect.succeed(
            JSON.stringify(
              dumpCount++ === 0
                ? {
                    id: "root",
                    bounds: { x: 0, y: 0, width: 300, height: 600 },
                    visible: true,
                    enabled: true,
                    children: [{ text: "Top", bounds: { x: 0, y: 0, width: 100, height: 40 } }],
                  }
                : {
                    id: "root",
                    bounds: { x: 0, y: 0, width: 300, height: 600 },
                    visible: true,
                    enabled: true,
                    children: [
                      { id: "target-card", bounds: { x: 0, y: 400, width: 100, height: 40 } },
                    ],
                  },
            ),
          ),
        swipe: swipeFn as any,
      }),
      "web",
      parseHierarchy,
    );

    await session.scrollUntilVisible({ testID: "target-card" });

    expect(swipeFn).toHaveBeenCalledTimes(1);
  });

  test("backUntilVisible uses system back until the target screen appears", async () => {
    const backFn = mock(() => Effect.void);
    let dumpCount = 0;
    const session = new Session(
      mockDriver({
        dumpHierarchy: () =>
          Effect.succeed(
            JSON.stringify(
              dumpCount++ === 0
                ? {
                    id: "root",
                    bounds: { x: 0, y: 0, width: 300, height: 200 },
                    visible: true,
                    enabled: true,
                    children: [{ text: "Modal", bounds: { x: 50, y: 50, width: 80, height: 30 } }],
                  }
                : {
                    id: "root",
                    bounds: { x: 0, y: 0, width: 300, height: 200 },
                    visible: true,
                    enabled: true,
                    children: [
                      { id: "home-title", bounds: { x: 50, y: 50, width: 80, height: 30 } },
                    ],
                  },
            ),
          ),
        back: backFn as any,
      }),
      "web",
      parseHierarchy,
    );

    await session.backUntilVisible({ testID: "home-title" }, { maxBacks: 2 });

    expect(backFn).toHaveBeenCalledTimes(1);
  });

  test("openLink calls driver", async () => {
    const olFn = mock(() => Effect.void);
    const session = new Session(mockDriver({ openLink: olFn as any }), "web", parseHierarchy);
    await session.openLink("https://example.com");
    expect(olFn).toHaveBeenCalledWith("https://example.com");
  });

  test("back calls driver", async () => {
    const backFn = mock(() => Effect.void);
    const session = new Session(mockDriver({ back: backFn as any }), "web", parseHierarchy);
    await session.back();
    expect(backFn).toHaveBeenCalled();
  });

  test("screenshot returns bytes", async () => {
    const session = new Session(mockDriver(), "web", parseHierarchy);
    const data = await session.screenshot();
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("evaluate calls driver.evaluate", async () => {
    const evFn = mock(() => Effect.succeed("result"));
    const session = new Session(mockDriver({ evaluate: evFn as any }), "web", parseHierarchy);
    await session.evaluate(() => "result");
    expect(evFn).toHaveBeenCalled();
  });

  test("browser helpers call through to the web driver", async () => {
    const saveCookies = mock(() => Effect.void);
    const loadAuthState = mock(() => Effect.void);
    const setNetworkConditions = mock(() => Effect.void);
    const session = new Session(
      mockDriver({
        saveCookies: saveCookies as any,
        loadAuthState: loadAuthState as any,
        setNetworkConditions: setNetworkConditions as any,
      }),
      "web",
      parseHierarchy,
    );

    await session.saveCookies("./cookies.json");
    await session.loadAuthState("./auth.json");
    await session.setNetworkConditions({ offline: true });

    expect(saveCookies).toHaveBeenCalledWith("./cookies.json");
    expect(loadAuthState).toHaveBeenCalledWith("./auth.json");
    expect(setNetworkConditions).toHaveBeenCalledWith({ offline: true });
  });

  test("evaluate throws on mobile", async () => {
    const session = new Session(
      mockDriver({
        evaluate: () =>
          Effect.fail(
            new DriverError({ message: "evaluate() is only supported on the web platform" }),
          ),
      }),
      "android",
      parseHierarchy,
    );
    await expect(session.evaluate(() => "nope")).rejects.toThrow(
      "evaluate() is only supported on the web platform",
    );
  });

  test("browser helpers throw on non-web sessions without driver support", async () => {
    const session = new Session(
      mockDriver({
        saveCookies: undefined,
      }),
      "android",
      parseHierarchy,
    );

    await expect(session.saveCookies("./cookies.json")).rejects.toThrow(
      "saveCookies() is only supported on the web platform",
    );
  });

  test("swipe computes coordinates from device info", async () => {
    const swipeFn = mock(() => Effect.void);
    const session = new Session(mockDriver({ swipe: swipeFn as any }), "web", parseHierarchy);
    await session.swipe("up");
    expect(swipeFn).toHaveBeenCalled();
    const args = swipeFn.mock.calls[0] as unknown as number[];
    // Start Y should be > End Y for swipe up
    expect(args[1]!).toBeGreaterThan(args[3]!);
  });

  test("launch calls launchApp", async () => {
    const laFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ launchApp: laFn as any }),
      "web",
      parseHierarchy,
      "com.test.app",
    );
    await session.launch();
    expect(laFn).toHaveBeenCalledWith("com.test.app", undefined);
  });

  test("launch with deepLink", async () => {
    const laFn = mock(() => Effect.void);
    const session = new Session(
      mockDriver({ launchApp: laFn as any }),
      "web",
      parseHierarchy,
      "com.test.app",
    );
    await session.launch({ deepLink: "myapp://home" });
    expect(laFn).toHaveBeenCalledWith("com.test.app", { deepLink: "myapp://home" });
  });

  test("platform is exposed", () => {
    const session = new Session(mockDriver(), "ios", parseHierarchy);
    expect(session.platform).toBe("ios");
  });
});
