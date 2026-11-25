import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DriverError } from "../errors.js";
import { allocatePort } from "../core/port-allocator.js";
import { getHealthyWarmDaemon, registerWarmDaemon } from "../runtime/daemon-manager.js";
import { resolveNetworkConditions } from "./network-profiles.js";
import type { Selector } from "../schemas/selector.js";
import type {
  BrowserConsoleLog,
  BrowserJSError,
  BrowserMockResponse,
  BrowserRouteMatcher,
  NetworkConditions,
  RawDriverService,
  RawHierarchy,
  VirtualAuthenticatorOptions,
  VirtualCredential,
} from "./raw-driver.js";
import { CdpDomChannel, type WebSocketFactory } from "../channels/cdp-client.js";

export interface DirectCdpBrowserLaunchOptions {
  /** Explicit Chromium/Chrome binary path. Auto-detects system Chrome or Playwright Chromium if omitted. */
  executablePath?: string;
  /** Run headless (default: true). */
  headless?: boolean;
  /** Reuse a detached warm Chromium daemon across CLI runs. */
  warmBrowser?: boolean;
  /** Isolation scope key for warm Chromium daemon (defaults to cwd hash). */
  warmBrowserScope?: string;
  /** Extra Chrome launch flags. */
  args?: string[];
}

export interface DirectCdpBrowserHandle {
  /** HTTP debugging endpoint, e.g. `http://127.0.0.1:9322`. */
  httpEndpoint: string;
  /** Browser-level CDP WebSocket URL (`ws://127.0.0.1:.../devtools/browser/...`). */
  browserWsUrl: string;
  /** True when attached to a pre-existing warm daemon (close will NOT kill it). */
  reused: boolean;
  pid?: number;
  close(): Promise<void>;
}

const INSTANT_ANIMATIONS_CDP_SCRIPT = `
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

function resolveDirectCdpScopeKey(scope?: string): string {
  if (scope && scope.trim().length > 0) return scope.trim();
  const cwdHash = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 10);
  return `cdp-${cwdHash}`;
}

function resolveChromiumExecutable(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit;
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "linux"
        ? [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ]
        : [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return explicit ?? "google-chrome";
}

async function fetchBrowserWsUrl(httpEndpoint: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpEndpoint}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        const data = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
      }
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Direct CDP browser did not expose /json/version on ${httpEndpoint}`);
}

/**
 * Launch (or attach to a warm) Chromium process directly over raw CDP WebSocket —
 * completely bypassing Playwright's Node client↔server IPC pipe!
 */
