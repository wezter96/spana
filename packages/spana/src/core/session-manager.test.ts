import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Element } from "../schemas/element.js";
import { SessionManager, createSessions } from "./session-manager.js";

const makeSession = (name: string) => ({
  name,
  platform: "web" as const,
  app: {} as any,
  expect: {} as any,
  disconnect: async () => {},
});

describe("SessionManager", () => {
  test("starts with no sessions", () => {
    const manager = new SessionManager();
    expect(manager.all()).toEqual([]);
  });

  test("register adds sessions and all() returns them", () => {
    const manager = new SessionManager();
    const fakeSession = {
      name: "admin",
      platform: "web" as const,
      app: {} as any,
      expect: {} as any,
      disconnect: async () => {},
    };
    manager.register(fakeSession, async () => {});
    expect(manager.all()).toEqual([fakeSession]);
  });

  test("disconnectAll calls cleanup for each session in reverse order", async () => {
    const manager = new SessionManager();
    const order: string[] = [];
    manager.register(makeSession("first"), async () => {
      order.push("first");
    });
    manager.register(makeSession("second"), async () => {
      order.push("second");
    });

    await manager.disconnectAll();
    expect(order).toEqual(["second", "first"]);
    expect(manager.all()).toEqual([]);
  });

  test("disconnectAll continues through errors and warns", async () => {
    const manager = new SessionManager();
    const order: string[] = [];
    manager.register(makeSession("ok"), async () => {
      order.push("ok");
    });
    manager.register(makeSession("failing"), async () => {
      throw new Error("boom");
    });

    // Should not throw
    await manager.disconnectAll();
    // "failing" is second, so cleaned up first (reverse), then "ok"
    expect(order).toEqual(["ok"]);
    expect(manager.all()).toEqual([]);
  });
});

function createMockDriver(): { driver: RawDriverService; events: Array<[string, ...unknown[]]> } {
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
  const hierarchy: Element = {
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    children: [],
    visible: true,
    clickable: false,
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
    longPressAtCoordinate: (x, y, d) => {
      events.push(["longPressAtCoordinate", x, y, d]);
      return Effect.void;
    },
    swipe: (sx, sy, ex, ey, d) => {
      events.push(["swipe", sx, sy, ex, ey, d]);
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
    launchApp: (appId) => {
      events.push(["launchApp", appId]);
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
  };
  return { driver, events };
}

const parse = (raw: string): Element => JSON.parse(raw) as Element;

describe("createSessions", () => {
  test("open() creates a SecondarySession with app and expect", async () => {
    const { driver } = createMockDriver();
    const manager = new SessionManager();
    const sessions = createSessions(manager, () => Promise.resolve(driver), { parse });

    const session = await sessions.open({
      name: "admin",
      platform: "web",
      baseUrl: "http://localhost:4000",
    });

    expect(session.name).toBe("admin");
    expect(session.platform).toBe("web");
    expect(typeof session.app.tap).toBe("function");
    expect(typeof session.expect).toBe("function");
    expect(typeof session.disconnect).toBe("function");
    expect(manager.all().length).toBe(1);
  });

  test("open() rejects duplicate session names", async () => {
    const { driver } = createMockDriver();
    const manager = new SessionManager();
    const sessions = createSessions(manager, () => Promise.resolve(driver), { parse });

    await sessions.open({ name: "admin", platform: "web" });
    await expect(sessions.open({ name: "admin", platform: "web" })).rejects.toThrow(
      /already exists/,
    );
  });

  test("disconnect() removes session from manager", async () => {
    const { driver } = createMockDriver();
    const manager = new SessionManager();
    const sessions = createSessions(manager, () => Promise.resolve(driver), { parse });

    const session = await sessions.open({ name: "admin", platform: "web" });
    expect(manager.all().length).toBe(1);
    await session.disconnect();
    expect(manager.all().length).toBe(0);
  });
});
