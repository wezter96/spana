import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Element } from "../schemas/element.js";
import { ElementNotFoundError, WaitTimeoutError } from "../errors.js";
import { waitForElement, waitForNotVisible } from "./auto-wait.js";
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

function createDriver(hierarchies: Element[]) {
  let dumpCount = 0;

  const driver: RawDriverService = {
    dumpHierarchy: () => {
      const index = Math.min(dumpCount, hierarchies.length - 1);
      dumpCount += 1;
      return Effect.succeed(JSON.stringify(hierarchies[index]));
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
  };
}

const parse = (raw: string): Element => JSON.parse(raw) as Element;

function unwrapFailure<E>(result: { _tag: "Failure"; failure: E } | { _tag: "Success" }): E {
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") {
    throw new Error("Expected Effect failure");
  }
  return result.failure;
}

describe("auto wait", () => {
  test("waitForElement polls until a matching element appears", async () => {
    const root = createElement();
    const target = createElement({ text: "Ready" });
    const { driver, getDumpCount } = createDriver([root, createElement({ children: [target] })]);

    const element = await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, {
        timeout: 50,
        pollInterval: 0,
      }),
    );

    expect(element.text).toBe("Ready");
    expect(getDumpCount()).toBe(2);
  });

  test("waitForElement fails with ElementNotFoundError after the timeout", async () => {
    const { driver } = createDriver([createElement()]);

    const result = await Effect.runPromise(
      Effect.result(
        waitForElement(driver, { text: "Missing" }, parse, {
          timeout: 5,
          pollInterval: 0,
        }),
      ),
    );

    const failure = unwrapFailure(result);
    expect(failure).toBeInstanceOf(ElementNotFoundError);
    expect(failure).toMatchObject({
      selector: { text: "Missing" },
      timeoutMs: 5,
    });
  });

  test("waitForNotVisible resolves once the matching element disappears", async () => {
    const target = createElement({ text: "Ready" });
    const { driver, getDumpCount } = createDriver([
      createElement({ children: [target] }),
      createElement(),
    ]);

    await Effect.runPromise(
      waitForNotVisible(driver, { text: "Ready" }, parse, {
        timeout: 50,
        pollInterval: 0,
      }),
    );

    expect(getDumpCount()).toBe(2);
  });

  test("waitForElement resolves with a relative selector", async () => {
    const header = createElement({
      text: "Header",
      bounds: { x: 0, y: 0, width: 100, height: 50 },
    });
    const btn = createElement({
      text: "Submit",
      bounds: { x: 0, y: 60, width: 100, height: 40 },
      clickable: true,
    });
    const root = createElement({ children: [header, btn] });
    const { driver } = createDriver([root]);

    const element = await Effect.runPromise(
      waitForElement(driver, { selector: { text: "Submit" }, below: { text: "Header" } }, parse, {
        timeout: 50,
        pollInterval: 0,
      }),
    );

    expect(element.text).toBe("Submit");
  });

  test("waitForNotVisible fails with WaitTimeoutError when the element stays visible", async () => {
    const target = createElement({ text: "Ready" });
    const { driver } = createDriver([createElement({ children: [target] })]);

    const result = await Effect.runPromise(
      Effect.result(
        waitForNotVisible(driver, { text: "Ready" }, parse, {
          timeout: 5,
          pollInterval: 0,
        }),
      ),
    );

    const failure = unwrapFailure(result);
    expect(failure).toBeInstanceOf(WaitTimeoutError);
    expect(failure).toMatchObject({
      selector: { text: "Ready" },
      timeoutMs: 5,
    });
  });
});

