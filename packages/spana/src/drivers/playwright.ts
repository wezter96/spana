import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  buildDomFillScript,
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomWaitForSelectorScript,
  type DomChannel,
  type DomElementMatch,
  type DomWaitForMatchResult,
} from "../channels/dom-channel.js";
import { allocateFreePort } from "../core/port-allocator.js";
import { getHealthyWarmDaemon, registerWarmDaemon } from "../runtime/daemon-manager.js";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Download,
  type FrameLocator,
  type Locator,
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
  type BrowserCookie,
  type BrowserMockResponse,
  type BrowserResponseInfo,
  type NetworkConditions,
  type BrowserRouteMatcher,
  type BrowserConsoleLog,
  type BrowserHAR,
  type BrowserHAREntry,
  type BrowserHARHeader,
  type BrowserHARPage,
  type BrowserJSError,
  type CdpSessionHandle,
  type VirtualAuthenticatorOptions,
  type VirtualCredential,
  type VirtualCredentialInput,
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
  /** Connect to a remote Playwright WebSocket server (e.g. BrowserStack Automate Web `wss://cdp.browserstack.com/playwright?...`). */
  wsEndpoint?: string;
  /** Reuse a persistent detached headless Chromium daemon across CLI runs (Flashwright-style warm session). */
  warmBrowser?: boolean;
  /** Scope key for isolating warm Chromium daemons across concurrent repos/runs (defaults to cwd hash). */
  warmBrowserScope?: string;
  /** Create a fresh isolated BrowserContext per flow via a pre-warmed context pool + background teardown. */
  freshContextPerFlow?: boolean;
  /** Automatically attach a CDP WebAuthn virtual authenticator (passkey) to every fresh context. */
  virtualAuthenticator?: boolean | VirtualAuthenticatorOptions;
  /** Attach a built-in zero-setup Playwright DOM channel for ~1ms `{ testID }` queries without full DOM dumps. Default: true. */
  enableDomChannel?: boolean;
}

/**
 * Evaluate a string or function with arbitrary positional arguments on a Playwright Page.
 * Playwright's native `page.evaluate(fn, arg)` only accepts a single argument and silently
 * drops `args[1..]`. For 0–1 args we call `page.evaluate` directly (fast & mock-friendly);
 * for 2+ args we serialize a CSP-safe call expression evaluated via the browser protocol
 * (avoiding runtime `(0, eval)` which strict page CSP blocks).
 */
async function evaluateOnPage<T = unknown>(
  activePage: Page,
  script: string | ((...args: any[]) => T),
  args: unknown[],
): Promise<T> {
  if (typeof script === "string") {
    return (await activePage.evaluate(script)) as T;
  }
  if (args.length === 0) {
    return (await activePage.evaluate(script as never)) as T;
  }
  if (args.length === 1) {
    return (await activePage.evaluate(script as never, args[0] as never)) as T;
  }
  const serializedArgs = args
    .map((arg) => (arg === undefined ? "undefined" : JSON.stringify(arg)))
    .join(", ");
  return (await activePage.evaluate(`(${script.toString()})(${serializedArgs})`)) as T;
}

