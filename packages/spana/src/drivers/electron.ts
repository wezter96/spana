import { Effect } from "effect";
import type {
  _electron,
  chromium,
  Browser,
  BrowserContext,
  ElectronApplication,
  Page,
} from "playwright-core";
import { DriverError } from "../errors.js";
import type { DomChannel } from "../channels/dom-channel.js";
import type {
  BrowserConsoleLog,
  BrowserJSError,
  BrowserMockResponse,
  BrowserRouteMatcher,
  LaunchOptions,
  RawDriverService,
  RawHierarchy,
} from "./raw-driver.js";

export interface ElectronDriverOptions {
  /** Path to Electron main entry file or app directory (passed to `_electron.launch`) */
  entry?: string;
  /** Path to packaged Electron executable */
  executablePath?: string;
  /** Extra CLI args passed to Electron */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Attach to an already running Electron app over CDP instead of launching */
  cdpUrl?: string;
  /** Remote debugging port (when attaching over CDP or launching with debugging enabled) */
  cdpPort?: number;
  /** Optional initial URL to load inside the first Electron window */
  url?: string;
  /** Optional spana-bridge DOM channel */
  domChannel?: DomChannel;
  /** Injectable launchers for unit testing */
  launchElectron?: typeof _electron.launch;
  connectOverCDP?: typeof chromium.connectOverCDP;
}

const DOM_HIERARCHY_WALK_SCRIPT = `
  (function() {
    function walk(el) {
      if (!el) return null;
      var rect = el.getBoundingClientRect();
      var style = window.getComputedStyle(el);
      var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      var isVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      var intersectsViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.getAttribute("data-testid") || el.getAttribute("testID") || undefined,
        text: el.childNodes.length === 1 && el.childNodes[0] && el.childNodes[0].nodeType === 3
          ? (el.childNodes[0].textContent || "").trim() || undefined
          : undefined,
        value: (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")
          ? (el.value !== undefined ? String(el.value) : undefined)
          : undefined,
        accessibilityLabel: el.getAttribute("aria-label") || undefined,
        role: el.getAttribute("role") || undefined,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        enabled: !el.hasAttribute("disabled"),
        visible: isVisible && rect.width > 0 && rect.height > 0 && intersectsViewport,
        clickable: el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.getAttribute("role") === "button" || el.onclick !== null,
        attributes: (function() { var a = {}; for (var i = 0; i < el.attributes.length; i++) { var attr = el.attributes[i]; a[attr.name] = attr.value; } return Object.keys(a).length > 0 ? a : undefined; })(),
        children: Array.from(el.children).map(walk).filter(Boolean)
      };
    }
    return walk(document.body);
  })()
`;

const CLEAR_STORAGE_SCRIPT = `
  (() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  })();
`;

/**
 * Create a Spana driver for Electron apps.
 *
 * Uses Playwright's `_electron.launch()` by default (zero extra setup), or
 * connects via CDP (`chromium.connectOverCDP`) when `cdpUrl` / `cdpPort` is
 * specified. Reuses the running Electron process across flows and resets
 * storage cleanly between runs.
 */
