import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DriverError } from "../errors.js";
import { getHealthyWarmDaemon, registerWarmDaemon } from "../runtime/daemon-manager.js";
import { resolveNetworkConditions } from "./network-profiles.js";
import type { Selector } from "../schemas/selector.js";
import type {
  BrowserConsoleLog,
  BrowserCookie,
  BrowserDialogHandler,
  BrowserDialogInfo,
  BrowserDownloadInfo,
  BrowserEmulationOptions,
  BrowserJSError,
  BrowserMockResponse,
  BrowserRequestInfo,
  BrowserResponseInfo,
  BrowserRoute,
  BrowserRouteHandler,
  BrowserRouteMatcher,
  CdpSessionHandle,
  NetworkConditions,
  RawDriverService,
  RawHierarchy,
  UploadFileInput,
  VirtualAuthenticatorOptions,
  VirtualCredential,
  VirtualCredentialInput,
} from "./raw-driver.js";
import { CdpDomChannel, type WebSocketFactory } from "../channels/cdp-client.js";
import {
  buildDomFindElementScript,
  SPANA_INJECTED_RUNTIME_SCRIPT,
} from "../channels/dom-channel.js";
import { applyExtensionChromeArgs, resolveBrowserExtensions } from "./browser-extensions.js";
import {
  isWasmTrapError,
  resolveChromiumGpuArgs,
  SPANA_WASM_HOOK_SCRIPT,
  type WasmMetrics,
  type WasmTrap,
  type WebGpuMode,
} from "./wasm-utils.js";

export interface DirectCdpBrowserLaunchOptions {
  /** Explicit Chromium/Chrome binary path. Auto-detects system Chrome or Playwright Chromium if omitted. */
  executablePath?: string;
  /** Run headless (default: true). */
  headless?: boolean;
  /** Reuse a detached warm Chromium daemon across CLI runs. */
  warmBrowser?: boolean;
  /** Isolation scope key for warm Chromium daemon (defaults to cwd hash). */
  warmBrowserScope?: string;
  /** Optional custom daemon state file path. */
  daemonStateFile?: string;
  /** Unpacked browser extension directories to load into Chromium. */
  extensions?: string[];
  /** GPU rendering mode (`"auto" | "swiftshader" | "hardware" | "disabled"`). */
  gpu?: WebGpuMode;
  /** Enable WebGPU flags (`--enable-unsafe-webgpu`, deterministic SwiftShader when headless). */
  webgpu?: boolean;
  /** Extra Chrome launch flags. */
  args?: string[];
  /** Browser startup timeout in ms (default: 30_000). */
  launchTimeout?: number;
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
  const cwdHash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 10);
  return `cdp-${cwdHash}`;
}

function findPlaywrightCachedChromium(): string | undefined {
  const roots: string[] = [];
  if (process.env["PLAYWRIGHT_BROWSERS_PATH"] && process.env["PLAYWRIGHT_BROWSERS_PATH"] !== "0") {
    roots.push(process.env["PLAYWRIGHT_BROWSERS_PATH"]);
  }
  const home = homedir();
  if (process.platform === "darwin") {
    roots.push(join(home, "Library", "Caches", "ms-playwright"));
  } else if (process.platform === "linux") {
    roots.push(join(process.env["XDG_CACHE_HOME"] || join(home, ".cache"), "ms-playwright"));
  } else if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] || join(home, "AppData", "Local");
    roots.push(join(localAppData, "ms-playwright"));
  }

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const chromiumDirs = entries
      .filter((e) => /^chromium-\d+$/.test(e))
      .toSorted((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const dir of chromiumDirs) {
      const base = join(root, dir);
      const relCandidates =
        process.platform === "darwin"
          ? [
              "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
              "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
              "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            ]
          : process.platform === "linux"
            ? ["chrome-linux64/chrome", "chrome-linux/chrome"]
            : ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"];
      for (const rel of relCandidates) {
        const full = join(base, rel);
        if (existsSync(full)) return full;
      }
    }
  }
  return undefined;
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

async function waitForDevToolsActivePort(
  userDataDir: string,
  child: ChildProcess,
  getExitInfo: () => { exited: boolean; code: number | null; signal: NodeJS.Signals | null },
  getStderr: () => string,
  timeoutMs: number,
): Promise<{ port: number; wsPath: string; browserWsUrl: string; httpEndpoint: string }> {
  const activePortFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const exit = getExitInfo();
    if (exit.exited) {
      const tail = getStderr().trim();
      throw new Error(
        `Direct CDP browser exited prematurely (code=${exit.code}, signal=${exit.signal})${tail ? `\nstderr:\n${tail}` : ""}`,
      );
    }

    if (existsSync(activePortFile)) {
      try {
        const lines = readFileSync(activePortFile, "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const port = Number.parseInt(lines[0] ?? "", 10);
        const wsPath = lines[1] ?? "";
        if (Number.isFinite(port) && port > 0 && wsPath.startsWith("/")) {
          const httpEndpoint = `http://127.0.0.1:${port}`;
          const res = await fetch(`${httpEndpoint}/json/version`, {
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            const data = (await res.json()) as { webSocketDebuggerUrl?: string };
            const wsUrl = data.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}${wsPath}`;
            if (wsUrl.includes(wsPath) || wsUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
              return { port, wsPath, browserWsUrl: wsUrl, httpEndpoint };
            }
          }
        }
      } catch {
        // file still being written or HTTP endpoint booting
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }

  const tail = getStderr().trim();
  throw new Error(
    `Direct CDP browser did not expose DevToolsActivePort / /json/version within ${timeoutMs}ms (pid=${child.pid ?? "unknown"})${tail ? `\nstderr:\n${tail}` : ""}`,
  );
}

export interface DirectChromiumLaunchArgsOptions {
  /** Fresh throwaway profile directory path. */
  userDataDir: string;
  /** Remote debugging port (`0` lets Chromium pick a free ephemeral port). */
  remoteDebuggingPort?: number;
  /** Run headless (default: true). */
  headless?: boolean;
  /** GPU rendering mode (`"auto" | "swiftshader" | "hardware" | "disabled"`). */
  gpu?: WebGpuMode;
  /** Enable WebGPU flags (`--enable-unsafe-webgpu`, deterministic SwiftShader when headless). */
  webgpu?: boolean;
  /** Extra Chrome launch flags. */
  args?: string[];
}

/**
 * Build deterministic Chromium launch arguments for throwaway automation profiles.
 *
 * Always includes `--use-mock-keychain` and `--password-store=basic` so Chromium never
 * queries the macOS login keychain ("Chromium Safe Storage") or Linux Secret Service /
 * KWallet when initializing cookie/credential storage for an ephemeral test profile.
 */
export function buildDirectChromiumLaunchArgs(options: DirectChromiumLaunchArgsOptions): string[] {
  return [
    ...(options.headless !== false ? ["--headless=new"] : []),
    `--remote-debugging-port=${options.remoteDebuggingPort ?? 0}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-service-autorun",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",
    "--disable-hang-monitor",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    ...resolveChromiumGpuArgs({
      headless: options.headless,
      gpu: options.gpu,
      webgpu: options.webgpu,
    }),
    "--metrics-recording-only",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
    ...(options.args ?? []),
    "about:blank",
  ];
}

/**
 * Launch (or attach to a warm) Chromium process directly over raw CDP WebSocket —
 * completely bypassing Playwright's Node client↔server IPC pipe!
 */
export async function launchDirectCdpBrowser(
  options: DirectCdpBrowserLaunchOptions = {},
): Promise<DirectCdpBrowserHandle> {
  const daemonKey = resolveDirectCdpScopeKey(options.warmBrowserScope);
  const launchTimeoutMs = options.launchTimeout ?? 30_000;
  if (options.warmBrowser) {
    const existing = await getHealthyWarmDaemon("chromium", daemonKey, {
      statusPath: "/json/version",
      stateFile: options.daemonStateFile,
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
    execPath = findPlaywrightCachedChromium();
  }
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

  // Fresh throwaway profile: never expose the user's real Chrome profile (cookies, logins) over CDP.
  // Use `--remote-debugging-port=0` so Chromium atomically claims an OS-assigned port (zero TOCTOU race!).
  const userDataDir = mkdtempSync(join(tmpdir(), "spana-cdp-profile-"));
  const baseChromeArgs = buildDirectChromiumLaunchArgs({
    userDataDir,
    remoteDebuggingPort: 0,
    headless: options.headless,
    gpu: options.gpu,
    webgpu: options.webgpu,
    args: options.args,
  });
  const resolvedExts =
    options.extensions && options.extensions.length > 0
      ? resolveBrowserExtensions(options.extensions)
      : [];
  const chromeArgs =
    resolvedExts.length > 0
      ? applyExtensionChromeArgs(baseChromeArgs, resolvedExts)
      : baseChromeArgs;

  const child: ChildProcess = spawn(execPath, chromeArgs, {
    detached: Boolean(options.warmBrowser),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderrBuf = "";
  const MAX_STDERR = 8192;
  let resolveStderrWs:
    | ((bound: {
        port: number;
        wsPath: string;
        browserWsUrl: string;
        httpEndpoint: string;
      }) => void)
    | undefined;
  const stderrWsPromise = new Promise<{
    port: number;
    wsPath: string;
    browserWsUrl: string;
    httpEndpoint: string;
  }>((resolve) => {
    resolveStderrWs = resolve;
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (stderrBuf.length > MAX_STDERR) {
      stderrBuf = stderrBuf.slice(-MAX_STDERR);
    }
    if (resolveStderrWs) {
      const m = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)(\/[^\s]+))/.exec(stderrBuf);
      if (m) {
        const browserWsUrl = m[1]!;
        const port = Number.parseInt(m[2]!, 10);
        const wsPath = m[3]!;
        const done = resolveStderrWs;
        resolveStderrWs = undefined;
        done({ port, wsPath, browserWsUrl, httpEndpoint: `http://127.0.0.1:${port}` });
      }
    }
  });

  let exitState: { exited: boolean; code: number | null; signal: NodeJS.Signals | null } = {
    exited: false,
    code: null,
    signal: null,
  };
  let resolveExit: (() => void) | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  child.once("exit", (code, signal) => {
    exitState = { exited: true, code, signal };
    resolveExit?.();
  });
  child.once("error", (err) => {
    stderrBuf += `\nspawn error: ${err.message}`;
    exitState = { exited: true, code: -1, signal: null };
    resolveExit?.();
  });

  let bound: { port: number; wsPath: string; browserWsUrl: string; httpEndpoint: string };
  try {
    bound = await Promise.race([
      stderrWsPromise,
      waitForDevToolsActivePort(
        userDataDir,
        child,
        () => exitState,
        () => stderrBuf,
        launchTimeoutMs,
      ),
    ]);
  } catch (err) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    rmSync(userDataDir, { recursive: true, force: true });
    throw err;
  }

  if (options.warmBrowser) {
    child.stderr?.removeAllListeners("data");
    child.stderr?.destroy();
    child.unref();
    registerWarmDaemon(
      {
        kind: "chromium",
        deviceId: daemonKey,
        host: "127.0.0.1",
        port: bound.port,
        pid: child.pid,
        userDataDir,
        startedAt: new Date().toISOString(),
      },
      options.daemonStateFile,
    );
  }

  return {
    httpEndpoint: bound.httpEndpoint,
    browserWsUrl: bound.browserWsUrl,
    reused: Boolean(options.warmBrowser),
    pid: child.pid,
    close: async () => {
      if (options.warmBrowser) return;
      if (!exitState.exited) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already exited
        }
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 150))]);
        if (!exitState.exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already exited
          }
          await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 50))]);
        }
      }
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
  /** Evaluation timeout in ms (default: 10_000). */
  evaluateTimeout?: number;
  /**
   * Use isolated CDP browser contexts (`Target.createBrowserContext` + flattened CDP sessions)
   * on a browser-level WebSocket — zero Playwright Node client↔server pipe!
   * Auto-enabled when `cdpUrl` is a `/devtools/browser/` URL or `freshContextPerFlow` is true.
   */
  useBrowserContexts?: boolean;
  /** Pre-warm the next isolated CDP browser context while the current flow runs, and dispose old contexts asynchronously. */
  freshContextPerFlow?: boolean;
  /**
   * Context isolation mode when `freshContextPerFlow` is enabled:
   * - `"hot-cache"` (default in v0.14+): keeps Chromium's HTTP & V8 bytecode caches warm while
   *   wiping cookies, localStorage, sessionStorage, OPFS, IndexedDB, CacheStorage, and service
   *   workers (~4 ms reset).
   * - `"fresh"`: creates a brand-new `Target.createBrowserContext` per flow (strictest isolation).
   */
  contextIsolation?: "fresh" | "hot-cache";
  /** Install persistent `window.__spanaRt` once per document to cut CDP wire payload ~100× (default: true on live sockets). */
  useInjectedRuntime?: boolean;
  /** Navigation wait condition (`"domcontentloaded"`, `"load"`, or `"commit"`). Default: `"domcontentloaded"` in browser-context mode. */
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  /** Collapse CSS transitions & animations to 0.001ms via `Page.addScriptToEvaluateOnNewDocument`. */
  instantAnimations?: boolean;
  /** Abort specified resource types before hitting the network. */
  blockResources?: Array<"image" | "font" | "media" | "stylesheet">;
  /** Automatically attach a CDP WebAuthn virtual authenticator (passkey) to every context. */
  virtualAuthenticator?: boolean | VirtualAuthenticatorOptions;
  /** Optional Playwright-compatible storageState JSON path to preload into contexts. */
  storageState?: string;
  /** Emulate `prefers-color-scheme`, `prefers-reduced-motion`, `locale`, or `timezoneId` on every context. */
  emulation?: BrowserEmulationOptions;
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
  kind: "mock" | "block" | "handler";
  matcher: BrowserRouteMatcher;
  response?: BrowserMockResponse;
  handler?: BrowserRouteHandler;
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

