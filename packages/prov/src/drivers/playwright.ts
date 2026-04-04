import { Effect, Layer } from "effect";
import { chromium } from "playwright-core";
import { DriverError } from "../errors.js";
import { RawDriver, type RawDriverService, type RawHierarchy, type LaunchOptions } from "./raw-driver.js";

interface PlaywrightConfig {
  headless?: boolean;
  baseUrl?: string;
}

function makePlaywrightDriver(config: PlaywrightConfig): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const browser = yield* Effect.tryPromise({
      try: () => chromium.launch({ headless: config.headless ?? true }),
      catch: (e) => new DriverError({ message: `Failed to launch browser: ${e}` }),
    });

    const page = yield* Effect.tryPromise({
      try: () => browser.newPage(),
      catch: (e) => new DriverError({ message: `Failed to create page: ${e}` }),
    });

    const service: RawDriverService = {
      dumpHierarchy: () =>
        Effect.tryPromise({
          try: async (): Promise<RawHierarchy> => {
            // page.evaluate runs in the browser context — DOM types exist there, not in our TS
            const tree = await page.evaluate(`
              (function() {
                function walk(el) {
                  var rect = el.getBoundingClientRect();
                  var style = window.getComputedStyle(el);
                  var isVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
                  return {
                    tag: el.tagName.toLowerCase(),
                    id: el.getAttribute("data-testid") || el.getAttribute("testID") || undefined,
                    text: el.childNodes.length === 1 && el.childNodes[0] && el.childNodes[0].nodeType === 3
                      ? (el.childNodes[0].textContent || "").trim() || undefined
                      : undefined,
                    accessibilityLabel: el.getAttribute("aria-label") || undefined,
                    role: el.getAttribute("role") || undefined,
                    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    enabled: !el.hasAttribute("disabled"),
                    visible: isVisible && rect.width > 0 && rect.height > 0,
                    clickable: el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button" || el.onclick !== null,
                    children: Array.from(el.children).map(walk),
                  };
                }
                return walk(document.body);
              })()
            `);
            return JSON.stringify(tree);
          },
          catch: (e) => new DriverError({ message: `Failed to dump hierarchy: ${e}` }),
        }),

      tapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => page.mouse.click(x, y),
          catch: (e) => new DriverError({ message: `Failed to tap at (${x}, ${y}): ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => page.mouse.dblclick(x, y),
          catch: (e) => new DriverError({ message: `Failed to double tap at (${x}, ${y}): ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await new Promise<void>((r) => setTimeout(r, duration));
            await page.mouse.up();
          },
          catch: (e) => new DriverError({ message: `Failed to long press at (${x}, ${y}): ${e}` }),
        }),

      swipe: (startX, startY, endX, endY, duration) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            const steps = Math.max(Math.round(duration / 16), 5);
            for (let i = 1; i <= steps; i++) {
              const t = i / steps;
              await page.mouse.move(
                startX + (endX - startX) * t,
                startY + (endY - startY) * t,
              );
            }
            await page.mouse.up();
          },
          catch: (e) => new DriverError({ message: `Failed to swipe: ${e}` }),
        }),

      inputText: (text) =>
        Effect.tryPromise({
          try: () => page.keyboard.type(text),
          catch: (e) => new DriverError({ message: `Failed to input text: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          try: () => page.keyboard.press(key),
          catch: (e) => new DriverError({ message: `Failed to press key ${key}: ${e}` }),
        }),

      hideKeyboard: () => Effect.void,

      takeScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            const buffer = await page.screenshot();
            return new Uint8Array(buffer);
          },
          catch: (e) => new DriverError({ message: `Failed to take screenshot: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.tryPromise({
          try: async () => {
            const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
            return {
              platform: "web" as const,
              deviceId: "playwright-chromium",
              name: "Chromium",
              isEmulator: false,
              screenWidth: viewport.width,
              screenHeight: viewport.height,
              driverType: "playwright" as const,
            };
          },
          catch: (e) => new DriverError({ message: `Failed to get device info: ${e}` }),
        }),

      launchApp: (url, _opts?: LaunchOptions) =>
        Effect.tryPromise({
          try: () => page.goto(url || config.baseUrl || "about:blank").then(() => {}),
          catch: (e) => new DriverError({ message: `Failed to navigate to ${url}: ${e}` }),
        }),

      stopApp: (_id) =>
        Effect.tryPromise({
          try: () => page.goto("about:blank").then(() => {}),
          catch: (e) => new DriverError({ message: `Failed to stop app: ${e}` }),
        }),

      killApp: (_id) =>
        Effect.tryPromise({
          try: () => page.close().then(() => {}),
          catch: (e) => new DriverError({ message: `Failed to kill app: ${e}` }),
        }),

      clearAppState: (_id) =>
        Effect.tryPromise({
          try: async () => {
            await page.context().clearCookies();
            await page.evaluate(`localStorage.clear(); sessionStorage.clear();`);
          },
          catch: (e) => new DriverError({ message: `Failed to clear app state: ${e}` }),
        }),

      openLink: (url) =>
        Effect.tryPromise({
          try: () => page.goto(url).then(() => {}),
          catch: (e) => new DriverError({ message: `Failed to open link ${url}: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          try: () => page.goBack().then(() => {}),
          catch: (e) => new DriverError({ message: `Failed to go back: ${e}` }),
        }),
    };

    return service;
  });
}

export function PlaywrightDriverLive(config: PlaywrightConfig = {}): Layer.Layer<RawDriver, DriverError> {
  return Layer.effect(RawDriver, makePlaywrightDriver(config));
}