export function makeElectronDriver(
  options: ElectronDriverOptions,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    let electronApp: ElectronApplication | undefined;
    let cdpBrowser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page!: Page;

    const consoleLogs: BrowserConsoleLog[] = [];
    const jsErrors: BrowserJSError[] = [];
    const appliedRoutes: Array<{ matcher: BrowserRouteMatcher }> = [];

    const attachDiagnostics = (targetPage: Page) => {
      targetPage.on("console", (msg) => {
        const loc = msg.location();
        consoleLogs.push({
          type: msg.type(),
          text: msg.text(),
          ...(loc.url ? { location: loc } : {}),
        });
      });
      targetPage.on("pageerror", (err) => {
        jsErrors.push({ name: err.name, message: err.message, stack: err.stack });
      });
    };

    const resolvedCdpUrl =
      options.cdpUrl ??
      (options.cdpPort && !options.entry && !options.executablePath
        ? `http://127.0.0.1:${options.cdpPort}`
        : undefined);

    if (resolvedCdpUrl) {
      cdpBrowser = yield* Effect.tryPromise({
        try: async () => {
          const connect =
            options.connectOverCDP ??
            (await import("playwright-core")).chromium.connectOverCDP.bind(
              (await import("playwright-core")).chromium,
            );
          return connect(resolvedCdpUrl);
        },
        catch: (e) =>
          new DriverError({
            message: `Failed to connect to Electron over CDP (${resolvedCdpUrl}): ${e}`,
          }),
      });

      page = yield* Effect.tryPromise({
        try: async () => {
          const contexts = cdpBrowser!.contexts();
          context = contexts[0];
          const pages = context?.pages() ?? [];
          const existing = pages[0];
          if (existing) return existing;
          if (context) return await context.newPage();
          context = await cdpBrowser!.newContext();
          return await context.newPage();
        },
        catch: (e) =>
          new DriverError({ message: `Failed to acquire Electron window over CDP: ${e}` }),
      });
    } else {
      const launchArgs = [
        ...(options.entry ? [options.entry] : []),
        ...(options.cdpPort ? [`--remote-debugging-port=${options.cdpPort}`] : []),
        ...(options.args ?? []),
      ];
      if (!options.executablePath && launchArgs.length === 0) {
        return yield* new DriverError({
          message:
            "Electron target requires `apps.electron.entry`, `apps.electron.executablePath`, or `apps.electron.cdpUrl`/`cdpPort`.",
        });
      }

      electronApp = yield* Effect.tryPromise({
        try: async () => {
          const launcher =
            options.launchElectron ??
            (await import("playwright-core"))._electron.launch.bind(
              (await import("playwright-core"))._electron,
            );
          return launcher({
            ...(options.executablePath ? { executablePath: options.executablePath } : {}),
            ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.env
              ? { env: { ...process.env, ...options.env } as Record<string, string> }
              : {}),
          });
        },
        catch: (e) => new DriverError({ message: `Failed to launch Electron app: ${e}` }),
      });

      page = yield* Effect.tryPromise({
        try: async () => {
          const win = await electronApp!.firstWindow();
          context = electronApp!.context();
          return win;
        },
        catch: (e) =>
          new DriverError({ message: `Failed to acquire Electron firstWindow(): ${e}` }),
      });
    }

    attachDiagnostics(page);

    const domChannel = options.domChannel;

    const clearStorageAndCookies = async () => {
      if (domChannel?.isConnected() && domChannel.clearStorage) {
        await domChannel.clearStorage({
          localStorage: true,
          sessionStorage: true,
          cookies: true,
          indexedDB: true,
        });
        return;
      }
      if (context) {
        await context.clearCookies().catch(() => {});
      }
      await page.evaluate(CLEAR_STORAGE_SCRIPT).catch(() => {});
    };

    const service: RawDriverService = {
      domChannel,

      beginFlow: () =>
        Effect.sync(() => {
          consoleLogs.length = 0;
          jsErrors.length = 0;
        }),

      dumpHierarchy: () =>
        Effect.tryPromise({
          try: async (): Promise<RawHierarchy> => {
            const tree = await page.evaluate(DOM_HIERARCHY_WALK_SCRIPT);
            return JSON.stringify(tree);
          },
          catch: (e) => new DriverError({ message: `Electron dumpHierarchy failed: ${e}` }),
        }),

      tapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => page.mouse.click(x, y),
          catch: (e) => new DriverError({ message: `Electron tap failed at (${x}, ${y}): ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => page.mouse.dblclick(x, y),
          catch: (e) =>
            new DriverError({ message: `Electron doubleTap failed at (${x}, ${y}): ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await new Promise((r) => setTimeout(r, duration));
            await page.mouse.up();
          },
          catch: (e) => new DriverError({ message: `Electron longPress failed: ${e}` }),
        }),

      swipe: (startX, startY, endX, endY, duration) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(startX, startY);
            await page.mouse.wheel(startX - endX, startY - endY);
            await new Promise((r) => setTimeout(r, duration));
          },
          catch: (e) => new DriverError({ message: `Electron swipe failed: ${e}` }),
        }),

      inputText: (text) =>
        Effect.tryPromise({
          try: () => page.keyboard.insertText(text),
          catch: (e) => new DriverError({ message: `Electron inputText failed: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          try: () => page.keyboard.press(key),
          catch: (e) => new DriverError({ message: `Electron pressKey failed: ${e}` }),
        }),

      hideKeyboard: () => Effect.void,

      takeScreenshot: () =>
        Effect.tryPromise({
          try: async () => new Uint8Array(await page.screenshot()),
          catch: (e) => new DriverError({ message: `Electron screenshot failed: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.tryPromise({
          try: async () => {
            const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
            return {
              platform: "electron" as const,
              deviceId: resolvedCdpUrl ?? options.entry ?? options.executablePath ?? "electron",
              name: "Electron",
              isEmulator: false,
              screenWidth: viewport.width,
              screenHeight: viewport.height,
              driverType: "electron" as const,
            };
          },
          catch: (e) => new DriverError({ message: `Electron getDeviceInfo failed: ${e}` }),
        }),

      launchApp: (appRef, opts?: LaunchOptions) =>
        Effect.tryPromise({
          try: async () => {
            if (opts?.clearState) {
              await clearStorageAndCookies();
            }
            const targetUrl =
              opts?.deepLink ??
              options.url ??
              (appRef && (appRef.startsWith("http://") || appRef.startsWith("https://"))
                ? appRef
                : undefined);
            if (targetUrl) {
              await page.goto(targetUrl);
            }
          },
          catch: (e) => new DriverError({ message: `Electron launchApp failed: ${e}` }),
        }),

      stopApp: () => Effect.void,

      killApp: () =>
        Effect.tryPromise({
          try: async () => {
            await domChannel?.disconnect().catch(() => {});
            if (electronApp) {
              await electronApp.close();
            } else if (cdpBrowser) {
              await cdpBrowser.close();
            }
          },
          catch: (e) => new DriverError({ message: `Electron killApp failed: ${e}` }),
        }),

      clearAppState: () =>
        Effect.tryPromise({
          try: async () => {
            await clearStorageAndCookies();
          },
          catch: (e) => new DriverError({ message: `Electron clearAppState failed: ${e}` }),
        }),

      resetFast: () =>
        Effect.tryPromise({
          try: async () => {
            await clearStorageAndCookies();
            await page.reload();
          },
          catch: (e) => new DriverError({ message: `Electron resetFast failed: ${e}` }),
        }),

      openLink: (url) =>
        Effect.tryPromise({
          try: async () => {
            await page.goto(url);
          },
          catch: (e) => new DriverError({ message: `Electron openLink failed: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          try: async () => {
            await page.goBack();
          },
          catch: (e) => new DriverError({ message: `Electron back failed: ${e}` }),
        }),

      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel?.isConnected()) {
              return await domChannel.evaluate<T>(script, ...args);
            }
            if (typeof script === "function") {
              return (await page.evaluate(
                ({ fnSource, fnArgs }: { fnSource: string; fnArgs: unknown[] }) => {
                  const fn = new Function(`return (${fnSource})`)();
                  return fn(...fnArgs);
                },
                { fnSource: script.toString(), fnArgs: args },
              )) as T;
            }
            return (await page.evaluate(script)) as T;
          },
          catch: (e) => new DriverError({ message: `Electron evaluate failed: ${e}` }),
        }),

      mockNetwork: (matcher, response: BrowserMockResponse) =>
        Effect.tryPromise({
          try: async () => {
            if (!context) throw new Error("No Electron BrowserContext available");
            await context.route(matcher, async (route) => {
              await route.fulfill({
                status: response.status ?? 200,
                headers: response.headers,
                contentType: response.contentType,
                ...(response.json !== undefined
                  ? { json: response.json }
                  : { body: response.body ?? "" }),
              });
            });
            appliedRoutes.push({ matcher });
          },
          catch: (e) => new DriverError({ message: `Electron mockNetwork failed: ${e}` }),
        }),

      blockNetwork: (matcher) =>
        Effect.tryPromise({
          try: async () => {
            if (!context) throw new Error("No Electron BrowserContext available");
            await context.route(matcher, async (route) => {
              await route.abort();
            });
            appliedRoutes.push({ matcher });
          },
          catch: (e) => new DriverError({ message: `Electron blockNetwork failed: ${e}` }),
        }),

      clearNetworkMocks: () =>
        Effect.tryPromise({
          try: async () => {
            if (!context) return;
            for (const entry of appliedRoutes) {
              await context.unroute(entry.matcher).catch(() => {});
            }
            appliedRoutes.length = 0;
          },
          catch: (e) => new DriverError({ message: `Electron clearNetworkMocks failed: ${e}` }),
        }),

      getConsoleLogs: () => Effect.succeed([...consoleLogs]),
      getJSErrors: () => Effect.succeed([...jsErrors]),
    };

    return service;
  });
}
