import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  buildDomFillScript,
  buildDomFrameEvaluateScript,
  buildDomQueryScript,
  buildDomScrollIntoViewScript,
  buildDomTapScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomWaitForSelectorScript,
  serializeEvaluateArg,
  type DomChannel,
  type DomElementMatch,
  type DomWaitForMatchResult,
} from "../channels/dom-channel.js";
import { allocateFreePort } from "../core/port-allocator.js";
import { getHealthyWarmDaemon, registerWarmDaemon } from "../runtime/daemon-manager.js";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Download,
  FrameLocator,
  Locator,
  Page,
  Request,
  Route,
} from "playwright-core";
import { DriverError } from "../errors.js";
import { buildDirectChromiumLaunchArgs } from "./cdp-browser.js";
import { hasLaunchDeviceState } from "./launch-options.js";
import { deviceEffect } from "./device-controls.js";
import { resolveNetworkConditions } from "./network-profiles.js";
import type { BrowserName, WebViewportConfig } from "../schemas/config.js";
import type { Selector } from "../schemas/selector.js";
import {
  RawDriver,
  type RawDriverService,
  type RawHierarchy,
  type LaunchOptions,
  type BrowserCookie,
  type BrowserDialogHandler,
  type BrowserDialogInfo,
  type BrowserDownloadInfo,
  type BrowserEmulationOptions,
  type BrowserMockResponse,
  type BrowserRequestInfo,
  type BrowserResponseInfo,
  type BrowserRoute,
  type BrowserRouteHandler,
  type HttpCredentials,
  type NetworkConditions,
  type BrowserRouteMatcher,
  type BrowserConsoleLog,
  type BrowserHAR,
  type BrowserHAREntry,
  type BrowserHARHeader,
  type BrowserHARPage,
  type BrowserJSError,
  type CdpSessionHandle,
  type UploadFileInput,
  type VirtualAuthenticatorOptions,
  type VirtualCredential,
  type VirtualCredentialInput,
} from "./raw-driver.js";

type RouteDefinition =
  | { kind: "mock"; matcher: BrowserRouteMatcher; response: BrowserMockResponse }
  | { kind: "block"; matcher: BrowserRouteMatcher }
  | { kind: "handler"; matcher: BrowserRouteMatcher; handler: BrowserRouteHandler };

interface AppliedRoute {
  matcher: BrowserRouteMatcher;
  handler: (route: Route) => Promise<void>;
  userHandler?: BrowserRouteHandler;
  definition: RouteDefinition;
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
  /** Extra browser launch arguments (forwarded to `browser.launch({ args })`). */
  args?: string[];
  /** Default viewport dimensions (and optional mobile/DPR/touch fields) for new contexts. */
  viewport?: WebViewportConfig;
  /** Device pixel ratio override (default: 1). */
  deviceScaleFactor?: number;
  /** Emulate mobile viewport meta tag & scrollbars. */
  mobile?: boolean;
  /** Playwright-compatible alias for `mobile`. */
  isMobile?: boolean;
  /** Enable touch event emulation (`'ontouchstart' in window`). */
  hasTouch?: boolean;
  /** HTTP Basic / Digest authentication credentials for new contexts. */
  httpCredentials?: HttpCredentials;
  /** Default locale (e.g. "en-US", "sv-SE") for new contexts. */
  locale?: string;
  /** Default User-Agent override for new contexts. */
  userAgent?: string;
  /** Default timezone ID for new contexts. */
  timezoneId?: string;
  /** Default prefers-color-scheme for new contexts. */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Default prefers-reduced-motion for new contexts. */
  reducedMotion?: "reduce" | "no-preference";
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
  /** Optional JS expression evaluated before fail-fast idle checks (sets `window.__SPANA_APP_READY__`). */
  readyExpression?: string;
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
  const serializedArgs = args.map((arg) => serializeEvaluateArg(arg)).join(", ");
  return (await activePage.evaluate(`(${script.toString()})(${serializedArgs})`)) as T;
}

function resolveWarmBrowserKey(scope?: string): string {
  if (scope && scope.trim().length > 0) return scope.trim();
  const cwdHash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 10);
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
async function loadPlaywrightCore() {
  return import("playwright-core");
}

async function getBrowserLauncher(browserName: BrowserName) {
  const pw = await loadPlaywrightCore();
  return pw[browserName];
}

