import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DriverError } from "../errors.js";

const tempDirs: string[] = [];

const playwrightState = {
  events: [] as Array<[string, ...unknown[]]>,
  routes: [] as Array<{ matcher: unknown; handler: unknown }>,
  launchError: undefined as Error | undefined,
  newPageError: undefined as Error | undefined,
  pressError: undefined as Error | undefined,
  tapError: undefined as Error | undefined,
  dumpHierarchyTree: {
    tag: "body",
    id: "root",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    visible: true,
    clickable: false,
    children: [],
  },
  screenshot: new Uint8Array([7, 8, 9]),
  viewport: { width: 111, height: 222 },
  currentUrl: "about:blank",
  cookies: [{ name: "session", value: "abc", domain: "example.com", path: "/" }],
  lastAddedCookies: undefined as unknown,
  storageState: {
    cookies: [{ name: "session", value: "abc", domain: "example.com", path: "/" }],
    origins: [],
  },
};

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-playwright-"));
  tempDirs.push(dir);
  return dir;
}

function resetPlaywrightState() {
  playwrightState.events = [];
  playwrightState.routes = [];
  playwrightState.launchError = undefined;
  playwrightState.newPageError = undefined;
  playwrightState.pressError = undefined;
  playwrightState.tapError = undefined;
  playwrightState.dumpHierarchyTree = {
    tag: "body",
    id: "root",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    visible: true,
    clickable: false,
    children: [],
  };
  playwrightState.screenshot = new Uint8Array([7, 8, 9]);
  playwrightState.viewport = { width: 111, height: 222 };
  playwrightState.currentUrl = "about:blank";
  playwrightState.cookies = [{ name: "session", value: "abc", domain: "example.com", path: "/" }];
  playwrightState.lastAddedCookies = undefined;
  playwrightState.storageState = {
    cookies: [{ name: "session", value: "abc", domain: "example.com", path: "/" }],
    origins: [],
  };
}

function makePage(browserName: string, context: Record<string, unknown>) {
  return {
    async evaluate(script: string | ((...args: unknown[]) => unknown), ...args: unknown[]) {
      playwrightState.events.push(["evaluate", script, ...args]);
      if (typeof script === "string" && script.includes("return walk(document.body)")) {
        return playwrightState.dumpHierarchyTree;
      }
      if (
        typeof script === "string" &&
        script.includes("No clickable element found at tap point") &&
        playwrightState.tapError
      ) {
        throw playwrightState.tapError;
      }
      if (typeof script === "function") {
        return script(...args);
      }
      return undefined;
    },
    mouse: {
      async dblclick(x: number, y: number) {
        playwrightState.events.push(["dblclick", x, y]);
      },
      async move(x: number, y: number) {
        playwrightState.events.push(["mouseMove", x, y]);
      },
      async down() {
        playwrightState.events.push(["mouseDown"]);
      },
      async up() {
        playwrightState.events.push(["mouseUp"]);
      },
    },
    keyboard: {
      async type(text: string) {
        playwrightState.events.push(["keyboardType", text]);
      },
      async press(key: string) {
        if (playwrightState.pressError) throw playwrightState.pressError;
        playwrightState.events.push(["keyboardPress", key]);
      },
    },
    async screenshot() {
      playwrightState.events.push(["screenshot"]);
      return Buffer.from(playwrightState.screenshot);
    },
    viewportSize() {
      return playwrightState.viewport;
    },
    async goto(url: string) {
      playwrightState.currentUrl = url;
      playwrightState.events.push(["goto", url]);
    },
    async close() {
      playwrightState.events.push(["pageClose", browserName]);
    },
    context() {
      return context;
    },
    async goBack() {
      playwrightState.events.push(["goBack"]);
    },
    url() {
      return playwrightState.currentUrl;
    },
  };
}

