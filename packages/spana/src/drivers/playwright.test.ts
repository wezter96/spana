import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { DriverError } from "../errors.js";

const playwrightState = {
  events: [] as Array<[string, ...unknown[]]>,
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
};

function resetPlaywrightState() {
  playwrightState.events = [];
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
}

mock.module("playwright-core", () => ({
  chromium: {
    async launch(options: { headless?: boolean }) {
      if (playwrightState.launchError) throw playwrightState.launchError;
      playwrightState.events.push(["launch", options]);

      return {
        async newPage() {
          if (playwrightState.newPageError) throw playwrightState.newPageError;
          playwrightState.events.push(["newPage"]);

          return {
            async evaluate(script: string) {
              playwrightState.events.push(["evaluate", script]);
              if (script.includes("return walk(document.body)")) {
                return playwrightState.dumpHierarchyTree;
              }
              if (
                script.includes("No clickable element found at tap point") &&
                playwrightState.tapError
              ) {
                throw playwrightState.tapError;
              }
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
              playwrightState.events.push(["goto", url]);
            },
            async close() {
              playwrightState.events.push(["close"]);
            },
            context() {
              return {
                async clearCookies() {
                  playwrightState.events.push(["clearCookies"]);
                },
              };
            },
            async goBack() {
              playwrightState.events.push(["goBack"]);
            },
          };
        },
      };
    },
  },
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
    expect(playwrightState.events).toContainEqual(["launch", { headless: false }]);
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
          script.includes("localStorage.clear(); sessionStorage.clear();"),
      ),
    ).toBe(true);
    expect(playwrightState.events).toContainEqual(["goBack"]);
    expect(playwrightState.events).toContainEqual(["close"]);
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