export async function ensureWarmBrowserDaemon(
  config: Pick<PlaywrightConfig, "executablePath" | "headless" | "warmBrowserScope"> = {},
): Promise<{ browser: Browser; cdpUrl: string; reused: boolean }> {
  const { chromium } = await loadPlaywrightCore();
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
  const rawTmp = tmpdir();
  const safeTmpDir =
    process.platform === "linux" && rawTmp.length > 50 && existsSync("/tmp") ? "/tmp" : rawTmp;
  const userDataDir = mkdtempSync(join(safeTmpDir, "spana-warm-chrome-"));
  const execPath = config.executablePath ?? chromium.executablePath();
  const child = spawn(
    execPath,
    buildDirectChromiumLaunchArgs({
      userDataDir,
      remoteDebuggingPort: port,
      headless: config.headless,
    }),
    {
      detached: true,
      stdio: "ignore",
      ...(safeTmpDir !== rawTmp ? { env: { ...process.env, TMPDIR: safeTmpDir } } : {}),
    },
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
  const { chromium } = await loadPlaywrightCore();
  return chromium.connectOverCDP(cdpEndpoint);
}

export async function connectPlaywrightOverWS(
  wsEndpoint: string,
  browserName: BrowserName = "chromium",
): Promise<Browser> {
  const launcher = await getBrowserLauncher(browserName);
  return launcher.connect(wsEndpoint);
}

export async function launchPlaywrightBrowser(
  config: Pick<
    PlaywrightConfig,
    "browser" | "headless" | "channel" | "executablePath" | "args"
  > = {},
): Promise<Browser> {
  const browserName = config.browser ?? "chromium";
  const launcher = await getBrowserLauncher(browserName);
  return launcher.launch({
    headless: config.headless ?? true,
    ...(config.channel ? { channel: config.channel } : {}),
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
  });
}

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
  if ("anyOf" in selector) {
    const branches = selector.anyOf.map((branch) => resolvePlaywrightLocator(scope, branch));
    locator = branches.reduce((acc, next) => acc.or(next));
  } else if ("allOf" in selector) {
    const branches = selector.allOf.map((branch) => resolvePlaywrightLocator(scope, branch));
    locator = branches.reduce((acc, next) => acc.and(next));
  } else if ("css" in selector) {
    locator = scope.locator(selector.css);
  } else if ("role" in selector) {
    locator = scope.getByRole(selector.role as never, {
      ...(selector.name !== undefined ? { name: selector.name } : {}),
      ...(selector.exact !== undefined ? { exact: selector.exact } : {}),
      ...(selector.level !== undefined ? { level: selector.level } : {}),
      ...(selector.pressed !== undefined ? { pressed: selector.pressed } : {}),
      ...(selector.includeHidden !== undefined ? { includeHidden: selector.includeHidden } : {}),
    });
  } else if ("label" in selector) {
    locator = scope.getByLabel(
      selector.label,
      selector.exact !== undefined ? { exact: selector.exact } : undefined,
    );
  } else if ("placeholder" in selector) {
    locator = scope.getByPlaceholder(
      selector.placeholder,
      selector.exact !== undefined ? { exact: selector.exact } : undefined,
    );
  } else if ("altText" in selector) {
    locator = scope.getByAltText(
      selector.altText,
      selector.exact !== undefined ? { exact: selector.exact } : undefined,
    );
  } else if ("title" in selector) {
    locator = scope.getByTitle(
      selector.title,
      selector.exact !== undefined ? { exact: selector.exact } : undefined,
    );
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
  if (selector.has !== undefined) {
    locator = locator.filter({ has: resolvePlaywrightLocator(scope, selector.has) });
  }
  if (selector.hasNot !== undefined) {
    locator = locator.filter({ hasNot: resolvePlaywrightLocator(scope, selector.hasNot) });
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
            try: async () => (await getBrowserLauncher(browserName)).connect(config.wsEndpoint!),
            catch: (e) =>
              new DriverError({
                message: `Failed to connect to remote Playwright server (${config.wsEndpoint}): ${e}`,
              }),
          })
        : config.cdpEndpoint
          ? yield* Effect.tryPromise({
              try: async () =>
                (await loadPlaywrightCore()).chromium.connectOverCDP(config.cdpEndpoint!),
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
                try: async () =>
                  (await getBrowserLauncher(browserName)).launch({
                    headless: config.headless ?? true,
                    ...(config.channel ? { channel: config.channel } : {}),
                    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
                    ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
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
    let dialogHandler: BrowserDialogHandler | null = null;
    const attachedPages = new WeakSet<Page>();
    const navigationUrls: string[] = [];
    let lastNavigationStatus: number | null = null;
    let activeLocale = config.locale;
    let activeUserAgent = config.userAgent;
    const requestListeners = new Set<(req: BrowserRequestInfo) => void>();
    const toBrowserRequestInfo = (request: Request): BrowserRequestInfo => ({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      resourceType: request.resourceType(),
      postData: () => request.postData(),
      postDataJSON: <T = unknown>() => {
        try {
          return request.postDataJSON() as T;
        } catch {
          return null;
        }
      },
    });

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

      activePage.on("dialog", (dialog) => {
        const activeHandler = dialogHandler;
        if (!activeHandler) return;
        let handled = false;
        const info: BrowserDialogInfo = {
          type: dialog.type() as BrowserDialogInfo["type"],
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
          accept: async (promptText?: string) => {
            if (handled) return;
            handled = true;
            await dialog.accept(promptText);
          },
          dismiss: async () => {
            if (handled) return;
            handled = true;
            await dialog.dismiss();
          },
        };
        void Promise.resolve(activeHandler(info))
          .catch(() => {})
          .finally(() => {
            if (!handled) {
              handled = true;
              void dialog.dismiss().catch(() => {});
            }
          });
      });

      if (config.recordHar !== false) {
        activePage.on("requestfinished", (request) => {
          void recordRequestFinished(activePage, request).catch(() => {});
        });

        activePage.on("requestfailed", (request) => {
          void recordRequestFailed(activePage, request).catch(() => {});
        });
      }

      activePage.on("framenavigated", (frame) => {
        if (frame === activePage.mainFrame()) {
          const u = frame.url();
          if (u) {
            navigationUrls.push(u);
            if (navigationUrls.length > 50) navigationUrls.shift();
          }
        }
      });

      activePage.on("response", (response) => {
        try {
          if (
            response.frame() === activePage.mainFrame() &&
            response.request().isNavigationRequest()
          ) {
            lastNavigationStatus = response.status();
          }
        } catch {
          // ignore response tracking errors on closing pages
        }
      });

      activePage.on("request", (request) => {
        if (requestListeners.size === 0) return;
        const info = toBrowserRequestInfo(request);
        for (const listener of requestListeners) {
          try {
            listener(info);
          } catch {
            // ignore listener errors
          }
        }
      });

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
          : definition.kind === "block"
            ? async (route: Route) => {
                await route.abort();
              }
            : async (route: Route) => {
                let handled = false;
                const reqInfo = toBrowserRequestInfo(route.request());
                const wrapped: BrowserRoute = {
                  request: () => reqInfo,
                  continue: async (overrides) => {
                    if (handled) return;
                    handled = true;
                    await route.continue(overrides);
                  },
                  fallback: async (overrides) => {
                    if (handled) return;
                    handled = true;
                    await route.fallback(overrides);
                  },
                  abort: async (errorCode) => {
                    if (handled) return;
                    handled = true;
                    await route.abort(errorCode);
                  },
                  fulfill: async (response) => {
                    if (handled) return;
                    handled = true;
                    await route.fulfill(buildMockResponse(response));
                  },
                  fetch: async (overrides) => {
                    const res = await route.fetch(overrides);
                    return {
                      url: res.url(),
                      status: res.status(),
                      statusText: res.statusText(),
                      headers: res.headers(),
                      method: overrides?.method ?? reqInfo.method,
                      body: () => res.text(),
                      json: <T = unknown>() => res.json() as Promise<T>,
                    };
                  },
                };
                try {
                  await definition.handler(wrapped);
                } finally {
                  if (!handled) {
                    handled = true;
                    await route.continue().catch(() => {});
                  }
                }
              };

      await context.route(definition.matcher, handler);
      appliedRoutes.push({
        matcher: definition.matcher,
        handler,
        userHandler: definition.kind === "handler" ? definition.handler : undefined,
        definition,
      });
    };

    const reapplyRoutes = async () => {
      appliedRoutes = [];
      for (const definition of routeDefinitions) {
        await applyRouteDefinition(definition);
      }
    };

    const normalizePlaywrightFiles = (input: UploadFileInput) => {
      if (typeof input === "string") return input;
      const items = Array.isArray(input) ? input : [input];
      if (items.every((item) => typeof item === "string")) {
        return items as string[];
      }
      return items.map((item) =>
        typeof item === "string"
          ? item
          : {
              name: item.name,
              mimeType: item.mimeType,
              buffer: Buffer.from(item.buffer),
            },
      );
    };

    const setInputFiles = async (selector: Selector, path: UploadFileInput) => {
      const pwFiles = normalizePlaywrightFiles(path) as never;
      if (typeof selector === "string") {
        try {
          await page.getByLabel(selector, { exact: true }).setInputFiles(pwFiles);
          return;
        } catch {
          await page.getByText(selector, { exact: true }).setInputFiles(pwFiles);
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
          await page.getByTestId(selector.testID).setInputFiles(pwFiles);
          return;
        }

        if ("accessibilityLabel" in selector) {
          await page
            .getByLabel(selector.accessibilityLabel, { exact: true })
            .setInputFiles(pwFiles);
          return;
        }

        if ("text" in selector) {
          try {
            await page.getByLabel(selector.text, { exact: true }).setInputFiles(pwFiles);
            return;
          } catch {
            await page.getByText(selector.text, { exact: true }).setInputFiles(pwFiles);
            return;
          }
        }
      }

      await resolvePlaywrightLocator(page, selector).setInputFiles(pwFiles);
    };

    const applyContextSpeedOptions = async (ctx: BrowserContext) => {
      if (config.instantAnimations && typeof ctx.addInitScript === "function") {
        await ctx.addInitScript(INSTANT_ANIMATIONS_INIT_SCRIPT);
      }
      if (config.readyExpression && typeof ctx.addInitScript === "function") {
        const expr = config.readyExpression;
        await ctx.addInitScript(
          `(() => { window.__SPANA_APP_READY__ = () => { try { return Boolean(${expr}); } catch { return false; } }; })();`,
        );
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
      const effectiveDpr = config.deviceScaleFactor ?? config.viewport?.deviceScaleFactor;
      const effectiveIsMobile =
        config.isMobile ?? config.mobile ?? config.viewport?.isMobile ?? config.viewport?.mobile;
      const effectiveHasTouch = config.hasTouch ?? config.viewport?.hasTouch;
      const nextCtx = await browser.newContext({
        acceptDownloads: true,
        ...(storageStatePath ? { storageState: storageStatePath } : {}),
        ...(config.viewport
          ? { viewport: { width: config.viewport.width, height: config.viewport.height } }
          : {}),
        ...(effectiveDpr !== undefined ? { deviceScaleFactor: effectiveDpr } : {}),
        ...(effectiveIsMobile !== undefined ? { isMobile: effectiveIsMobile } : {}),
        ...(effectiveHasTouch !== undefined ? { hasTouch: effectiveHasTouch } : {}),
        ...(config.httpCredentials ? { httpCredentials: config.httpCredentials } : {}),
        ...(config.locale ? { locale: config.locale } : {}),
        ...(config.userAgent ? { userAgent: config.userAgent } : {}),
        ...(config.timezoneId ? { timezoneId: config.timezoneId } : {}),
        ...(config.colorScheme ? { colorScheme: config.colorScheme } : {}),
        ...(config.reducedMotion ? { reducedMotion: config.reducedMotion } : {}),
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

    let hasFlowInitScripts = false;
    const beginFlow = async (flowName: string) => {
      currentFlowName = flowName;
      resetWebDiagnostics();
      navigationUrls.length = 0;
      lastNavigationStatus = null;
      activeLocale = config.locale;
      activeUserAgent = config.userAgent;
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

      if ((config.freshContextPerFlow || hasFlowInitScripts) && hasRunFirstFlow) {
        hasFlowInitScripts = false;
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

    const queryCrossOriginPlaywrightFrames = async (
      selector: Selector,
    ): Promise<DomElementMatch[]> => {
      if (
        typeof selector !== "object" ||
        selector === null ||
        !("frame" in selector) ||
        !selector.frame
      ) {
        return [];
      }
      const { frame: frameSel, ...innerRest } = selector as unknown as Record<string, unknown>;
      const innerSel = innerRest as Selector;
      const frameCss = selectorToFrameCss(frameSel as Selector);
      const iframeHandle = await page
        .locator(frameCss)
        .first()
        .elementHandle()
        .catch(() => null);
      if (!iframeHandle) return [];
      const [contentFrame, frameBox] = await Promise.all([
        iframeHandle.contentFrame().catch(() => null),
        iframeHandle.boundingBox().catch(() => null),
      ]);
      if (!contentFrame) return [];
      const matches = await contentFrame.evaluate(buildDomQueryScript(innerSel)).catch(() => []);
      if (!Array.isArray(matches) || matches.length === 0) return [];
      const ox = frameBox?.x ?? 0;
      const oy = frameBox?.y ?? 0;
      return (matches as DomElementMatch[]).map((m) => ({
        ...m,
        inIframe: true,
        rect: { ...m.rect, x: m.rect.x + ox, y: m.rect.y + oy },
      }));
    };

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
            evaluateInFrame: async <T = unknown>(
              frameSelector: Selector,
              script: string | ((doc: any, win: any, ...args: any[]) => T),
              ...args: any[]
            ): Promise<T> => {
              const parentRes = (await page
                .evaluate(buildDomFrameEvaluateScript(frameSelector, script, args))
                .catch(() => null)) as { __spanaFrameEvalOk?: boolean; value?: T } | null;
              if (parentRes?.__spanaFrameEvalOk) {
                return parentRes.value as T;
              }
              const iframeHandle = await page
                .locator(selectorToFrameCss(frameSelector))
                .first()
                .elementHandle()
                .catch(() => null);
              const cf = iframeHandle ? await iframeHandle.contentFrame().catch(() => null) : null;
              if (!cf) {
                throw new Error(`Iframe matching ${JSON.stringify(frameSelector)} not found`);
              }
              const serializedArgs = args.map((a) => serializeEvaluateArg(a)).join(", ");
              const expr =
                typeof script === "function"
                  ? `(${script.toString()})(document, window${serializedArgs ? `, ${serializedArgs}` : ""})`
                  : script;
              return (await cf.evaluate(expr)) as T;
            },
            query: async (selector) => {
              const res = await page.evaluate(buildDomQueryScript(selector));
              if (Array.isArray(res) && res.length > 0) return res;
              return queryCrossOriginPlaywrightFrames(selector);
            },
            waitForSelector: async (selector, opts) => {
              if (
                typeof selector === "object" &&
                selector !== null &&
                "frame" in selector &&
                selector.frame
              ) {
                const start = Date.now();
                const timeoutMs = opts?.timeoutMs ?? 5000;
                while (Date.now() - start < timeoutMs) {
                  const res = await page.evaluate(buildDomQueryScript(selector));
                  const hits =
                    Array.isArray(res) && res.length > 0
                      ? (res as DomElementMatch[])
                      : await queryCrossOriginPlaywrightFrames(selector);
                  const filtered = hits.filter((m) => m.visible && (!opts?.forAction || m.enabled));
                  if (filtered.length > 0) return filtered;
                  await new Promise((r) => setTimeout(r, 50));
                }
                return [];
              }
              const res = await page.evaluate(buildDomWaitForSelectorScript(selector, opts));
              return Array.isArray(res) ? res : [];
            },
            waitForHidden: async (selector, opts) => {
              const res = await page.evaluate(buildDomWaitForHiddenScript(selector, opts));
              return Boolean(res);
            },
            supportsInlineTapGuard: () => true,
            checkTapGuard: async () => {
              try {
                return Boolean(
                  await page.evaluate(
                    `(() => {
                      const missed = Boolean(window.__spanaTapMissed);
                      if (window.__spanaTapGuardCleanup) window.__spanaTapGuardCleanup();
                      delete window.__spanaTapMissed;
                      return missed;
                    })()`,
                  ),
                );
              } catch {
                return false;
              }
            },
            waitForMatch: async (selector, opts) => {
              if (
                typeof selector === "object" &&
                selector !== null &&
                "frame" in selector &&
                selector.frame
              ) {
                const { frame: frameSel, ...innerRest } = selector as unknown as Record<
                  string,
                  unknown
                >;
                const frameCss = selectorToFrameCss(frameSel as Selector);
                const timeoutMs = opts?.timeoutMs ?? 5000;
                const deadline = Date.now() + timeoutMs;
                let cf: import("playwright-core").Frame | null = null;
                while (Date.now() < deadline) {
                  const iframeHandle = await page
                    .locator(frameCss)
                    .first()
                    .elementHandle()
                    .catch(() => null);
                  cf = iframeHandle ? await iframeHandle.contentFrame().catch(() => null) : null;
                  if (cf) break;
                  await new Promise((r) => setTimeout(r, 40));
                }
                if (!cf) {
                  throw new Error(
                    `Iframe matching ${JSON.stringify(frameSel)} not found within ${timeoutMs}ms`,
                  );
                }
                const remaining = Math.max(50, deadline - Date.now());
                const frameRes = await cf
                  .evaluate(
                    buildDomWaitForMatchScript(innerRest as Selector, {
                      ...opts,
                      timeoutMs: remaining,
                    }),
                  )
                  .catch(() => null);
                if (frameRes && typeof frameRes === "object") {
                  return frameRes as DomWaitForMatchResult;
                }
                return { matched: false };
              }
              const res = await page.evaluate(buildDomWaitForMatchScript(selector, opts));
              return res && typeof res === "object"
                ? (res as DomWaitForMatchResult)
                : { matched: false };
            },
            fillDom: async (selector, value, opts) => {
              const res = await page.evaluate(buildDomFillScript(selector, value, opts));
              if (res) return true;
              if (
                typeof selector === "object" &&
                selector !== null &&
                "frame" in selector &&
                selector.frame
              ) {
                const { frame: frameSel, ...innerRest } = selector as unknown as Record<
                  string,
                  unknown
                >;
                const iframeHandle = await page
                  .locator(selectorToFrameCss(frameSel as Selector))
                  .first()
                  .elementHandle()
                  .catch(() => null);
                const cf = iframeHandle
                  ? await iframeHandle.contentFrame().catch(() => null)
                  : null;
                if (cf) {
                  return Boolean(
                    await cf
                      .evaluate(buildDomFillScript(innerRest as Selector, value, opts))
                      .catch(() => false),
                  );
                }
              }
              return false;
            },
            scrollIntoView: async (selector) => {
              const res = await page.evaluate(buildDomScrollIntoViewScript(selector));
              return res && typeof res === "object" ? (res as DomElementMatch) : null;
            },
            tapDom: async (selector) => {
              const res = await page.evaluate(buildDomTapScript(selector));
              if (res) return true;
              if (
                typeof selector === "object" &&
                selector !== null &&
                "frame" in selector &&
                selector.frame
              ) {
                const { frame: frameSel, ...innerRest } = selector as unknown as Record<
                  string,
                  unknown
                >;
                const iframeHandle = await page
                  .locator(selectorToFrameCss(frameSel as Selector))
                  .first()
                  .elementHandle()
                  .catch(() => null);
                const cf = iframeHandle
                  ? await iframeHandle.contentFrame().catch(() => null)
                  : null;
                if (cf) {
                  return Boolean(
                    await cf.evaluate(buildDomTapScript(innerRest as Selector)).catch(() => false),
                  );
                }
              }
              return false;
            },
          };

    let coveragePage: Page | undefined;
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
                  var isVisible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
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
                    visible: isVisible && rect.width > 0 && rect.height > 0,
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

      typeText: (text, opts) =>
        Effect.tryPromise({
          try: () => page.keyboard.type(text, opts?.delay ? { delay: opts.delay } : undefined),
          catch: (e) => new DriverError({ message: `Failed to type text: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          try: () => page.keyboard.press(key),
          catch: (e) => new DriverError({ message: `Failed to press key ${key}: ${e}` }),
        }),

      keyDown: (key) =>
        Effect.tryPromise({
          try: () => page.keyboard.down(key),
          catch: (e) => new DriverError({ message: `Failed to press keyDown ${key}: ${e}` }),
        }),

      keyUp: (key) =>
        Effect.tryPromise({
          try: () => page.keyboard.up(key),
          catch: (e) => new DriverError({ message: `Failed to release keyUp ${key}: ${e}` }),
        }),

      mouseDown: (x, y, opts) =>
        Effect.tryPromise({
          try: async () => {
            const resolvedOpts =
              typeof x === "object" && x !== null
                ? (x as { button?: "left" | "right" | "middle" })
                : opts;
            if (typeof x === "number" && typeof y === "number") {
              await page.mouse.move(x, y);
            }
            await page.mouse.down({ button: resolvedOpts?.button ?? "left" });
          },
          catch: (e) => new DriverError({ message: `Failed to mouseDown at (${x}, ${y}): ${e}` }),
        }),

      mouseUp: (x, y, opts) =>
        Effect.tryPromise({
          try: async () => {
            const resolvedOpts =
              typeof x === "object" && x !== null
                ? (x as { button?: "left" | "right" | "middle" })
                : opts;
            if (typeof x === "number" && typeof y === "number") {
              await page.mouse.move(x, y);
            }
            await page.mouse.up({ button: resolvedOpts?.button ?? "left" });
          },
          catch: (e) => new DriverError({ message: `Failed to mouseUp at (${x}, ${y}): ${e}` }),
        }),

      mouseWheel: (x, y, deltaX, deltaY) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(x, y);
            await page.mouse.wheel(deltaX, deltaY);
          },
          catch: (e) =>
            new DriverError({
              message: `Failed to mouseWheel (${deltaX}, ${deltaY}) at (${x}, ${y}): ${e}`,
            }),
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

      takeFullPageScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            const buffer = await page.screenshot({ fullPage: true });
            return new Uint8Array(buffer);
          },
          catch: (e) => new DriverError({ message: `Failed to take fullPage screenshot: ${e}` }),
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
            const rawTarget = opts?.deepLink || url || config.baseUrl || "about:blank";
            const resolveTargetUrl = (raw: string): string => {
              if (
                raw.startsWith("http://") ||
                raw.startsWith("https://") ||
                raw === "about:blank" ||
                raw.startsWith("data:") ||
                raw.startsWith("file:")
              ) {
                return raw;
              }
              if (config.baseUrl && config.baseUrl !== "about:blank") {
                try {
                  return new URL(raw, config.baseUrl).toString();
                } catch {
                  return `${config.baseUrl.replace(/\/$/, "")}/${raw.replace(/^\//, "")}`;
                }
              }
              const cur = currentPageUrl(page);
              if (cur.startsWith("http://") || cur.startsWith("https://")) {
                try {
                  return new URL(raw, new URL(cur).origin).toString();
                } catch {
                  // fall through
                }
              }
              return raw;
            };
            const targetUrl = resolveTargetUrl(rawTarget);
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
            let targetUrl = url;
            if (
              !url.startsWith("http://") &&
              !url.startsWith("https://") &&
              url !== "about:blank" &&
              !url.startsWith("data:") &&
              !url.startsWith("file:")
            ) {
              if (config.baseUrl && config.baseUrl !== "about:blank") {
                try {
                  targetUrl = new URL(url, config.baseUrl).toString();
                } catch {
                  targetUrl = `${config.baseUrl.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
                }
              } else {
                const cur = currentPageUrl(page);
                if (cur.startsWith("http://") || cur.startsWith("https://")) {
                  try {
                    targetUrl = new URL(url, new URL(cur).origin).toString();
                  } catch {
                    // keep raw url
                  }
                }
              }
            }
            const navRes = await page.goto(
              targetUrl,
              config.waitUntil ? { waitUntil: config.waitUntil } : undefined,
            );
            lastNavigationStatus = navRes ? navRes.status() : null;
            updateHarPage(page);
            schedulePrefetchNextContext();
            debugLog("openLink", targetUrl);
          },
          catch: (e) => new DriverError({ message: `Failed to open link ${url}: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          try: async () => {
            const navRes = await page.goBack();
            if (navRes) lastNavigationStatus = navRes.status();
            updateHarPage(page);
            debugLog("back", currentPageUrl(page));
          },
          catch: (e) => new DriverError({ message: `Failed to go back: ${e}` }),
        }),

      forward: () =>
        Effect.tryPromise({
          try: async () => {
            const navRes = await page.goForward();
            if (navRes) lastNavigationStatus = navRes.status();
            updateHarPage(page);
            debugLog("forward", currentPageUrl(page));
          },
          catch: (e) => new DriverError({ message: `Failed to go forward: ${e}` }),
        }),

      reload: (reloadOpts) =>
        Effect.tryPromise({
          try: async () => {
            const waitUntil = reloadOpts?.waitUntil ?? config.waitUntil;
            const navRes = await page.reload(waitUntil ? { waitUntil } : undefined);
            if (navRes) lastNavigationStatus = navRes.status();
            updateHarPage(page);
            debugLog("reload", currentPageUrl(page));
          },
          catch: (e) => new DriverError({ message: `Failed to reload page: ${e}` }),
        }),

      hoverAtCoordinate: (x, y, opts) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(x, y, opts?.steps ? { steps: opts.steps } : undefined);
          },
          catch: (e) => new DriverError({ message: `Failed to hover at (${x}, ${y}): ${e}` }),
        }),

      getUrl: () => Effect.sync(() => currentPageUrl(page)),

      getNavigationUrls: () => [...navigationUrls],

      getLastNavigationStatus: () => lastNavigationStatus,

      waitForLoadState: (state = "load", waitOpts) =>
        Effect.tryPromise({
          try: () => page.waitForLoadState(state, waitOpts),
          catch: (e) => new DriverError({ message: `waitForLoadState() failed: ${e}` }),
        }),

      waitForPopup: (triggerFn, waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeout = waitOpts?.timeout ?? 15_000;
            const popupPromise = page.waitForEvent("popup", { timeout });
            await triggerFn();
            const popup = await popupPromise;
            attachPageDiagnostics(popup);
            return getTabId(popup);
          },
          catch: (e) => new DriverError({ message: `waitForPopup() failed: ${e}` }),
        }),

      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: () => evaluateOnPage<T>(page, script, args),
          catch: (e) => new DriverError({ message: `Evaluate failed: ${e}` }),
        }),

      addInitScript: (script, ...args) =>
        Effect.tryPromise({
          try: async () => {
            hasFlowInitScripts = true;
            const source =
              typeof script === "string"
                ? script
                : `(${script.toString()})(${args.map((a) => serializeEvaluateArg(a)).join(", ")});`;
            await context.addInitScript(source);
          },
          catch: (e) => new DriverError({ message: `addInitScript() failed: ${e}` }),
        }),

      exposeFunction: (name, fn) =>
        Effect.tryPromise({
          try: () => context.exposeFunction(name, fn),
          catch: (e) => new DriverError({ message: `exposeFunction() failed: ${e}` }),
        }),

      getRawPage: () => page,

      getAriaSnapshot: (selector, timeout) =>
        deviceEffect("getAriaSnapshot", () => {
          if (typeof selector === "string") {
            return page
              .getByLabel(selector, { exact: true })
              .or(page.getByText(selector, { exact: true }))
              .ariaSnapshot({ timeout });
          }
          if ("point" in selector) throw new Error("ARIA snapshots require a locator, not a point");
          return resolvePlaywrightLocator(
            page,
            "text" in selector
              ? { ...selector, css: `text=${JSON.stringify(selector.text)}` }
              : selector,
          ).ariaSnapshot({ timeout });
        }),

      ...(browserName === "chromium"
        ? {
            startJSCoverage: () =>
              deviceEffect("startJSCoverage", async () => {
                const target = page;
                await target.coverage.startJSCoverage({ resetOnNavigation: false });
                coveragePage = target;
              }),
            stopJSCoverage: () =>
              deviceEffect("stopJSCoverage", async () => {
                const target = coveragePage;
                coveragePage = undefined;
                if (!target) throw new Error("JavaScript coverage was not started");
                return target.coverage.stopJSCoverage();
              }),
          }
        : {}),

      setGeolocation: (point) =>
        deviceEffect("setGeolocation", () => context.setGeolocation(point)),

      setSystemTime: (time) => deviceEffect("setSystemTime", () => page.clock.setSystemTime(time)),

      setPermission: (_appId, permission, state, options) =>
        deviceEffect("setPermission", async () => {
          if (state === "grant") {
            await context.grantPermissions([permission], options);
            return;
          }
          if (browserName !== "chromium")
            throw new Error(`Permission denial is not supported on ${browserName} (web)`);
          const session = await ensureCdpSession();
          const {
            targetInfo: { browserContextId },
          } = await session.send("Target.getTargetInfo");
          if (!browserContextId)
            throw new Error("Could not resolve Chromium's browser context for permission denial");
          const name = permission === "midi-sysex" ? "midi" : permission;
          await session.send("Browser.setPermission", {
            permission: { name, ...(permission === "midi-sysex" ? { sysex: true } : {}) },
            setting: "denied",
            ...(options?.origin ? { origin: options.origin } : {}),
            browserContextId,
          });
        }),

      setOrientation: (orientation) =>
        deviceEffect("setOrientation", async () => {
          const viewport =
            page.viewportSize() ??
            (await page.evaluate<{ width: number; height: number }>(
              "({ width: window.innerWidth, height: window.innerHeight })",
            ));
          const { width, height } = viewport;
          if (
            (orientation === "portrait" && width > height) ||
            (orientation === "landscape" && height > width)
          ) {
            await page.setViewportSize({ width: height, height: width });
          }
        }),

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

      route: (matcher, handler) =>
        Effect.tryPromise({
          try: async () => {
            const definition: RouteDefinition = { kind: "handler", matcher, handler };
            routeDefinitions.push(definition);
            await applyRouteDefinition(definition);
            debugLog("route", typeof matcher === "string" ? matcher : matcher.toString());
          },
          catch: (e) => new DriverError({ message: `Failed to register route: ${e}` }),
        }),

      unroute: (matcher, handler) =>
        Effect.tryPromise({
          try: async () => {
            const matchesSame = (a: BrowserRouteMatcher, b: BrowserRouteMatcher): boolean => {
              if (a === b) return true;
              if (a instanceof RegExp && b instanceof RegExp) {
                return a.source === b.source && a.flags === b.flags;
              }
              return false;
            };
            const remainingApplied: AppliedRoute[] = [];
            const removedDefs = new Set<RouteDefinition>();
            for (const appliedRoute of appliedRoutes) {
              const sameMatcher = matchesSame(appliedRoute.matcher, matcher);
              const sameHandler = handler === undefined || appliedRoute.userHandler === handler;
              if (sameMatcher && sameHandler) {
                await context.unroute(appliedRoute.matcher, appliedRoute.handler);
                removedDefs.add(appliedRoute.definition);
              } else {
                remainingApplied.push(appliedRoute);
              }
            }
            appliedRoutes = remainingApplied;
            for (let i = routeDefinitions.length - 1; i >= 0; i--) {
              if (removedDefs.has(routeDefinitions[i]!)) {
                routeDefinitions.splice(i, 1);
              }
            }
            debugLog("unroute", typeof matcher === "string" ? matcher : matcher.toString());
          },
          catch: (e) => new DriverError({ message: `Failed to unroute: ${e}` }),
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
            const matches = (
              res: import("playwright-core").Response,
            ): BrowserResponseInfo | null => {
              const info: BrowserResponseInfo = {
                url: res.url(),
                status: res.status(),
                statusText: res.statusText(),
                headers: res.headers(),
                method: res.request().method(),
                body: () => res.text(),
                json: <T = unknown>() => res.json() as Promise<T>,
              };
              const ok =
                typeof matcher === "function"
                  ? matcher(info)
                  : matcher instanceof RegExp
                    ? matcher.test(info.url)
                    : info.url.includes(matcher);
              return ok ? info : null;
            };

            return await new Promise<BrowserResponseInfo>((resolve, reject) => {
              const watchedPages = new Set<Page>();
              let settled = false;
              const onResponse = (res: import("playwright-core").Response) => {
                if (settled) return;
                const hit = matches(res);
                if (hit) {
                  cleanup();
                  resolve(hit);
                }
              };
              const attachPage = (p: Page) => {
                if (watchedPages.has(p)) return;
                watchedPages.add(p);
                p.on("response", onResponse);
              };
              const onNewPage = (p: Page) => {
                if (!settled) attachPage(p);
              };
              const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                context.off("page", onNewPage);
                for (const p of watchedPages) {
                  p.off("response", onResponse);
                }
                watchedPages.clear();
              };
              const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timed out waiting for response after ${timeout}ms`));
              }, timeout);

              for (const existingPage of context.pages()) {
                attachPage(existingPage);
              }
              attachPage(page);
              context.on("page", onNewPage);
            });
          },
          catch: (e) => new DriverError({ message: `waitForResponse() failed: ${e}` }),
        }),

      onRequest: (listener) => {
        requestListeners.add(listener);
        return () => {
          requestListeners.delete(listener);
        };
      },

      waitForRequest: (matcher, waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeout = waitOpts?.timeout ?? 15_000;
            return await new Promise<BrowserRequestInfo>((resolve, reject) => {
              let settled = false;
              const cleanup = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                requestListeners.delete(onReq);
              };
              const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timed out waiting for request after ${timeout}ms`));
              }, timeout);
              const onReq = (req: BrowserRequestInfo) => {
                const matched =
                  typeof matcher === "function"
                    ? matcher(req)
                    : matcher instanceof RegExp
                      ? matcher.test(req.url)
                      : req.url.includes(matcher);
                if (matched) {
                  cleanup();
                  resolve(req);
                }
              };
              requestListeners.add(onReq);
            });
          },
          catch: (e) => new DriverError({ message: `waitForRequest() failed: ${e}` }),
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
                ...(ctxOpts?.viewport ? { viewport: ctxOpts.viewport } : {}),
                ...(ctxOpts?.deviceScaleFactor !== undefined
                  ? { deviceScaleFactor: ctxOpts.deviceScaleFactor }
                  : {}),
                ...(ctxOpts?.mobile !== undefined ? { mobile: ctxOpts.mobile } : {}),
                ...(ctxOpts?.isMobile !== undefined ? { isMobile: ctxOpts.isMobile } : {}),
                ...(ctxOpts?.hasTouch !== undefined ? { hasTouch: ctxOpts.hasTouch } : {}),
                ...(ctxOpts?.httpCredentials ? { httpCredentials: ctxOpts.httpCredentials } : {}),
                ...(ctxOpts?.locale ? { locale: ctxOpts.locale } : {}),
                ...(ctxOpts?.userAgent ? { userAgent: ctxOpts.userAgent } : {}),
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

      dragAndDrop: (fromX, fromY, toX, toY, steps = 10) =>
        Effect.tryPromise({
          try: async () => {
            await page.mouse.move(fromX, fromY);
            await page.mouse.down();
            await page.mouse.move(toX, toY, { steps: Math.max(1, Math.round(steps)) });
            await page.mouse.up();
          },
          catch: (e) => new DriverError({ message: `Failed to dragAndDrop: ${e}` }),
        }),

      setViewport: (viewport) =>
        Effect.tryPromise({
          try: async () => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            const hasMobileOpts =
              viewport.deviceScaleFactor !== undefined ||
              viewport.mobile !== undefined ||
              viewport.isMobile !== undefined ||
              viewport.hasTouch !== undefined;
            if (hasMobileOpts && browserName === "chromium") {
              const session = await ensureCdpSession();
              const dpr = viewport.deviceScaleFactor ?? config.deviceScaleFactor ?? 1;
              const isMob = Boolean(
                viewport.isMobile ?? viewport.mobile ?? config.isMobile ?? config.mobile ?? false,
              );
              await session
                .send("Emulation.setDeviceMetricsOverride", {
                  width: viewport.width,
                  height: viewport.height,
                  deviceScaleFactor: dpr,
                  mobile: isMob,
                })
                .catch(() => {});
              if (viewport.hasTouch !== undefined) {
                await session
                  .send("Emulation.setTouchEmulationEnabled", {
                    enabled: viewport.hasTouch,
                    ...(viewport.hasTouch ? { maxTouchPoints: 5 } : {}),
                  })
                  .catch(() => {});
              }
            }
          },
          catch: (e) => new DriverError({ message: `Failed to set viewport: ${e}` }),
        }),

      setEmulation: (emulationOpts: BrowserEmulationOptions) =>
        Effect.tryPromise({
          try: async () => {
            if (
              emulationOpts.colorScheme !== undefined ||
              emulationOpts.reducedMotion !== undefined
            ) {
              await page.emulateMedia({
                ...(emulationOpts.colorScheme !== undefined
                  ? { colorScheme: emulationOpts.colorScheme }
                  : {}),
                ...(emulationOpts.reducedMotion !== undefined
                  ? { reducedMotion: emulationOpts.reducedMotion }
                  : {}),
              });
            }
            if (emulationOpts.locale !== undefined) {
              activeLocale = emulationOpts.locale;
            }
            if (emulationOpts.userAgent !== undefined) {
              activeUserAgent = emulationOpts.userAgent;
            }
            if (
              browserName === "chromium" &&
              (emulationOpts.locale !== undefined ||
                emulationOpts.timezoneId !== undefined ||
                emulationOpts.userAgent !== undefined)
            ) {
              const session = await ensureCdpSession();
              if (emulationOpts.locale !== undefined) {
                await session
                  .send("Emulation.setLocaleOverride", { locale: emulationOpts.locale })
                  .catch(() => {});
              }
              if (emulationOpts.timezoneId !== undefined) {
                await session
                  .send("Emulation.setTimezoneOverride", { timezoneId: emulationOpts.timezoneId })
                  .catch(() => {});
              }
              if (emulationOpts.userAgent !== undefined || emulationOpts.locale !== undefined) {
                let uaToUse = activeUserAgent;
                if (!uaToUse) {
                  const currentUa = await page.evaluate(() => navigator.userAgent).catch(() => "");
                  uaToUse = currentUa ? currentUa.replaceAll("HeadlessChrome/", "Chrome/") : "";
                }
                await session
                  .send("Emulation.setUserAgentOverride", {
                    userAgent: uaToUse,
                    ...(activeLocale ? { acceptLanguage: activeLocale } : {}),
                  })
                  .catch(() => {});
              }
            }
          },
          catch: (e) => new DriverError({ message: `Failed to set emulation: ${e}` }),
        }),

      setDialogHandler: (handler) =>
        Effect.sync(() => {
          dialogHandler = handler;
        }),

      getClipboard: () =>
        Effect.tryPromise({
          try: async () => {
            if (browserName === "chromium") {
              await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
            }
            const val = await page.evaluate<string>(`(async () => {
              if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
                try { return await navigator.clipboard.readText(); } catch {}
              }
              return typeof window.__spanaClipboardText === "string" ? window.__spanaClipboardText : "";
            })()`);
            return typeof val === "string" ? val : "";
          },
          catch: (e) => new DriverError({ message: `Failed to read clipboard: ${e}` }),
        }),

      setClipboard: (text) =>
        Effect.tryPromise({
          try: async () => {
            if (browserName === "chromium") {
              await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
            }
            const encoded = JSON.stringify(text);
            await page.evaluate(`(async (txt) => {
              window.__spanaClipboardText = txt;
              if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
                try { await navigator.clipboard.writeText(txt); } catch {}
              }
            })(${encoded})`);
          },
          catch: (e) => new DriverError({ message: `Failed to write clipboard: ${e}` }),
        }),

      waitForDownload: (triggerFn, dlOpts) =>
        Effect.tryPromise({
          try: async (): Promise<BrowserDownloadInfo> => {
            const timeout = dlOpts?.timeout ?? 15_000;
            const downloadPromise = page.waitForEvent("download", { timeout });
            await triggerFn();
            const download = await downloadPromise;
            const filePath =
              (await download.path()) ?? join(tmpdir(), download.suggestedFilename());
            return {
              suggestedFilename: download.suggestedFilename(),
              path: filePath,
              url: download.url(),
              text: async () => {
                const actualPath = await download.path();
                if (!actualPath) {
                  throw new Error("Download path unavailable (remote browser?)");
                }
                return readFile(actualPath, "utf8");
              },
              bytes: async () => {
                const actualPath = await download.path();
                if (!actualPath) {
                  throw new Error("Download path unavailable (remote browser?)");
                }
                return new Uint8Array(await readFile(actualPath));
              },
              saveAs: (destPath: string) => download.saveAs(destPath),
            };
          },
          catch: (e) => new DriverError({ message: `waitForDownload() failed: ${e}` }),
        }),

      uploadFile: (selector, path) =>
        Effect.tryPromise({
          try: async () => {
            await setInputFiles(selector, path);
            const label = Array.isArray(path)
              ? path.map((p) => (typeof p === "string" ? p : p.name)).join(", ")
              : typeof path === "string"
                ? path
                : path.name;
            debugLog("uploadFile", label);
          },
          catch: (e) => {
            const label = Array.isArray(path)
              ? path.map((p) => (typeof p === "string" ? p : p.name)).join(", ")
              : typeof path === "string"
                ? path
                : path.name;
            return new DriverError({
              message: `Failed to upload file ${label}: ${e}`,
            });
          },
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