function makeContext(browserName: string) {
  const context = {
    async newPage() {
      if (playwrightState.newPageError) throw playwrightState.newPageError;
      playwrightState.events.push(["newPage", browserName]);
      return makePage(browserName, context);
    },
    async clearCookies() {
      playwrightState.events.push(["clearCookies"]);
    },
    async addCookies(cookies: unknown) {
      playwrightState.lastAddedCookies = cookies;
      playwrightState.events.push(["addCookies", cookies]);
    },
    async cookies() {
      playwrightState.events.push(["cookies"]);
      return playwrightState.cookies;
    },
    async storageState(options?: { path?: string }) {
      playwrightState.events.push(["storageState", options]);
      if (options?.path) {
        await writeFile(options.path, JSON.stringify(playwrightState.storageState), "utf8");
      }
      return playwrightState.storageState;
    },
    async route(matcher: unknown, handler: unknown) {
      playwrightState.routes.push({ matcher, handler });
      playwrightState.events.push(["route", matcher]);
    },
    async unroute(matcher: unknown, handler: unknown) {
      playwrightState.routes = playwrightState.routes.filter(
        (route) => route.matcher !== matcher || route.handler !== handler,
      );
      playwrightState.events.push(["unroute", matcher]);
    },
    async setOffline(offline: boolean) {
      playwrightState.events.push(["setOffline", offline]);
    },
    async newCDPSession(_page: unknown) {
      playwrightState.events.push(["newCDPSession", browserName]);
      return {
        async send(method: string, params?: unknown) {
          playwrightState.events.push(["cdpSend", method, params]);
        },
      };
    },
    async close() {
      playwrightState.events.push(["contextClose", browserName]);
    },
  };

  return context;
}

function makeBrowserType(browserName: "chromium" | "firefox" | "webkit") {
  return {
    async launch(options: { headless?: boolean }) {
      if (playwrightState.launchError) throw playwrightState.launchError;
      playwrightState.events.push(["launch", browserName, options]);

      return {
        async newContext(options?: { storageState?: string }) {
          playwrightState.events.push(["newContext", browserName, options]);
          return makeContext(browserName);
        },
        async close() {
          playwrightState.events.push(["browserClose", browserName]);
        },
      };
    },
  };
}

mock.module("playwright-core", () => ({
  chromium: makeBrowserType("chromium"),
  firefox: makeBrowserType("firefox"),
  webkit: makeBrowserType("webkit"),
}));

let importCounter = 0;

async function importFreshDriver() {
  importCounter += 1;
  return import(new URL(`./playwright.ts?case=${importCounter}`, import.meta.url).href) as Promise<
    typeof import("./playwright.js")
  >;
}