const CDP_SPECIAL_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " " },
  " ": { code: "Space", keyCode: 32, text: " " },
};

function parseCdpKeyDescriptor(rawKey: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  commands?: string[];
} {
  const parts = rawKey.split("+");
  let modifiers = 0;
  let baseKey = rawKey;
  if (parts.length > 1) {
    baseKey = parts[parts.length - 1] ?? rawKey;
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = (parts[i] ?? "").toLowerCase();
      if (mod === "alt" || mod === "option") modifiers |= 1;
      else if (mod === "control" || mod === "ctrl") modifiers |= 2;
      else if (mod === "meta" || mod === "cmd" || mod === "command") modifiers |= 4;
      else if (mod === "shift") modifiers |= 8;
    }
  }

  const special = CDP_SPECIAL_KEYS[baseKey];
  if (special) {
    return {
      key: baseKey === "Space" ? " " : baseKey,
      code: special.code,
      windowsVirtualKeyCode: special.keyCode,
      modifiers,
      ...(special.text ? { text: special.text } : {}),
    };
  }

  if (baseKey.length === 1) {
    const upper = baseKey.toUpperCase();
    const charCode = upper.charCodeAt(0);
    const isLetter = charCode >= 65 && charCode <= 90;
    const isDigit = charCode >= 48 && charCode <= 57;
    const commands: string[] = [];
    if ((modifiers & (2 | 4)) !== 0) {
      if (baseKey.toLowerCase() === "a") commands.push("selectAll");
      else if (baseKey.toLowerCase() === "c") commands.push("copy");
      else if (baseKey.toLowerCase() === "v") commands.push("paste");
      else if (baseKey.toLowerCase() === "x") commands.push("cut");
      else if (baseKey.toLowerCase() === "z") commands.push("undo");
    }
    return {
      key: baseKey,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${baseKey}` : "",
      windowsVirtualKeyCode: charCode,
      modifiers,
      ...(modifiers === 0 || modifiers === 8 ? { text: baseKey } : {}),
      ...(commands.length > 0 ? { commands } : {}),
    };
  }

  return {
    key: baseKey,
    code: baseKey,
    windowsVirtualKeyCode: 0,
    modifiers,
  };
}

export const UPLOAD_ATTACH_TIMEOUT_MS = 30_000;

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
      timeoutMs: options.evaluateTimeout ?? 10_000,
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

    const initialWidth = options.viewport?.width ?? 1280;
    const initialHeight = options.viewport?.height ?? 720;
    let width = initialWidth;
    let height = initialHeight;
    let emulationMutated = false;
    let viewportMutated = false;
    let isAtBlank = true;
    const label = options.engineLabel ?? "cdp";
    const contextIsolation = options.contextIsolation ?? "hot-cache";

    let activeSlot: CdpContextSlot | undefined;
    let prefetchedSlotPromise: Promise<CdpContextSlot> | undefined;
    let hasRunFirstFlow = false;
    let activeAuthenticatorId: string | undefined;
    let dialogHandler: BrowserDialogHandler | null = null;
    const backgroundDisposals: Array<Promise<unknown>> = [];
    const consoleLogs: BrowserConsoleLog[] = [];
    const jsErrors: BrowserJSError[] = [];
    const routeRules: CdpRouteRule[] = [];
    const initScripts: string[] = [];
    const exposedFunctions = new Map<string, (...args: any[]) => any>();
    const requestListeners = new Set<(req: BrowserRequestInfo) => void>();
    const navigationUrls: string[] = [];
    const uploadTempDirs: string[] = [];
    let currentNetworkConditions: NetworkConditions | undefined;
    let cachedUserAgent: string | undefined;
    let fetchInterceptEnabled = false;
    let activeResponseWatchers = 0;
    let nextTabSeq = 1;
    let downloadDir: string | undefined;
    const popupWaiters: Array<{
      resolve: (tabId: string) => void;
      reject: (err: Error) => void;
    }> = [];
    interface CompletedCdpDownload {
      filePath: string;
      suggestedFilename: string;
      url: string;
    }
    const completedDownloads: CompletedCdpDownload[] = [];
    const downloadWaiters: Array<{
      resolve: (dl: CompletedCdpDownload) => void;
      reject: (err: Error) => void;
    }> = [];
    const pendingDownloadGuids = new Map<string, CompletedCdpDownload>();

    cdpChannel.onEvent("Browser.downloadWillBegin", (params) => {
      if (params?.guid && downloadDir) {
        const guid = String(params.guid);
        pendingDownloadGuids.set(guid, {
          filePath: join(downloadDir, guid),
          suggestedFilename: String(params?.suggestedFilename ?? guid),
          url: String(params?.url ?? ""),
        });
      }
    });

    cdpChannel.onEvent("Browser.downloadProgress", (params) => {
      if (params?.state === "completed" && params?.guid) {
        const guid = String(params.guid);
        const entry: CompletedCdpDownload | undefined =
          pendingDownloadGuids.get(guid) ??
          (downloadDir
            ? {
                filePath: join(downloadDir, guid),
                suggestedFilename: guid,
                url: "",
              }
            : undefined);
        pendingDownloadGuids.delete(guid);
        if (!entry) return;
        const waiter = downloadWaiters.shift();
        if (waiter) waiter.resolve(entry);
        else completedDownloads.push(entry);
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

    const useInjectedRuntime = options.useInjectedRuntime ?? !options.createWebSocket;
    cdpChannel.enableInjectedRuntime(useInjectedRuntime);

    const applyLocaleOverride = async (sessionId: string | null, locale: string) => {
      await cdpChannel
        .sendCommand("Emulation.setLocaleOverride", { locale }, sessionId)
        .catch(() => {});
      if (!cachedUserAgent) {
        const ua = await cdpChannel
          .evaluateOnSession<string>(sessionId, "navigator.userAgent")
          .catch(() => "");
        if (ua) cachedUserAgent = ua;
      }
      const acceptLanguage = locale.includes("-")
        ? `${locale},${locale.split("-")[0]};q=0.9`
        : locale;
      await cdpChannel
        .sendCommand(
          "Emulation.setUserAgentOverride",
          {
            userAgent: cachedUserAgent || "Mozilla/5.0",
            acceptLanguage,
          },
          sessionId,
        )
        .catch(() => {});
    };

    const applyNetworkConditionsToSession = async (
      sessionId: string | null,
      conditions: NetworkConditions,
    ) => {
      const resolved = resolveNetworkConditions(conditions);
      await cdpChannel.sendCommand("Network.enable", {}, sessionId).catch(() => {});
      await cdpChannel
        .sendCommand(
          "Network.emulateNetworkConditions",
          {
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
          },
          sessionId,
        )
        .catch(() => {});
    };

    const installExposeFunctionOnSession = async (sessionId: string | null, name: string) => {
      const bindingName = `__spana_bind_${name}`;
      await cdpChannel
        .sendCommand("Runtime.addBinding", { name: bindingName }, sessionId)
        .catch(() => {});
      const wrapperSource = `(() => {
        if (window[${JSON.stringify(name)}]) return;
        let seq = 0;
        const pending = (window.__spanaBindPending = window.__spanaBindPending || {});
        window[${JSON.stringify(name)}] = (...args) => new Promise((resolve, reject) => {
          const id = ${JSON.stringify(name)} + ":" + (++seq);
          pending[id] = { resolve, reject };
          window[${JSON.stringify(bindingName)}](JSON.stringify({ id, name: ${JSON.stringify(name)}, args }));
        });
      })();`;
      await cdpChannel
        .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: wrapperSource }, sessionId)
        .catch(() => {});
      await cdpChannel.evaluateOnSession(sessionId, wrapperSource).catch(() => {});
    };

    const configureSession = async (sessionId: string | null, storageStatePath?: string) => {
      const state = await loadStorageStateFile(storageStatePath);
      await Promise.all([
        cdpChannel.sendCommand("Page.enable", {}, sessionId).catch(() => {}),
        cdpChannel.sendCommand("Runtime.enable", {}, sessionId).catch(() => {}),
        // Enable Network in the initial parallel batch (0 extra RTTs) so waitForResponse / app.cdp() never race fast localhost loads.
        cdpChannel.sendCommand("Network.enable", {}, sessionId).catch(() => {}),
        ...(useInjectedRuntime
          ? [
              cdpChannel
                .sendCommand(
                  "Page.addScriptToEvaluateOnNewDocument",
                  { source: SPANA_INJECTED_RUNTIME_SCRIPT },
                  sessionId,
                )
                .catch(() => {}),
            ]
          : []),
        cdpChannel
          .sendCommand(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            sessionId,
          )
          .catch(() => {}),
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

      for (const scriptSource of initScripts) {
        await cdpChannel
          .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: scriptSource }, sessionId)
          .catch(() => {});
      }

      for (const fnName of exposedFunctions.keys()) {
        await installExposeFunctionOnSession(sessionId, fnName);
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
        fetchInterceptEnabled = true;
        await cdpChannel
          .sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId)
          .catch(() => {});
      }

      if (currentNetworkConditions) {
        await applyNetworkConditionsToSession(sessionId, currentNetworkConditions);
      }

      if (options.emulation) {
        const emuFeatures: Array<{ name: string; value: string }> = [];
        if (options.emulation.colorScheme !== undefined) {
          emuFeatures.push({
            name: "prefers-color-scheme",
            value:
              options.emulation.colorScheme === "no-preference"
                ? ""
                : options.emulation.colorScheme,
          });
        }
        if (options.emulation.reducedMotion !== undefined) {
          emuFeatures.push({
            name: "prefers-reduced-motion",
            value:
              options.emulation.reducedMotion === "no-preference"
                ? ""
                : options.emulation.reducedMotion,
          });
        }
        if (emuFeatures.length > 0) {
          await cdpChannel
            .sendCommand("Emulation.setEmulatedMedia", { features: emuFeatures }, sessionId)
            .catch(() => {});
        }
        if (options.emulation.locale) {
          await applyLocaleOverride(sessionId, options.emulation.locale);
        }
        if (options.emulation.timezoneId) {
          await cdpChannel
            .sendCommand(
              "Emulation.setTimezoneOverride",
              { timezoneId: options.emulation.timezoneId },
              sessionId,
            )
            .catch(() => {});
        }
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
      if (
        !useContexts ||
        !options.freshContextPerFlow ||
        contextIsolation === "hot-cache" ||
        prefetchedSlotPromise
      ) {
        return;
      }
      prefetchedSlotPromise = createContextSlot(options.storageState);
      prefetchedSlotPromise.catch(() => {
        prefetchedSlotPromise = undefined;
      });
    };

    // Track Web Worker / Service Worker sessions so worker logs & WASM traps are captured cleanly
    const workerSessions = new Map<string, string>();
    const wasmTraps: WasmTrap[] = [];

    // Auto-track cross-origin iframe (OOPIF) child targets, Web Workers, & popup/new tabs in the same browserContext
    cdpChannel.onEvent("Target.attachedToTarget", (params) => {
      const targetInfo = params?.targetInfo;
      const childSid = params?.sessionId;
      const waiting = Boolean(params?.waitingForDebugger);
      if (
        (targetInfo?.type === "worker" || targetInfo?.type === "service_worker") &&
        typeof childSid === "string"
      ) {
        workerSessions.set(childSid, typeof targetInfo.url === "string" ? targetInfo.url : "");
        void (async () => {
          await cdpChannel.sendCommand("Runtime.enable", {}, childSid).catch(() => {});
          await cdpChannel.evaluateOnSession(childSid, SPANA_WASM_HOOK_SCRIPT).catch(() => {});
          if (waiting) {
            await cdpChannel
              .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
              .catch(() => {});
          }
        })();
        return;
      }
      if (targetInfo?.type === "iframe" && typeof childSid === "string") {
        cdpChannel.addChildSession(childSid, {
          targetId: typeof targetInfo.targetId === "string" ? targetInfo.targetId : undefined,
          url: typeof targetInfo.url === "string" ? targetInfo.url : undefined,
        });
        void (async () => {
          await cdpChannel.sendCommand("Runtime.enable", {}, childSid).catch(() => {});
          if (useInjectedRuntime) {
            await cdpChannel
              .sendCommand(
                "Page.addScriptToEvaluateOnNewDocument",
                { source: SPANA_INJECTED_RUNTIME_SCRIPT },
                childSid,
              )
              .catch(() => {});
          }
          if (waiting) {
            await cdpChannel
              .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
              .catch(() => {});
          }
        })();
      } else if (
        targetInfo?.type === "page" &&
        typeof childSid === "string" &&
        activeSlot &&
        targetInfo.browserContextId === activeSlot.browserContextId
      ) {
        const alreadyTracked = activeSlot.tabs.some(
          (t) => t.sessionId === childSid || t.targetId === targetInfo.targetId,
        );
        let newTabId: string | undefined;
        if (!alreadyTracked) {
          newTabId = `tab-${nextTabSeq++}`;
          activeSlot.tabs.push({
            tabId: newTabId,
            targetId: String(targetInfo.targetId ?? ""),
            sessionId: childSid,
          });
        }
        void (async () => {
          const setupCalls: Array<Promise<unknown>> = [
            cdpChannel.sendCommand("Page.enable", {}, childSid).catch(() => {}),
            cdpChannel.sendCommand("Runtime.enable", {}, childSid).catch(() => {}),
          ];
          if (activeResponseWatchers > 0 || requestListeners.size > 0) {
            setupCalls.push(cdpChannel.sendCommand("Network.enable", {}, childSid).catch(() => {}));
          }
          if (currentNetworkConditions) {
            setupCalls.push(applyNetworkConditionsToSession(childSid, currentNetworkConditions));
          }
          if (fetchInterceptEnabled) {
            setupCalls.push(
              cdpChannel
                .sendCommand("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, childSid)
                .catch(() => {}),
            );
          }
          if (useInjectedRuntime) {
            setupCalls.push(
              cdpChannel
                .sendCommand(
                  "Page.addScriptToEvaluateOnNewDocument",
                  { source: SPANA_INJECTED_RUNTIME_SCRIPT },
                  childSid,
                )
                .catch(() => {}),
            );
          }
          for (const scriptSource of initScripts) {
            setupCalls.push(
              cdpChannel
                .sendCommand(
                  "Page.addScriptToEvaluateOnNewDocument",
                  { source: scriptSource },
                  childSid,
                )
                .catch(() => {}),
            );
          }
          await Promise.all(setupCalls);
          if (waiting) {
            await cdpChannel
              .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
              .catch(() => {});
          }
          if (newTabId && popupWaiters.length > 0) {
            const waiter = popupWaiters.shift();
            if (waiter) waiter.resolve(newTabId);
          }
        })();
      } else if (waiting && typeof childSid === "string") {
        void cdpChannel
          .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
          .catch(() => {});
      }
    });

    cdpChannel.onEvent("Target.detachedFromTarget", (params) => {
      if (typeof params?.sessionId === "string") {
        cdpChannel.removeChildSession(params.sessionId);
        if (activeSlot) {
          activeSlot.tabs = activeSlot.tabs.filter((t) => t.sessionId !== params.sessionId);
        }
      }
    });

    // Handle JS dialogs (alert/confirm/prompt/beforeunload) via registered custom handler,
    // falling back to safe auto-handling so dialogs never freeze subsequent CDP commands.
    cdpChannel.onEvent("Page.javascriptDialogOpening", (params, sid) => {
      const targetSid = sid ?? null;
      const dialogType = String(params?.type ?? "alert") as BrowserDialogInfo["type"];
      const message = String(params?.message ?? "");
      const defaultValue = String(params?.defaultPrompt ?? "");
      const activeHandler = dialogHandler;
      if (!activeHandler) {
        const accept = dialogType === "beforeunload";
        void cdpChannel
          .sendCommand("Page.handleJavaScriptDialog", { accept }, targetSid)
          .catch(() => {});
        return;
      }

      let handled = false;
      const info: BrowserDialogInfo = {
        type: dialogType,
        message,
        defaultValue,
        accept: async (promptText?: string) => {
          if (handled) return;
          handled = true;
          await cdpChannel.sendCommand(
            "Page.handleJavaScriptDialog",
            {
              accept: true,
              ...(promptText !== undefined ? { promptText } : {}),
            },
            targetSid,
          );
        },
        dismiss: async () => {
          if (handled) return;
          handled = true;
          await cdpChannel.sendCommand("Page.handleJavaScriptDialog", { accept: false }, targetSid);
        },
      };

      void Promise.resolve(activeHandler(info))
        .catch(() => {})
        .finally(() => {
          if (!handled) {
            handled = true;
            void cdpChannel
              .sendCommand(
                "Page.handleJavaScriptDialog",
                { accept: dialogType === "beforeunload" },
                targetSid,
              )
              .catch(() => {});
          }
        });
    });

    cdpChannel.setFrameOffsetResolver(async (child) => {
      if (!child.targetId) return { x: 0, y: 0 };
      try {
        await cdpChannel.sendCommand("DOM.enable");
        const owner = (await cdpChannel.sendCommand("DOM.getFrameOwner", {
          frameId: child.targetId,
        })) as { backendNodeId?: number; nodeId?: number };
        const boxParams = owner.backendNodeId
          ? { backendNodeId: owner.backendNodeId }
          : { nodeId: owner.nodeId };
        const box = (await cdpChannel.sendCommand("DOM.getBoxModel", boxParams)) as {
          model?: { content?: number[]; border?: number[] };
        };
        const quad = box?.model?.content ?? box?.model?.border;
        if (Array.isArray(quad) && quad.length >= 2) {
          return { x: quad[0] ?? 0, y: quad[1] ?? 0 };
        }
      } catch {
        // Cross-origin frame owner unavailable — default to (0, 0)
      }
      return { x: 0, y: 0 };
    });

    // Capture console logs, JS errors, worker WASM traps, and Fetch interception over the single raw WS
    cdpChannel.onEvent("Runtime.consoleAPICalled", (params, sid) => {
      const isWorker = typeof sid === "string" && workerSessions.has(sid);
      if (!isWorker && activeSlot && sid && sid !== activeSlot.sessionId) return;
      const args = Array.isArray(params?.args)
        ? params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")
        : "";
      consoleLogs.push({
        type: String(params?.type ?? "log"),
        text: isWorker ? `[worker] ${args}` : args,
      });
    });

    cdpChannel.onEvent("Runtime.exceptionThrown", (params, sid) => {
      const isWorker = typeof sid === "string" && workerSessions.has(sid);
      if (!isWorker && activeSlot && sid && sid !== activeSlot.sessionId) return;
      const detail = params?.exceptionDetails;
      const name = String(detail?.exception?.className ?? "Error");
      const message = String(
        detail?.exception?.description ?? detail?.text ?? "Uncaught exception",
      );
      jsErrors.push({
        name,
        message: isWorker ? `[worker] ${message}` : message,
      });
      if (isWasmTrapError({ name, message })) {
        wasmTraps.push({
          name,
          message,
          source: isWorker ? "worker" : "main",
          ...(isWorker ? { workerUrl: workerSessions.get(sid!) } : {}),
          timestamp: Date.now(),
        });
      }
    });

    // Track committed navigation URLs so waitForURL catches rapid redirects (2.13)
    const recordNavUrl = (url: unknown, sid?: string) => {
      if (activeSlot && sid && sid !== activeSlot.sessionId) return;
      if (typeof url === "string" && url.length > 0) {
        navigationUrls.push(url);
        if (navigationUrls.length > 50) navigationUrls.shift();
      }
    };
    cdpChannel.onEvent("Page.frameNavigated", (params, sid) => {
      if (!params?.frame?.parentId) {
        recordNavUrl(params?.frame?.url, sid);
      }
    });
    cdpChannel.onEvent("Page.navigatedWithinDocument", (params, sid) => {
      recordNavUrl(params?.url, sid);
    });

    // Dispatch exposed Node bindings called from browser code (3.6)
    cdpChannel.onEvent("Runtime.bindingCalled", (params, sid) => {
      const payloadRaw = params?.payload;
      if (typeof payloadRaw !== "string") return;
      let parsed: { id?: string; name?: string; args?: unknown[] };
      try {
        parsed = JSON.parse(payloadRaw);
      } catch {
        return;
      }
      if (!parsed.id || !parsed.name) return;
      const fn = exposedFunctions.get(parsed.name);
      if (!fn) return;
      void (async () => {
        try {
          const val = await fn(...(parsed.args ?? []));
          const serialized = val === undefined ? "undefined" : JSON.stringify(val);
          await cdpChannel.evaluateOnSession(
            sid ?? activeSlot?.sessionId ?? null,
            `(() => { const p = window.__spanaBindPending?.[${JSON.stringify(parsed.id)}]; if (p) { delete window.__spanaBindPending[${JSON.stringify(parsed.id)}]; p.resolve(${serialized}); } })()`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await cdpChannel
            .evaluateOnSession(
              sid ?? activeSlot?.sessionId ?? null,
              `(() => { const p = window.__spanaBindPending?.[${JSON.stringify(parsed.id)}]; if (p) { delete window.__spanaBindPending[${JSON.stringify(parsed.id)}]; p.reject(new Error(${JSON.stringify(errMsg)})); } })()`,
            )
            .catch(() => {});
        }
      })();
    });

    // Broadcast outgoing requests to app.onRequest / app.waitForRequest listeners (3.8, 3.25)
    cdpChannel.onEvent("Network.requestWillBeSent", (params, sid) => {
      if (requestListeners.size === 0) return;
      if (
        activeSlot &&
        sid &&
        !activeSlot.tabs.some((t) => t.sessionId === sid) &&
        sid !== activeSlot.sessionId
      ) {
        return;
      }
      const req = params?.request;
      if (!req?.url) return;
      const rawHeaders = (req.headers ?? {}) as Record<string, unknown>;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k.toLowerCase()] = String(v);
      }
      const postDataStr = typeof req.postData === "string" ? req.postData : null;
      const info: BrowserRequestInfo = {
        url: String(req.url),
        method: String(req.method ?? "GET"),
        headers,
        resourceType: typeof params?.type === "string" ? params.type.toLowerCase() : undefined,
        postData: () => postDataStr,
        postDataJSON: <T = unknown>() => {
          if (!postDataStr) return null;
          try {
            return JSON.parse(postDataStr) as T;
          } catch {
            return null;
          }
        },
      };
      for (const listener of requestListeners) {
        try {
          listener(info);
        } catch {
          // ignore listener errors
        }
      }
    });

    cdpChannel.onEvent("Fetch.requestPaused", (params, sid) => {
      // Only handle Fetch.requestPaused when Spana itself enabled Fetch interception;
      // otherwise leave pauses alone for user `app.cdp().send("Fetch.enable", ...)` handlers! (2.17)
      if (!fetchInterceptEnabled) return;
      const reqId = params?.requestId;
      const reqObj = params?.request ?? {};
      const url = String(reqObj.url ?? "");
      if (!reqId) return;
      const rule = routeRules.find((r) => matchUrl(r.matcher, url));
      if (!rule) {
        void cdpChannel
          .sendCommand("Fetch.continueRequest", { requestId: reqId }, sid ?? null)
          .catch(() => {});
        return;
      }
      const fulfillWith = async (resp: BrowserMockResponse) => {
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
        const responseHeaders = Object.entries(headersObj).map(([name, value]) => ({
          name,
          value,
        }));
        await cdpChannel.sendCommand(
          "Fetch.fulfillRequest",
          {
            requestId: reqId,
            responseCode: resp.status ?? 200,
            responseHeaders,
            body: Buffer.from(bodyStr, "utf8").toString("base64"),
          },
          sid ?? null,
        );
      };

      if (rule.kind === "handler" && rule.handler) {
        const rawHeaders = (reqObj.headers ?? {}) as Record<string, unknown>;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
        const postDataStr = typeof reqObj.postData === "string" ? reqObj.postData : null;
        const reqInfo: BrowserRequestInfo = {
          url,
          method: String(reqObj.method ?? "GET"),
          headers,
          resourceType:
            typeof params?.resourceType === "string"
              ? params.resourceType.toLowerCase()
              : undefined,
          postData: () => postDataStr,
          postDataJSON: <T = unknown>() => {
            if (!postDataStr) return null;
            try {
              return JSON.parse(postDataStr) as T;
            } catch {
              return null;
            }
          },
        };
        let handled = false;
        const routeObj: BrowserRoute = {
          request: () => reqInfo,
          continue: async (overrides) => {
            if (handled) return;
            handled = true;
            await cdpChannel.sendCommand(
              "Fetch.continueRequest",
              {
                requestId: reqId,
                ...(overrides?.url ? { url: overrides.url } : {}),
                ...(overrides?.method ? { method: overrides.method } : {}),
                ...(overrides?.headers
                  ? {
                      headers: Object.entries(overrides.headers).map(([name, value]) => ({
                        name,
                        value,
                      })),
                    }
                  : {}),
                ...(overrides?.postData !== undefined
                  ? { postData: Buffer.from(overrides.postData, "utf8").toString("base64") }
                  : {}),
              },
              sid ?? null,
            );
          },
          abort: async (errorCode) => {
            if (handled) return;
            handled = true;
            await cdpChannel.sendCommand(
              "Fetch.failRequest",
              { requestId: reqId, errorReason: errorCode ?? "Failed" },
              sid ?? null,
            );
          },
          fulfill: async (response) => {
            if (handled) return;
            handled = true;
            await fulfillWith(response);
          },
          fetch: async (overrides) => {
            const targetUrl = overrides?.url ?? url;
            const fetchHeaders = { ...headers, ...overrides?.headers };
            const fetchMethod = overrides?.method ?? reqInfo.method;
            const body =
              overrides?.postData !== undefined
                ? overrides.postData
                : fetchMethod !== "GET" && fetchMethod !== "HEAD"
                  ? (postDataStr ?? undefined)
                  : undefined;
            const res = await fetch(targetUrl, {
              method: fetchMethod,
              headers: fetchHeaders,
              ...(body !== undefined ? { body } : {}),
            });
            const resText = await res.text();
            const outHeaders: Record<string, string> = {};
            res.headers.forEach((v, k) => {
              outHeaders[k.toLowerCase()] = v;
            });
            return {
              url: res.url || targetUrl,
              status: res.status,
              statusText: res.statusText,
              headers: outHeaders,
              method: fetchMethod,
              body: async () => resText,
              json: async <T = unknown>() => JSON.parse(resText) as T,
            };
          },
        };
        void Promise.resolve(rule.handler(routeObj))
          .catch(() => {})
          .finally(() => {
            if (!handled) {
              handled = true;
              void cdpChannel
                .sendCommand("Fetch.continueRequest", { requestId: reqId }, sid ?? null)
                .catch(() => {});
            }
          });
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
      void fulfillWith(rule.response ?? {}).catch(() => {});
    });

    if (useContexts) {
      yield* Effect.tryPromise({
        try: () =>
          cdpChannel
            .sendCommand(
              "Target.setAutoAttach",
              {
                autoAttach: true,
                waitForDebuggerOnStart: true,
                flatten: true,
                filter: [{ type: "page" }],
              },
              null,
            )
            .catch(() => {}),
        catch: () => new DriverError({ message: "Failed to enable Target.setAutoAttach" }),
      }).pipe(Effect.catch(() => Effect.void));
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

      const waitUntil = options.waitUntil ?? "domcontentloaded";
      const targetSid = activeSlot?.sessionId;
      if (target === "about:blank") {
        if (isAtBlank) return;
        await cdpChannel
          .sendCommand("Page.navigate", { url: target }, undefined, 4_000)
          .catch(() => {});
        isAtBlank = true;
        return;
      }
      isAtBlank = false;
      if (waitUntil === "commit") {
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

    let coverageSession: string | null | undefined;
    const service: RawDriverService = {
      domChannel: cdpChannel,

      startJSCoverage: () =>
        Effect.tryPromise({
          try: async () => {
            const session = activeSlot?.sessionId ?? null;
            await cdpChannel.sendCommand("Profiler.enable", {}, session);
            try {
              await cdpChannel.sendCommand(
                "Profiler.startPreciseCoverage",
                { callCount: true, detailed: true },
                session,
              );
              coverageSession = session;
            } catch (error) {
              await cdpChannel.sendCommand("Profiler.disable", {}, session).catch(() => {});
              throw error;
            }
          },
          catch: (error) =>
            new DriverError({ message: `CDP JavaScript coverage is unavailable: ${error}` }),
        }),

      stopJSCoverage: () =>
        Effect.tryPromise({
          try: async () => {
            const session = coverageSession;
            coverageSession = undefined;
            if (session === undefined) throw new Error("JavaScript coverage was not started");
            try {
              const { result } = await cdpChannel.sendCommand<{ result: Array<{ url: string }> }>(
                "Profiler.takePreciseCoverage",
                {},
                session,
              );
              return result.filter(({ url }) => url && !url.startsWith("extensions::"));
            } finally {
              await cdpChannel
                .sendCommand("Profiler.stopPreciseCoverage", {}, session)
                .catch(() => {});
              await cdpChannel.sendCommand("Profiler.disable", {}, session).catch(() => {});
            }
          },
          catch: (error) =>
            new DriverError({ message: `CDP JavaScript coverage collection failed: ${error}` }),
        }),

      beginFlow: (_flowName) =>
        Effect.tryPromise({
          try: async () => {
            const visitedOrigins = new Set<string>();
            for (const u of navigationUrls) {
              try {
                const parsed = new URL(u);
                if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                  visitedOrigins.add(parsed.origin);
                }
              } catch {
                // ignore non-URL entries
              }
            }
            consoleLogs.length = 0;
            jsErrors.length = 0;
            wasmTraps.length = 0;
            navigationUrls.length = 0;
            dialogHandler = null;
            routeRules.length = 0;
            currentNetworkConditions = undefined;
            width = initialWidth;
            height = initialHeight;
            cdpChannel.clearChildSessions();
            if (useContexts && options.freshContextPerFlow && hasRunFirstFlow) {
              if (contextIsolation === "hot-cache" && activeSlot) {
                // 1. Close any extra tabs opened by the prior flow and return to tab 0 BEFORE clearing page state.
                const preResetOps: Array<Promise<unknown>> = [];
                if (activeSlot.tabs.length > 1) {
                  const primaryTab = activeSlot.tabs[0]!;
                  const extraTabs = activeSlot.tabs.slice(1);
                  activeSlot.tabs = [primaryTab];
                  activeSlot.targetId = primaryTab.targetId;
                  activeSlot.sessionId = primaryTab.sessionId;
                  cdpChannel.setSessionId(primaryTab.sessionId);
                  for (const extra of extraTabs) {
                    preResetOps.push(
                      cdpChannel
                        .sendCommand("Target.closeTarget", { targetId: extra.targetId }, null)
                        .catch(() => {}),
                    );
                  }
                }
                if (!isAtBlank) {
                  // Clear in-page localStorage/sessionStorage/OPFS first, then navigate to about:blank
                  // BEFORE calling Storage.clearDataForOrigin so no JS handle contends with CDP storage deletion.
                  preResetOps.push(
                    cdpChannel
                      .evaluateFast(
                        `(async () => {
                          try { localStorage.clear(); sessionStorage.clear(); } catch {}
                          try {
                            if (navigator.storage && typeof navigator.storage.getDirectory === "function") {
                              const root = await navigator.storage.getDirectory();
                              if (root && typeof root.entries === "function") {
                                for await (const [name] of root.entries()) {
                                  await root.removeEntry(name, { recursive: true }).catch(() => {});
                                }
                              }
                            }
                          } catch {}
                        })()`,
                      )
                      .catch(() => {})
                      .then(() =>
                        cdpChannel
                          .sendCommand("Page.navigate", { url: "about:blank" }, undefined, 4_000)
                          .catch(() => {}),
                      )
                      .then(() => {
                        isAtBlank = true;
                      }),
                  );
                }
                if (preResetOps.length > 0) {
                  await Promise.all(preResetOps);
                }
                // 2. Now that the page is safely on about:blank (no active document holding storage locks),
                // wipe cookies, per-origin storage, routes, viewport, emulation, and network conditions in parallel.
                const resetOps: Array<Promise<unknown>> = [
                  cdpChannel.sendCommand("Network.clearBrowserCookies").catch(() => {}),
                ];
                for (const origin of visitedOrigins) {
                  resetOps.push(
                    cdpChannel
                      .sendCommand("Storage.clearDataForOrigin", {
                        origin,
                        storageTypes:
                          "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers,file_systems",
                      })
                      .catch(() => {}),
                  );
                }
                if (fetchInterceptEnabled) {
                  fetchInterceptEnabled = false;
                  resetOps.push(cdpChannel.sendCommand("Fetch.disable").catch(() => {}));
                }
                if (viewportMutated) {
                  viewportMutated = false;
                  resetOps.push(
                    cdpChannel
                      .sendCommand("Emulation.setDeviceMetricsOverride", {
                        width: initialWidth,
                        height: initialHeight,
                        deviceScaleFactor: 1,
                        mobile: false,
                      })
                      .catch(() => {}),
                  );
                }
                if (emulationMutated) {
                  emulationMutated = false;
                  const defaultLocale = options.emulation?.locale ?? "";
                  resetOps.push(
                    cdpChannel
                      .sendCommand("Emulation.setLocaleOverride", { locale: defaultLocale })
                      .catch(() => {}),
                    cdpChannel
                      .sendCommand("Emulation.setUserAgentOverride", {
                        userAgent: cachedUserAgent || "Mozilla/5.0",
                        acceptLanguage: defaultLocale
                          ? defaultLocale.includes("-")
                            ? `${defaultLocale},${defaultLocale.split("-")[0]};q=0.9`
                            : defaultLocale
                          : "",
                      })
                      .catch(() => {}),
                    cdpChannel
                      .sendCommand("Emulation.setEmulatedMedia", {
                        media: "",
                        features: [
                          {
                            name: "prefers-color-scheme",
                            value:
                              options.emulation?.colorScheme &&
                              options.emulation.colorScheme !== "no-preference"
                                ? options.emulation.colorScheme
                                : "",
                          },
                          {
                            name: "prefers-reduced-motion",
                            value:
                              options.emulation?.reducedMotion &&
                              options.emulation.reducedMotion !== "no-preference"
                                ? options.emulation.reducedMotion
                                : "",
                          },
                        ],
                      })
                      .catch(() => {}),
                    cdpChannel
                      .sendCommand("Emulation.setTimezoneOverride", {
                        timezoneId: options.emulation?.timezoneId ?? "",
                      })
                      .catch(() => {}),
                  );
                }
                resetOps.push(
                  cdpChannel
                    .sendCommand("Network.emulateNetworkConditions", {
                      offline: false,
                      latency: 0,
                      downloadThroughput: -1,
                      uploadThroughput: -1,
                    })
                    .catch(() => {}),
                );
                await Promise.all(resetOps);
                const state = await loadStorageStateFile(options.storageState);
                if (state?.cookies && state.cookies.length > 0) {
                  await cdpChannel
                    .sendCommand("Network.setCookies", { cookies: state.cookies })
                    .catch(() => {});
                }
                // Re-ensure virtual authenticator is present in hot-cache mode (2.16)
                if (options.virtualAuthenticator && !activeSlot.authenticatorId) {
                  const authOpts =
                    typeof options.virtualAuthenticator === "object"
                      ? options.virtualAuthenticator
                      : undefined;
                  activeSlot.authenticatorId = await attachVirtualAuthenticatorForSession(
                    activeSlot.sessionId,
                    authOpts,
                  ).catch(() => undefined);
                }
                activeAuthenticatorId = activeSlot.authenticatorId;
              } else {
                fetchInterceptEnabled = false;
                emulationMutated = false;
                viewportMutated = false;
                isAtBlank = true;
                const previousSlot = activeSlot;
                const pending = prefetchedSlotPromise;
                prefetchedSlotPromise = undefined;
                activeSlot = pending
                  ? await pending
                  : await createContextSlot(options.storageState);
                cdpChannel.setSessionId(activeSlot.sessionId);
                if (options.virtualAuthenticator && !activeSlot.authenticatorId) {
                  const authOpts =
                    typeof options.virtualAuthenticator === "object"
                      ? options.virtualAuthenticator
                      : undefined;
                  activeSlot.authenticatorId = await attachVirtualAuthenticatorForSession(
                    activeSlot.sessionId,
                    authOpts,
                  ).catch(() => undefined);
                }
                activeAuthenticatorId = activeSlot.authenticatorId;
                if (previousSlot) {
                  disposeSlotInBackground(previousSlot);
                }
              }
            } else if (activeSlot) {
              // Ensure primary slot's virtual authenticator wasn't dropped between flows (2.16)
              if (options.virtualAuthenticator && !activeSlot.authenticatorId) {
                const authOpts =
                  typeof options.virtualAuthenticator === "object"
                    ? options.virtualAuthenticator
                    : undefined;
                activeSlot.authenticatorId = await attachVirtualAuthenticatorForSession(
                  activeSlot.sessionId,
                  authOpts,
                ).catch(() => undefined);
              }
              activeAuthenticatorId = activeSlot.authenticatorId;
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

      typeText: (text, opts) =>
        Effect.tryPromise({
          try: async () => {
            const delay = opts?.delay ?? 0;
            for (const ch of Array.from(text)) {
              const desc = parseCdpKeyDescriptor(ch);
              await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: desc.key,
                ...(desc.code ? { code: desc.code } : {}),
                ...(desc.windowsVirtualKeyCode
                  ? {
                      windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
                      nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
                    }
                  : {}),
                modifiers: desc.modifiers,
                text: ch,
                unmodifiedText: ch,
              });
              await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: desc.key,
                ...(desc.code ? { code: desc.code } : {}),
                ...(desc.windowsVirtualKeyCode
                  ? {
                      windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
                      nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
                    }
                  : {}),
                modifiers: desc.modifiers,
              });
              if (delay > 0) {
                await new Promise((r) => setTimeout(r, delay));
              }
            }
          },
          catch: (e) => new DriverError({ message: `CDP typeText failed: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          try: async () => {
            const desc = parseCdpKeyDescriptor(key);
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
              type: desc.text ? "keyDown" : "rawKeyDown",
              key: desc.key,
              ...(desc.code ? { code: desc.code } : {}),
              ...(desc.windowsVirtualKeyCode
                ? {
                    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
                    nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
                  }
                : {}),
              modifiers: desc.modifiers,
              ...(desc.text ? { text: desc.text, unmodifiedText: desc.text } : {}),
              ...(desc.commands ? { commands: desc.commands } : {}),
            });
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: desc.key,
              ...(desc.code ? { code: desc.code } : {}),
              ...(desc.windowsVirtualKeyCode
                ? {
                    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
                    nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
                  }
                : {}),
              modifiers: desc.modifiers,
            });
          },
          catch: (e) => new DriverError({ message: `CDP pressKey failed: ${e}` }),
        }),

      keyDown: (key) =>
        Effect.tryPromise({
          try: async () => {
            const desc = parseCdpKeyDescriptor(key);
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
              type: desc.text ? "keyDown" : "rawKeyDown",
              key: desc.key,
              ...(desc.code ? { code: desc.code } : {}),
              ...(desc.windowsVirtualKeyCode
                ? {
                    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
                    nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
                  }
                : {}),
              modifiers: desc.modifiers,
              ...(desc.text ? { text: desc.text, unmodifiedText: desc.text } : {}),
            });
          },
          catch: (e) => new DriverError({ message: `CDP keyDown failed: ${e}` }),
        }),

      keyUp: (key) =>
        Effect.tryPromise({
          try: async () => {
            const desc = parseCdpKeyDescriptor(key);
            await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: desc.key,
              ...(desc.code ? { code: desc.code } : {}),
              ...(desc.windowsVirtualKeyCode
                ? {
                    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
                    nativeVirtualKeyCode: desc.windowsVirtualKeyCode,
                  }
                : {}),
              modifiers: desc.modifiers,
            });
          },
          catch: (e) => new DriverError({ message: `CDP keyUp failed: ${e}` }),
        }),

      mouseDown: (x, y, opts) =>
        Effect.tryPromise({
          try: async () => {
            const button = opts?.button ?? "left";
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button,
              buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
              clickCount: 1,
            });
          },
          catch: (e) => new DriverError({ message: `CDP mouseDown failed: ${e}` }),
        }),

      mouseUp: (x, y, opts) =>
        Effect.tryPromise({
          try: async () => {
            const button = opts?.button ?? "left";
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button,
              buttons: 0,
              clickCount: 1,
            });
          },
          catch: (e) => new DriverError({ message: `CDP mouseUp failed: ${e}` }),
        }),

      mouseWheel: (x, y, deltaX, deltaY) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x,
              y,
              deltaX,
              deltaY,
            });
          },
          catch: (e) =>
            new DriverError({
              message: `CDP mouseWheel (${deltaX}, ${deltaY}) failed at (${x}, ${y}): ${e}`,
            }),
        }),

      getWasmTraps: () =>
        Effect.tryPromise({
          try: async () => {
            const pageTraps = await cdpChannel
              .evaluate<WasmTrap[]>(
                `(() => (globalThis.__spanaWasm ? globalThis.__spanaWasm.getMetrics().traps : []))()`,
              )
              .catch(() => [] as WasmTrap[]);
            const merged: WasmTrap[] = [...wasmTraps];
            const seen = new Set(merged.map((t) => `${t.source}:${t.name}:${t.message}`));
            for (const t of Array.isArray(pageTraps) ? pageTraps : []) {
              const key = `${t.source}:${t.name}:${t.message}`;
              if (!seen.has(key)) {
                seen.add(key);
                merged.push(t);
              }
            }
            return merged;
          },
          catch: (e) => new DriverError({ message: `CDP getWasmTraps failed: ${e}` }),
        }),

      getWasmMetrics: () =>
        Effect.tryPromise({
          try: async () => {
            const raw = await cdpChannel
              .evaluate<WasmMetrics>(
                `(() => globalThis.__spanaWasm ? globalThis.__spanaWasm.getMetrics() : {
                  moduleCount: 0,
                  pendingCount: 0,
                  wasmMemoryBytes: 0,
                  wasmMemoryPages: 0,
                  peakWasmMemoryBytes: 0,
                  crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
                  sharedArrayBufferAvailable: typeof SharedArrayBuffer !== "undefined",
                  traps: [],
                  modules: []
                })()`,
              )
              .catch(() => ({
                moduleCount: 0,
                pendingCount: 0,
                wasmMemoryBytes: 0,
                wasmMemoryPages: 0,
                peakWasmMemoryBytes: 0,
                crossOriginIsolated: false,
                sharedArrayBufferAvailable: false,
                traps: [],
                modules: [],
              }));
            const mergedTraps: WasmTrap[] = [...wasmTraps];
            const seen = new Set(mergedTraps.map((t) => `${t.source}:${t.name}:${t.message}`));
            for (const t of raw.traps ?? []) {
              const key = `${t.source}:${t.name}:${t.message}`;
              if (!seen.has(key)) {
                seen.add(key);
                mergedTraps.push(t);
              }
            }
            return { ...raw, traps: mergedTraps };
          },
          catch: (e) => new DriverError({ message: `CDP getWasmMetrics failed: ${e}` }),
        }),

      hoverAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
            });
          },
          catch: (e) => new DriverError({ message: `CDP hover failed at (${x}, ${y}): ${e}` }),
        }),

      reload: (reloadOpts) =>
        Effect.tryPromise({
          try: async () => {
            const waitUntil = reloadOpts?.waitUntil ?? options.waitUntil ?? "domcontentloaded";
            const targetSid = activeSlot?.sessionId;
            const eventName =
              waitUntil === "domcontentloaded"
                ? "Page.domContentEventFired"
                : "Page.loadEventFired";
            const waiter = cdpChannel.waitForEvent(
              eventName,
              15_000,
              (_p, sid) => !targetSid || !sid || sid === targetSid,
            );
            await cdpChannel.sendCommand("Page.reload", {});
            await waiter.catch(() => {});
          },
          catch: (e) => new DriverError({ message: `CDP reload failed: ${e}` }),
        }),

      getUrl: () =>
        Effect.tryPromise({
          try: async () => {
            const url = await cdpChannel.evaluate<string>(
              "typeof window !== 'undefined' && window.location ? String(window.location.href || '') : ''",
            );
            return url ?? "";
          },
          catch: (e) => new DriverError({ message: `CDP getUrl failed: ${e}` }),
        }),

      getNavigationUrls: () => [...navigationUrls],

      waitForLoadState: (state = "load", waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeoutMs = waitOpts?.timeout ?? 15_000;
            const targetSid = activeSlot?.sessionId;
            if (state === "domcontentloaded") {
              const ready = await cdpChannel
                .evaluate<string>("document.readyState")
                .catch(() => "");
              if (ready === "interactive" || ready === "complete") return;
              await cdpChannel
                .waitForEvent(
                  "Page.domContentEventFired",
                  timeoutMs,
                  (_p, sid) => !targetSid || !sid || sid === targetSid,
                )
                .catch(() => {});
              return;
            }
            if (state === "load") {
              const ready = await cdpChannel
                .evaluate<string>("document.readyState")
                .catch(() => "");
              if (ready === "complete") return;
              await cdpChannel
                .waitForEvent(
                  "Page.loadEventFired",
                  timeoutMs,
                  (_p, sid) => !targetSid || !sid || sid === targetSid,
                )
                .catch(() => {});
              return;
            }
            // networkidle: wait for 500ms with 0 inflight requests
            await cdpChannel.sendCommand("Network.enable").catch(() => {});
            await new Promise<void>((resolve) => {
              let inflight = 0;
              let settled = false;
              let idleTimer: ReturnType<typeof setTimeout> | undefined;
              const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(maxTimer);
                if (idleTimer) clearTimeout(idleTimer);
                offStart();
                offEnd();
                offFail();
                resolve();
              };
              const armIdle = () => {
                if (idleTimer) clearTimeout(idleTimer);
                if (inflight <= 0) {
                  idleTimer = setTimeout(finish, 500);
                }
              };
              const maxTimer = setTimeout(finish, timeoutMs);
              const offStart = cdpChannel.onEvent("Network.requestWillBeSent", (_p, sid) => {
                if (targetSid && sid && sid !== targetSid) return;
                inflight += 1;
                if (idleTimer) clearTimeout(idleTimer);
              });
              const onDone = (_p: unknown, sid?: string) => {
                if (targetSid && sid && sid !== targetSid) return;
                inflight = Math.max(0, inflight - 1);
                armIdle();
              };
              const offEnd = cdpChannel.onEvent("Network.loadingFinished", onDone);
              const offFail = cdpChannel.onEvent("Network.loadingFailed", onDone);
              armIdle();
            });
          },
          catch: (e) => new DriverError({ message: `CDP waitForLoadState failed: ${e}` }),
        }),

      waitForPopup: (triggerFn, waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeoutMs = waitOpts?.timeout ?? 15_000;
            const popupPromise = new Promise<string>((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`Timed out waiting for popup after ${timeoutMs}ms`));
              }, timeoutMs);
              popupWaiters.push({
                resolve: (tabId) => {
                  clearTimeout(timer);
                  resolve(tabId);
                },
                reject: (err) => {
                  clearTimeout(timer);
                  reject(err);
                },
              });
            });
            await triggerFn();
            return await popupPromise;
          },
          catch: (e) => new DriverError({ message: `CDP waitForPopup failed: ${e}` }),
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

      takeFullPageScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            const res = (await cdpChannel.sendCommand("Page.captureScreenshot", {
              format: "png",
              captureBeyondViewport: true,
              fromSurface: true,
            })) as { data?: string };
            return new Uint8Array(Buffer.from(res?.data ?? "", "base64"));
          },
          catch: (e) => new DriverError({ message: `CDP fullPage screenshot failed: ${e}` }),
        }),

      setGeolocation: (point) =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Emulation.setGeolocationOverride", {
              latitude: point.latitude,
              longitude: point.longitude,
              accuracy: point.accuracy ?? 1,
            });
          },
          catch: (e) => new DriverError({ message: `CDP setGeolocation failed: ${e}` }),
        }),

      setPermission: (_appId, permission, state, permOpts) =>
        Effect.tryPromise({
          try: async () => {
            const cdpName =
              permission === "clipboard-read"
                ? "clipboardReadWrite"
                : permission === "clipboard-write"
                  ? "clipboardSanitizedWrite"
                  : permission === "midi-sysex"
                    ? "midi"
                    : permission;
            const origin = permOpts?.origin;
            const ctxId = activeSlot?.browserContextId;
            if (state === "grant") {
              await cdpChannel.sendCommand(
                "Browser.grantPermissions",
                {
                  permissions: [cdpName],
                  ...(origin ? { origin } : {}),
                  ...(ctxId ? { browserContextId: ctxId } : {}),
                },
                null,
              );
            } else {
              await cdpChannel.sendCommand(
                "Browser.setPermission",
                {
                  permission: {
                    name: cdpName,
                    ...(permission === "midi-sysex" ? { sysex: true } : {}),
                  },
                  setting: "denied",
                  ...(origin ? { origin } : {}),
                  ...(ctxId ? { browserContextId: ctxId } : {}),
                },
                null,
              );
            }
          },
          catch: (e) => new DriverError({ message: `CDP setPermission failed: ${e}` }),
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
            prefetchedSlotPromise = undefined;
            // All contexts are created with disposeOnDetach: true, so disconnecting cleans up immediately
            // without stalling teardown on pending prefetches or background disposal timers.
            if (useContexts && activeSlot) {
              void cdpChannel
                .sendCommand(
                  "Target.disposeBrowserContext",
                  { browserContextId: activeSlot.browserContextId },
                  null,
                )
                .catch(() => {});
            }
            if (downloadDir) {
              try {
                rmSync(downloadDir, { recursive: true, force: true });
              } catch {
                // ignore temp dir cleanup errors
              }
              downloadDir = undefined;
            }
            for (const dir of uploadTempDirs.splice(0)) {
              try {
                rmSync(dir, { recursive: true, force: true });
              } catch {
                // ignore temp dir cleanup errors
              }
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
            const targetSid = activeSlot?.sessionId;
            const history = (await cdpChannel
              .sendCommand("Page.getNavigationHistory", {})
              .catch(() => null)) as {
              currentIndex?: number;
              entries?: Array<{ id: number; url: string }>;
            } | null;
            if (history?.entries && typeof history.currentIndex === "number") {
              const targetEntry = history.entries[history.currentIndex - 1];
              if (!targetEntry) return;
              const eventName =
                (options.waitUntil ?? "domcontentloaded") === "load"
                  ? "Page.loadEventFired"
                  : "Page.domContentEventFired";
              const waiter = Promise.race([
                cdpChannel.waitForEvent(
                  eventName,
                  10_000,
                  (_p, sid) => !targetSid || !sid || sid === targetSid,
                ),
                cdpChannel.waitForEvent(
                  "Page.navigatedWithinDocument",
                  10_000,
                  (_p, sid) => !targetSid || !sid || sid === targetSid,
                ),
              ]);
              await cdpChannel.sendCommand("Page.navigateToHistoryEntry", {
                entryId: targetEntry.id,
              });
              await waiter.catch(() => {});
              return;
            }
            await cdpChannel.evaluate("window.history.back()");
          },
          catch: (e) => new DriverError({ message: `CDP back failed: ${e}` }),
        }),

      forward: () =>
        Effect.tryPromise({
          try: async () => {
            const targetSid = activeSlot?.sessionId;
            const history = (await cdpChannel
              .sendCommand("Page.getNavigationHistory", {})
              .catch(() => null)) as {
              currentIndex?: number;
              entries?: Array<{ id: number; url: string }>;
            } | null;
            if (history?.entries && typeof history.currentIndex === "number") {
              const targetEntry = history.entries[history.currentIndex + 1];
              if (!targetEntry) return;
              const eventName =
                (options.waitUntil ?? "domcontentloaded") === "load"
                  ? "Page.loadEventFired"
                  : "Page.domContentEventFired";
              const waiter = Promise.race([
                cdpChannel.waitForEvent(
                  eventName,
                  10_000,
                  (_p, sid) => !targetSid || !sid || sid === targetSid,
                ),
                cdpChannel.waitForEvent(
                  "Page.navigatedWithinDocument",
                  10_000,
                  (_p, sid) => !targetSid || !sid || sid === targetSid,
                ),
              ]);
              await cdpChannel.sendCommand("Page.navigateToHistoryEntry", {
                entryId: targetEntry.id,
              });
              await waiter.catch(() => {});
              return;
            }
            await cdpChannel.evaluate("window.history.forward()");
          },
          catch: (e) => new DriverError({ message: `CDP forward failed: ${e}` }),
        }),

      evaluate: (fn, ...args) =>
        Effect.tryPromise({
          try: async () => {
            if (typeof fn === "string") {
              return (await cdpChannel.evaluate(fn)) as any;
            }
            const serializedArgs = args
              .map((a) => (a === undefined ? "undefined" : JSON.stringify(a)))
              .join(", ");
            return (await cdpChannel.evaluate(`(${fn.toString()})(${serializedArgs})`)) as any;
          },
          catch: (e) => new DriverError({ message: `CDP evaluate failed: ${e}` }),
        }),

      addInitScript: (script, ...args) =>
        Effect.tryPromise({
          try: async () => {
            const source =
              typeof script === "string"
                ? script
                : `(${script.toString()})(${args.map((a) => (a === undefined ? "undefined" : JSON.stringify(a))).join(", ")});`;
            initScripts.push(source);
            const sessions = activeSlot
              ? activeSlot.tabs.map((t) => t.sessionId)
              : [null as string | null];
            await Promise.all(
              sessions.map((sid) =>
                cdpChannel
                  .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source }, sid)
                  .catch(() => {}),
              ),
            );
          },
          catch: (e) => new DriverError({ message: `CDP addInitScript failed: ${e}` }),
        }),

      exposeFunction: (name, fn) =>
        Effect.tryPromise({
          try: async () => {
            exposedFunctions.set(name, fn);
            const sessions = activeSlot
              ? activeSlot.tabs.map((t) => t.sessionId)
              : [null as string | null];
            await Promise.all(sessions.map((sid) => installExposeFunctionOnSession(sid, name)));
          },
          catch: (e) => new DriverError({ message: `CDP exposeFunction failed: ${e}` }),
        }),

      getRawPage: () => ({
        kind: "cdp",
        cdpChannel,
        sessionId: activeSlot?.sessionId ?? null,
        browserContextId: activeSlot?.browserContextId ?? null,
      }),

      getCdpSession: (): CdpSessionHandle => ({
        send: <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>) =>
          cdpChannel.sendCommand<T>(method, params ?? {}),
        on: (event: string, listener: (params: Record<string, unknown>) => void) =>
          cdpChannel.onEvent(event, (params, sid) => {
            if (activeSlot && sid && sid !== activeSlot.sessionId) return;
            listener((params ?? {}) as Record<string, unknown>);
          }),
        get sessionId() {
          return activeSlot?.sessionId;
        },
        get browserContextId() {
          return activeSlot?.browserContextId;
        },
      }),

      route: (matcher, handler) =>
        Effect.tryPromise({
          try: async () => {
            routeRules.push({ kind: "handler", matcher, handler });
            await ensureFetchIntercept();
          },
          catch: (e) => new DriverError({ message: `CDP route failed: ${e}` }),
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
            const cookies = await (async () => {
              if (activeSlot?.browserContextId) {
                const storageRes = (await cdpChannel
                  .sendCommand(
                    "Storage.getCookies",
                    { browserContextId: activeSlot.browserContextId },
                    null,
                  )
                  .catch(() => null)) as { cookies?: unknown[] } | null;
                if (Array.isArray(storageRes?.cookies)) return storageRes.cookies;
              }
              const res = (await cdpChannel.sendCommand("Network.getCookies")) as {
                cookies?: unknown[];
              };
              return res?.cookies ?? [];
            })();
            await writeFile(path, JSON.stringify(cookies, null, 2), "utf8");
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

      getCookies: (urls) =>
        Effect.tryPromise({
          try: async () => {
            if (urls && urls.length > 0) {
              const res = (await cdpChannel.sendCommand("Network.getCookies", { urls })) as {
                cookies?: BrowserCookie[];
              };
              return Array.isArray(res?.cookies) ? res.cookies : [];
            }
            // Return ALL cookies in the browser context regardless of current page URL (2.22)
            if (activeSlot?.browserContextId) {
              const storageRes = (await cdpChannel
                .sendCommand(
                  "Storage.getCookies",
                  { browserContextId: activeSlot.browserContextId },
                  null,
                )
                .catch(() => null)) as { cookies?: BrowserCookie[] } | null;
              if (Array.isArray(storageRes?.cookies)) return storageRes.cookies;
            }
            const allRes = (await cdpChannel
              .sendCommand("Network.getAllCookies")
              .catch(() => null)) as { cookies?: BrowserCookie[] } | null;
            if (Array.isArray(allRes?.cookies)) return allRes.cookies;
            const res = (await cdpChannel.sendCommand("Network.getCookies", {})) as {
              cookies?: BrowserCookie[];
            };
            return Array.isArray(res?.cookies) ? res.cookies : [];
          },
          catch: (e) => new DriverError({ message: `CDP getCookies failed: ${e}` }),
        }),

      setCookies: (cookies) =>
        Effect.tryPromise({
          try: async () => {
            if (cookies.length === 0) return;
            await cdpChannel.sendCommand("Network.setCookies", { cookies });
          },
          catch: (e) => new DriverError({ message: `CDP setCookies failed: ${e}` }),
        }),

      clearCookies: () =>
        Effect.tryPromise({
          try: async () => {
            await cdpChannel.sendCommand("Network.clearBrowserCookies");
          },
          catch: (e) => new DriverError({ message: `CDP clearCookies failed: ${e}` }),
        }),

      waitForResponse: (matcher, waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeoutMs = waitOpts?.timeout ?? 15_000;
            const slotSessions = (): Set<string> | null => {
              if (!activeSlot) return null;
              const set = new Set<string>([activeSlot.sessionId]);
              for (const t of activeSlot.tabs) {
                if (t.sessionId) set.add(t.sessionId);
              }
              return set;
            };
            const matchesActiveSlot = (sid?: string): boolean => {
              const allowed = slotSessions();
              if (!allowed || !sid) return true;
              return allowed.has(sid);
            };
            activeResponseWatchers += 1;
            const initialSessions = slotSessions();
            if (initialSessions && initialSessions.size > 0) {
              await Promise.all(
                Array.from(initialSessions).map((sid) =>
                  cdpChannel.sendCommand("Network.enable", {}, sid).catch(() => {}),
                ),
              );
            } else {
              await cdpChannel.sendCommand("Network.enable").catch(() => {});
            }
            const requestMethods = new Map<string, string>();
            return await new Promise<BrowserResponseInfo>((resolve, reject) => {
              let cleaned = false;
              const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                activeResponseWatchers = Math.max(0, activeResponseWatchers - 1);
                clearTimeout(timer);
                offReq();
                offRes();
              };
              const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timed out waiting for response after ${timeoutMs}ms`));
              }, timeoutMs);
              const emitResponse = (
                resp: Record<string, unknown>,
                requestId: string,
                sid?: string,
                explicitMethod?: string,
              ) => {
                const rawHeaders = (resp.headers ?? {}) as Record<string, unknown>;
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(rawHeaders)) {
                  headers[k.toLowerCase()] = String(v);
                }
                const responseSid = sid ?? activeSlot?.sessionId ?? null;
                const info: BrowserResponseInfo = {
                  url: String(resp.url ?? ""),
                  status: Number(resp.status ?? 0),
                  statusText: String(resp.statusText ?? ""),
                  headers,
                  method: explicitMethod ?? requestMethods.get(`${sid ?? ""}:${requestId}`),
                  body: async () => {
                    const bodyRes = (await cdpChannel.sendCommand(
                      "Network.getResponseBody",
                      { requestId },
                      responseSid,
                    )) as { body?: string; base64Encoded?: boolean };
                    if (bodyRes?.base64Encoded && bodyRes.body) {
                      return Buffer.from(bodyRes.body, "base64").toString("utf8");
                    }
                    return bodyRes?.body ?? "";
                  },
                  json: async <T = unknown>() => {
                    const text = await info.body!();
                    return JSON.parse(text) as T;
                  },
                };
                const matched =
                  typeof matcher === "function" ? matcher(info) : matchUrl(matcher, info.url);
                if (matched) {
                  cleanup();
                  resolve(info);
                }
              };
              const offReq = cdpChannel.onEvent("Network.requestWillBeSent", (params, sid) => {
                if (!matchesActiveSlot(sid)) return;
                const reqId = String(params?.requestId ?? "");
                const key = `${sid ?? ""}:${reqId}`;
                // CDP emits 3xx redirect responses via `redirectResponse` on the follow-up requestWillBeSent
                // rather than `Network.responseReceived`. Match them against the original request's method.
                if (params?.redirectResponse) {
                  const origMethod = requestMethods.get(key);
                  emitResponse(params.redirectResponse, reqId, sid, origMethod);
                }
                if (params?.requestId && params?.request?.method) {
                  requestMethods.set(key, String(params.request.method));
                }
              });
              const offRes = cdpChannel.onEvent("Network.responseReceived", (params, sid) => {
                if (!matchesActiveSlot(sid)) return;
                const resp = params?.response;
                if (!resp) return;
                emitResponse(resp, String(params?.requestId ?? ""), sid);
              });
            });
          },
          catch: (e) => new DriverError({ message: `CDP waitForResponse failed: ${e}` }),
        }),

      onRequest: (listener) => {
        requestListeners.add(listener);
        const sessions = activeSlot
          ? activeSlot.tabs.map((t) => t.sessionId)
          : [null as string | null];
        for (const sid of sessions) {
          void cdpChannel.sendCommand("Network.enable", {}, sid).catch(() => {});
        }
        return () => {
          requestListeners.delete(listener);
        };
      },

      waitForRequest: (matcher, waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeoutMs = waitOpts?.timeout ?? 15_000;
            const sessions = activeSlot
              ? activeSlot.tabs.map((t) => t.sessionId)
              : [null as string | null];
            await Promise.all(
              sessions.map((sid) =>
                cdpChannel.sendCommand("Network.enable", {}, sid).catch(() => {}),
              ),
            );
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
                reject(new Error(`Timed out waiting for request after ${timeoutMs}ms`));
              }, timeoutMs);
              const onReq = (req: BrowserRequestInfo) => {
                const matched =
                  typeof matcher === "function" ? matcher(req) : matchUrl(matcher, req.url);
                if (matched) {
                  cleanup();
                  resolve(req);
                }
              };
              requestListeners.add(onReq);
            });
          },
          catch: (e) => new DriverError({ message: `CDP waitForRequest failed: ${e}` }),
        }),

      createIsolatedContext: (ctxOpts) =>
        Effect.tryPromise({
          try: async () => {
            const childDriver = await Effect.runPromise(
              makeLightweightCdpDriver({
                ...options,
                cdpUrl: connectWsUrl ?? options.cdpUrl,
                useBrowserContexts: true,
                freshContextPerFlow: false,
                ...(ctxOpts?.viewport ? { viewport: ctxOpts.viewport } : {}),
                ...(ctxOpts?.locale
                  ? { emulation: { ...options.emulation, locale: ctxOpts.locale } }
                  : {}),
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
          catch: (e) => new DriverError({ message: `CDP createIsolatedContext failed: ${e}` }),
        }),

      saveAuthState: (path) =>
        Effect.tryPromise({
          try: async () => {
            const cookies = await (async () => {
              if (activeSlot?.browserContextId) {
                const storageRes = (await cdpChannel
                  .sendCommand(
                    "Storage.getCookies",
                    { browserContextId: activeSlot.browserContextId },
                    null,
                  )
                  .catch(() => null)) as { cookies?: unknown[] } | null;
                if (Array.isArray(storageRes?.cookies)) return storageRes.cookies;
              }
              const res = (await cdpChannel.sendCommand("Network.getCookies")) as {
                cookies?: unknown[];
              };
              return res?.cookies ?? [];
            })();
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
              cookies,
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
            if (activeSlot) activeSlot.authenticatorId = activeAuthenticatorId;
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
            if (activeSlot && activeSlot.authenticatorId === id) {
              activeSlot.authenticatorId = undefined;
            }
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

      addVirtualCredential: (credential: VirtualCredentialInput, authenticatorId?: string) =>
        Effect.tryPromise({
          try: async () => {
            let id = authenticatorId ?? activeAuthenticatorId;
            if (!id) {
              id = await attachVirtualAuthenticatorForSession(activeSlot?.sessionId ?? null);
              activeAuthenticatorId = id;
            }
            await cdpChannel.sendCommand("WebAuthn.addCredential", {
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
          },
          catch: (e) => new DriverError({ message: `CDP addVirtualCredential failed: ${e}` }),
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
            currentNetworkConditions = { ...conditions };
            // Apply to ALL tabs in the active browser context (3.16)
            const sessions = activeSlot
              ? Array.from(
                  new Set([activeSlot.sessionId, ...activeSlot.tabs.map((t) => t.sessionId)]),
                )
              : [null as string | null];
            await Promise.all(
              sessions.map((sid) => applyNetworkConditionsToSession(sid, conditions)),
            );
          },
          catch: (e) => new DriverError({ message: `CDP setNetworkConditions failed: ${e}` }),
        }),

      uploadFile: (selector: Selector, filePath: UploadFileInput) =>
        Effect.tryPromise({
          try: async () => {
            const rawItems = Array.isArray(filePath) ? filePath : [filePath];
            const files: string[] = [];
            let batchTempDir: string | undefined;
            for (const item of rawItems) {
              if (typeof item === "string") {
                files.push(item);
              } else {
                if (!batchTempDir) {
                  batchTempDir = mkdtempSync(join(tmpdir(), "spana-cdp-upload-"));
                  uploadTempDirs.push(batchTempDir);
                }
                const safeFileName = item.name.replaceAll(/[\\/]/g, "_") || "upload.bin";
                const dest = join(batchTempDir, safeFileName);
                await writeFile(dest, Buffer.from(item.buffer));
                files.push(dest);
              }
            }
            const expr = buildDomFindElementScript(selector);
            await cdpChannel.sendCommand("DOM.enable");
            await cdpChannel.sendCommand("DOM.getDocument", { depth: 0 }).catch(() => {});

            const envTimeout = Number(process.env["SPANA_UPLOAD_TIMEOUT_MS"]);
            const attachTimeout =
              Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : UPLOAD_ATTACH_TIMEOUT_MS;
            const deadline = Date.now() + attachTimeout;
            let objectId: string | undefined;
            while (Date.now() < deadline) {
              const evalRes = (await cdpChannel.sendCommand("Runtime.evaluate", {
                expression: expr,
                returnByValue: false,
              })) as { result?: { objectId?: string } };
              if (evalRes?.result?.objectId) {
                objectId = evalRes.result.objectId;
                break;
              }
              await new Promise((r) => setTimeout(r, 50));
            }
            if (!objectId) {
              throw new Error(
                `No matching file input found within ${attachTimeout}ms for selector ${JSON.stringify(selector)}`,
              );
            }
            const nodeRes = (await cdpChannel
              .sendCommand("DOM.requestNode", { objectId })
              .catch(() => ({}))) as { nodeId?: number };
            if (nodeRes?.nodeId && nodeRes.nodeId > 0) {
              await cdpChannel.sendCommand("DOM.setFileInputFiles", {
                nodeId: nodeRes.nodeId,
                files,
              });
            } else {
              await cdpChannel.sendCommand("DOM.setFileInputFiles", {
                objectId,
                files,
              });
            }
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
              (await new Promise<CompletedCdpDownload>((resolve, reject) => {
                const timer = setTimeout(() => {
                  reject(new Error("Timed out waiting for CDP file download"));
                }, 15_000);
                downloadWaiters.push({
                  resolve: (entry) => {
                    clearTimeout(timer);
                    resolve(entry);
                  },
                  reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                  },
                });
              }));
            await copyFile(downloaded.filePath, destPath);
          },
          catch: (e) => new DriverError({ message: `CDP downloadFile failed: ${e}` }),
        }),

      dragAndDrop: (fromX: number, fromY: number, toX: number, toY: number, steps = 10) =>
        Effect.tryPromise({
          try: async () => {
            // If the source (or an ancestor) uses HTML5 Drag and Drop (`draggable="true"`),
            // raw CDP mouse events do not trigger HTML5 DataTransfer drag events; drive DragEvent
            // with a 2-rAF yield after `dragstart` so React/Vue drop handlers mount before `drop`.
            const didHtml5Drag = await cdpChannel
              .evaluate<boolean>(
                `(async (fx, fy, tx, ty) => {
                  const hit = document.elementFromPoint(fx, fy);
                  const src = hit && hit.closest ? hit.closest('[draggable="true"]') : null;
                  if (!src) return false;
                  const dst = document.elementFromPoint(tx, ty) || document.body;
                  const dt = new DataTransfer();
                  src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, clientX: fx, clientY: fy, dataTransfer: dt }));
                  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                  dst.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: dt }));
                  dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: dt }));
                  dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: dt }));
                  src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: dt }));
                  return true;
                })(${fromX}, ${fromY}, ${toX}, ${toY})`,
              )
              .catch(() => false);
            if (didHtml5Drag) return;
            const totalSteps = Math.max(1, Math.round(steps));
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: fromX,
              y: fromY,
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: fromX,
              y: fromY,
              button: "left",
              buttons: 1,
              clickCount: 1,
            });
            for (let i = 1; i <= totalSteps; i++) {
              const t = i / totalSteps;
              await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: fromX + (toX - fromX) * t,
                y: fromY + (toY - fromY) * t,
                button: "left",
                buttons: 1,
              });
            }
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: toX,
              y: toY,
              button: "left",
              buttons: 0,
              clickCount: 1,
            });
          },
          catch: (e) => new DriverError({ message: `CDP dragAndDrop failed: ${e}` }),
        }),

      setViewport: (viewport) =>
        Effect.tryPromise({
          try: async () => {
            width = viewport.width;
            height = viewport.height;
            viewportMutated = true;
            await cdpChannel.sendCommand("Emulation.setDeviceMetricsOverride", {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
              mobile: viewport.mobile ?? false,
            });
          },
          catch: (e) => new DriverError({ message: `CDP setViewport failed: ${e}` }),
        }),

      setEmulation: (emulationOpts: BrowserEmulationOptions) =>
        Effect.tryPromise({
          try: async () => {
            emulationMutated = true;
            const features: Array<{ name: string; value: string }> = [];
            if (emulationOpts.colorScheme !== undefined) {
              features.push({
                name: "prefers-color-scheme",
                value:
                  emulationOpts.colorScheme === "no-preference" ? "" : emulationOpts.colorScheme,
              });
            }
            if (emulationOpts.reducedMotion !== undefined) {
              features.push({
                name: "prefers-reduced-motion",
                value:
                  emulationOpts.reducedMotion === "no-preference"
                    ? ""
                    : emulationOpts.reducedMotion,
              });
            }
            if (features.length > 0) {
              await cdpChannel.sendCommand("Emulation.setEmulatedMedia", { features });
            }
            if (emulationOpts.locale !== undefined) {
              await applyLocaleOverride(activeSlot?.sessionId ?? null, emulationOpts.locale);
            }
            if (emulationOpts.timezoneId !== undefined) {
              await cdpChannel
                .sendCommand("Emulation.setTimezoneOverride", {
                  timezoneId: emulationOpts.timezoneId,
                })
                .catch(() => {});
            }
          },
          catch: (e) => new DriverError({ message: `CDP setEmulation failed: ${e}` }),
        }),

      setDialogHandler: (handler) =>
        Effect.sync(() => {
          dialogHandler = handler;
        }),

      getClipboard: () =>
        Effect.tryPromise({
          try: async () => {
            if (activeSlot?.browserContextId) {
              await cdpChannel
                .sendCommand(
                  "Browser.grantPermissions",
                  {
                    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
                    browserContextId: activeSlot.browserContextId,
                  },
                  null,
                )
                .catch(() => {});
            }
            const res = (await cdpChannel.sendCommand("Runtime.evaluate", {
              expression: `(async () => {
                if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
                  try { return await navigator.clipboard.readText(); } catch {}
                }
                return typeof window.__spanaClipboardText === "string" ? window.__spanaClipboardText : "";
              })()`,
              awaitPromise: true,
              returnByValue: true,
              userGesture: true,
            })) as { result?: { value?: unknown } };
            return typeof res?.result?.value === "string" ? res.result.value : "";
          },
          catch: (e) => new DriverError({ message: `CDP getClipboard failed: ${e}` }),
        }),

      setClipboard: (text: string) =>
        Effect.tryPromise({
          try: async () => {
            if (activeSlot?.browserContextId) {
              await cdpChannel
                .sendCommand(
                  "Browser.grantPermissions",
                  {
                    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
                    browserContextId: activeSlot.browserContextId,
                  },
                  null,
                )
                .catch(() => {});
            }
            const encoded = JSON.stringify(text);
            await cdpChannel.sendCommand("Runtime.evaluate", {
              expression: `(async (txt) => {
                window.__spanaClipboardText = txt;
                if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
                  try { await navigator.clipboard.writeText(txt); return; } catch {}
                }
              })(${encoded})`,
              awaitPromise: true,
              returnByValue: true,
              userGesture: true,
            });
          },
          catch: (e) => new DriverError({ message: `CDP setClipboard failed: ${e}` }),
        }),

      waitForDownload: (triggerFn, dlOpts) =>
        Effect.tryPromise({
          try: async (): Promise<BrowserDownloadInfo> => {
            const timeoutMs = dlOpts?.timeout ?? 15_000;
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
            const downloadPromise = new Promise<CompletedCdpDownload>((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`Timed out waiting for download after ${timeoutMs}ms`));
              }, timeoutMs);
              downloadWaiters.push({
                resolve: (entry) => {
                  clearTimeout(timer);
                  resolve(entry);
                },
                reject: (err) => {
                  clearTimeout(timer);
                  reject(err);
                },
              });
            });
            await triggerFn();
            const entry = await downloadPromise;
            return {
              suggestedFilename: entry.suggestedFilename,
              path: entry.filePath,
              url: entry.url,
              text: () => readFile(entry.filePath, "utf8"),
              bytes: async () => new Uint8Array(await readFile(entry.filePath)),
              saveAs: async (destPath: string) => {
                await copyFile(entry.filePath, destPath);
              },
            };
          },
          catch: (e) => new DriverError({ message: `CDP waitForDownload failed: ${e}` }),
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
