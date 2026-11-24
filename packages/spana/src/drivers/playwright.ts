import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import {
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  type DomChannel,
  type DomElementMatch,
} from "../channels/dom-channel.js";
import { allocatePort } from "../core/port-allocator.js";
import { getHealthyWarmDaemon, registerWarmDaemon } from "../runtime/daemon-manager.js";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Download,
  type Page,
  type Request,
  type Route,
} from "playwright-core";
import { DriverError } from "../errors.js";
import { hasLaunchDeviceState } from "./launch-options.js";
import { resolveNetworkConditions } from "./network-profiles.js";
import type { BrowserName } from "../schemas/config.js";
import type { Selector } from "../schemas/selector.js";
import {
  RawDriver,
  type RawDriverService,
  type RawHierarchy,
  type LaunchOptions,
  type BrowserMockResponse,
  type NetworkConditions,
  type BrowserRouteMatcher,
  type BrowserConsoleLog,
  type BrowserHAR,
  type BrowserHAREntry,
  type BrowserHARHeader,
  type BrowserHARPage,
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
  verboseLogging?: boolean;
  /** Optional pre-launched Browser instance shared across parallel BrowserContext workers. */
  sharedBrowser?: Browser;
  /** Optional browser channel (e.g. "chrome") or explicit executable path. */
  channel?: string;
  executablePath?: string;
  /** Navigation wait condition for launchApp / openLink (e.g. "domcontentloaded" for prefetch-heavy SSR apps). */
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  /** Record per-request HAR metadata over CDP/IPC. Disable when `artifacts.har` is off for faster page loads. Default: true. */
  recordHar?: boolean;
  /** Flashwright-inspired: speed up CSS transitions & animations to 0.001ms so actions never stall on transitions. */
  instantAnimations?: boolean;
  /** Flashwright-inspired: abort specified resource types (e.g. ["image", "font", "media"]) before hitting the network. */
  blockResources?: Array<"image" | "font" | "media" | "stylesheet">;
  /** Connect to an already-running warm Chromium CDP endpoint instead of launching a new browser process. */
  cdpEndpoint?: string;
  /** Reuse a persistent detached headless Chromium daemon across CLI runs (Flashwright-style warm session). */
  warmBrowser?: boolean;
  /** Attach a built-in zero-setup Playwright DOM channel for ~1ms `{ testID }` queries without full DOM dumps. Default: true. */
  enableDomChannel?: boolean;
}

const INSTANT_ANIMATIONS_INIT_SCRIPT = `
  (() => {
    const inject = () => {
      if (document.getElementById("__spana_instant_anim")) return;
      const style = document.createElement("style");
      style.id = "__spana_instant_anim";
      style.textContent = "*, *::before, *::after { transition-duration: 0.001ms !important; transition-delay: 0ms !important; animation-duration: 0.001ms !important; animation-delay: 0ms !important; scroll-behavior: auto !important; }";
      (document.head || document.documentElement).appendChild(style);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    } else {
      inject();
    }
  })();
`;

/**
 * Connect to an existing warm headless Chromium daemon or start a detached one
 * registered in Spana's warm daemon registry (`spana daemon status|stop`).
 */