export async function launchDirectCdpBrowser(
  options: DirectCdpBrowserLaunchOptions = {},
): Promise<DirectCdpBrowserHandle> {
  const daemonKey = resolveDirectCdpScopeKey(options.warmBrowserScope);
  if (options.warmBrowser) {
    const existing = await getHealthyWarmDaemon("chromium", daemonKey, {
      statusPath: "/json/version",
    });
    if (existing) {
      const httpEndpoint = `http://${existing.host}:${existing.port}`;
      try {
        const browserWsUrl = await fetchBrowserWsUrl(httpEndpoint, 1500);
        return {
          httpEndpoint,
          browserWsUrl,
          reused: true,
          pid: existing.pid,
          close: async () => {},
        };
      } catch {
        // Fall through to launch fresh browser
      }
    }
  }

  let execPath = options.executablePath;
  if (!execPath) {
    try {
      const { chromium } = await import("playwright-core");
      const pwPath = chromium.executablePath();
      if (pwPath && existsSync(pwPath)) {
        execPath = pwPath;
      }
    } catch {
      // ignore — fall back to system Chrome
    }
  }
  execPath = resolveChromiumExecutable(execPath);

  const port = allocatePort(9350);
  // Fresh throwaway profile: never expose the user's real Chrome profile (cookies, logins) over CDP.
  const userDataDir = mkdtempSync(join(tmpdir(), "spana-cdp-profile-"));
  const chromeArgs = [
    ...(options.headless !== false ? ["--headless=new"] : []),
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
    ...(options.headless !== false ? ["--disable-gpu"] : []),
    "--metrics-recording-only",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
    ...(options.args ?? []),
    "about:blank",
  ];

  const child: ChildProcess = spawn(execPath, chromeArgs, {
    detached: Boolean(options.warmBrowser),
    stdio: "ignore",
  });
  if (options.warmBrowser) {
    child.unref();
  }

  const httpEndpoint = `http://127.0.0.1:${port}`;
  const browserWsUrl = await fetchBrowserWsUrl(httpEndpoint, 10_000);

  if (options.warmBrowser) {
    registerWarmDaemon({
      kind: "chromium",
      deviceId: daemonKey,
      host: "127.0.0.1",
      port,
      pid: child.pid,
      startedAt: new Date().toISOString(),
    });
  }

  return {
    httpEndpoint,
    browserWsUrl,
    reused: Boolean(options.warmBrowser),
    pid: child.pid,
    close: async () => {
      if (options.warmBrowser) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      await new Promise((r) => setTimeout(r, 200));
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

export interface LightweightCdpDriverOptions {
  /**
   * HTTP CDP endpoint (e.g. `"http://127.0.0.1:9222"` for Lightpanda or Chrome `--remote-debugging-port`)
   * OR direct WebSocket debugger URL (`"ws://127.0.0.1:9222/devtools/page/..."` or `"/devtools/browser/..."`).
   */
  cdpUrl: string;
  /** Optional base URL used when `launchApp()` receives a relative path. */
  baseUrl?: string;
  /** Engine label reported in `getDeviceInfo()` (e.g. `"lightpanda"` or `"cdp"`). */
  engineLabel?: string;
  /** Optional viewport dimensions reported to coordinator (default: 1280×720). */
  viewport?: { width: number; height: number };
  /**
   * Use isolated CDP browser contexts (`Target.createBrowserContext` + flattened CDP sessions)
   * on a browser-level WebSocket — zero Playwright Node client↔server pipe!
   * Auto-enabled when `cdpUrl` is a `/devtools/browser/` URL or `freshContextPerFlow` is true.
   */
  useBrowserContexts?: boolean;
  /** Pre-warm the next isolated CDP browser context while the current flow runs, and dispose old contexts asynchronously. */
  freshContextPerFlow?: boolean;
  /** Navigation wait condition (`"load"`, `"domcontentloaded"`, or `"commit"`). Default: `"load"` in browser-context mode. */
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  /** Collapse CSS transitions & animations to 0.001ms via `Page.addScriptToEvaluateOnNewDocument`. */
  instantAnimations?: boolean;
  /** Abort specified resource types before hitting the network. */
  blockResources?: Array<"image" | "font" | "media" | "stylesheet">;
  /** Automatically attach a CDP WebAuthn virtual authenticator (passkey) to every context. */
  virtualAuthenticator?: boolean | VirtualAuthenticatorOptions;
  /** Optional Playwright-compatible storageState JSON path to preload into contexts. */
  storageState?: string;
  /** Injectable fetch & WebSocket factory for tests. */
  fetchFn?: typeof fetch;
  createWebSocket?: WebSocketFactory;
}

const CDP_DUMP_HIERARCHY_SCRIPT = `(() => {
  function walk(el) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const style = window.getComputedStyle ? window.getComputedStyle(el) : { display: "block", visibility: "visible", opacity: "1" };
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") !== 0;
    const tag = (el.tagName || "").toLowerCase();
    return {
      id: el.getAttribute?.("data-testid") || el.getAttribute?.("testID") || el.id || undefined,
      text: el.children?.length === 0 ? (el.textContent || "").trim() || undefined : undefined,
      accessibilityLabel: el.getAttribute?.("aria-label") || undefined,
      elementType: tag,
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible,
      enabled: !el.hasAttribute?.("disabled"),
      clickable: tag === "button" || tag === "a" || tag === "input" || el.getAttribute?.("role") === "button",
      children: Array.from(el.children || []).map(walk),
    };
  }
  return document.body ? JSON.stringify(walk(document.body)) : JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 0 }, children: [] });
})()`;

interface CdpTabEntry {
  tabId: string;
  targetId: string;
  sessionId: string;
}

interface CdpContextSlot {
  browserContextId: string;
  targetId: string;
  sessionId: string;
  authenticatorId?: string;
  tabs: CdpTabEntry[];
}

interface CdpRouteRule {
  kind: "mock" | "block";
  matcher: BrowserRouteMatcher;
  response?: BrowserMockResponse;
}

function matchUrl(matcher: BrowserRouteMatcher, url: string): boolean {
  if (matcher instanceof RegExp) return matcher.test(url);
  if (matcher.includes("*")) {
    const escaped = matcher
      .replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*");
    return new RegExp(escaped).test(url);
  }
  return url.includes(matcher);
}

const RESOURCE_BLOCK_PATTERNS: Record<string, string[]> = {
  image: ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.svg", "*.ico", "*.avif"],
  font: ["*.woff", "*.woff2", "*.ttf", "*.otf", "*.eot"],
  media: ["*.mp4", "*.webm", "*.ogg", "*.mp3", "*.wav", "*.m4a"],
  stylesheet: ["*.css"],
};

/**
 * Direct CDP Chromium / Lightpanda driver speaking raw WebSocket CDP directly
 * from Bun/Node to the browser — completely eliminating Playwright's Node
 * client↔server IPC pipe!
 *
 * Supports:
 * - Page-level attach (Lightpanda or existing tab)
 * - Full browser-level isolated contexts (`Target.createBrowserContext`), pre-warmed
 *   context pooling (`freshContextPerFlow`), background async context disposal,
 *   built-in WebAuthn virtual passkeys, network mocking (`Fetch`), cookies/auth state,
 *   and single-round-trip MutationObserver actionability via `CdpDomChannel`.
 */
export function makeLightweightCdpDriver(
  options: LightweightCdpDriverOptions,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const isBrowserWs = options.cdpUrl.includes("/devtools/browser/");
    const useContexts = Boolean(
      options.useBrowserContexts || options.freshContextPerFlow || isBrowserWs,
    );
    const isWs = options.cdpUrl.startsWith("ws://") || options.cdpUrl.startsWith("wss://");

    const httpEndpoint = isWs
      ? options.cdpUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/devtools\/.*$/, "")
      : options.cdpUrl.replace(/\/+$/, "");

    let connectWsUrl: string | undefined = isWs ? options.cdpUrl : undefined;
    if (useContexts && !connectWsUrl) {
      connectWsUrl = yield* Effect.tryPromise({
        try: () => fetchBrowserWsUrl(httpEndpoint, 5000),
        catch: (e) =>
          new DriverError({
            message: `Failed to resolve browser CDP WebSocket at ${options.cdpUrl}: ${e}`,
          }),
      });
    }

    const cdpChannel = new CdpDomChannel({
      endpointUrl: httpEndpoint,
      ...(connectWsUrl ? { webSocketUrl: connectWsUrl } : {}),
      fetchFn: options.fetchFn,
      createWebSocket: options.createWebSocket,
    });

    yield* Effect.tryPromise({
      try: () => cdpChannel.connect(),
      catch: (e) =>
        new DriverError({
          message: `Failed to connect lightweight CDP browser at ${options.cdpUrl}: ${e}`,
        }),
    });

    const width = options.viewport?.width ?? 1280;
    const height = options.viewport?.height ?? 720;
    const label = options.engineLabel ?? "cdp";

    let activeSlot: CdpContextSlot | undefined;
    let prefetchedSlotPromise: Promise<CdpContextSlot> | undefined;
    let hasRunFirstFlow = false;
    let activeAuthenticatorId: string | undefined;
    const backgroundDisposals: Array<Promise<unknown>> = [];
    const consoleLogs: BrowserConsoleLog[] = [];
    const jsErrors: BrowserJSError[] = [];
    const routeRules: CdpRouteRule[] = [];
    let fetchInterceptEnabled = false;
    let nextTabSeq = 1;
    let downloadDir: string | undefined;
    const completedDownloads: string[] = [];
    const downloadWaiters: Array<{
      resolve: (filePath: string) => void;
      reject: (err: Error) => void;
    }> = [];
    const pendingDownloadGuids = new Map<string, string>();

    cdpChannel.onEvent("Browser.downloadWillBegin", (params) => {
      if (params?.guid && downloadDir) {
        pendingDownloadGuids.set(String(params.guid), join(downloadDir, String(params.guid)));
      }
    });

    cdpChannel.onEvent("Browser.downloadProgress", (params) => {
      if (params?.state === "completed" && params?.guid) {
        const filePath =
          pendingDownloadGuids.get(String(params.guid)) ??
          (downloadDir ? join(downloadDir, String(params.guid)) : "");
        pendingDownloadGuids.delete(String(params.guid));
        if (!filePath) return;
        const waiter = downloadWaiters.shift();
        if (waiter) waiter.resolve(filePath);
        else completedDownloads.push(filePath);
      }
    });

    const loadStorageStateFile = async (
      path?: string,
    ): Promise<{
      cookies?: Array<Record<string, unknown>>;
      origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
    } | null> => {
      if (!path) return null;
      try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const attachVirtualAuthenticatorForSession = async (
      sessionId: string | null,
      opts?: VirtualAuthenticatorOptions,
    ): Promise<string> => {
      await cdpChannel.sendCommand("WebAuthn.enable", { enableUI: false }, sessionId);
      const res = (await cdpChannel.sendCommand(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: opts?.protocol ?? "ctap2",
            transport: opts?.transport ?? "internal",
            hasResidentKey: opts?.hasResidentKey ?? true,
            hasUserVerification: opts?.hasUserVerification ?? true,
            isUserVerified: opts?.isUserVerified ?? true,
            automaticPresenceSimulation: opts?.automaticPresenceSimulation ?? true,
          },
        },
        sessionId,
      )) as { authenticatorId?: string };
      return res?.authenticatorId ?? "cdp-virtual-auth-1";
    };

    const configureSession = async (sessionId: string | null, storageStatePath?: string) => {
      const state = await loadStorageStateFile(storageStatePath);
      const needsNetworkDomain = Boolean(
        (options.blockResources && options.blockResources.length > 0) ||
        (state?.cookies && state.cookies.length > 0),
      );
      await Promise.all([
        cdpChannel.sendCommand("Page.enable", {}, sessionId).catch(() => {}),
        cdpChannel.sendCommand("Runtime.enable", {}, sessionId).catch(() => {}),
        ...(needsNetworkDomain
          ? [cdpChannel.sendCommand("Network.enable", {}, sessionId).catch(() => {})]
          : []),
        cdpChannel
          .sendCommand(
            "Emulation.setDeviceMetricsOverride",
            { width, height, deviceScaleFactor: 1, mobile: false },
            sessionId,
          )
          .catch(() => {}),
      ]);

      if (options.instantAnimations) {
        await cdpChannel
          .sendCommand(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: INSTANT_ANIMATIONS_CDP_SCRIPT },
            sessionId,
          )
          .catch(() => {});
      }

      if (options.blockResources && options.blockResources.length > 0) {
        const urls = options.blockResources.flatMap((t) => RESOURCE_BLOCK_PATTERNS[t] ?? []);
        if (urls.length > 0) {
          await cdpChannel
            .sendCommand("Network.setBlockedURLs", { urls }, sessionId)
            .catch(() => {});
        }
      }

      if (state?.cookies && state.cookies.length > 0) {
        await cdpChannel
          .sendCommand("Network.setCookies", { cookies: state.cookies }, sessionId)
          .catch(() => {});
      }
      if (state?.origins && state.origins.length > 0) {
        const originsJson = JSON.stringify(state.origins);
        await cdpChannel
          .sendCommand(
            "Page.addScriptToEvaluateOnNewDocument",
            {
              source: `(() => {
                const origins = ${originsJson};
                const hit = origins.find((o) => o.origin === window.location.origin);
                if (hit && Array.isArray(hit.localStorage)) {
                  for (const item of hit.localStorage) {
                    try { window.localStorage.setItem(item.name, item.value); } catch {}
                  }
                }
              })();`,
            },
            sessionId,
          )
          .catch(() => {});
      }

      if (routeRules.length > 0) {
        await cdpChannel
          .sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId)
          .catch(() => {});
      }

      let authenticatorId: string | undefined;
      if (options.virtualAuthenticator) {
        const authOpts =
          typeof options.virtualAuthenticator === "object"
            ? options.virtualAuthenticator
            : undefined;
        authenticatorId = await attachVirtualAuthenticatorForSession(sessionId, authOpts).catch(
          () => undefined,
        );
      }
      return authenticatorId;
    };

    const createContextSlot = async (storageStatePath?: string): Promise<CdpContextSlot> => {
      const ctxRes = (await cdpChannel.sendCommand(
        "Target.createBrowserContext",
        { disposeOnDetach: true },
        null,
      )) as { browserContextId: string };
      const targetRes = (await cdpChannel.sendCommand(
        "Target.createTarget",
        { url: "about:blank", browserContextId: ctxRes.browserContextId, width, height },
        null,
      )) as { targetId: string };
      const attachRes = (await cdpChannel.sendCommand(
        "Target.attachToTarget",
        { targetId: targetRes.targetId, flatten: true },
        null,
      )) as { sessionId: string };

      const authenticatorId = await configureSession(
        attachRes.sessionId,
        storageStatePath ?? options.storageState,
      );
      const firstTabId = `tab-${nextTabSeq++}`;
      return {
        browserContextId: ctxRes.browserContextId,
        targetId: targetRes.targetId,
        sessionId: attachRes.sessionId,
        authenticatorId,
        tabs: [{ tabId: firstTabId, targetId: targetRes.targetId, sessionId: attachRes.sessionId }],
      };
    };

    const disposeSlotInBackground = (slot: CdpContextSlot) => {
      const p = new Promise<void>((r) => setTimeout(r, 120))
        .then(() =>
          cdpChannel.sendCommand(
            "Target.disposeBrowserContext",
            { browserContextId: slot.browserContextId },
            null,
          ),
        )
        .catch(() => {})
        .finally(() => {
          const idx = backgroundDisposals.indexOf(p);
          if (idx >= 0) backgroundDisposals.splice(idx, 1);
        });
      backgroundDisposals.push(p);
    };

    const schedulePrefetch = () => {
      if (!useContexts || !options.freshContextPerFlow || prefetchedSlotPromise) return;
      prefetchedSlotPromise = createContextSlot(options.storageState);
      prefetchedSlotPromise.catch(() => {
        prefetchedSlotPromise = undefined;
      });
    };

    // Capture console logs, JS errors, and Fetch interception over the single raw WS
    cdpChannel.onEvent("Runtime.consoleAPICalled", (params, sid) => {
      if (activeSlot && sid && sid !== activeSlot.sessionId) return;
      const args = Array.isArray(params?.args)
        ? params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")
        : "";
      consoleLogs.push({ type: String(params?.type ?? "log"), text: args });
    });

    cdpChannel.onEvent("Runtime.exceptionThrown", (params, sid) => {
      if (activeSlot && sid && sid !== activeSlot.sessionId) return;
      const detail = params?.exceptionDetails;
      jsErrors.push({
        name: detail?.exception?.className ?? "Error",
        message: detail?.exception?.description ?? detail?.text ?? "Uncaught exception",
      });
    });

    cdpChannel.onEvent("Fetch.requestPaused", (params, sid) => {
      const reqId = params?.requestId;
      const url = String(params?.request?.url ?? "");
      if (!reqId) return;
      const rule = routeRules.find((r) => matchUrl(r.matcher, url));
      if (!rule) {
        void cdpChannel
          .sendCommand("Fetch.continueRequest", { requestId: reqId }, sid ?? null)
          .catch(() => {});
        return;
      }
      if (rule.kind === "block") {
        void cdpChannel
          .sendCommand(
            "Fetch.failRequest",
            { requestId: reqId, errorReason: "BlockedByClient" },
            sid ?? null,
          )
          .catch(() => {});
        return;
      }
      const resp = rule.response ?? {};
      const bodyStr = resp.json !== undefined ? JSON.stringify(resp.json) : (resp.body ?? "");
      const headersObj: Record<string, string> = { ...resp.headers };
      if (
        resp.contentType &&
        !Object.keys(headersObj).some((k) => k.toLowerCase() === "content-type")
      ) {
        headersObj["content-type"] = resp.contentType;
      } else if (
        resp.json !== undefined &&
        !Object.keys(headersObj).some((k) => k.toLowerCase() === "content-type")
      ) {
        headersObj["content-type"] = "application/json";
      }
      const responseHeaders = Object.entries(headersObj).map(([name, value]) => ({ name, value }));
      void cdpChannel
        .sendCommand(
          "Fetch.fulfillRequest",
          {
            requestId: reqId,
            responseCode: resp.status ?? 200,
            responseHeaders,
            body: Buffer.from(bodyStr, "utf8").toString("base64"),
          },
          sid ?? null,
        )
        .catch(() => {});
    });

    if (useContexts) {
      activeSlot = yield* Effect.tryPromise({
        try: () => createContextSlot(options.storageState),
        catch: (e) =>
          new DriverError({ message: `Failed to create direct CDP browser context: ${e}` }),
      });
      cdpChannel.setSessionId(activeSlot.sessionId);
      activeAuthenticatorId = activeSlot.authenticatorId;
    }

    const resolveUrl = (rawUrl: string): string =>
      rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl === "about:blank"
        ? rawUrl
        : options.baseUrl
          ? `${options.baseUrl.replace(/\/$/, "")}/${rawUrl.replace(/^\//, "")}`
          : rawUrl;

    const navigate = async (rawUrl: string) => {
      const target = resolveUrl(rawUrl);
      if (!useContexts) {
        await cdpChannel.sendCommand("Page.enable").catch(() => {});
        await cdpChannel.sendCommand("Page.navigate", { url: target });
        return;
      }

      const waitUntil = options.waitUntil ?? "load";
      const targetSid = activeSlot?.sessionId;
      if (waitUntil === "commit" || target === "about:blank") {
        await cdpChannel.sendCommand("Page.navigate", { url: target });
        return;
      }

      const eventName =
        waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
      const waiter = cdpChannel.waitForEvent(
        eventName,
        15_000,
        (_p, sid) => !targetSid || !sid || sid === targetSid,
      );
      await cdpChannel.sendCommand("Page.navigate", { url: target });
      await waiter.catch(() => {});
      // Pre-warm the next fresh context AFTER navigation settles so renderer spawn
      // never contends with the active flow's page load!
      schedulePrefetch();
    };

    const ensureFetchIntercept = async () => {
      if (fetchInterceptEnabled) return;
      fetchInterceptEnabled = true;
      await cdpChannel.sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    };

    const service: RawDriverService = {
      domChannel: cdpChannel,

      beginFlow: (_flowName) =>
        Effect.tryPromise({
          try: async () => {
            consoleLogs.length = 0;
            jsErrors.length = 0;
            if (useContexts && options.freshContextPerFlow && hasRunFirstFlow) {
              const previousSlot = activeSlot;
              const pending = prefetchedSlotPromise;
              prefetchedSlotPromise = undefined;
              activeSlot = pending ? await pending : await createContextSlot(options.storageState);
              cdpChannel.setSessionId(activeSlot.sessionId);
              activeAuthenticatorId = activeSlot.authenticatorId;
              if (previousSlot) {
                disposeSlotInBackground(previousSlot);
              }
            }
            hasRunFirstFlow = true;
          },
          catch: (e) => new DriverError({ message: `CDP beginFlow failed: ${e}` }),
        }),

      dumpHierarchy: () =>
        Effect.tryPromise({
          try: async () => {
            const raw = await cdpChannel.evaluate<string>(CDP_DUMP_HIERARCHY_SCRIPT);
            return (raw ?? "{}") as RawHierarchy;
          },
          catch: (e) => new DriverError({ message: `CDP dumpHierarchy failed: ${e}` }),
        }),

      tapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            // Pipeline move + down + up on the FIFO-ordered CDP WebSocket (1 RTT instead of 3)
            await Promise.all([
              cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x,
                y,
              }),
              cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x,
                y,
                button: "left",
                clickCount: 1,
              }),
              cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x,
                y,
                button: "left",
                clickCount: 1,
              }),
            ]);
          },
          catch: (e) => new DriverError({ message: `CDP tap failed at (${x}, ${y}): ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 2,
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 2,
            });
          },
          catch: (e) => new DriverError({ message: `CDP doubleTap failed: ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
            await new Promise((r) => setTimeout(r, duration));
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              clickCount: 1,
            });
          },
          catch: (e) => new DriverError({ message: `CDP longPress failed: ${e}` }),
        }),

      swipe: (startX, startY, endX, endY) =>
        Effect.tryPromise({
          try: async () => {
            const dx = startX - endX;
            const dy = startY - endY;
            await cdpChannel.evaluate(`window.scrollBy(${dx}, ${dy})`);
          },
          catch: (e) => new DriverError({ message: `CDP swipe failed: ${e}` }),
        }),

      inputText: (text) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.insertText", { text });
          },
          catch: (e) => new DriverError({ message: `CDP inputText failed: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key });
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
          },
          catch: (e) => new DriverError({ message: `CDP pressKey failed: ${e}` }),
        }),

      hideKeyboard: () => Effect.void,

      takeScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            const res = (await cdpChannel.sendCommand("Page.captureScreenshot", {
              format: "png",
            })) as { data?: string };
            return new Uint8Array(Buffer.from(res?.data ?? "", "base64"));
          },
          catch: (e) => new DriverError({ message: `CDP screenshot failed: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.succeed({
          platform: "web" as const,
          deviceId: `${label}:${options.cdpUrl}`,
          name: `${label} (CDP-direct)`,
          isEmulator: true,
          screenWidth: width,
          screenHeight: height,
          driverType: "cdp" as any,
        }),

      launchApp: (url, opts) =>
        Effect.tryPromise({
          try: async () => {
            if (opts?.clearState) {
              await cdpChannel.sendCommand("Network.clearBrowserCookies").catch(() => {});
              await cdpChannel.evaluate(
                "try { localStorage.clear(); sessionStorage.clear(); } catch {}",
              );
            }
            await navigate(opts?.deepLink || url || options.baseUrl || "about:blank");
          },
          catch: (e) => new DriverError({ message: `CDP launchApp failed: ${e}` }),
        }),

      stopApp: () =>
        Effect.tryPromise({
          try: () => navigate("about:blank"),
          catch: (e) => new DriverError({ message: `CDP stopApp failed: ${e}` }),
        }),

      killApp: () =>
        Effect.tryPromise({
          try: async () => {
            const pendingPrefetch = prefetchedSlotPromise;
            prefetchedSlotPromise = undefined;
            if (useContexts) {
              const slotsToDispose: CdpContextSlot[] = [];
              if (activeSlot) slotsToDispose.push(activeSlot);
              if (pendingPrefetch) {
                const prefetched = await pendingPrefetch.catch(() => undefined);
                if (prefetched) slotsToDispose.push(prefetched);
              }
              await Promise.allSettled([
                ...slotsToDispose.map((s) =>
                  cdpChannel.sendCommand(
                    "Target.disposeBrowserContext",
                    { browserContextId: s.browserContextId },
                    null,
                  ),
                ),
                ...backgroundDisposals,
              ]);
            }
            if (downloadDir) {
              try {
                rmSync(downloadDir, { recursive: true, force: true });
              } catch {
                // ignore temp dir cleanup errors
              }
              downloadDir = undefined;
            }
            await cdpChannel.disconnect();
          },
          catch: (e) => new DriverError({ message: `CDP disconnect failed: ${e}` }),
        }),

      clearAppState: () =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Network.clearBrowserCookies").catch(() => {});
            await cdpChannel.evaluate(
              "try { localStorage.clear(); sessionStorage.clear(); } catch {}",
            );
          },
          catch: (e) => new DriverError({ message: `CDP clearAppState failed: ${e}` }),
        }),

      openLink: (url) =>
        Effect.tryPromise({
          try: () => navigate(url),
          catch: (e) => new DriverError({ message: `CDP openLink failed: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.evaluate("window.history.back()");
          },
          catch: (e) => new DriverError({ message: `CDP back failed: ${e}` }),
        }),

      evaluate: (fn, ...args) =>
        Effect.tryPromise({
          try: async () => {
            if (typeof fn === "string") {
              return (await cdpChannel.evaluate(fn)) as any;
            }
            const serializedArgs = args.map((a) => JSON.stringify(a)).join(", ");
            return (await cdpChannel.evaluate(`(${fn.toString()})(${serializedArgs})`)) as any;
          },
          catch: (e) => new DriverError({ message: `CDP evaluate failed: ${e}` }),
        }),

      getRawPage: () => ({
        kind: "cdp",
        cdpChannel,
        sessionId: activeSlot?.sessionId ?? null,
        browserContextId: activeSlot?.browserContextId ?? null,
      }),

      mockNetwork: (matcher, response) =>
        Effect.tryPromise({
          try: async () => {
            routeRules.push({ kind: "mock", matcher, response });
            await ensureFetchIntercept();
          },
          catch: (e) => new DriverError({ message: `CDP mockNetwork failed: ${e}` }),
        }),

      blockNetwork: (matcher) =>
        Effect.tryPromise({
          try: async () => {
            routeRules.push({ kind: "block", matcher });
            await ensureFetchIntercept();
          },
          catch: (e) => new DriverError({ message: `CDP blockNetwork failed: ${e}` }),
        }),

      clearNetworkMocks: () =>
        Effect.tryPromise({
          try: async () => {
            routeRules.length = 0;
            if (fetchInterceptEnabled) {
              fetchInterceptEnabled = false;
              await cdpChannel.sendCommand("Fetch.disable").catch(() => {});
            }
          },
          catch: (e) => new DriverError({ message: `CDP clearNetworkMocks failed: ${e}` }),
        }),

      saveCookies: (path) =>
        Effect.tryPromise({
          try: async () => {
            const res = (await cdpChannel.sendCommand("Network.getCookies")) as {
              cookies?: unknown[];
            };
            await writeFile(path, JSON.stringify(res?.cookies ?? [], null, 2), "utf8");
          },
          catch: (e) => new DriverError({ message: `CDP saveCookies failed: ${e}` }),
        }),

      loadCookies: (path) =>
        Effect.tryPromise({
          try: async () => {
            const cookies = JSON.parse(await readFile(path, "utf8"));
            if (Array.isArray(cookies)) {
              await cdpChannel.sendCommand("Network.setCookies", { cookies });
            }
          },
          catch: (e) => new DriverError({ message: `CDP loadCookies failed: ${e}` }),
        }),

      saveAuthState: (path) =>
        Effect.tryPromise({
          try: async () => {
            const res = (await cdpChannel.sendCommand("Network.getCookies")) as {
              cookies?: unknown[];
            };
            const originState = await cdpChannel
              .evaluate<{ origin: string; localStorage: Array<{ name: string; value: string }> }>(
                `(() => {
                  const entries = [];
                  try {
                    for (let i = 0; i < localStorage.length; i++) {
                      const k = localStorage.key(i);
                      if (k !== null) entries.push({ name: k, value: localStorage.getItem(k) ?? "" });
                    }
                  } catch {}
                  return { origin: window.location.origin, localStorage: entries };
                })()`,
              )
              .catch(() => null);
            const payload = {
              cookies: res?.cookies ?? [],
              origins: originState && originState.origin !== "null" ? [originState] : [],
            };
            await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
          },
          catch: (e) => new DriverError({ message: `CDP saveAuthState failed: ${e}` }),
        }),

      loadAuthState: (path) =>
        Effect.tryPromise({
          try: async () => {
            if (useContexts) {
              const previousSlot = activeSlot;
              activeSlot = await createContextSlot(path);
              cdpChannel.setSessionId(activeSlot.sessionId);
              activeAuthenticatorId = activeSlot.authenticatorId;
              if (previousSlot) disposeSlotInBackground(previousSlot);
              return;
            }
            const state = await loadStorageStateFile(path);
            if (state?.cookies?.length) {
              await cdpChannel.sendCommand("Network.setCookies", { cookies: state.cookies });
            }
          },
          catch: (e) => new DriverError({ message: `CDP loadAuthState failed: ${e}` }),
        }),

      enableVirtualAuthenticator: (opts) =>
        Effect.tryPromise({
          try: async () => {
            activeAuthenticatorId = await attachVirtualAuthenticatorForSession(
              activeSlot?.sessionId ?? null,
              opts,
            );
            return activeAuthenticatorId;
          },
          catch: (e) => new DriverError({ message: `CDP enableVirtualAuthenticator failed: ${e}` }),
        }),

      removeVirtualAuthenticator: (authenticatorId) =>
        Effect.tryPromise({
          try: async () => {
            const id = authenticatorId ?? activeAuthenticatorId;
            if (!id) return;
            await cdpChannel.sendCommand("WebAuthn.removeVirtualAuthenticator", {
              authenticatorId: id,
            });
            if (id === activeAuthenticatorId) activeAuthenticatorId = undefined;
          },
          catch: (e) => new DriverError({ message: `CDP removeVirtualAuthenticator failed: ${e}` }),
        }),

      getVirtualCredentials: (authenticatorId) =>
        Effect.tryPromise({
          try: async () => {
            const id = authenticatorId ?? activeAuthenticatorId;
            if (!id) return [];
            const res = (await cdpChannel.sendCommand("WebAuthn.getCredentials", {
              authenticatorId: id,
            })) as { credentials?: VirtualCredential[] };
            return Array.isArray(res?.credentials) ? res.credentials : [];
          },
          catch: (e) => new DriverError({ message: `CDP getVirtualCredentials failed: ${e}` }),
        }),

      clearVirtualCredentials: (authenticatorId) =>
        Effect.tryPromise({
          try: async () => {
            const id = authenticatorId ?? activeAuthenticatorId;
            if (!id) return;
            await cdpChannel.sendCommand("WebAuthn.clearCredentials", { authenticatorId: id });
          },
          catch: (e) => new DriverError({ message: `CDP clearVirtualCredentials failed: ${e}` }),
        }),

      getConsoleLogs: () => Effect.succeed([...consoleLogs]),
      getJSErrors: () => Effect.succeed([...jsErrors]),

      setNetworkConditions: (conditions: NetworkConditions) =>
        Effect.tryPromise({
          try: async () => {
            const resolved = resolveNetworkConditions(conditions);
            await cdpChannel.sendCommand("Network.enable");
            await cdpChannel.sendCommand("Network.emulateNetworkConditions", {
              offline: resolved.offline,
              latency: resolved.latencyMs,
              downloadThroughput:
                resolved.downloadThroughputKbps < 0
                  ? -1
                  : Math.max(Math.round((resolved.downloadThroughputKbps * 1024) / 8), 0),
              uploadThroughput:
                resolved.uploadThroughputKbps < 0
                  ? -1
                  : Math.max(Math.round((resolved.uploadThroughputKbps * 1024) / 8), 0),
            });
          },
          catch: (e) => new DriverError({ message: `CDP setNetworkConditions failed: ${e}` }),
        }),

      uploadFile: (selector: Selector, filePath: string) =>
        Effect.tryPromise({
          try: async () => {
            const serialized = JSON.stringify(selector);
            const expr = `(function(sel) {
              if (typeof sel === "object" && sel !== null && "testID" in sel) {
                return document.querySelector('[data-testid="' + sel.testID + '"], [testID="' + sel.testID + '"]');
              }
              if (typeof sel === "object" && sel !== null && "accessibilityLabel" in sel) {
                return document.querySelector('[aria-label="' + sel.accessibilityLabel + '"]');
              }
              return document.querySelector('input[type="file"]');
            })(${serialized})`;
            await cdpChannel.sendCommand("DOM.enable");
            const evalRes = (await cdpChannel.sendCommand("Runtime.evaluate", {
              expression: expr,
              returnByValue: false,
            })) as { result?: { objectId?: string } };
            const objectId = evalRes?.result?.objectId;
            if (!objectId) {
              throw new Error(`No matching file input found for selector ${serialized}`);
            }
            const nodeRes = (await cdpChannel.sendCommand("DOM.requestNode", { objectId })) as {
              nodeId?: number;
            };
            if (!nodeRes?.nodeId) {
              throw new Error("Failed to resolve DOM nodeId for file input");
            }
            await cdpChannel.sendCommand("DOM.setFileInputFiles", {
              nodeId: nodeRes.nodeId,
              files: [filePath],
            });
          },
          catch: (e) => new DriverError({ message: `CDP uploadFile failed: ${e}` }),
        }),

      downloadFile: (destPath: string) =>
        Effect.tryPromise({
          try: async () => {
            if (!downloadDir) {
              downloadDir = mkdtempSync(join(tmpdir(), "spana-cdp-dl-"));
              await cdpChannel.sendCommand(
                "Browser.setDownloadBehavior",
                {
                  behavior: "allowAndName",
                  downloadPath: downloadDir,
                  eventsEnabled: true,
                  ...(activeSlot?.browserContextId
                    ? { browserContextId: activeSlot.browserContextId }
                    : {}),
                },
                null,
              );
            }
            const downloaded =
              completedDownloads.shift() ??
              (await new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => {
                  reject(new Error("Timed out waiting for CDP file download"));
                }, 15_000);
                downloadWaiters.push({
                  resolve: (fp) => {
                    clearTimeout(timer);
                    resolve(fp);
                  },
                  reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                  },
                });
              }));
            await copyFile(downloaded, destPath);
          },
          catch: (e) => new DriverError({ message: `CDP downloadFile failed: ${e}` }),
        }),

      newTab: (url?: string) =>
        Effect.tryPromise({
          try: async () => {
            if (!activeSlot) {
              throw new Error("newTab() requires browser-context mode (engine: 'cdp')");
            }
            const targetRes = (await cdpChannel.sendCommand(
              "Target.createTarget",
              {
                url: url ? resolveUrl(url) : "about:blank",
                browserContextId: activeSlot.browserContextId,
                width,
                height,
              },
              null,
            )) as { targetId: string };
            const attachRes = (await cdpChannel.sendCommand(
              "Target.attachToTarget",
              { targetId: targetRes.targetId, flatten: true },
              null,
            )) as { sessionId: string };
            await configureSession(attachRes.sessionId, options.storageState);
            const tabId = `tab-${nextTabSeq++}`;
            activeSlot.tabs.push({
              tabId,
              targetId: targetRes.targetId,
              sessionId: attachRes.sessionId,
            });
            activeSlot.targetId = targetRes.targetId;
            activeSlot.sessionId = attachRes.sessionId;
            cdpChannel.setSessionId(attachRes.sessionId);
            return tabId;
          },
          catch: (e) => new DriverError({ message: `CDP newTab failed: ${e}` }),
        }),

      switchToTab: (index: number) =>
        Effect.tryPromise({
          try: async () => {
            if (!activeSlot || !activeSlot.tabs[index]) {
              throw new Error(`Tab index ${index} is out of range.`);
            }
            const target = activeSlot.tabs[index]!;
            activeSlot.targetId = target.targetId;
            activeSlot.sessionId = target.sessionId;
            cdpChannel.setSessionId(target.sessionId);
            await cdpChannel
              .sendCommand("Target.activateTarget", { targetId: target.targetId }, null)
              .catch(() => {});
          },
          catch: (e) => new DriverError({ message: `CDP switchToTab failed: ${e}` }),
        }),

      closeTab: () =>
        Effect.tryPromise({
          try: async () => {
            if (!activeSlot) return;
            if (activeSlot.tabs.length <= 1) {
              await navigate("about:blank");
              return;
            }
            const idx = activeSlot.tabs.findIndex((t) => t.sessionId === activeSlot!.sessionId);
            const closing = activeSlot.tabs[idx >= 0 ? idx : activeSlot.tabs.length - 1]!;
            activeSlot.tabs = activeSlot.tabs.filter((t) => t.sessionId !== closing.sessionId);
            const fallback =
              activeSlot.tabs[Math.max(0, Math.min(idx - 1, activeSlot.tabs.length - 1))]!;
            activeSlot.targetId = fallback.targetId;
            activeSlot.sessionId = fallback.sessionId;
            cdpChannel.setSessionId(fallback.sessionId);
            await cdpChannel
              .sendCommand("Target.closeTarget", { targetId: closing.targetId }, null)
              .catch(() => {});
          },
          catch: (e) => new DriverError({ message: `CDP closeTab failed: ${e}` }),
        }),

      getTabIds: () =>
        Effect.sync(() => (activeSlot ? activeSlot.tabs.map((t) => t.tabId) : ["tab-1"])),
    };

    return service;
  });
}