describe("error messages", () => {
  test("ElementNotFoundError includes selector in message", () => {
    const err = new ElementNotFoundError({
      message: 'Element not found within 5000ms — selector: {"testID":"login-btn"}',
      selector: { testID: "login-btn" },
      timeoutMs: 5000,
    });
    expect(err.message).toContain("testID");
    expect(err.message).toContain("login-btn");
    expect(err.message).toContain("5000");
  });

  test("WaitTimeoutError includes selector in message", () => {
    const err = new WaitTimeoutError({
      message: 'Element still visible after 3000ms — selector: {"text":"Loading"}',
      selector: { text: "Loading" },
      timeoutMs: 3000,
    });
    expect(err.message).toContain("text");
    expect(err.message).toContain("Loading");
    expect(err.message).toContain("3000");
  });

  test("waitForElement error message includes selector JSON", async () => {
    const { driver } = createDriver([createElement()]);

    const result = await Effect.runPromise(
      Effect.result(
        waitForElement(driver, { testID: "login-btn" }, parse, {
          timeout: 5,
          pollInterval: 0,
        }),
      ),
    );

    const failure = unwrapFailure(result);
    expect(failure.message).toContain("testID");
    expect(failure.message).toContain("login-btn");
  });

  test("waitForNotVisible error message includes selector JSON", async () => {
    const target = createElement({ text: "Loading" });
    const { driver } = createDriver([createElement({ children: [target] })]);

    const result = await Effect.runPromise(
      Effect.result(
        waitForNotVisible(driver, { text: "Loading" }, parse, {
          timeout: 5,
          pollInterval: 0,
        }),
      ),
    );

    const failure = unwrapFailure(result);
    expect(failure.message).toContain("text");
    expect(failure.message).toContain("Loading");
  });
});

describe("settle timeout", () => {
  test("settleTimeout re-checks element stability before returning", async () => {
    const target = createElement({ text: "Ready" });
    const rootWithTarget = createElement({ children: [target] });
    // Element present on first check, also present after settle re-check
    const { driver, getDumpCount } = createDriver([rootWithTarget, rootWithTarget]);

    const element = await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, {
        timeout: 500,
        pollInterval: 0,
        settleTimeout: 1,
      }),
    );

    expect(element.text).toBe("Ready");
    // Should have dumped at least twice: first find + settle re-check
    expect(getDumpCount()).toBeGreaterThanOrEqual(2);
  });

  test("settleTimeout retries when element disappears during settle", async () => {
    const target = createElement({ text: "Ready" });
    const rootWithTarget = createElement({ children: [target] });
    const rootEmpty = createElement();
    // 1st: found, 2nd (settle): gone, 3rd: found again, 4th (settle): still there
    const { driver } = createDriver([rootWithTarget, rootEmpty, rootWithTarget, rootWithTarget]);

    const element = await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, {
        timeout: 500,
        pollInterval: 0,
        settleTimeout: 1,
      }),
    );

    expect(element.text).toBe("Ready");
  });

  test("settleTimeout=0 (default) returns immediately on first match", async () => {
    const target = createElement({ text: "Ready" });
    const { driver, getDumpCount } = createDriver([createElement({ children: [target] })]);

    await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, {
        timeout: 50,
        pollInterval: 0,
        settleTimeout: 0,
      }),
    );

    expect(getDumpCount()).toBe(1);
  });
});

describe("adaptive polling", () => {
  test("uses initialPollInterval for first polls", async () => {
    const rootEmpty = createElement();
    const target = createElement({ text: "Found" });
    const rootWithTarget = createElement({ children: [target] });
    // First two misses must use initialPollInterval=10 (not pollInterval=500) so the element is found before the 300ms timeout
    const { driver, getDumpCount } = createDriver([rootEmpty, rootEmpty, rootWithTarget]);

    const element = await Effect.runPromise(
      waitForElement(driver, { text: "Found" }, parse, {
        timeout: 300,
        pollInterval: 500,
        initialPollInterval: 10,
      }),
    );

    expect(element.text).toBe("Found");
    expect(getDumpCount()).toBe(3);
  });

  test("falls back to pollInterval when initialPollInterval equals pollInterval", async () => {
    const rootEmpty = createElement();
    const target = createElement({ text: "Found" });
    const rootWithTarget = createElement({ children: [target] });
    const { driver, getDumpCount } = createDriver([rootEmpty, rootWithTarget]);

    const element = await Effect.runPromise(
      waitForElement(driver, { text: "Found" }, parse, {
        timeout: 2000,
        pollInterval: 5,
        initialPollInterval: 5,
      }),
    );

    expect(element.text).toBe("Found");
    expect(getDumpCount()).toBe(2);
  });
});