export async function ensureWarmBrowserDaemon(
  config: Pick<PlaywrightConfig, "executablePath" | "headless"> = {},
): Promise<{ browser: Browser; cdpUrl: string; reused: boolean }> {
  const existing = await getHealthyWarmDaemon("chromium", "default", {
    statusPath: "/json/version",
  });
  if (existing) {
    const cdpUrl = `http://${existing.host}:${existing.port}`;
    try {
      const browser = await chromium.connectOverCDP(cdpUrl);
      return { browser, cdpUrl, reused: true };
    } catch {
      // Fall through to launch fresh warm daemon
    }
  }

  const port = allocatePort(9322);
  const execPath = config.executablePath ?? chromium.executablePath();
  const child = spawn(
    execPath,
    [
      ...(config.headless !== false ? ["--headless=new"] : []),
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  const cdpUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!ready) {
    throw new Error(`Warm Chromium daemon failed to start on ${cdpUrl}`);
  }

  registerWarmDaemon({
    kind: "chromium",
    deviceId: "default",
    host: "127.0.0.1",
    port,
    pid: child.pid,
    startedAt: new Date().toISOString(),
  });

  const browser = await chromium.connectOverCDP(cdpUrl);
  return { browser, cdpUrl, reused: false };
}

export async function connectPlaywrightOverCDP(cdpEndpoint: string): Promise<Browser> {
  return chromium.connectOverCDP(cdpEndpoint);
}

export async function launchPlaywrightBrowser(
  config: Pick<PlaywrightConfig, "browser" | "headless" | "channel" | "executablePath"> = {},
): Promise<Browser> {
  const browserName = config.browser ?? "chromium";
  return browserLaunchers[browserName].launch({
    headless: config.headless ?? true,
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
  });
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

function toBytesPerSecond(kbps: number): number {
  if (kbps < 0) {
    return -1;
  }

  return Math.max(Math.round((kbps * 1024) / 8), 0);
}

function currentPageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "about:blank";
  }
}