beforeEach(() => {
  resetPlaywrightState();
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Playwright driver adapter", () => {
  test("creates a driver and routes web lifecycle/navigation calls through Playwright", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        headless: false,
        baseUrl: "https://base.test",
      }),
    );

    const hierarchy = await Effect.runPromise(driver.dumpHierarchy());
    await Effect.runPromise(driver.tapAtCoordinate(5, 7));
    await Effect.runPromise(driver.launchApp(""));
    await Effect.runPromise(
      driver.launchApp("https://ignored.test", { deepLink: "https://deep.test" }),
    );
    await Effect.runPromise(driver.clearAppState("ignored"));
    await Effect.runPromise(driver.openLink("https://open.test"));
    await Effect.runPromise(driver.back());
    await Effect.runPromise(driver.stopApp("ignored"));
    await Effect.runPromise(driver.killApp("ignored"));
    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(JSON.parse(hierarchy)).toMatchObject({ tag: "body", id: "root" });
    expect(playwrightState.events).toContainEqual(["launch", "chromium", { headless: false }]);
    expect(playwrightState.events).toContainEqual(["goto", "https://base.test"]);
    expect(playwrightState.events).toContainEqual(["goto", "https://deep.test"]);
    expect(playwrightState.events).toContainEqual(["goto", "https://open.test"]);
    expect(playwrightState.events).toContainEqual(["goto", "about:blank"]);
    expect(playwrightState.events).toContainEqual(["clearCookies"]);
    expect(
      playwrightState.events.some(
        ([type, script]) =>
          type === "evaluate" &&
          typeof script === "string" &&
          script.includes("localStorage.clear()") &&
          script.includes("sessionStorage.clear()"),
      ),
    ).toBe(true);
    expect(playwrightState.events).toContainEqual(["goBack"]);
    expect(playwrightState.events).toContainEqual(["pageClose", "chromium"]);
    expect(playwrightState.events).toContainEqual(["contextClose", "chromium"]);
    expect(playwrightState.events).toContainEqual(["browserClose", "chromium"]);
    expect(info).toEqual({
      platform: "web",
      deviceId: "playwright-chromium",
      name: "Chromium",
      isEmulator: false,
      screenWidth: 111,
      screenHeight: 222,
      driverType: "playwright",
    });
  });

  test("supports browser selection and initial storage state", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: "firefox",
        storageState: "/tmp/auth.json",
      }),
    );

    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(playwrightState.events).toContainEqual(["launch", "firefox", { headless: true }]);
    expect(playwrightState.events).toContainEqual([
      "newContext",
      "firefox",
      { storageState: "/tmp/auth.json" },
    ]);
    expect(info.deviceId).toBe("playwright-firefox");
    expect(info.name).toBe("Firefox");
  });

  test("supports network helpers and auth state management", async () => {
    const tempDir = createTempDir();
    const cookieInputPath = join(tempDir, "input-cookies.json");
    const cookieOutputPath = join(tempDir, "output-cookies.json");
    const authStatePath = join(tempDir, "auth-state.json");
    const cookies = [{ name: "pref", value: "dark", domain: "example.com", path: "/" }];
    writeFileSync(cookieInputPath, JSON.stringify(cookies), "utf8");

    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(makePlaywrightDriver({}));

    await Effect.runPromise(driver.launchApp("https://app.test"));
    await Effect.runPromise(driver.mockNetwork!(/\/api\/user$/, { json: { ok: true } }));
    await Effect.runPromise(driver.blockNetwork!("**/ads"));
    await Effect.runPromise(driver.saveCookies!(cookieOutputPath));
    await Effect.runPromise(driver.loadCookies!(cookieInputPath));
    await Effect.runPromise(driver.saveAuthState!(authStatePath));
    await Effect.runPromise(driver.loadAuthState!(authStatePath));
    await Effect.runPromise(driver.clearNetworkMocks!());

    expect(
      playwrightState.events.some(
        ([type, matcher]) => type === "route" && matcher instanceof RegExp,
      ),
    ).toBe(true);
    expect(playwrightState.events).toContainEqual(["route", "**/ads"]);
    expect(
      playwrightState.events.some(
        ([type, matcher]) => type === "unroute" && matcher instanceof RegExp,
      ),
    ).toBe(true);
    expect(playwrightState.events).toContainEqual(["unroute", "**/ads"]);
    expect(JSON.parse(readFileSync(cookieOutputPath, "utf8"))).toEqual(playwrightState.cookies);
    expect(playwrightState.lastAddedCookies).toEqual(cookies);
    expect(JSON.parse(readFileSync(authStatePath, "utf8"))).toEqual(playwrightState.storageState);
    expect(playwrightState.events).toContainEqual([
      "newContext",
      "chromium",
      { storageState: authStatePath },
    ]);
    expect(playwrightState.events).toContainEqual(["goto", "https://app.test"]);
    expect(playwrightState.events).toContainEqual(["pageClose", "chromium"]);
    expect(playwrightState.events).toContainEqual(["contextClose", "chromium"]);
  });

  test("uses CDP for chromium network throttling and rejects non-chromium throttling", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(makePlaywrightDriver({ browser: "chromium" }));

    await Effect.runPromise(
      driver.setNetworkConditions!({
        offline: true,
        latencyMs: 120,
        downloadThroughputKbps: 800,
        uploadThroughputKbps: 400,
      }),
    );

    expect(playwrightState.events).toContainEqual(["setOffline", true]);
    expect(playwrightState.events).toContainEqual(["newCDPSession", "chromium"]);
    expect(playwrightState.events).toContainEqual(["cdpSend", "Network.enable", undefined]);
    expect(playwrightState.events).toContainEqual([
      "cdpSend",
      "Network.emulateNetworkConditions",
      {
        offline: true,
        latency: 120,
        downloadThroughput: 102400,
        uploadThroughput: 51200,
      },
    ]);

    resetPlaywrightState();

    const firefoxDriver = await Effect.runPromise(makePlaywrightDriver({ browser: "firefox" }));
    const result = await Effect.runPromise(
      Effect.either(firefoxDriver.setNetworkConditions!({ latencyMs: 10 })),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("only supported with the chromium browser");
    }
  });

  test("wraps browser launch failures in DriverError", async () => {
    playwrightState.launchError = new Error("browser exploded");

    const { makePlaywrightDriver } = await importFreshDriver();
    const result = await Effect.runPromise(Effect.either(makePlaywrightDriver({})));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Failed to launch browser: Error: browser exploded");
    }
  });

  test("wraps page creation failures in DriverError", async () => {
    playwrightState.newPageError = new Error("page exploded");

    const { makePlaywrightDriver } = await importFreshDriver();
    const result = await Effect.runPromise(Effect.either(makePlaywrightDriver({})));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Failed to create page: Error: page exploded");
    }
  });

  test("wraps page interaction failures in DriverError", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(makePlaywrightDriver({}));
    playwrightState.pressError = new Error("press exploded");

    const result = await Effect.runPromise(Effect.either(driver.pressKey("Enter")));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Failed to press key Enter: Error: press exploded");
    }
  });
});
