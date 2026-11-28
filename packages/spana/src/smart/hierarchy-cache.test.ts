import { describe, expect, setSystemTime, test } from "bun:test";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Element } from "../schemas/element.js";
import { createHierarchyCache } from "./hierarchy-cache.js";

const deviceInfo: DeviceInfo = {
  platform: "web",
  deviceId: "playwright",
  name: "Chromium",
  isEmulator: false,
  screenWidth: 1280,
  screenHeight: 720,
  driverType: "playwright",
};

function createElement(overrides: Partial<Element> = {}): Element {
  return {
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    children: [],
    visible: true,
    clickable: true,
    ...overrides,
  };
}

function createDriver() {
  let dumpCount = 0;
  let currentHierarchy = createElement({ text: "initial" });

  const driver: RawDriverService = {
    dumpHierarchy: () => {
      dumpCount++;
      return Effect.succeed(JSON.stringify(currentHierarchy));
    },
    tapAtCoordinate: () => Effect.void,
    doubleTapAtCoordinate: () => Effect.void,
    longPressAtCoordinate: () => Effect.void,
    swipe: () => Effect.void,
    inputText: () => Effect.void,
    pressKey: () => Effect.void,
    hideKeyboard: () => Effect.void,
    takeScreenshot: () => Effect.succeed(new Uint8Array([1, 2, 3])),
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
    setHierarchy: (el: Element) => {
      currentHierarchy = el;
    },
  };
}

const parse = (raw: string): Element => JSON.parse(raw) as Element;

describe("hierarchy cache", () => {
  test("returns cached result within TTL", async () => {
    const cache = createHierarchyCache({ hierarchyCacheTtl: 1000 });
    const { driver, getDumpCount } = createDriver();

    const first = await Effect.runPromise(cache.get(driver, parse));
    const second = await Effect.runPromise(cache.get(driver, parse));

    expect(first.text).toBe("initial");
    expect(second.text).toBe("initial");
    expect(getDumpCount()).toBe(1); // Only one actual dump
  });

  test("fetches fresh hierarchy after TTL expires", async () => {
    const cache = createHierarchyCache({ hierarchyCacheTtl: 1 });
    const { driver, getDumpCount, setHierarchy } = createDriver();

    await Effect.runPromise(cache.get(driver, parse));
    expect(getDumpCount()).toBe(1);

    // Move the clock past the 1 ms TTL
    setSystemTime(new Date(Date.now() + 5));
    setHierarchy(createElement({ text: "updated" }));

    const result = await Effect.runPromise(cache.get(driver, parse)).finally(() => setSystemTime());
    expect(result.text).toBe("updated");
    expect(getDumpCount()).toBe(2);
  });

  test("invalidate forces fresh fetch on next get", async () => {
    const cache = createHierarchyCache({ hierarchyCacheTtl: 10_000 });
    const { driver, getDumpCount, setHierarchy } = createDriver();

    await Effect.runPromise(cache.get(driver, parse));
    expect(getDumpCount()).toBe(1);

    setHierarchy(createElement({ text: "after-mutation" }));
    cache.invalidate();

    const result = await Effect.runPromise(cache.get(driver, parse));
    expect(result.text).toBe("after-mutation");
    expect(getDumpCount()).toBe(2);
  });

  test("disabling cache (ttl=0) always fetches fresh", async () => {
    const cache = createHierarchyCache({ hierarchyCacheTtl: 0 });
    const { driver, getDumpCount } = createDriver();

    await Effect.runPromise(cache.get(driver, parse));
    await Effect.runPromise(cache.get(driver, parse));
    await Effect.runPromise(cache.get(driver, parse));

    expect(getDumpCount()).toBe(3);
  });

  test("default TTL (100ms) is used when not configured", async () => {
    const cache = createHierarchyCache();
    const { driver, getDumpCount } = createDriver();

    await Effect.runPromise(cache.get(driver, parse));
    await Effect.runPromise(cache.get(driver, parse));

    // Second call should be cached (within 100ms)
    expect(getDumpCount()).toBe(1);
  });
});