function toHarHeaders(headers: Record<string, string>): BrowserHARHeader[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function toHarQueryString(url: string): BrowserHARHeader[] {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
}

function timingDuration(start: number, end: number): number {
  if (start < 0 || end < 0 || end < start) {
    return -1;
  }

  return Math.max(Math.round(end - start), 0);
}

type RequestTiming = ReturnType<Request["timing"]>;

function totalHarTime(timing: RequestTiming): number {
  const end =
    timing.responseEnd >= 0
      ? timing.responseEnd
      : timing.responseStart >= 0
        ? timing.responseStart
        : timing.requestStart >= 0
          ? timing.requestStart
          : 0;
  return Math.max(Math.round(end), 0);
}

export function makePlaywrightDriver(
  config: PlaywrightConfig,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const browserName = config.browser ?? "chromium";
    const ownsBrowser = !config.sharedBrowser && !config.cdpEndpoint && !config.warmBrowser;
    const browser = config.sharedBrowser
      ? config.sharedBrowser
      : config.cdpEndpoint
        ? yield* Effect.tryPromise({
            try: () => chromium.connectOverCDP(config.cdpEndpoint!),
            catch: (e) =>
              new DriverError({
                message: `Failed to connect to browser over CDP (${config.cdpEndpoint}): ${e}`,
              }),
          })
        : config.warmBrowser && browserName === "chromium"
          ? yield* Effect.tryPromise({
              try: async () => (await ensureWarmBrowserDaemon(config)).browser,
              catch: (e) =>
                new DriverError({ message: `Failed to connect to warm Chromium daemon: ${e}` }),
            })
          : yield* Effect.tryPromise({
              try: () =>
                browserLaunchers[browserName].launch({
                  headless: config.headless ?? true,
                  ...(config.channel ? { channel: config.channel } : {}),
                  ...(config.executablePath ? { executablePath: config.executablePath } : {}),
                }),
              catch: (e) => new DriverError({ message: `Failed to launch browser: ${e}` }),
            });

    let context!: BrowserContext;
    let page!: Page;
    let cdpSession: CDPSession | undefined;
    const routeDefinitions: RouteDefinition[] = [];
    let appliedRoutes: AppliedRoute[] = [];
    let currentNetworkConditions: NetworkConditions = {};
    let currentFlowName = "unscoped";
    let consoleLogs: BrowserConsoleLog[] = [];
    let jsErrors: BrowserJSError[] = [];
    let tabIds = new Map<Page, string>();
    let nextTabId = 1;
    let harEntries: BrowserHAREntry[] = [];
    let harPages = new Map<Page, BrowserHARPage>();
    let queuedDownloads: Download[] = [];
    let downloadWaiters: Array<{
      resolve: (download: Download) => void;
      reject: (error: Error) => void;
    }> = [];
    const attachedPages = new WeakSet<Page>();

    const resetWebDiagnostics = () => {
      consoleLogs = [];
      jsErrors = [];
    };

    const debugLog = (...parts: Array<string | number | boolean | undefined>) => {
      if (!config.verboseLogging) {
        return;
      }

      const rendered = parts.filter((part) => part !== undefined).map((part) => String(part));
      console.log("[spana:web]", `[${currentFlowName}]`, ...rendered);
    };

    const getTabId = (activePage: Page): string => {
      const existing = tabIds.get(activePage);
      if (existing) {
        return existing;
      }

      const id = `tab-${nextTabId++}`;
      tabIds.set(activePage, id);
      harPages.set(activePage, {
        id,
        title: currentPageUrl(activePage),
        startedDateTime: new Date().toISOString(),
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      });
      return id;
    };

    const updateHarPage = (activePage: Page) => {
      const harPage = harPages.get(activePage);
      if (harPage) {
        harPage.title = currentPageUrl(activePage);
      }
    };

    const flushDownload = (download: Download) => {
      const waiter = downloadWaiters.shift();
      if (waiter) {
        waiter.resolve(download);
        return;
      }

      queuedDownloads.push(download);
    };

    const nextDownload = (): Promise<Download> => {
      const queued = queuedDownloads.shift();
      if (queued) {
        return Promise.resolve(queued);
      }

      return new Promise<Download>((resolve, reject) => {
        downloadWaiters.push({ resolve, reject });
      });
    };

    const defaultSizes = {
      requestBodySize: 0,
      requestHeadersSize: -1,
      responseBodySize: 0,
      responseHeadersSize: -1,
    };

    const recordRequestFinished = async (activePage: Page, request: Request) => {
      if (typeof activePage.isClosed === "function" && activePage.isClosed()) return;
      const response = await request.response().catch(() => null);
      if (!response || (typeof activePage.isClosed === "function" && activePage.isClosed())) {
        return;
      }

      const [requestHeaders, responseHeaders, sizes, httpVersion, serverAddr] = await Promise.all([
        request.allHeaders().catch(() => request.headers()),
        response.allHeaders().catch(() => Promise.resolve(response.headers())),
        request.sizes().catch(() => Promise.resolve(defaultSizes)),
        response.httpVersion().catch(() => Promise.resolve("HTTP/1.1")),
        response.serverAddr().catch(() => Promise.resolve(null)),
      ]);

      const timing = request.timing();
      const responseContentType =
        responseHeaders["content-type"] ??
        response.headers()["content-type"] ??
        "application/octet-stream";
      const redirectURL = responseHeaders.location ?? response.headers().location ?? "";
      const requestContentType = requestHeaders["content-type"] ?? "";
      const postData = request.postData();

      updateHarPage(activePage);
      harEntries.push({
        pageref: getTabId(activePage),
        startedDateTime:
          timing.startTime > 0
            ? new Date(timing.startTime).toISOString()
            : new Date().toISOString(),
        time: totalHarTime(timing),
        request: {
          method: request.method(),
          url: request.url(),
          httpVersion,
          headers: toHarHeaders(requestHeaders),
          queryString: toHarQueryString(request.url()),
          headersSize: sizes.requestHeadersSize,
          bodySize: sizes.requestBodySize,
          ...(postData
            ? {
                postData: {
                  mimeType: requestContentType || "application/octet-stream",
                  text: postData,
                },
              }
            : {}),
        },
        response: {
          status: response.status(),
          statusText: response.statusText(),
          httpVersion,
          headers: toHarHeaders(responseHeaders),
          redirectURL,
          headersSize: sizes.responseHeadersSize,
          bodySize: sizes.responseBodySize,
          content: {
            size: sizes.responseBodySize,
            mimeType: responseContentType,
          },
        },
        cache: {},
        timings: {
          blocked: 0,
          dns: timingDuration(timing.domainLookupStart, timing.domainLookupEnd),
          connect: timingDuration(timing.connectStart, timing.connectEnd),
          ssl: timingDuration(timing.secureConnectionStart, timing.connectEnd),
          send: 0,
          wait: timingDuration(timing.requestStart, timing.responseStart),
          receive: timingDuration(timing.responseStart, timing.responseEnd),
        },
        ...(serverAddr?.ipAddress ? { serverIPAddress: serverAddr.ipAddress } : {}),
        _resourceType: request.resourceType(),
      });

      debugLog("network", request.method(), response.status(), request.url());
    };

    const recordRequestFailed = async (activePage: Page, request: Request) => {
      const requestHeaders = await request
        .allHeaders()
        .catch(() => Promise.resolve(request.headers()));
      const requestContentType = requestHeaders["content-type"] ?? "";
      const postData = request.postData();
      const timing = request.timing();
      const failureText = request.failure()?.errorText ?? "Request failed";

      updateHarPage(activePage);
      harEntries.push({
        pageref: getTabId(activePage),
        startedDateTime:
          timing.startTime > 0
            ? new Date(timing.startTime).toISOString()
            : new Date().toISOString(),
        time: totalHarTime(timing),
        request: {
          method: request.method(),
          url: request.url(),
          httpVersion: "",
          headers: toHarHeaders(requestHeaders),
          queryString: toHarQueryString(request.url()),
          headersSize: -1,
          bodySize: postData ? Buffer.byteLength(postData) : 0,
          ...(postData
            ? {
                postData: {
                  mimeType: requestContentType || "application/octet-stream",
                  text: postData,
                },
              }
            : {}),
        },
        response: {
          status: 0,
          statusText: failureText,
          httpVersion: "",
          headers: [],
          redirectURL: "",
          headersSize: -1,
          bodySize: 0,
          content: {
            size: 0,
            mimeType: "application/octet-stream",
          },
        },
        cache: {},
        timings: {
          blocked: 0,
          dns: timingDuration(timing.domainLookupStart, timing.domainLookupEnd),
          connect: timingDuration(timing.connectStart, timing.connectEnd),
          ssl: timingDuration(timing.secureConnectionStart, timing.connectEnd),
          send: 0,
          wait: timing.requestStart >= 0 ? Math.max(Math.round(timing.requestStart), 0) : -1,
          receive: -1,
        },
        _resourceType: request.resourceType(),
        _failureText: failureText,
      });

      debugLog("network", request.method(), "FAILED", request.url(), failureText);
    };

    const attachPageDiagnostics = (activePage: Page) => {
      if (attachedPages.has(activePage)) {
        return;
      }

      attachedPages.add(activePage);
      getTabId(activePage);

      activePage.on("console", (message) => {
        const location = message.location();
        const entry: BrowserConsoleLog = {
          type: message.type(),
          text: message.text(),
        };

        if (
          location.url ||
          location.lineNumber !== undefined ||
          location.columnNumber !== undefined
        ) {
          entry.location = {
            url: location.url || undefined,
            lineNumber: location.lineNumber,
            columnNumber: location.columnNumber,
          };
        }

        consoleLogs.push(entry);
        debugLog("console", entry.type, entry.text);
      });

      activePage.on("pageerror", (error) => {
        jsErrors.push({
          name: error.name,
          message: error.message,
          stack: error.stack,
        });
        debugLog("pageerror", error.message);
      });

      activePage.on("download", (download) => {
        debugLog("download", getTabId(activePage), download.suggestedFilename(), download.url());
        flushDownload(download);
      });

      if (config.recordHar !== false) {
        activePage.on("requestfinished", (request) => {
          void recordRequestFinished(activePage, request).catch(() => {});
        });

        activePage.on("requestfailed", (request) => {
          void recordRequestFailed(activePage, request).catch(() => {});
        });
      }

      activePage.on("close", () => {
        debugLog("tabClosed", tabIds.get(activePage) ?? "untracked");
      });
    };

    const clearStorage = async () => {
      await context.clearCookies();
      await page.evaluate(CLEAR_STORAGE_SCRIPT);
    };

    const applyNetworkConditions = async () => {
      const resolved = resolveNetworkConditions(currentNetworkConditions);

      const needsThrottling =
        resolved.latencyMs > 0 ||
        resolved.downloadThroughputKbps >= 0 ||
        resolved.uploadThroughputKbps >= 0;

      if (browserName !== "chromium" && needsThrottling) {
        throw new DriverError({
          message:
            "setNetworkConditions() latency and throughput controls are only supported with the chromium browser. Use offline mode only for firefox or webkit.",
        });
      }

      await context.setOffline(resolved.offline);

      const shouldUseCDP =
        browserName === "chromium" && (needsThrottling || cdpSession !== undefined);

      if (!shouldUseCDP) {
        return;
      }

      const session = cdpSession ?? (cdpSession = await context.newCDPSession(page));
      await session.send("Network.enable");
      await session.send("Network.emulateNetworkConditions", {
        offline: resolved.offline,
        latency: resolved.latencyMs,
        downloadThroughput: toBytesPerSecond(resolved.downloadThroughputKbps),
        uploadThroughput: toBytesPerSecond(resolved.uploadThroughputKbps),
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

    const setInputFiles = async (selector: Selector, path: string) => {
      if (typeof selector === "string") {
        try {
          await page.getByLabel(selector, { exact: true }).setInputFiles(path);
          return;
        } catch {
          await page.getByText(selector, { exact: true }).setInputFiles(path);
          return;
        }
      }

      if ("point" in selector) {
        throw new DriverError({
          message:
            "uploadFile() does not support point selectors on the web platform. Use testID, text, or accessibilityLabel.",
        });
      }

      if ("testID" in selector) {
        await page.getByTestId(selector.testID).setInputFiles(path);
        return;
      }

      if ("accessibilityLabel" in selector) {
        await page.getByLabel(selector.accessibilityLabel, { exact: true }).setInputFiles(path);
        return;
      }

      if ("text" in selector) {
        try {
          await page.getByLabel(selector.text, { exact: true }).setInputFiles(path);
          return;
        } catch {
          await page.getByText(selector.text, { exact: true }).setInputFiles(path);
          return;
        }
      }
    };

    const applyContextSpeedOptions = async (ctx: BrowserContext) => {
      if (config.instantAnimations && typeof ctx.addInitScript === "function") {
        await ctx.addInitScript(INSTANT_ANIMATIONS_INIT_SCRIPT);
      }
      if (
        config.blockResources &&
        config.blockResources.length > 0 &&
        typeof ctx.route === "function"
      ) {
        const blocked = new Set<string>(config.blockResources);
        await ctx.route("**/*", async (route) => {
          if (blocked.has(route.request().resourceType())) {
            await route.abort();
          } else {
            await route.continue();
          }
        });
      }
    };

    const createContextAndPage = async (storageStatePath?: string) => {
      context = await browser.newContext({
        acceptDownloads: true,
        ...(storageStatePath ? { storageState: storageStatePath } : {}),
      });
      await applyContextSpeedOptions(context);
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

    const beginFlow = async (flowName: string) => {
      currentFlowName = flowName;
      resetWebDiagnostics();
      harEntries = [];
      harPages = new Map();
      tabIds = new Map();
      nextTabId = 1;
      queuedDownloads = [];
      for (const waiter of downloadWaiters) {
        waiter.reject(
          new Error("A new flow started before downloadFile() received a download event."),
        );
      }
      downloadWaiters = [];

      const openPages = context.pages();
      if (openPages.length === 0) {
        page = await context.newPage();
      } else {
        const [firstPage, ...extraPages] = openPages;
        page = firstPage!;
        await Promise.all(extraPages.map((extraPage) => extraPage.close()));
      }

      attachPageDiagnostics(page);
      getTabId(page);
      updateHarPage(page);
      debugLog("beginFlow", flowName);
    };

    yield* Effect.tryPromise({
      try: () => createContextAndPage(config.storageState),
      catch: (e) => new DriverError({ message: `Failed to create page: ${e}` }),
    });

    const domChannel: DomChannel | undefined =
      config.enableDomChannel === false
        ? undefined
        : {
            kind: "playwright",
            isConnected: () =>
              Boolean(page) && (typeof page.isClosed !== "function" || !page.isClosed()),
            connect: async () => {},
            disconnect: async () => {},
            evaluate: async <T = unknown>(
              script: string | ((...args: any[]) => T),
              ...args: any[]
            ): Promise<T> => {
              if (typeof script === "string") {
                return (await page.evaluate(script)) as T;
              }
              return (await page.evaluate(script as any, ...(args as [any]))) as T;
            },
            query: async (selector) => {
              const res = await page.evaluate(buildDomQueryScript(selector));
              return Array.isArray(res) ? res : [];
            },
            scrollIntoView: async (selector) => {
              const res = await page.evaluate(buildDomScrollIntoViewScript(selector));
              return res && typeof res === "object" ? (res as DomElementMatch) : null;
            },
            tapDom: async (selector) => {
              const res = await page.evaluate(buildDomTapScript(selector));
              return Boolean(res);
            },
          };

    const service: RawDriverService = {
      ...(domChannel ? { domChannel } : {}),
      beginFlow: (flowName) =>
        Effect.tryPromise({
          try: () => beginFlow(flowName),
          catch: (e) => new DriverError({ message: `Failed to prepare flow ${flowName}: ${e}` }),
        }),

      dumpHierarchy: () =>
        Effect.tryPromise({
          try: async (): Promise<RawHierarchy> => {
            // page.evaluate runs in the browser context — DOM types exist there, not in our TS
            const tree = await page.evaluate(`
              (function() {
                function walk(el) {
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
                    value: (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") ? (el.value !== undefined ? String(el.value) : undefined) : undefined,
                    accessibilityLabel: el.getAttribute("aria-label") || undefined,
                    role: el.getAttribute("role") || undefined,
                    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    enabled: !el.hasAttribute("disabled"),
                    visible: isVisible && rect.width > 0 && rect.height > 0 && intersectsViewport,
                    clickable: el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.getAttribute("role") === "button" || el.onclick !== null,
                    attributes: (function() { var a = {}; for (var i = 0; i < el.attributes.length; i++) { var attr = el.attributes[i]; a[attr.name] = attr.value; } return Object.keys(a).length > 0 ? a : undefined; })(),
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
            await page.mouse.click(x, y);
            // Only wait for React Native Web focus retention when the tapped target is
            // actually an editable input; non-input buttons/links return immediately (~2ms vs 48ms).
            await page
              .evaluate(`
              (function() {
                var el = document.elementFromPoint(${x}, ${y});
                if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT")) {
                  return;
                }
                el.focus();
                return new Promise(function(resolve) {
                  requestAnimationFrame(function() {
                    var cur = document.elementFromPoint(${x}, ${y});
                    if (cur && (cur.tagName === "INPUT" || cur.tagName === "TEXTAREA" || cur.tagName === "SELECT")) {
                      cur.focus();
                    }
                    resolve();
                  });
                });
              })()
            `)
              .catch(() => {});
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
            await page.evaluate(`
              (function() {
                function isScrollable(el) {
                  if (!el) return false;
                  var style = window.getComputedStyle(el);
                  var canScrollY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
                  var canScrollX = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
                  return canScrollY || canScrollX;
                }
                function findScrollable(el) {
                  var current = el;
                  while (current && current !== document.body) {
                    if (isScrollable(current)) return current;
                    current = current.parentElement;
                  }
                  return document.scrollingElement || document.documentElement || document.body;
                }
                var target = document.elementFromPoint(${startX}, ${startY});
                var scroller = findScrollable(target);
                var left = ${startX - endX};
                var top = ${startY - endY};
                if (scroller && typeof scroller.scrollBy === "function") {
                  scroller.scrollBy({ left: left, top: top, behavior: "auto" });
                  return;
                }
                if (scroller) {
                  scroller.scrollLeft += left;
                  scroller.scrollTop += top;
                }
              })()
            `);
            await new Promise<void>((resolve) => setTimeout(resolve, duration));
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
            const targetUrl = opts?.deepLink || url || config.baseUrl || "about:blank";
            if (opts?.clearState) {
              await clearStorage();
            }
            if (hasLaunchDeviceState(opts?.deviceState)) {
              console.warn(
                "deviceState launch overrides are ignored in web mode. " +
                  "Use browser-specific emulation when execution.web adds that support.",
              );
            }
            await page.goto(
              targetUrl,
              config.waitUntil ? { waitUntil: config.waitUntil } : undefined,
            );
            updateHarPage(page);
            debugLog("launchApp", targetUrl);
          },
          catch: (e) => new DriverError({ message: `Failed to navigate to ${url}: ${e}` }),
        }),

      stopApp: (_id) =>
        Effect.tryPromise({
          try: async () => {
            await page.goto("about:blank");
            updateHarPage(page);
            debugLog("stopApp");
          },
          catch: (e) => new DriverError({ message: `Failed to stop app: ${e}` }),
        }),

      killApp: (_id) =>
        Effect.tryPromise({
          try: async () => {
            await Promise.allSettled([
              page.close(),
              context.close(),
              ...(ownsBrowser ? [browser.close()] : []),
            ]);
          },
          catch: (e) => new DriverError({ message: `Failed to kill app: ${e}` }),
        }),

      clearAppState: (_id) =>
        Effect.tryPromise({
          try: async () => {
            await clearStorage();
            debugLog("clearAppState");
          },
          catch: (e) => new DriverError({ message: `Failed to clear app state: ${e}` }),
        }),

      openLink: (url) =>
        Effect.tryPromise({
          try: async () => {
            await page.goto(url, config.waitUntil ? { waitUntil: config.waitUntil } : undefined);
            updateHarPage(page);
            debugLog("openLink", url);
          },
          catch: (e) => new DriverError({ message: `Failed to open link ${url}: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          try: async () => {
            await page.goBack();
            updateHarPage(page);
            debugLog("back", currentPageUrl(page));
          },
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
            debugLog("mockNetwork", typeof matcher === "string" ? matcher : matcher.toString());
          },
          catch: (e) => new DriverError({ message: `Failed to mock network route: ${e}` }),
        }),

      blockNetwork: (matcher) =>
        Effect.tryPromise({
          try: async () => {
            const definition: RouteDefinition = { kind: "block", matcher };
            routeDefinitions.push(definition);
            await applyRouteDefinition(definition);
            debugLog("blockNetwork", typeof matcher === "string" ? matcher : matcher.toString());
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
            debugLog("clearNetworkMocks");
          },
          catch: (e) => new DriverError({ message: `Failed to clear network mocks: ${e}` }),
        }),

      setNetworkConditions: (conditions) =>
        Effect.tryPromise({
          try: async () => {
            currentNetworkConditions = { ...conditions };
            await applyNetworkConditions();
            debugLog("setNetworkConditions", JSON.stringify(conditions));
          },
          catch: (e) => new DriverError({ message: `Failed to set network conditions: ${e}` }),
        }),

      saveCookies: (path) =>
        Effect.tryPromise({
          try: async () => {
            const cookies = await context.cookies();
            await writeFile(path, JSON.stringify(cookies, null, 2), "utf8");
            debugLog("saveCookies", path);
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
            debugLog("loadCookies", path);
          },
          catch: (e) => new DriverError({ message: `Failed to load cookies from ${path}: ${e}` }),
        }),

      saveAuthState: (path) =>
        Effect.tryPromise({
          try: async () => {
            await context.storageState({ path });
            debugLog("saveAuthState", path);
          },
          catch: (e) => new DriverError({ message: `Failed to save auth state to ${path}: ${e}` }),
        }),

      loadAuthState: (path) =>
        Effect.tryPromise({
          try: async () => {
            await replaceContext(path);
            updateHarPage(page);
            debugLog("loadAuthState", path);
          },
          catch: (e) =>
            new DriverError({ message: `Failed to load auth state from ${path}: ${e}` }),
        }),

      downloadFile: (path) =>
        Effect.tryPromise({
          try: async () => {
            const download = await nextDownload();
            await download.saveAs(path);
            debugLog("downloadFile", path, download.suggestedFilename());
          },
          catch: (e) => new DriverError({ message: `Failed to download file to ${path}: ${e}` }),
        }),

      uploadFile: (selector, path) =>
        Effect.tryPromise({
          try: async () => {
            await setInputFiles(selector, path);
            debugLog("uploadFile", path);
          },
          catch: (e) => new DriverError({ message: `Failed to upload file ${path}: ${e}` }),
        }),

      newTab: (url) =>
        Effect.tryPromise({
          try: async () => {
            const nextPage = await context.newPage();
            attachPageDiagnostics(nextPage);
            page = nextPage;
            if (url) {
              await nextPage.goto(url);
            }
            updateHarPage(nextPage);
            const tabId = getTabId(nextPage);
            debugLog("newTab", tabId, url ?? "about:blank");
            return tabId;
          },
          catch: (e) => new DriverError({ message: `Failed to open a new tab: ${e}` }),
        }),

      switchToTab: (index) =>
        Effect.tryPromise({
          try: async () => {
            const openPages = context.pages();
            const nextPage = openPages[index];
            if (!nextPage) {
              throw new Error(
                `Tab index ${index} is out of range. Open tabs: ${Math.max(openPages.length - 1, 0)}.`,
              );
            }
            page = nextPage;
            attachPageDiagnostics(page);
            updateHarPage(page);
            debugLog("switchToTab", index, getTabId(page));
          },
          catch: (e) => new DriverError({ message: `Failed to switch tabs: ${e}` }),
        }),

      closeTab: () =>
        Effect.tryPromise({
          try: async () => {
            const openPages = context.pages();
            if (openPages.length <= 1) {
              await page.goto("about:blank");
              updateHarPage(page);
              debugLog("closeTab", "last-tab-reset");
              return;
            }

            const currentIndex = openPages.indexOf(page);
            const fallbackIndex =
              currentIndex <= 0 ? 1 : Math.min(currentIndex - 1, openPages.length - 1);
            const fallbackPage = openPages[fallbackIndex]!;
            const closingTabId = getTabId(page);
            await page.close();
            page = fallbackPage;
            updateHarPage(page);
            debugLog("closeTab", closingTabId, "->", getTabId(page));
          },
          catch: (e) => new DriverError({ message: `Failed to close the current tab: ${e}` }),
        }),

      getTabIds: () =>
        Effect.sync(() => {
          const ids = context.pages().map((openPage) => getTabId(openPage));
          debugLog("getTabIds", ids.join(", "));
          return ids;
        }),

      getConsoleLogs: () => Effect.succeed([...consoleLogs]),

      getJSErrors: () => Effect.succeed([...jsErrors]),

      getHAR: () =>
        Effect.sync<BrowserHAR>(() => ({
          log: {
            version: "1.2",
            creator: {
              name: "spana",
              version: "dev",
            },
            browser: {
              name: browserLabels[browserName],
            },
            pages: Array.from(harPages.values()).map((harPage) => ({ ...harPage })),
            entries: [...harEntries],
          },
        })),
    };

    return service;
  });
}

export function PlaywrightDriverLive(
  config: PlaywrightConfig = {},
): Layer.Layer<RawDriver, DriverError> {
  return Layer.effect(RawDriver, makePlaywrightDriver(config));
}