describe("hierarchy cache integration", () => {
  test("waitForElement uses cache to reduce hierarchy dumps", async () => {
    const target = createElement({ text: "Ready" });
    const root = createElement({ children: [target] });
    const { driver, getDumpCount } = createDriver([root]);
    const cache = createHierarchyCache({ hierarchyCacheTtl: 10_000 });

    // First call populates cache
    await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, { timeout: 50, pollInterval: 0 }, cache),
    );
    expect(getDumpCount()).toBe(1);

    // Second call with same cache should not dump again
    await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, { timeout: 50, pollInterval: 0 }, cache),
    );
    expect(getDumpCount()).toBe(1);
  });

  test("waitForElement fetches fresh hierarchy after cache invalidation", async () => {
    const root = createElement({ children: [createElement({ text: "Ready" })] });
    const { driver, getDumpCount } = createDriver([root]);
    const cache = createHierarchyCache({ hierarchyCacheTtl: 10_000 });

    await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, { timeout: 50, pollInterval: 0 }, cache),
    );
    expect(getDumpCount()).toBe(1);

    cache.invalidate();

    await Effect.runPromise(
      waitForElement(driver, { text: "Ready" }, parse, { timeout: 50, pollInterval: 0 }, cache),
    );
    expect(getDumpCount()).toBe(2);
  });

  test("waitForNotVisible uses cache", async () => {
    const rootEmpty = createElement();
    const { driver, getDumpCount } = createDriver([rootEmpty]);
    const cache = createHierarchyCache({ hierarchyCacheTtl: 10_000 });

    // Pre-populate cache with empty root
    await Effect.runPromise(cache.get(driver, parse));
    expect(getDumpCount()).toBe(1);

    await Effect.runPromise(
      waitForNotVisible(
        driver,
        { text: "Missing" },
        parse,
        { timeout: 50, pollInterval: 0 },
        cache,
      ),
    );
    // Should use cached result, no additional dump
    expect(getDumpCount()).toBe(1);
  });

  test("uses MutationObserver reactive domChannel.waitForSelector without sleeping on poll backoff", async () => {
    let mounted = false;
    let waitForSelectorCalls = 0;
    const match = {
      id: "async-cta",
      tag: "button",
      text: "Ready",
      rect: { x: 10, y: 20, width: 100, height: 40 },
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      viewportWidth: 1280,
      viewportHeight: 720,
      visible: true,
      enabled: true,
      clickable: true,
    };

    const { driver, getDumpCount } = createDriver([createElement()]);
    const driverWithDom = {
      ...driver,
      domChannel: {
        kind: "playwright" as const,
        isConnected: () => true,
        connect: async () => {},
        disconnect: async () => {},
        evaluate: async () => undefined as any,
        query: async () => (mounted ? [match] : []),
        waitForSelector: async () => {
          waitForSelectorCalls += 1;
          await new Promise((r) => setTimeout(r, 15));
          mounted = true;
          return [match];
        },
        tapDom: async () => true,
      },
    };

    // timeout=250 < pollInterval=500: only succeeds if reactive waitForSelector wakes without sleeping on pollInterval
    const el = await Effect.runPromise(
      waitForElement(driverWithDom, { testID: "async-cta" }, parse, {
        timeout: 250,
        pollInterval: 500,
        initialPollInterval: 500,
        platform: "web",
      }),
    );
    expect(el.id).toBe("async-cta");
    expect(waitForSelectorCalls).toBe(1);
    expect(getDumpCount()).toBe(0);
  });

  test("failFastWhenIdle on web fails early after one empty reactive probe instead of retrying until timeout", async () => {
    let waitForSelectorCalls = 0;
    const { driver, getDumpCount } = createDriver([createElement()]);
    const driverWithDom = {
      ...driver,
      domChannel: {
        kind: "playwright" as const,
        isConnected: () => true,
        connect: async () => {},
        disconnect: async () => {},
        evaluate: async () => undefined as any,
        query: async () => [],
        waitForSelector: async () => {
          waitForSelectorCalls += 1;
          return [];
        },
        tapDom: async () => false,
      },
    };

    const result = await Effect.runPromise(
      Effect.result(
        waitForElement(driverWithDom, { testID: "missing-btn" }, parse, {
          timeout: 3000,
          pollInterval: 200,
          platform: "web",
          failFastWhenIdle: true,
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    // One reactive probe plus a single hierarchy snapshot, not a poll loop until the 3s timeout.
    expect(waitForSelectorCalls).toBe(1);
    expect(getDumpCount()).toBe(1);
  });
});
