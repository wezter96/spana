import { readFile, writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import {
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
} from "playwright-core";
import { DriverError } from "../errors.js";
import type { BrowserName } from "../schemas/config.js";
import {
  RawDriver,
  type RawDriverService,
  type RawHierarchy,
  type LaunchOptions,
  type BrowserMockResponse,
  type BrowserNetworkConditions,
  type BrowserRouteMatcher,
  type BrowserConsoleLog,
  type BrowserJSError,
} from "./raw-driver.js";

type RouteDefinition =
  | { kind: "mock"; matcher: BrowserRouteMatcher; response: BrowserMockResponse }
  | { kind: "block"; matcher: BrowserRouteMatcher };

interface AppliedRoute {
  matcher: BrowserRouteMatcher;
  handler: (route: Route) => Promise<void>;
}

export interface PlaywrightConfig {
  browser?: BrowserName;
  headless?: boolean;
  baseUrl?: string;
  storageState?: string;
}

const browserLaunchers = {
  chromium,
  firefox,
  webkit,
} as const;

const browserLabels: Record<BrowserName, string> = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
};

const CLEAR_STORAGE_SCRIPT = `
  (() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  })();
`;

function hasContentTypeHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
}

function buildMockResponse(response: BrowserMockResponse): {
  status: number;
  body?: string;
  json?: unknown;
  headers: Record<string, string>;
} {
  if (response.body !== undefined && response.json !== undefined) {
    throw new DriverError({
      message: "mockNetwork() response cannot include both body and json.",
    });
  }

  const headers = { ...response.headers };
  if (response.contentType && !hasContentTypeHeader(headers)) {
    headers["content-type"] = response.contentType;
  }

  if (response.json !== undefined) {
    return {
      status: response.status ?? 200,
      json: response.json,
      headers,
    };
  }

  return {
    status: response.status ?? 200,
    body: response.body ?? "",
    headers,
  };
}

function toBytesPerSecond(kbps: number | undefined): number {
  if (kbps === undefined) {
    return -1;
  }

  return Math.max(Math.round((kbps * 1024) / 8), 0);
}

function requiresChromiumThrottling(conditions: BrowserNetworkConditions): boolean {
  return (
    conditions.latencyMs !== undefined ||
    conditions.downloadThroughputKbps !== undefined ||
    conditions.uploadThroughputKbps !== undefined
  );
}

function currentPageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "about:blank";
  }
}