function resolveWarmBrowserKey(scope?: string): string {
  if (scope && scope.trim().length > 0) return scope.trim();
  const cwdHash = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 10);
  return `scope-${cwdHash}`;
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
  config: Pick<PlaywrightConfig, "executablePath" | "headless" | "warmBrowserScope"> = {},
): Promise<{ browser: Browser; cdpUrl: string; reused: boolean }> {
  const daemonKey = resolveWarmBrowserKey(config.warmBrowserScope);
  const existing = await getHealthyWarmDaemon("chromium", daemonKey, {
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

  const port = await allocateFreePort(9322);
  const userDataDir = mkdtempSync(join(tmpdir(), "spana-warm-chrome-"));
  const execPath = config.executablePath ?? chromium.executablePath();
  const child = spawn(
    execPath,
    [
      ...(config.headless !== false ? ["--headless=new"] : []),
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-ipc-flooding-protection",
      "--disable-hang-monitor",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
      ...(config.headless !== false ? ["--disable-gpu"] : []),
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
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
    rmSync(userDataDir, { recursive: true, force: true });
    throw new Error(`Warm Chromium daemon failed to start on ${cdpUrl}`);
  }

  registerWarmDaemon({
    kind: "chromium",
    deviceId: daemonKey,
    host: "127.0.0.1",
    port,
    pid: child.pid,
    userDataDir,
    startedAt: new Date().toISOString(),
  });

  const browser = await chromium.connectOverCDP(cdpUrl);
  return { browser, cdpUrl, reused: false };
}

export async function connectPlaywrightOverCDP(cdpEndpoint: string): Promise<Browser> {
  return chromium.connectOverCDP(cdpEndpoint);
}

export async function connectPlaywrightOverWS(
  wsEndpoint: string,
  browserName: BrowserName = "chromium",
): Promise<Browser> {
  return browserLaunchers[browserName].connect(wsEndpoint);
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

function selectorToFrameCss(frameSel: Selector): string {
  if (typeof frameSel === "string") return frameSel;
  if (typeof frameSel === "object" && frameSel !== null) {
    if ("css" in frameSel && frameSel.css) return frameSel.css;
    if ("testID" in frameSel && frameSel.testID) return `[data-testid="${frameSel.testID}"]`;
    if ("accessibilityLabel" in frameSel && frameSel.accessibilityLabel) {
      return `[aria-label="${frameSel.accessibilityLabel}"], iframe[title="${frameSel.accessibilityLabel}"]`;
    }
  }
  return "iframe";
}

function resolvePlaywrightLocator(
  root: Page | Locator | FrameLocator,
  selector: Selector,
): Locator {
  if (typeof selector === "string") {
    return root.getByLabel(selector, { exact: true });
  }
  if ("point" in selector) {
    throw new DriverError({
      message:
        "uploadFile() does not support point selectors on the web platform. Use testID, css, role, text, or accessibilityLabel.",
    });
  }

  let scope: Page | Locator | FrameLocator = root;
  if (selector.frame) {
    scope = scope.frameLocator(selectorToFrameCss(selector.frame));
  }
  if (selector.within) {
    scope = resolvePlaywrightLocator(scope, selector.within);
  }

  let locator: Locator;
  if ("css" in selector) {
    locator = scope.locator(selector.css);
  } else if ("role" in selector) {
    locator = scope.getByRole(selector.role as never, {
      ...(selector.name !== undefined ? { name: selector.name } : {}),
      ...(selector.exact !== undefined ? { exact: selector.exact } : {}),
    });
  } else if ("testID" in selector) {
    locator = scope.getByTestId(selector.testID);
  } else if ("accessibilityLabel" in selector) {
    locator = scope.getByLabel(selector.accessibilityLabel, { exact: true });
  } else {
    locator = scope.getByLabel(selector.text, { exact: true });
  }

  if (selector.hasText !== undefined) {
    locator = locator.filter({ hasText: selector.hasText });
  }
  if (selector.hasNotText !== undefined) {
    locator = locator.filter({ hasNotText: selector.hasNotText });
  }
  if (selector.first) {
    locator = locator.first();
  } else if (selector.last) {
    locator = locator.last();
  } else if (typeof selector.nth === "number") {
    locator = locator.nth(selector.nth);
  }
  return locator;
}

export function makePlaywrightDriver(
  config: PlaywrightConfig,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const browserName = config.browser ?? "chromium";
    const ownsBrowser =
      !config.sharedBrowser && !config.cdpEndpoint && !config.wsEndpoint && !config.warmBrowser;
    const browser = config.sharedBrowser
      ? config.sharedBrowser
      : config.wsEndpoint
        ? yield* Effect.tryPromise({
            try: () => browserLaunchers[browserName].connect(config.wsEndpoint!),
            catch: (e) =>
              new DriverError({
                message: `Failed to connect to remote Playwright server (${config.wsEndpoint}): ${e}`,
              }),
          })
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
    let activeAuthenticatorId: string | undefined;
    let hasRunFirstFlow = false;
    let prefetchedSlotPromise:
      | Promise<{
          context: BrowserContext;
          page: Page;
          cdpSession?: CDPSession;
          authenticatorId?: string;
        }>
      | undefined;
    const backgroundCloses: Array<Promise<unknown>> = [];
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

    const setInputFiles = async (selector: Selector, path: string | string[]) => {
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
            "uploadFile() does not support point selectors on the web platform. Use testID, css, role, text, or accessibilityLabel.",
        });
      }

      const hasModifiers = Boolean(
        selector.within ||
        selector.frame ||
        selector.hasText !== undefined ||
        selector.hasNotText !== undefined ||
        selector.nth !== undefined ||
        selector.first ||
        selector.last,
      );

      if (!hasModifiers) {
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
      }

      await resolvePlaywrightLocator(page, selector).setInputFiles(path);
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

    const ensureCdpSession = async (
      targetCtx: BrowserContext = context,
      targetPage: Page = page,
    ): Promise<CDPSession> => {
      if (targetCtx === context && targetPage === page && cdpSession) {
        return cdpSession;
      }
      const session = await targetCtx.newCDPSession(targetPage);
      if (targetCtx === context && targetPage === page) {
        cdpSession = session;
      }
      return session;
    };

    const attachVirtualAuthenticatorOn = async (
      targetCtx: BrowserContext,
      targetPage: Page,
      opts?: VirtualAuthenticatorOptions,
    ): Promise<{ session: CDPSession; authenticatorId: string }> => {
      if (browserName !== "chromium") {
        throw new DriverError({
          message: "enableVirtualAuthenticator() is only supported on Chromium browsers.",
        });
      }
      const session = await ensureCdpSession(targetCtx, targetPage);
      await session.send("WebAuthn.enable", { enableUI: false });
      const res = (await session.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: opts?.protocol ?? "ctap2",
          transport: opts?.transport ?? "internal",
          hasResidentKey: opts?.hasResidentKey ?? true,
          hasUserVerification: opts?.hasUserVerification ?? true,
          isUserVerified: opts?.isUserVerified ?? true,
          automaticPresenceSimulation: opts?.automaticPresenceSimulation ?? true,
        },
      })) as { authenticatorId?: string };
      return { session, authenticatorId: res?.authenticatorId ?? "virtual-auth-1" };
    };

    const closeContextInBackground = (oldContext: BrowserContext, oldPage?: Page, delayMs = 0) => {
      const trigger =
        delayMs > 0 ? new Promise<void>((r) => setTimeout(r, delayMs)) : Promise.resolve();
      const p = trigger
        .then(() => Promise.allSettled([...(oldPage ? [oldPage.close()] : []), oldContext.close()]))
        .catch(() => {})
        .finally(() => {
          const idx = backgroundCloses.indexOf(p);
          if (idx >= 0) backgroundCloses.splice(idx, 1);
        });
      backgroundCloses.push(p);
    };

    const prepareContextSlot = async (storageStatePath?: string) => {
      const nextCtx = await browser.newContext({
        acceptDownloads: true,
        ...(storageStatePath ? { storageState: storageStatePath } : {}),
      });
      await applyContextSpeedOptions(nextCtx);
      const nextPage = await nextCtx.newPage();
      let nextCdp: CDPSession | undefined;
      let nextAuthId: string | undefined;
      if (config.virtualAuthenticator && browserName === "chromium") {
        const authOpts =
          typeof config.virtualAuthenticator === "object" ? config.virtualAuthenticator : undefined;
        const attached = await attachVirtualAuthenticatorOn(nextCtx, nextPage, authOpts);
        nextCdp = attached.session;
        nextAuthId = attached.authenticatorId;
      }
      return {
        context: nextCtx,
        page: nextPage,
        cdpSession: nextCdp,
        authenticatorId: nextAuthId,
      };
    };

    const schedulePrefetchNextContext = () => {
      if (!config.freshContextPerFlow || prefetchedSlotPromise) return;
      prefetchedSlotPromise = prepareContextSlot(config.storageState);
      prefetchedSlotPromise.catch(() => {
        prefetchedSlotPromise = undefined;
      });
    };

    const createContextAndPage = async (storageStatePath?: string) => {
      const slot = await prepareContextSlot(storageStatePath);
      context = slot.context;
      page = slot.page;
      cdpSession = slot.cdpSession;
      activeAuthenticatorId = slot.authenticatorId;
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

      closeContextInBackground(previousContext, previousPage);
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

      if (config.freshContextPerFlow && hasRunFirstFlow) {
        const previousContext = context;
        const pendingSlot = prefetchedSlotPromise;
        prefetchedSlotPromise = undefined;
        const slot = pendingSlot
          ? await pendingSlot
          : await prepareContextSlot(config.storageState);
        context = slot.context;
        page = slot.page;
        cdpSession = slot.cdpSession;
        activeAuthenticatorId = slot.authenticatorId;
        attachPageDiagnostics(page);
        await reapplyRoutes();
        await applyNetworkConditions();
        // Close old context asynchronously after navigation settles (avoids colliding with next page load)
        closeContextInBackground(previousContext, undefined, 120);
      } else {
        const openPages = context.pages();
        if (openPages.length === 0) {
          page = await context.newPage();
        } else {
          const [firstPage, ...extraPages] = openPages;
          page = firstPage!;
          await Promise.all(extraPages.map((extraPage) => extraPage.close()));
        }
      }

      hasRunFirstFlow = true;

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
            ): Promise<T> => evaluateOnPage<T>(page, script, args),
            query: async (selector) => {
              const res = await page.evaluate(buildDomQueryScript(selector));
              return Array.isArray(res) ? res : [];
            },
            waitForSelector: async (selector, opts) => {
              const res = await page.evaluate(buildDomWaitForSelectorScript(selector, opts));
              return Array.isArray(res) ? res : [];
            },
            waitForHidden: async (selector, opts) => {
              const res = await page.evaluate(buildDomWaitForHiddenScript(selector, opts));
              return Boolean(res);
            },
            waitForMatch: async (selector, opts) => {
              const res = await page.evaluate(buildDomWaitForMatchScript(selector, opts));
              return res && typeof res === "object"
                ? (res as DomWaitForMatchResult)
                : { matched: false };
            },
            fillDom: async (selector, value, opts) => {
              const res = await page.evaluate(buildDomFillScript(selector, value, opts));
              return Boolean(res);
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
            schedulePrefetchNextContext();
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
            const prefetched = prefetchedSlotPromise;
            prefetchedSlotPromise = undefined;
            if (ownsBrowser) {
              // Close the active page/context/browser directly without waiting on
              // background-closing contexts (which browser.close() tears down instantly).
              await Promise.race([
                Promise.allSettled([page.close(), context.close(), browser.close()]),
                new Promise((r) => setTimeout(r, 5000)),
              ]);
              return;
            }
            const prefetchedClose = prefetched
              ? prefetched.then((slot) => slot.context.close()).catch(() => {})
              : Promise.resolve();
            const drain = Promise.allSettled([
              page.close(),
              context.close(),
              prefetchedClose,
              ...backgroundCloses,
            ]);
            await Promise.race([drain, new Promise((r) => setTimeout(r, 3000))]);
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
            schedulePrefetchNextContext();
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

      reload: (reloadOpts) =>
        Effect.tryPromise({
          try: async () => {
            const waitUntil = reloadOpts?.waitUntil ?? config.waitUntil;
            await page.reload(waitUntil ? { waitUntil } : undefined);
            updateHarPage(page);
            debugLog("reload", currentPageUrl(page));
          },
          catch: (e) => new DriverError({ message: `Failed to reload page: ${e}` }),
        }),

      hoverAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(x, y);
          },
          catch: (e) => new DriverError({ message: `Failed to hover at (${x}, ${y}): ${e}` }),
        }),

      getUrl: () => Effect.sync(() => currentPageUrl(page)),

      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: () => evaluateOnPage<T>(page, script, args),
          catch: (e) => new DriverError({ message: `Evaluate failed: ${e}` }),
        }),

      getRawPage: () => page,

      getCdpSession: (): CdpSessionHandle | undefined => {
        if (browserName !== "chromium") return undefined;
        return {
          send: async <T = Record<string, unknown>>(
            method: string,
            params?: Record<string, unknown>,
          ): Promise<T> => {
            const session = await ensureCdpSession();
            return (await session.send(method as never, params as never)) as T;
          },
          on: (event: string, listener: (params: Record<string, unknown>) => void) => {
            let unsubscribed = false;
            let attachedSession: CDPSession | undefined;
            const wrapped = (params: unknown) => {
              if (!unsubscribed) listener((params ?? {}) as Record<string, unknown>);
            };
            void ensureCdpSession()
              .then((session) => {
                if (unsubscribed) return;
                attachedSession = session;
                session.on(event as never, wrapped as never);
              })
              .catch(() => {});
            return () => {
              unsubscribed = true;
              if (attachedSession && typeof attachedSession.off === "function") {
                attachedSession.off(event as never, wrapped as never);
              }
            };
          },
        };
      },

      enableVirtualAuthenticator: (opts) =>
        Effect.tryPromise({
          try: async () => {
            const attached = await attachVirtualAuthenticatorOn(context, page, opts);
            activeAuthenticatorId = attached.authenticatorId;
            debugLog("enableVirtualAuthenticator", attached.authenticatorId);
            return attached.authenticatorId;
          },
          catch: (e) =>
            e instanceof DriverError
              ? e
              : new DriverError({ message: `Failed to enable virtual authenticator: ${e}` }),
        }),

      removeVirtualAuthenticator: (authenticatorId) =>
        Effect.tryPromise({
          try: async () => {
            const id = authenticatorId ?? activeAuthenticatorId;
            if (!id) return;
            const session = await ensureCdpSession();
            await session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: id });
            if (id === activeAuthenticatorId) activeAuthenticatorId = undefined;
            debugLog("removeVirtualAuthenticator", id);
          },
          catch: (e) =>
            new DriverError({ message: `Failed to remove virtual authenticator: ${e}` }),
        }),

      getVirtualCredentials: (authenticatorId) =>
        Effect.tryPromise({
          try: async () => {
            const id = authenticatorId ?? activeAuthenticatorId;
            if (!id) return [];
            const session = await ensureCdpSession();
            const res = (await session.send("WebAuthn.getCredentials", {
              authenticatorId: id,
            })) as { credentials?: VirtualCredential[] };
            return Array.isArray(res?.credentials) ? res.credentials : [];
          },
          catch: (e) => new DriverError({ message: `Failed to read virtual credentials: ${e}` }),
        }),

      addVirtualCredential: (credential: VirtualCredentialInput, authenticatorId?: string) =>
        Effect.tryPromise({
          try: async () => {
            if (browserName !== "chromium") {
              throw new DriverError({
                message: "addVirtualCredential() is only supported on Chromium browsers.",
              });
            }
            let id = authenticatorId ?? activeAuthenticatorId;
            if (!id) {
              const attached = await attachVirtualAuthenticatorOn(context, page);
              id = attached.authenticatorId;
              activeAuthenticatorId = id;
            }
            const session = await ensureCdpSession();
            await session.send("WebAuthn.addCredential", {
              authenticatorId: id,
              credential: {
                credentialId: credential.credentialId,
                isResidentCredential: credential.isResidentCredential,
                privateKey: credential.privateKey,
                signCount: credential.signCount ?? 0,
                ...(credential.rpId !== undefined ? { rpId: credential.rpId } : {}),
                ...(credential.userHandle !== undefined
                  ? { userHandle: credential.userHandle }
                  : {}),
                ...(credential.userName !== undefined ? { userName: credential.userName } : {}),
              },
            });
            debugLog("addVirtualCredential", id, credential.credentialId);
          },
          catch: (e) =>
            e instanceof DriverError
              ? e
              : new DriverError({ message: `Failed to import virtual credential: ${e}` }),
        }),

      clearVirtualCredentials: (authenticatorId) =>
        Effect.tryPromise({
          try: async () => {
            const id = authenticatorId ?? activeAuthenticatorId;
            if (!id) return;
            const session = await ensureCdpSession();
            await session.send("WebAuthn.clearCredentials", { authenticatorId: id });
            debugLog("clearVirtualCredentials", id);
          },
          catch: (e) => new DriverError({ message: `Failed to clear virtual credentials: ${e}` }),
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

      getCookies: (urls) =>
        Effect.tryPromise({
          try: async () => {
            const cookies = await (urls && urls.length > 0
              ? context.cookies(urls)
              : context.cookies());
            return cookies as unknown as BrowserCookie[];
          },
          catch: (e) => new DriverError({ message: `Failed to read cookies: ${e}` }),
        }),

      setCookies: (cookies) =>
        Effect.tryPromise({
          try: async () => {
            if (cookies.length === 0) return;
            await context.addCookies(cookies as never);
          },
          catch: (e) => new DriverError({ message: `Failed to set cookies: ${e}` }),
        }),

      clearCookies: () =>
        Effect.tryPromise({
          try: async () => {
            await context.clearCookies();
          },
          catch: (e) => new DriverError({ message: `Failed to clear cookies: ${e}` }),
        }),

      waitForResponse: (matcher, waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeout = waitOpts?.timeout ?? 15_000;
            const response = await page.waitForResponse(
              (res) => {
                const info: BrowserResponseInfo = {
                  url: res.url(),
                  status: res.status(),
                  statusText: res.statusText(),
                  headers: res.headers(),
                  method: res.request().method(),
                };
                if (typeof matcher === "function") return matcher(info);
                if (matcher instanceof RegExp) return matcher.test(info.url);
                return info.url.includes(matcher);
              },
              { timeout },
            );
            return {
              url: response.url(),
              status: response.status(),
              statusText: response.statusText(),
              headers: response.headers(),
              method: response.request().method(),
              body: () => response.text(),
              json: <T = unknown>() => response.json() as Promise<T>,
            };
          },
          catch: (e) => new DriverError({ message: `waitForResponse() failed: ${e}` }),
        }),

      createIsolatedContext: (ctxOpts) =>
        Effect.tryPromise({
          try: async () => {
            const childDriver = await Effect.runPromise(
              makePlaywrightDriver({
                ...config,
                sharedBrowser: browser,
                freshContextPerFlow: false,
                warmBrowser: false,
                cdpEndpoint: undefined,
                wsEndpoint: undefined,
              }),
            );
            if (ctxOpts?.url) {
              await Effect.runPromise(childDriver.openLink(ctxOpts.url));
            }
            return {
              driver: childDriver,
              close: async () => {
                await Effect.runPromise(childDriver.killApp("isolated-context")).catch(() => {});
              },
            };
          },
          catch: (e) => new DriverError({ message: `createIsolatedContext() failed: ${e}` }),
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
            debugLog("uploadFile", Array.isArray(path) ? path.join(", ") : path);
          },
          catch: (e) =>
            new DriverError({
              message: `Failed to upload file ${Array.isArray(path) ? path.join(", ") : path}: ${e}`,
            }),
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