export function makePlaywrightDriver(
  config: PlaywrightConfig,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const browserName = config.browser ?? "chromium";
    const browser = yield* Effect.tryPromise({
      try: () => browserLaunchers[browserName].launch({ headless: config.headless ?? true }),
      catch: (e) => new DriverError({ message: `Failed to launch browser: ${e}` }),
    });

    let context!: BrowserContext;
    let page!: Page;
    let cdpSession: CDPSession | undefined;
    const routeDefinitions: RouteDefinition[] = [];
    let appliedRoutes: AppliedRoute[] = [];
    let currentNetworkConditions: BrowserNetworkConditions = {};
    let consoleLogs: BrowserConsoleLog[] = [];
    let jsErrors: BrowserJSError[] = [];

    const resetWebDiagnostics = () => {
      consoleLogs = [];
      jsErrors = [];
    };

    const attachPageDiagnostics = (activePage: Page) => {
      activePage.on("console", (message) => {
        const location = message.location();
        const entry: BrowserConsoleLog = {
          type: message.type(),
          text: message.text(),
        };

        if (location.url || location.lineNumber !== undefined || location.columnNumber !== undefined) {
          entry.location = {
            url: location.url || undefined,
            lineNumber: location.lineNumber,
            columnNumber: location.columnNumber,
          };
        }

        consoleLogs.push(entry);
      });

      activePage.on("pageerror", (error) => {
        jsErrors.push({
          name: error.name,
          message: error.message,
          stack: error.stack,
        });
      });
    };

    const clearStorage = async () => {
      await context.clearCookies();
      await page.evaluate(CLEAR_STORAGE_SCRIPT);
    };

    const applyNetworkConditions = async () => {
      if (browserName !== "chromium" && requiresChromiumThrottling(currentNetworkConditions)) {
        throw new DriverError({
          message:
            "setNetworkConditions() latency and throughput controls are only supported with the chromium browser. Use offline mode only for firefox or webkit.",
        });
      }

      await context.setOffline(currentNetworkConditions.offline ?? false);

      const shouldUseCDP =
        browserName === "chromium" &&
        (requiresChromiumThrottling(currentNetworkConditions) || cdpSession !== undefined);

      if (!shouldUseCDP) {
        return;
      }

      const session = cdpSession ?? (cdpSession = await context.newCDPSession(page));
      await session.send("Network.enable");
      await session.send("Network.emulateNetworkConditions", {
        offline: currentNetworkConditions.offline ?? false,
        latency: currentNetworkConditions.latencyMs ?? 0,
        downloadThroughput: toBytesPerSecond(currentNetworkConditions.downloadThroughputKbps),
        uploadThroughput: toBytesPerSecond(currentNetworkConditions.uploadThroughputKbps),
      });
    };

    const applyRouteDefinition = async (definition: RouteDefinition) => {
      const handler =
        definition.kind === "mock"
          ? async (route: Route) => {
              await route.fulfill(buildMockResponse(definition.response));
            }
          : async (route: Route) => {
              await route.abort();
            };

      await context.route(definition.matcher, handler);
      appliedRoutes.push({ matcher: definition.matcher, handler });
    };

    const reapplyRoutes = async () => {
      appliedRoutes = [];
      for (const definition of routeDefinitions) {
        await applyRouteDefinition(definition);
      }
    };

    const createContextAndPage = async (storageStatePath?: string) => {
      context = await browser.newContext(
        storageStatePath ? { storageState: storageStatePath } : undefined,
      );
      page = await context.newPage();
      cdpSession = undefined;
      attachPageDiagnostics(page);

      await reapplyRoutes();
      await applyNetworkConditions();
    };

    const replaceContext = async (storageStatePath?: string) => {
      const previousContext = context;
      const previousPage = page;
      const url = currentPageUrl(page);

      await createContextAndPage(storageStatePath);

      if (url && url !== "about:blank") {
        await page.goto(url);
      }

      await Promise.allSettled([previousPage.close(), previousContext.close()]);
    };

    yield* Effect.tryPromise({
      try: () => createContextAndPage(config.storageState),
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
                    clickable: el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.getAttribute("role") === "button" || el.onclick !== null,
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
          try: async () => {
            // Use Playwright's native mouse for proper event dispatch (mousedown+mouseup+click)
            // which triggers focus on form elements
            await page.mouse.click(x, y);
            // Ensure focus is set for input elements (React Native Web needs explicit focus)
            await page.evaluate(`
              (function(x, y) {
                var el = document.elementFromPoint(x, y);
                if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) {
                  el.focus();
                }
              })(${x}, ${y})
            `);
          },
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
              await page.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t);
            }
            await page.mouse.up();
          },
          catch: (e) => new DriverError({ message: `Failed to swipe: ${e}` }),
        }),

      inputText: (text) =>
        Effect.tryPromise({
          try: () => page.keyboard.insertText(text),
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
              deviceId: `playwright-${browserName}`,
              name: browserLabels[browserName],
              isEmulator: false,
              screenWidth: viewport.width,
              screenHeight: viewport.height,
              driverType: "playwright" as const,
            };
          },
          catch: (e) => new DriverError({ message: `Failed to get device info: ${e}` }),
        }),

      launchApp: (url, opts?: LaunchOptions) =>
        Effect.tryPromise({
          try: async () => {
            resetWebDiagnostics();
            if (opts?.clearState) {
              await clearStorage();
            }
            await page.goto(opts?.deepLink || url || config.baseUrl || "about:blank");
          },
          catch: (e) => new DriverError({ message: `Failed to navigate to ${url}: ${e}` }),
        }),

      stopApp: (_id) =>
        Effect.tryPromise({
          try: () => page.goto("about:blank").then(() => {}),
          catch: (e) => new DriverError({ message: `Failed to stop app: ${e}` }),
        }),

      killApp: (_id) =>
        Effect.tryPromise({
          try: async () => {
            await Promise.allSettled([page.close(), context.close(), browser.close()]);
          },
          catch: (e) => new DriverError({ message: `Failed to kill app: ${e}` }),
        }),

      clearAppState: (_id) =>
        Effect.tryPromise({
          try: async () => {
            await clearStorage();
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

      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: () => page.evaluate(script as never, ...args) as Promise<T>,
          catch: (e) => new DriverError({ message: `Evaluate failed: ${e}` }),
        }),

      mockNetwork: (matcher, response) =>
        Effect.tryPromise({
          try: async () => {
            buildMockResponse(response);
            const definition: RouteDefinition = { kind: "mock", matcher, response };
            routeDefinitions.push(definition);
            await applyRouteDefinition(definition);
          },
          catch: (e) => new DriverError({ message: `Failed to mock network route: ${e}` }),
        }),

      blockNetwork: (matcher) =>
        Effect.tryPromise({
          try: async () => {
            const definition: RouteDefinition = { kind: "block", matcher };
            routeDefinitions.push(definition);
            await applyRouteDefinition(definition);
          },
          catch: (e) => new DriverError({ message: `Failed to block network route: ${e}` }),
        }),

      clearNetworkMocks: () =>
        Effect.tryPromise({
          try: async () => {
            for (const appliedRoute of appliedRoutes) {
              await context.unroute(appliedRoute.matcher, appliedRoute.handler);
            }
            appliedRoutes = [];
            routeDefinitions.length = 0;
          },
          catch: (e) => new DriverError({ message: `Failed to clear network mocks: ${e}` }),
        }),

      setNetworkConditions: (conditions) =>
        Effect.tryPromise({
          try: async () => {
            currentNetworkConditions = { ...conditions };
            await applyNetworkConditions();
          },
          catch: (e) => new DriverError({ message: `Failed to set network conditions: ${e}` }),
        }),

      saveCookies: (path) =>
        Effect.tryPromise({
          try: async () => {
            const cookies = await context.cookies();
            await writeFile(path, JSON.stringify(cookies, null, 2), "utf8");
          },
          catch: (e) => new DriverError({ message: `Failed to save cookies to ${path}: ${e}` }),
        }),

      loadCookies: (path) =>
        Effect.tryPromise({
          try: async () => {
            const contents = await readFile(path, "utf8");
            const cookies = JSON.parse(contents);
            if (!Array.isArray(cookies)) {
              throw new Error("Cookie file must contain an array of cookies.");
            }
            await context.addCookies(cookies);
          },
          catch: (e) => new DriverError({ message: `Failed to load cookies from ${path}: ${e}` }),
        }),

      saveAuthState: (path) =>
        Effect.tryPromise({
          try: () => context.storageState({ path }).then(() => {}),
          catch: (e) => new DriverError({ message: `Failed to save auth state to ${path}: ${e}` }),
        }),

      loadAuthState: (path) =>
        Effect.tryPromise({
          try: async () => {
            await replaceContext(path);
          },
          catch: (e) =>
            new DriverError({ message: `Failed to load auth state from ${path}: ${e}` }),
        }),

      getConsoleLogs: () => Effect.succeed([...consoleLogs]),

      getJSErrors: () => Effect.succeed([...jsErrors]),
    };

    return service;
  });
}

export function PlaywrightDriverLive(
  config: PlaywrightConfig = {},
): Layer.Layer<RawDriver, DriverError> {
  return Layer.effect(RawDriver, makePlaywrightDriver(config));
}
