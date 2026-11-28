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
  HttpCredentials,
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
  serializeEvaluateArg,
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
  /** Enable Chromium OS sandbox (default: false — passes `--no-sandbox` for Ubuntu 23.10+/CI compatibility). */
  chromiumSandbox?: boolean;
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
      const sandboxHint = /no usable sandbox/i.test(tail)
        ? '\nHint: Chromium\'s OS sandbox is blocked on this host (common on Ubuntu 23.10+ / GitHub Actions with AppArmor unprivileged userns restrictions). Either keep `execution.web.chromiumSandbox: false` (default), add `execution.web.args: ["--no-sandbox"]`, or allow unprivileged user namespaces via `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.'
        : "";
      throw new Error(
        `Direct CDP browser exited prematurely (code=${exit.code}, signal=${exit.signal})${sandboxHint}${tail ? `\nstderr:\n${tail}` : ""}`,
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
  /** Enable Chromium OS sandbox (default: false — passes `--no-sandbox`, matching Playwright's default). */
  chromiumSandbox?: boolean;
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
  const extraArgs = options.args ?? [];
  const needNoSandbox = options.chromiumSandbox !== true && !extraArgs.includes("--no-sandbox");
  const needDisableSetuidSandbox =
    process.platform === "linux" &&
    options.chromiumSandbox !== true &&
    !extraArgs.includes("--disable-setuid-sandbox");
  const hasBlinkSettings = extraArgs.some((a) => a.startsWith("--blink-settings="));
  const isHeadless = options.headless !== false;
  return [
    ...(isHeadless ? ["--headless=new"] : []),
    ...(needNoSandbox ? ["--no-sandbox"] : []),
    ...(needDisableSetuidSandbox ? ["--disable-setuid-sandbox"] : []),
    ...(!hasBlinkSettings
      ? [
          "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ]
      : []),
    ...(isHeadless && !extraArgs.includes("--hide-scrollbars") ? ["--hide-scrollbars"] : []),
    ...(isHeadless && !extraArgs.includes("--mute-audio") ? ["--mute-audio"] : []),
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
    ...extraArgs,
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
  // On Linux, Chromium creates a `SingletonSocket` Unix domain socket under TMPDIR / userDataDir, which
  // crashes with SIGABRT ("Socket path too long") if TMPDIR exceeds ~50 chars (Linux 108-byte sun_path limit).
  const rawTmp = tmpdir();
  const safeTmpDir =
    process.platform === "linux" && rawTmp.length > 40 && existsSync("/tmp") ? "/tmp" : rawTmp;
  const userDataDir = mkdtempSync(join(safeTmpDir, "spana-cdp-"));
  const baseChromeArgs = buildDirectChromiumLaunchArgs({
    userDataDir,
    remoteDebuggingPort: 0,
    headless: options.headless,
    chromiumSandbox: options.chromiumSandbox,
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
    ...(safeTmpDir !== rawTmp ? { env: { ...process.env, TMPDIR: safeTmpDir } } : {}),
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
        await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 500))]);
        if (!exitState.exited) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already exited
          }
          await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 150))]);
        }
      }
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Map Playwright / W3C permission names (e.g. `"camera"`, `"microphone"`, `"clipboard-read"`)
 * to Chromium CDP `Browser.grantPermissions` `PermissionType` enum values (3.29).
 */
export function mapPermissionToCdpGrantName(permission: string): string {
  switch (permission) {
    case "camera":
      return "videoCapture";
    case "microphone":
      return "audioCapture";
    case "clipboard-read":
      return "clipboardReadWrite";
    case "clipboard-write":
      return "clipboardSanitizedWrite";
    case "midi-sysex":
      return "midiSysex";
    case "background-sync":
      return "backgroundSync";
    case "ambient-light-sensor":
    case "accelerometer":
    case "gyroscope":
    case "magnetometer":
      return "sensors";
    case "accessibility-events":
      return "accessibilityEvents";
    case "payment-handler":
      return "paymentHandler";
    case "storage-access":
      return "storageAccess";
    case "top-level-storage-access":
      return "topLevelStorageAccess";
    case "local-fonts":
      return "localFonts";
    case "screen-wake-lock":
      return "wakeLockScreen";
    case "idle-detection":
      return "idleDetection";
    case "window-management":
      return "windowManagement";
    default:
      return permission;
  }
}

/**
 * Map Playwright / CDP permission names to Chromium CDP `Browser.setPermission`
 * `PermissionDescriptor` objects (which use W3C kebab-case names).
 */
export function mapPermissionToCdpDescriptor(permission: string): {
  name: string;
  sysex?: boolean;
} {
  switch (permission) {
    case "videoCapture":
      return { name: "camera" };
    case "audioCapture":
      return { name: "microphone" };
    case "clipboardReadWrite":
      return { name: "clipboard-read" };
    case "clipboardSanitizedWrite":
      return { name: "clipboard-write" };
    case "midi-sysex":
    case "midiSysex":
      return { name: "midi", sysex: true };
    case "backgroundSync":
      return { name: "background-sync" };
    case "accessibilityEvents":
      return { name: "accessibility-events" };
    case "paymentHandler":
      return { name: "payment-handler" };
    case "storageAccess":
      return { name: "storage-access" };
    case "localFonts":
      return { name: "local-fonts" };
    case "wakeLockScreen":
      return { name: "screen-wake-lock" };
    case "idleDetection":
      return { name: "idle-detection" };
    case "windowManagement":
      return { name: "window-management" };
    default:
      return { name: permission };
  }
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
  /** Optional viewport dimensions & mobile metrics reported to coordinator (default: 1280×720). */
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    isMobile?: boolean;
    hasTouch?: boolean;
  };
  /** Device pixel ratio override (default: `viewport.deviceScaleFactor ?? 1`). */
  deviceScaleFactor?: number;
  /** Emulate mobile device metrics (`isMobile` alias also accepted). */
  mobile?: boolean;
  /** Playwright-compatible alias for `mobile`. */
  isMobile?: boolean;
  /** Enable touch event emulation (`Emulation.setTouchEmulationEnabled`). */
  hasTouch?: boolean;
  /** HTTP Basic/Digest authentication credentials answered via CDP `Fetch.authRequired`. */
  httpCredentials?: HttpCredentials;
  /** Evaluation timeout in ms (default: 10_000). */
  evaluateTimeout?: number;
  /** Navigation timeout in ms for `openLink`, `launchApp`, `reload`, `back`, `forward` (default: 30_000). */
  navigationTimeout?: number;
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
  /**
   * Sanitize Chromium's default `HeadlessChrome/` User-Agent token to `Chrome/` when no
   * explicit `emulation.userAgent` (or `--user-agent=` flag) is provided. Default: `true`.
   */
  sanitizeHeadlessUserAgent?: boolean;
  /** Optional JS expression evaluated before fail-fast idle checks (sets `window.__SPANA_APP_READY__`). */
  readyExpression?: string;
  /** @internal Mark channel permanently closed on `killApp()` (used by `createIsolatedContext`). */
  _markClosedOnKill?: boolean;
  /** Injectable fetch & WebSocket factory for tests. */
  fetchFn?: typeof fetch;
  createWebSocket?: WebSocketFactory;
}

const CDP_DUMP_HIERARCHY_SCRIPT = `(() => {
  function walk(el) {
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const style = window.getComputedStyle ? window.getComputedStyle(el) : { display: "block", visibility: "visible", opacity: "1" };
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
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

const CDP_SPECIAL_KEYS: Record<
  string,
  { key?: string; code: string; keyCode: number; text?: string }
> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  CapsLock: { code: "CapsLock", keyCode: 20 },
  NumLock: { code: "NumLock", keyCode: 144 },
  ScrollLock: { code: "ScrollLock", keyCode: 145 },
  PrintScreen: { code: "PrintScreen", keyCode: 44 },
  Pause: { code: "Pause", keyCode: 19 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  F1: { code: "F1", keyCode: 112 },
  F2: { code: "F2", keyCode: 113 },
  F3: { code: "F3", keyCode: 114 },
  F4: { code: "F4", keyCode: 115 },
  F5: { code: "F5", keyCode: 116 },
  F6: { code: "F6", keyCode: 117 },
  F7: { code: "F7", keyCode: 118 },
  F8: { code: "F8", keyCode: 119 },
  F9: { code: "F9", keyCode: 120 },
  F10: { code: "F10", keyCode: 121 },
  F11: { code: "F11", keyCode: 122 },
  F12: { code: "F12", keyCode: 123 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  Backquote: { key: "`", code: "Backquote", keyCode: 192, text: "`" },
  Minus: { key: "-", code: "Minus", keyCode: 189, text: "-" },
  Equal: { key: "=", code: "Equal", keyCode: 187, text: "=" },
  BracketLeft: { key: "[", code: "BracketLeft", keyCode: 219, text: "[" },
  BracketRight: { key: "]", code: "BracketRight", keyCode: 221, text: "]" },
  Backslash: { key: "\\", code: "Backslash", keyCode: 220, text: "\\" },
  Semicolon: { key: ";", code: "Semicolon", keyCode: 186, text: ";" },
  Quote: { key: "'", code: "Quote", keyCode: 222, text: "'" },
  Comma: { key: ",", code: "Comma", keyCode: 188, text: "," },
  Period: { key: ".", code: "Period", keyCode: 190, text: "." },
  Slash: { key: "/", code: "Slash", keyCode: 191, text: "/" },
};

const CDP_PUNCTUATION_CHAR_MAP: Record<string, { code: string; keyCode: number }> = {
  "!": { code: "Digit1", keyCode: 49 },
  "@": { code: "Digit2", keyCode: 50 },
  "#": { code: "Digit3", keyCode: 51 },
  $: { code: "Digit4", keyCode: 52 },
  "%": { code: "Digit5", keyCode: 53 },
  "^": { code: "Digit6", keyCode: 54 },
  "&": { code: "Digit7", keyCode: 55 },
  "*": { code: "Digit8", keyCode: 56 },
  "(": { code: "Digit9", keyCode: 57 },
  ")": { code: "Digit0", keyCode: 48 },
  "`": { code: "Backquote", keyCode: 192 },
  "~": { code: "Backquote", keyCode: 192 },
  "-": { code: "Minus", keyCode: 189 },
  _: { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "+": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "{": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "}": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  "|": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  ":": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  '"': { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  "<": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  ">": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "?": { code: "Slash", keyCode: 191 },
};

function modifierBitForName(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "alt" || lower === "option") return 1;
  if (lower === "control" || lower === "ctrl") return 2;
  if (lower === "meta" || lower === "cmd" || lower === "command") return 4;
  if (lower === "controlormeta") return process.platform === "darwin" ? 4 : 2;
  if (lower === "shift") return 8;
  return 0;
}

function parseCdpKeyDescriptor(
  rawKey: string,
  extraModifiers = 0,
): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  commands?: string[];
} {
  const parts = rawKey.split("+");
  let modifiers = extraModifiers;
  let baseKey = rawKey;
  if (parts.length > 1) {
    baseKey = parts[parts.length - 1] ?? rawKey;
    for (let i = 0; i < parts.length - 1; i++) {
      modifiers |= modifierBitForName(parts[i] ?? "");
    }
  }

  if (baseKey.toLowerCase() === "controlormeta") {
    baseKey = process.platform === "darwin" ? "Meta" : "Control";
  }

  const keyCodeMatch = /^Key([A-Z])$/.exec(baseKey);
  if (keyCodeMatch) {
    const letter = keyCodeMatch[1]!;
    baseKey = (modifiers & 8) !== 0 ? letter : letter.toLowerCase();
  }
  const digitCodeMatch = /^Digit([0-9])$/.exec(baseKey);
  if (digitCodeMatch) {
    baseKey = digitCodeMatch[1]!;
  }

  const special = CDP_SPECIAL_KEYS[baseKey];
  if (special) {
    const emitText =
      special.text && (modifiers === 0 || modifiers === 8 || baseKey === "Enter")
        ? special.text
        : undefined;
    return {
      key: special.key ?? baseKey,
      code: special.code,
      windowsVirtualKeyCode: special.keyCode,
      modifiers,
      ...(emitText ? { text: emitText } : {}),
    };
  }

  if (baseKey.length === 1) {
    const upper = baseKey.toUpperCase();
    const charCode = upper.charCodeAt(0);
    const isLetter = charCode >= 65 && charCode <= 90;
    const isDigit = charCode >= 48 && charCode <= 57;
    const punct = CDP_PUNCTUATION_CHAR_MAP[baseKey];
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
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${baseKey}` : (punct?.code ?? ""),
      windowsVirtualKeyCode: isLetter || isDigit ? charCode : (punct?.keyCode ?? 0),
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
      options.useBrowserContexts ||
      options.freshContextPerFlow ||
      options.contextIsolation !== undefined ||
      isBrowserWs,
    );
    const effectiveFreshContextPerFlow = Boolean(
      options.freshContextPerFlow ?? options.contextIsolation !== undefined,
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
    const initialDeviceScaleFactor =
      options.deviceScaleFactor ?? options.viewport?.deviceScaleFactor ?? 1;
    const initialMobile = Boolean(
      options.isMobile ??
      options.mobile ??
      options.viewport?.isMobile ??
      options.viewport?.mobile ??
      false,
    );
    const initialHasTouch = Boolean(
      options.hasTouch ?? options.viewport?.hasTouch ?? initialMobile,
    );
    let width = initialWidth;
    let height = initialHeight;
    let currentDeviceScaleFactor = initialDeviceScaleFactor;
    let currentMobile = initialMobile;
    let currentHasTouch = initialHasTouch;
    let activeUserAgent: string | undefined = options.emulation?.userAgent;
    let activeLocale: string | undefined = options.emulation?.locale;
    const activeHttpCredentials: HttpCredentials | undefined = options.httpCredentials;
    let mainFrameId: string | null = null;
    let lastNavigationStatus: number | null = null;
    const authAttemptedRequestIds = new Set<string>();
    let hasDeviceMetricsDirty = false;
    let hasTouchEmulationDirty = false;
    let hasUserAgentDirty = false;
    let hasLocaleDirty = false;
    let hasEmulatedMediaDirty = false;
    let hasTimezoneDirty = false;
    let hasNetworkConditionsDirty = false;
    let hasSubframeNavigation = false;
    let slotNeedsHealthCheck = false;
    let geolocationMutated = false;
    let permissionsMutated = false;
    let slotHasCustomStorageState = false;
    let isAtBlank = true;
    const label = options.engineLabel ?? "cdp";
    const contextIsolation = options.contextIsolation ?? "hot-cache";
    const readyInitScript = options.readyExpression
      ? `(() => { window.__SPANA_APP_READY__ = () => { try { return Boolean(${options.readyExpression}); } catch { return false; } }; })();`
      : undefined;

    let activeSlot: CdpContextSlot | undefined;
    let prefetchedSlotPromise: Promise<CdpContextSlot> | undefined;
    let hasRunFirstFlow = false;
    let activeAuthenticatorId: string | undefined;
    let dialogHandler: BrowserDialogHandler | null = null;
    const backgroundDisposals: Array<Promise<unknown>> = [];
    const consoleLogs: BrowserConsoleLog[] = [];
    const jsErrors: BrowserJSError[] = [];
    const routeRules: CdpRouteRule[] = [];
    // Flow-scoped init scripts, fake-clock init script, and exposed bindings (cleared in beginFlow — 1.19)
    const flowInitScripts: string[] = [];
    const flowInitScriptIds = new Map<string | null, string[]>();
    let clockInitScript: string | null = null;
    const clockInitScriptIds = new Map<string | null, string[]>();
    const flowExposedFunctions = new Map<string, (...args: any[]) => any>();
    const flowExposedBindingNames = new Map<string | null, Set<string>>();
    const flowExposedScriptIds = new Map<string | null, string[]>();
    const requestListeners = new Set<(req: BrowserRequestInfo) => void>();
    const navigationUrls: string[] = [];
    const observedOrigins = new Set<string>();
    const observedStorageKeys = new Set<string>();
    const uploadTempDirs: string[] = [];

    const recordScriptId = (
      map: Map<string | null, string[]>,
      sessionId: string | null,
      res: unknown,
    ) => {
      const id = (res as { identifier?: unknown } | null)?.identifier;
      if (typeof id === "string" && id.length > 0) {
        const list = map.get(sessionId) ?? [];
        list.push(id);
        map.set(sessionId, list);
      }
    };

    const removeTrackedScripts = async (map: Map<string | null, string[]>) => {
      const ops: Array<Promise<unknown>> = [];
      for (const [sid, ids] of map.entries()) {
        for (const identifier of ids) {
          ops.push(
            cdpChannel
              .sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sid)
              .catch(() => {}),
          );
        }
      }
      map.clear();
      if (ops.length > 0) {
        await Promise.all(ops);
      }
    };

    const cleanupFlowScopedHooks = async () => {
      if (
        flowInitScripts.length === 0 &&
        clockInitScript === null &&
        flowExposedFunctions.size === 0 &&
        flowExposedBindingNames.size === 0 &&
        flowInitScriptIds.size === 0 &&
        clockInitScriptIds.size === 0 &&
        flowExposedScriptIds.size === 0
      ) {
        return;
      }
      flowInitScripts.length = 0;
      clockInitScript = null;
      flowExposedFunctions.clear();
      const bindingOps: Array<Promise<unknown>> = [];
      for (const [sid, names] of flowExposedBindingNames.entries()) {
        for (const name of names) {
          bindingOps.push(
            cdpChannel.sendCommand("Runtime.removeBinding", { name }, sid).catch(() => {}),
          );
        }
      }
      flowExposedBindingNames.clear();
      await Promise.all([
        removeTrackedScripts(flowInitScriptIds),
        removeTrackedScripts(clockInitScriptIds),
        removeTrackedScripts(flowExposedScriptIds),
        ...bindingOps,
      ]);
    };
    let currentNetworkConditions: NetworkConditions | undefined;
    let cachedUserAgent: string | undefined;
    let defaultCleanUserAgent: string | undefined;
    const hasExplicitUserAgent = Boolean(
      options.emulation?.userAgent || options.sanitizeHeadlessUserAgent === false,
    );
    const sanitizeHeadlessUserAgent = (ua: string): string =>
      hasExplicitUserAgent ? ua : ua.replaceAll(/HeadlessChrome\//gi, "Chrome/");
    const fetchEnabledSessions = new Set<string | null>();
    let heldModifiers = 0;
    let pressedMouseButtons = 0;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let activeResponseWatchers = 0;
    let nextTabSeq = 1;
    let downloadDir: string | undefined;
    const downloadConfiguredContexts = new Set<string>();
    const navigationTimeoutMs = options.navigationTimeout ?? 30_000;
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

    const buildAcceptLanguage = (locale: string | undefined): string | undefined => {
      if (!locale) return undefined;
      return locale.includes("-") ? `${locale},${locale.split("-")[0]};q=0.9` : locale;
    };

    const resolveEffectiveUserAgent = async (
      sessionId: string | null,
      explicitUserAgent?: string,
    ): Promise<string> => {
      if (explicitUserAgent) return explicitUserAgent;
      if (activeUserAgent) return activeUserAgent;
      if (options.emulation?.userAgent) return options.emulation.userAgent;
      if (defaultCleanUserAgent) return defaultCleanUserAgent;
      if (!cachedUserAgent) {
        const ua = await cdpChannel
          .evaluateOnSession<string>(sessionId, "navigator.userAgent")
          .catch(() => "");
        if (ua) cachedUserAgent = sanitizeHeadlessUserAgent(ua);
      }
      return cachedUserAgent || "Mozilla/5.0";
    };

    const applyLocaleOverride = async (
      sessionId: string | null,
      locale: string,
      explicitUserAgent?: string,
    ) => {
      await cdpChannel
        .sendCommand("Emulation.setLocaleOverride", { locale }, sessionId)
        .catch(() => {});
      const acceptLanguage = buildAcceptLanguage(locale);
      const effectiveUa = await resolveEffectiveUserAgent(sessionId, explicitUserAgent);
      await cdpChannel
        .sendCommand(
          "Emulation.setUserAgentOverride",
          {
            userAgent: effectiveUa,
            ...(acceptLanguage ? { acceptLanguage } : {}),
          },
          sessionId,
        )
        .catch(() => {});
    };

    const buildFetchEnableParams = (): Record<string, unknown> => {
      const needsAllSchemes = routeRules.some((r) =>
        typeof r.matcher === "string"
          ? /^(?:file|data|blob):/i.test(r.matcher)
          : /file:|data:|blob:/i.test(r.matcher.source),
      );
      const patterns = needsAllSchemes
        ? [{ urlPattern: "*" }]
        : [{ urlPattern: "http://*" }, { urlPattern: "https://*" }];
      return {
        patterns,
        ...(activeHttpCredentials ? { handleAuthRequests: true } : {}),
      };
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
      const boundSet = flowExposedBindingNames.get(sessionId) ?? new Set<string>();
      boundSet.add(bindingName);
      flowExposedBindingNames.set(sessionId, boundSet);
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
      const addRes = await cdpChannel
        .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: wrapperSource }, sessionId)
        .catch(() => null);
      recordScriptId(flowExposedScriptIds, sessionId, addRes);
      await cdpChannel.evaluateOnSession(sessionId, wrapperSource).catch(() => {});
    };

    const configureSession = async (
      sessionId: string | null,
      storageStatePath?: string,
      includeFlowState = false,
    ) => {
      const state = await loadStorageStateFile(storageStatePath);
      const targetWidth = includeFlowState ? width : initialWidth;
      const targetHeight = includeFlowState ? height : initialHeight;
      const targetDpr = includeFlowState ? currentDeviceScaleFactor : initialDeviceScaleFactor;
      const targetMobile = includeFlowState ? currentMobile : initialMobile;
      const targetHasTouch = includeFlowState ? currentHasTouch : initialHasTouch;
      await Promise.all([
        cdpChannel.sendCommand("Page.enable", {}, sessionId).catch(() => {}),
        cdpChannel.sendCommand("Runtime.enable", {}, sessionId).catch(() => {}),
        // Enable Network in the initial parallel batch (0 extra RTTs) so waitForResponse / app.cdp() never race fast localhost loads.
        cdpChannel.sendCommand("Network.enable", {}, sessionId).catch(() => {}),
        // Emulate focused page on headless Linux so :focus / focus-visible / hover states match desktop Chrome.
        cdpChannel
          .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId)
          .catch(() => {}),
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
        ...(readyInitScript
          ? [
              cdpChannel
                .sendCommand(
                  "Page.addScriptToEvaluateOnNewDocument",
                  { source: readyInitScript },
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
            {
              width: targetWidth,
              height: targetHeight,
              deviceScaleFactor: targetDpr,
              mobile: targetMobile,
            },
            sessionId,
          )
          .catch(() => {}),
        ...(targetHasTouch
          ? [
              cdpChannel
                .sendCommand(
                  "Emulation.setTouchEmulationEnabled",
                  { enabled: true, maxTouchPoints: 5 },
                  sessionId,
                )
                .catch(() => {}),
            ]
          : []),
        ...(!options.emulation?.userAgent && !options.emulation?.locale && defaultCleanUserAgent
          ? [
              cdpChannel
                .sendCommand(
                  "Emulation.setUserAgentOverride",
                  { userAgent: defaultCleanUserAgent },
                  sessionId,
                )
                .catch(() => {}),
            ]
          : []),
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

      if (includeFlowState) {
        for (const scriptSource of flowInitScripts) {
          const res = await cdpChannel
            .sendCommand(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: scriptSource },
              sessionId,
            )
            .catch(() => null);
          recordScriptId(flowInitScriptIds, sessionId, res);
        }
        if (clockInitScript) {
          const res = await cdpChannel
            .sendCommand(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: clockInitScript },
              sessionId,
            )
            .catch(() => null);
          recordScriptId(clockInitScriptIds, sessionId, res);
        }
        for (const fnName of flowExposedFunctions.keys()) {
          await installExposeFunctionOnSession(sessionId, fnName);
        }
        if (routeRules.length > 0 || activeHttpCredentials) {
          fetchEnabledSessions.add(sessionId);
          await cdpChannel
            .sendCommand("Fetch.enable", buildFetchEnableParams(), sessionId)
            .catch(() => {});
        }
        if (currentNetworkConditions) {
          await applyNetworkConditionsToSession(sessionId, currentNetworkConditions);
        }
      } else if (activeHttpCredentials) {
        fetchEnabledSessions.add(sessionId);
        await cdpChannel
          .sendCommand("Fetch.enable", buildFetchEnableParams(), sessionId)
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
                try {
                  const seedKey = "__spana_storage_seeded__:" + window.location.origin;
                  if (window.sessionStorage.getItem(seedKey)) return;
                  const origins = ${originsJson};
                  const hit = origins.find((o) => o.origin === window.location.origin);
                  if (hit && Array.isArray(hit.localStorage)) {
                    for (const item of hit.localStorage) {
                      try { window.localStorage.setItem(item.name, item.value); } catch {}
                    }
                    window.sessionStorage.setItem(seedKey, "1");
                  }
                } catch {}
              })();`,
            },
            sessionId,
          )
          .catch(() => {});
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
        if (options.emulation.userAgent) {
          const locale = options.emulation.locale;
          const acceptLanguage = locale
            ? locale.includes("-")
              ? `${locale},${locale.split("-")[0]};q=0.9`
              : locale
            : undefined;
          await cdpChannel
            .sendCommand(
              "Emulation.setUserAgentOverride",
              {
                userAgent: options.emulation.userAgent,
                ...(acceptLanguage ? { acceptLanguage } : {}),
              },
              sessionId,
            )
            .catch(() => {});
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
        {
          url: "about:blank",
          browserContextId: ctxRes.browserContextId,
          width: initialWidth,
          height: initialHeight,
        },
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
      downloadConfiguredContexts.delete(slot.browserContextId);
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
        !effectiveFreshContextPerFlow ||
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
    const handlingPopupTargets = new Set<string>();

    const setupPopupSession = async (
      targetId: string,
      childSid: string,
      waitingForDebugger: boolean,
    ) => {
      if (!activeSlot) {
        if (waitingForDebugger) {
          await cdpChannel
            .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
            .catch(() => {});
        }
        return;
      }
      const newTabId = `tab-${nextTabSeq++}`;
      if (!activeSlot.tabs.some((t) => t.targetId === targetId)) {
        activeSlot.tabs.push({ tabId: newTabId, targetId, sessionId: childSid });
      }
      const popupUa = activeUserAgent || options.emulation?.userAgent || defaultCleanUserAgent;
      const popupAcceptLang = buildAcceptLanguage(activeLocale || options.emulation?.locale);
      const setupCalls: Array<Promise<unknown>> = [
        // Enable Network FIRST unconditionally so fast popup fetch/XHR bodies are buffered before requestWillBeSent
        cdpChannel.sendCommand("Network.enable", {}, childSid).catch(() => {}),
        cdpChannel.sendCommand("Page.enable", {}, childSid).catch(() => {}),
        cdpChannel.sendCommand("Runtime.enable", {}, childSid).catch(() => {}),
        cdpChannel
          .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }, childSid)
          .catch(() => {}),
        ...(popupUa
          ? [
              cdpChannel
                .sendCommand(
                  "Emulation.setUserAgentOverride",
                  {
                    userAgent: popupUa,
                    ...(popupAcceptLang ? { acceptLanguage: popupAcceptLang } : {}),
                  },
                  childSid,
                )
                .catch(() => {}),
            ]
          : []),
      ];
      if (currentNetworkConditions) {
        setupCalls.push(applyNetworkConditionsToSession(childSid, currentNetworkConditions));
      }
      if (routeRules.length > 0 || activeHttpCredentials) {
        fetchEnabledSessions.add(childSid);
        setupCalls.push(
          cdpChannel
            .sendCommand("Fetch.enable", buildFetchEnableParams(), childSid)
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
      if (readyInitScript) {
        setupCalls.push(
          cdpChannel
            .sendCommand(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: readyInitScript },
              childSid,
            )
            .catch(() => {}),
        );
      }
      for (const scriptSource of flowInitScripts) {
        setupCalls.push(
          cdpChannel
            .sendCommand(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: scriptSource },
              childSid,
            )
            .then((res) => recordScriptId(flowInitScriptIds, childSid, res))
            .catch(() => {}),
        );
      }
      if (clockInitScript) {
        setupCalls.push(
          cdpChannel
            .sendCommand(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: clockInitScript },
              childSid,
            )
            .then((res) => recordScriptId(clockInitScriptIds, childSid, res))
            .catch(() => {}),
        );
      }
      for (const fnName of flowExposedFunctions.keys()) {
        setupCalls.push(installExposeFunctionOnSession(childSid, fnName).catch(() => {}));
      }
      await Promise.all(setupCalls);
      if (waitingForDebugger) {
        await cdpChannel
          .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
          .catch(() => {});
      }
      if (popupWaiters.length > 0) {
        const waiter = popupWaiters.shift();
        if (waiter) waiter.resolve(newTabId);
      }
    };

    // Fallback popup discovery if Target.setAutoAttach did not pause/attach the popup first
    cdpChannel.onEvent("Target.targetCreated", (params) => {
      const targetInfo = params?.targetInfo;
      if (
        targetInfo?.type !== "page" ||
        !targetInfo.targetId ||
        !targetInfo.openerId ||
        !activeSlot ||
        targetInfo.browserContextId !== activeSlot.browserContextId
      ) {
        return;
      }
      const targetId = String(targetInfo.targetId);
      if (
        handlingPopupTargets.has(targetId) ||
        activeSlot.tabs.some((t) => t.targetId === targetId)
      ) {
        return;
      }
      handlingPopupTargets.add(targetId);
      void (async () => {
        try {
          const attachRes = (await cdpChannel.sendCommand(
            "Target.attachToTarget",
            { targetId, flatten: true },
            null,
          )) as { sessionId?: string };
          const childSid = attachRes?.sessionId;
          if (!childSid) return;
          await setupPopupSession(targetId, childSid, false);
        } catch {
          // ignore popup attach errors if popup closed immediately
        }
      })();
    });

    // Auto-track popup pages (paused at birth so Network.enable & init scripts never race),
    // cross-origin iframe (OOPIF) child targets, and Web Workers.
    // IMPORTANT: Never call Target.detachFromTarget on foreign contexts' pages — detaching
    // triggers Chromium's WebAuthnHandler::Disable() and wipes the foreign context's passkey (2.14, 1.26).
    cdpChannel.onEvent("Target.attachedToTarget", (params) => {
      const targetInfo = params?.targetInfo;
      const childSid = params?.sessionId;
      const waiting = Boolean(params?.waitingForDebugger);
      if (targetInfo?.type === "page" && typeof childSid === "string") {
        const targetId = typeof targetInfo.targetId === "string" ? targetInfo.targetId : "";
        const isOurPopup = Boolean(
          targetId &&
          targetInfo.openerId &&
          activeSlot &&
          targetInfo.browserContextId === activeSlot.browserContextId,
        );
        if (isOurPopup && !handlingPopupTargets.has(targetId)) {
          handlingPopupTargets.add(targetId);
          void setupPopupSession(targetId, childSid, waiting).catch(() => {});
          return;
        }
        if (waiting) {
          void cdpChannel
            .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
            .catch(() => {});
        }
        return;
      }
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
        const frameTargetId =
          typeof targetInfo.targetId === "string" ? targetInfo.targetId : undefined;
        cdpChannel.addChildSession(childSid, {
          targetId: frameTargetId,
          url: typeof targetInfo.url === "string" ? targetInfo.url : undefined,
        });
        if (typeof targetInfo.url === "string") {
          try {
            const parsed = new URL(targetInfo.url);
            if (parsed.protocol === "http:" || parsed.protocol === "https:") {
              observedOrigins.add(parsed.origin);
            }
          } catch {
            // ignore
          }
        }
        void (async () => {
          await cdpChannel.sendCommand("Runtime.enable", {}, childSid).catch(() => {});
          if (frameTargetId) {
            const skRes = (await cdpChannel
              .sendCommand("Storage.getStorageKeyForFrame", { frameId: frameTargetId }, childSid)
              .catch(() => null)) as { storageKey?: string } | null;
            if (skRes?.storageKey) observedStorageKeys.add(skRes.storageKey);
          }
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
      } else if (waiting && typeof childSid === "string") {
        void cdpChannel
          .sendCommand("Runtime.runIfWaitingForDebugger", {}, childSid)
          .catch(() => {});
      }
    });

    cdpChannel.onEvent("Target.targetInfoChanged", (params) => {
      const targetInfo = params?.targetInfo;
      if (!targetInfo?.targetId || typeof targetInfo.url !== "string") return;
      cdpChannel.updateChildSessionByTargetId(String(targetInfo.targetId), {
        url: targetInfo.url,
      });
      try {
        const parsed = new URL(targetInfo.url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          observedOrigins.add(parsed.origin);
        }
      } catch {
        // ignore non-http(s) URLs
      }
    });

    cdpChannel.onEvent("Target.detachedFromTarget", (params) => {
      if (typeof params?.sessionId === "string") {
        cdpChannel.removeChildSession(params.sessionId);
        fetchEnabledSessions.delete(params.sessionId);
        if (activeSlot) {
          const wasActive = activeSlot.sessionId === params.sessionId;
          activeSlot.tabs = activeSlot.tabs.filter((t) => t.sessionId !== params.sessionId);
          if (wasActive && activeSlot.tabs.length > 0) {
            const fallback = activeSlot.tabs[0]!;
            activeSlot.targetId = fallback.targetId;
            activeSlot.sessionId = fallback.sessionId;
            cdpChannel.setSessionId(fallback.sessionId);
          } else if (wasActive) {
            slotNeedsHealthCheck = true;
          }
        }
      }
    });
    cdpChannel.onEvent("Target.targetDestroyed", (params) => {
      if (
        activeSlot &&
        typeof params?.targetId === "string" &&
        params.targetId === activeSlot.targetId
      ) {
        slotNeedsHealthCheck = true;
      }
    });
    cdpChannel.onEvent("Target.targetCrashed", (params) => {
      if (
        activeSlot &&
        typeof params?.targetId === "string" &&
        params.targetId === activeSlot.targetId
      ) {
        slotNeedsHealthCheck = true;
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
      if (!child.targetId) return { x: 0, y: 0, scaleX: 1, scaleY: 1 };
      try {
        await cdpChannel.sendCommand("DOM.enable");
        const owner = (await cdpChannel.sendCommand("DOM.getFrameOwner", {
          frameId: child.targetId,
        })) as { backendNodeId?: number; nodeId?: number };
        const boxParams = owner.backendNodeId
          ? { backendNodeId: owner.backendNodeId }
          : { nodeId: owner.nodeId };
        // Prefer Runtime.callFunctionOn so CSS transform: scale(...) + border offsets are computed accurately
        const resolved = (await cdpChannel
          .sendCommand("DOM.resolveNode", boxParams)
          .catch(() => null)) as { object?: { objectId?: string } } | null;
        if (resolved?.object?.objectId) {
          const objectId = resolved.object.objectId;
          try {
            const callRes = (await cdpChannel.sendCommand("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: `function() {
                var r = this.getBoundingClientRect();
                var win = (this.ownerDocument && this.ownerDocument.defaultView) || window;
                var cs = win && win.getComputedStyle ? win.getComputedStyle(this) : null;
                var bLeft = cs ? (parseFloat(cs.borderLeftWidth) || 0) : 0;
                var bTop = cs ? (parseFloat(cs.borderTopWidth) || 0) : 0;
                var bRight = cs ? (parseFloat(cs.borderRightWidth) || 0) : 0;
                var bBottom = cs ? (parseFloat(cs.borderBottomWidth) || 0) : 0;
                var layoutW = this.offsetWidth || (this.clientWidth + bLeft + bRight);
                var layoutH = this.offsetHeight || (this.clientHeight + bTop + bBottom);
                var sx = layoutW > 0 ? (r.width / layoutW) : 1;
                var sy = layoutH > 0 ? (r.height / layoutH) : 1;
                if (!isFinite(sx) || sx <= 0) sx = 1;
                if (!isFinite(sy) || sy <= 0) sy = 1;
                return { x: r.left + bLeft * sx, y: r.top + bTop * sy, scaleX: sx, scaleY: sy };
              }`,
              returnByValue: true,
            })) as {
              result?: { value?: { x: number; y: number; scaleX: number; scaleY: number } };
            };
            if (callRes?.result?.value) {
              return callRes.result.value;
            }
          } finally {
            void cdpChannel.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
          }
        }
        const box = (await cdpChannel.sendCommand("DOM.getBoxModel", boxParams)) as {
          model?: { content?: number[]; border?: number[] };
        };
        const quad = box?.model?.content ?? box?.model?.border;
        if (Array.isArray(quad) && quad.length >= 2) {
          return { x: quad[0] ?? 0, y: quad[1] ?? 0, scaleX: 1, scaleY: 1 };
        }
      } catch {
        // Cross-origin frame owner unavailable — default to (0, 0)
      }
      return { x: 0, y: 0, scaleX: 1, scaleY: 1 };
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
        if (
          (!activeSlot || !sid || sid === activeSlot.sessionId) &&
          typeof params?.frame?.id === "string"
        ) {
          mainFrameId = params.frame.id;
        }
        recordNavUrl(params?.frame?.url, sid);
      } else {
        hasSubframeNavigation = true;
        if (typeof params?.frame?.url === "string") {
          try {
            const parsed = new URL(params.frame.url);
            if (parsed.protocol === "http:" || parsed.protocol === "https:") {
              observedOrigins.add(parsed.origin);
            }
          } catch {
            // ignore non-http(s) subframe URLs
          }
        }
      }
    });
    cdpChannel.onEvent("Page.navigatedWithinDocument", (params, sid) => {
      recordNavUrl(params?.url, sid);
    });
    // Capture main-document HTTP navigation status (200, 404, 500, etc.) for app.lastNavigationStatus()
    cdpChannel.onEvent("Network.responseReceived", (params, sid) => {
      if (activeSlot && sid && sid !== activeSlot.sessionId) return;
      if (params?.type !== "Document") return;
      if (mainFrameId && params?.frameId && params.frameId !== mainFrameId) return;
      const status = params?.response?.status;
      if (typeof status === "number" && Number.isFinite(status)) {
        lastNavigationStatus = status;
      }
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
      const fn = flowExposedFunctions.get(parsed.name);
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
    // and track visited origins (including iframe/fetch origins) for hot-cache storage reset (1.24).
    cdpChannel.onEvent("Network.requestWillBeSent", (params, sid) => {
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
      try {
        const parsed = new URL(String(req.url));
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          observedOrigins.add(parsed.origin);
        }
      } catch {
        // ignore non-URL requests
      }
      if (requestListeners.size === 0) return;
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

    cdpChannel.onEvent("Fetch.authRequired", (params, sid) => {
      if (!activeHttpCredentials) return;
      const sessionKey = sid ?? null;
      if (!fetchEnabledSessions.has(sessionKey)) return;
      const reqId = params?.requestId;
      if (!reqId) return;
      if (authAttemptedRequestIds.has(reqId)) {
        authAttemptedRequestIds.delete(reqId);
        void cdpChannel
          .sendCommand(
            "Fetch.continueWithAuth",
            {
              requestId: reqId,
              authChallengeResponse: { response: "CancelAuth" },
            },
            sessionKey,
          )
          .catch(() => {});
        return;
      }
      authAttemptedRequestIds.add(reqId);
      if (authAttemptedRequestIds.size > 200) {
        const oldest = authAttemptedRequestIds.values().next().value;
        if (oldest !== undefined) authAttemptedRequestIds.delete(oldest);
      }
      void cdpChannel
        .sendCommand(
          "Fetch.continueWithAuth",
          {
            requestId: reqId,
            authChallengeResponse: {
              response: "ProvideCredentials",
              username: activeHttpCredentials.username,
              password: activeHttpCredentials.password,
            },
          },
          sessionKey,
        )
        .catch(() => {});
    });

    cdpChannel.onEvent("Fetch.requestPaused", (params, sid) => {
      // Only handle Fetch.requestPaused on sessions where Spana itself enabled Fetch interception;
      // otherwise leave pauses alone for user `app.cdp().send("Fetch.enable", ...)` handlers! (2.17)
      const sessionKey = sid ?? null;
      if (!fetchEnabledSessions.has(sessionKey)) return;
      const reqId = params?.requestId;
      const reqObj = params?.request ?? {};
      const url = String(reqObj.url ?? "");
      if (!reqId) return;

      // Match routes newest-first (LIFO, matching Playwright semantics) so `route.fallback()` can chain cleanly.
      const matchingRules: CdpRouteRule[] = [];
      for (let ri = routeRules.length - 1; ri >= 0; ri--) {
        const candidate = routeRules[ri]!;
        if (matchUrl(candidate.matcher, url)) {
          matchingRules.push(candidate);
        }
      }
      if (matchingRules.length === 0) {
        void cdpChannel
          .sendCommand("Fetch.continueRequest", { requestId: reqId }, sessionKey)
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
          sessionKey,
        );
      };

      let curUrl = url;
      let curMethod = String(reqObj.method ?? "GET");
      const rawHeaders = (reqObj.headers ?? {}) as Record<string, unknown>;
      let curHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        curHeaders[k.toLowerCase()] = String(v);
      }
      let curPostData: string | null = typeof reqObj.postData === "string" ? reqObj.postData : null;
      let hasOverrides = false;

      // Transparently answer CORS preflight OPTIONS requests on mocked/routed cross-origin fetches
      // (e.g. `file://` → `https://` POST with custom headers) so route handlers receive the real
      // request cleanly, matching Playwright `page.route()` semantics.
      if (
        curMethod.toUpperCase() === "OPTIONS" &&
        Boolean(curHeaders["access-control-request-method"]) &&
        matchingRules[0]?.kind !== "block"
      ) {
        const reqOrigin = curHeaders["origin"];
        const allowOrigin = reqOrigin && reqOrigin !== "null" ? reqOrigin : "*";
        const reqMethod =
          curHeaders["access-control-request-method"] || "GET, POST, PUT, PATCH, DELETE, OPTIONS";
        const reqHdrs = curHeaders["access-control-request-headers"] || "*";
        const preflightHeaders = [
          { name: "Access-Control-Allow-Origin", value: allowOrigin },
          {
            name: "Access-Control-Allow-Methods",
            value: `${reqMethod}, GET, POST, PUT, PATCH, DELETE, OPTIONS`,
          },
          { name: "Access-Control-Allow-Headers", value: reqHdrs },
          ...(allowOrigin !== "*"
            ? [{ name: "Access-Control-Allow-Credentials", value: "true" }]
            : []),
        ];
        void cdpChannel
          .sendCommand(
            "Fetch.fulfillRequest",
            {
              requestId: reqId,
              responseCode: 204,
              responsePhrase: "No Content",
              responseHeaders: preflightHeaders,
              body: "",
            },
            sessionKey,
          )
          .catch(() => {});
        return;
      }

      const continueRequest = async (overrides?: {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        postData?: string;
      }) => {
        const finalUrl = overrides?.url ?? (hasOverrides ? curUrl : undefined);
        const finalMethod = overrides?.method ?? (hasOverrides ? curMethod : undefined);
        const finalHeaders = overrides?.headers ?? (hasOverrides ? curHeaders : undefined);
        const finalPostData =
          overrides?.postData !== undefined
            ? overrides.postData
            : hasOverrides && curPostData !== null
              ? curPostData
              : undefined;
        await cdpChannel.sendCommand(
          "Fetch.continueRequest",
          {
            requestId: reqId,
            ...(finalUrl ? { url: finalUrl } : {}),
            ...(finalMethod ? { method: finalMethod } : {}),
            ...(finalHeaders
              ? {
                  headers: Object.entries(finalHeaders).map(([name, value]) => ({
                    name,
                    value,
                  })),
                }
              : {}),
            ...(finalPostData !== undefined
              ? { postData: Buffer.from(finalPostData, "utf8").toString("base64") }
              : {}),
          },
          sessionKey,
        );
      };

      const dispatchRuleAt = async (idx: number): Promise<void> => {
        if (idx >= matchingRules.length) {
          await continueRequest().catch(() => {});
          return;
        }
        const rule = matchingRules[idx]!;
        if (rule.kind === "block") {
          await cdpChannel
            .sendCommand(
              "Fetch.failRequest",
              { requestId: reqId, errorReason: "BlockedByClient" },
              sessionKey,
            )
            .catch(() => {});
          return;
        }
        if (rule.kind === "mock") {
          await fulfillWith(rule.response ?? {}).catch(() => {});
          return;
        }
        if (rule.kind === "handler" && rule.handler) {
          const reqInfo: BrowserRequestInfo = {
            url: curUrl,
            method: curMethod,
            headers: { ...curHeaders },
            resourceType:
              typeof params?.resourceType === "string"
                ? params.resourceType.toLowerCase()
                : undefined,
            postData: () => curPostData,
            postDataJSON: <T = unknown>() => {
              if (!curPostData) return null;
              try {
                return JSON.parse(curPostData) as T;
              } catch {
                return null;
              }
            },
          };
          let handled = false;
          let fellBack = false;
          const routeObj: BrowserRoute = {
            request: () => reqInfo,
            continue: async (overrides) => {
              if (handled) return;
              handled = true;
              await continueRequest(overrides);
            },
            fallback: async (overrides) => {
              if (handled) return;
              handled = true;
              fellBack = true;
              if (overrides) {
                hasOverrides = true;
                if (overrides.url) curUrl = overrides.url;
                if (overrides.method) curMethod = overrides.method;
                if (overrides.headers) curHeaders = { ...curHeaders, ...overrides.headers };
                if (overrides.postData !== undefined) curPostData = overrides.postData;
              }
              await dispatchRuleAt(idx + 1);
            },
            abort: async (errorCode) => {
              if (handled) return;
              handled = true;
              await cdpChannel.sendCommand(
                "Fetch.failRequest",
                { requestId: reqId, errorReason: errorCode ?? "Failed" },
                sessionKey,
              );
            },
            fulfill: async (response) => {
              if (handled) return;
              handled = true;
              await fulfillWith(response);
            },
            fetch: async (overrides) => {
              const targetUrl = overrides?.url ?? curUrl;
              const fetchHeaders = { ...curHeaders, ...overrides?.headers };
              const fetchMethod = overrides?.method ?? curMethod;
              const body =
                overrides?.postData !== undefined
                  ? overrides.postData
                  : fetchMethod !== "GET" && fetchMethod !== "HEAD"
                    ? (curPostData ?? undefined)
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
          try {
            await rule.handler(routeObj);
          } catch {
            // Fall through to continue if handler threw before resolving
          } finally {
            if (!handled && !fellBack) {
              handled = true;
              await continueRequest().catch(() => {});
            }
          }
        }
      };

      void dispatchRuleAt(0);
    });

    // Sanitize default headless `HeadlessChrome/` → `Chrome/` UA so sites using real-browser
    // UA detection / redirects / bot checks behave identically to regular Chrome unless the user
    // explicitly provided `emulation.userAgent` or `--user-agent=...`.
    if (!hasExplicitUserAgent) {
      const browserVer = yield* Effect.tryPromise({
        try: () =>
          cdpChannel.sendCommand<{ userAgent?: string }>("Browser.getVersion", {}, null, 2_000),
        catch: () => null,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      const rawUa = browserVer?.userAgent;
      if (rawUa && /HeadlessChrome\//i.test(rawUa)) {
        defaultCleanUserAgent = rawUa.replaceAll(/HeadlessChrome\//gi, "Chrome/");
        cachedUserAgent = defaultCleanUserAgent;
      }
    }

    if (useContexts) {
      yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            cdpChannel
              .sendCommand(
                "Target.setDiscoverTargets",
                {
                  discover: true,
                  filter: [{ type: "page" }, { type: "iframe" }],
                },
                null,
              )
              .catch(() => {}),
            // Auto-attach popup pages paused at birth (`waitForDebuggerOnStart: true`) on top-level
            // drivers so Network.enable, clean UA, routes, and init scripts install before byte 0.
            // Skip on ephemeral child contexts (`_markClosedOnKill`) so closing a child context's
            // WebSocket never detaches from the parent context's page (preserves WebAuthn — 2.14).
            ...(!options._markClosedOnKill
              ? [
                  cdpChannel
                    .sendCommand(
                      "Target.setAutoAttach",
                      {
                        autoAttach: true,
                        waitForDebuggerOnStart: true,
                        flatten: true,
                        filter: [{ type: "page", exclude: false }],
                      },
                      null,
                    )
                    .catch(() => {}),
                ]
              : []),
          ]),
        catch: () => new DriverError({ message: "Failed to enable Target.setDiscoverTargets" }),
      }).pipe(Effect.catch(() => Effect.void));
      activeSlot = yield* Effect.tryPromise({
        try: () => createContextSlot(options.storageState),
        catch: (e) =>
          new DriverError({ message: `Failed to create direct CDP browser context: ${e}` }),
      });
      cdpChannel.setSessionId(activeSlot.sessionId);
      activeAuthenticatorId = activeSlot.authenticatorId;
    } else if (defaultCleanUserAgent) {
      yield* Effect.tryPromise({
        try: () =>
          cdpChannel.sendCommand(
            "Emulation.setUserAgentOverride",
            { userAgent: defaultCleanUserAgent },
            null,
          ),
        catch: () => null,
      }).pipe(Effect.catch(() => Effect.void));
    }

    const resolveUrlAsync = async (rawUrl: string): Promise<string> => {
      if (
        rawUrl.startsWith("http://") ||
        rawUrl.startsWith("https://") ||
        rawUrl === "about:blank" ||
        rawUrl.startsWith("data:") ||
        rawUrl.startsWith("file:")
      ) {
        return rawUrl;
      }
      if (options.baseUrl && options.baseUrl !== "about:blank") {
        try {
          return new URL(rawUrl, options.baseUrl).toString();
        } catch {
          return `${options.baseUrl.replace(/\/$/, "")}/${rawUrl.replace(/^\//, "")}`;
        }
      }
      const cur = await cdpChannel
        .evaluate<string>(
          "typeof window !== 'undefined' && window.location ? String(window.location.href || '') : ''",
        )
        .catch(() => "");
      if (cur && (cur.startsWith("http://") || cur.startsWith("https://"))) {
        try {
          return new URL(rawUrl, new URL(cur).origin).toString();
        } catch {
          // fall through
        }
      }
      return rawUrl;
    };

    const ensureDownloadBehaviorForActiveContext = async (): Promise<void> => {
      if (!downloadDir) {
        const dlBaseDir = process.platform === "linux" && tmpdir().length > 40 ? "/tmp" : tmpdir();
        downloadDir = mkdtempSync(join(dlBaseDir, "spana-cdp-dl-"));
      }
      const ctxId = activeSlot?.browserContextId;
      const ctxKey = ctxId ?? "__default__";
      if (downloadConfiguredContexts.has(ctxKey)) return;
      await cdpChannel.sendCommand(
        "Browser.setDownloadBehavior",
        {
          behavior: "allowAndName",
          downloadPath: downloadDir,
          eventsEnabled: true,
          ...(ctxId ? { browserContextId: ctxId } : {}),
        },
        null,
      );
      downloadConfiguredContexts.add(ctxKey);
    };

    const navigate = async (rawUrl: string) => {
      const target = await resolveUrlAsync(rawUrl);
      lastNavigationStatus = null;
      if (!useContexts) {
        await cdpChannel.sendCommand("Page.enable").catch(() => {});
        const navRes = (await cdpChannel.sendCommand(
          "Page.navigate",
          { url: target },
          undefined,
          navigationTimeoutMs,
        )) as {
          frameId?: string;
        } | null;
        if (navRes?.frameId) mainFrameId = navRes.frameId;
        return;
      }

      const waitUntil = options.waitUntil ?? "domcontentloaded";
      const targetSid = activeSlot?.sessionId;
      if (target === "about:blank") {
        if (isAtBlank) return;
        await cdpChannel
          .sendCommand(
            "Page.navigate",
            { url: target },
            undefined,
            Math.min(4_000, navigationTimeoutMs),
          )
          .catch(() => {});
        isAtBlank = true;
        return;
      }
      isAtBlank = false;
      if (waitUntil === "commit") {
        const commitRes = (await cdpChannel.sendCommand(
          "Page.navigate",
          { url: target },
          undefined,
          navigationTimeoutMs,
        )) as {
          frameId?: string;
          errorText?: string;
        } | null;
        if (commitRes?.frameId) mainFrameId = commitRes.frameId;
        if (commitRes?.errorText && commitRes.errorText !== "net::ERR_ABORTED") {
          throw new Error(`Navigation to "${target}" failed: ${commitRes.errorText}`);
        }
        return;
      }

      const eventName =
        waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : "Page.loadEventFired";
      let targetFrameCommitted = false;
      let expectedLoaderId: string | undefined;
      const seenLoaderIds = new Set<string>();
      const unsubNavCommit = cdpChannel.onEvent("Page.frameNavigated", (params, sid) => {
        if (targetSid && sid && sid !== targetSid) return;
        if (params?.frame?.parentId) return;
        const loaderId =
          typeof params?.frame?.loaderId === "string" ? params.frame.loaderId : undefined;
        if (loaderId) seenLoaderIds.add(loaderId);
        const frameUrl = typeof params?.frame?.url === "string" ? params.frame.url : "";
        if (expectedLoaderId) {
          if (loaderId === expectedLoaderId || (frameUrl && frameUrl !== "about:blank")) {
            targetFrameCommitted = true;
          }
        } else if (frameUrl !== "about:blank") {
          targetFrameCommitted = true;
        }
      });
      const navStart = Date.now();
      const waiter = cdpChannel.waitForEventCancellable(
        eventName,
        navigationTimeoutMs,
        (_p, sid) => (!targetSid || !sid || sid === targetSid) && targetFrameCommitted,
      );
      waiter.promise.catch(() => {});
      try {
        const navRes = (await cdpChannel.sendCommand(
          "Page.navigate",
          { url: target },
          undefined,
          navigationTimeoutMs,
        )) as {
          frameId?: string;
          loaderId?: string;
          errorText?: string;
        } | null;
        if (navRes?.frameId) mainFrameId = navRes.frameId;
        if (navRes?.errorText && navRes.errorText !== "net::ERR_ABORTED") {
          throw new Error(`Navigation to "${target}" failed: ${navRes.errorText}`);
        }
        if (navRes?.loaderId) {
          expectedLoaderId = navRes.loaderId;
          if (seenLoaderIds.has(navRes.loaderId)) {
            targetFrameCommitted = true;
          }
          try {
            await waiter.promise;
          } catch (waitErr) {
            const elapsed = Date.now() - navStart;
            throw new Error(
              `Navigation to "${target}" timed out waiting for ${waitUntil} after ${elapsed}ms (navigationTimeout: ${navigationTimeoutMs}ms): ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`,
              { cause: waitErr },
            );
          }
        }
      } finally {
        unsubNavCommit();
        waiter.cancel();
      }
      // Pre-warm the next fresh context AFTER navigation settles so renderer spawn
      // never contends with the active flow's page load!
      schedulePrefetch();
    };

    const ensureFetchIntercept = async () => {
      const sessions: Array<string | null> = activeSlot
        ? Array.from(new Set([activeSlot.sessionId, ...activeSlot.tabs.map((t) => t.sessionId)]))
        : [null];
      const enableParams = buildFetchEnableParams();
      for (const sid of sessions) fetchEnabledSessions.add(sid);
      await Promise.all(
        sessions.map((sid) =>
          cdpChannel.sendCommand("Fetch.enable", enableParams, sid).catch(() => {
            fetchEnabledSessions.delete(sid);
          }),
        ),
      );
    };

    const disableAllFetchInterception = async () => {
      if (activeHttpCredentials) {
        // Keep Fetch enabled when httpCredentials is configured so authRequired keeps working across flows
        return;
      }
      if (fetchEnabledSessions.size === 0) return;
      const sessions = Array.from(fetchEnabledSessions);
      fetchEnabledSessions.clear();
      await Promise.all(
        sessions.map((sid) => cdpChannel.sendCommand("Fetch.disable", {}, sid).catch(() => {})),
      );
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
            const ensureVirtualAuthenticatorForSlot = async (
              slot: CdpContextSlot,
              clearExisting: boolean,
            ) => {
              if (!options.virtualAuthenticator) {
                activeAuthenticatorId = slot.authenticatorId;
                return;
              }
              const authOpts =
                typeof options.virtualAuthenticator === "object"
                  ? options.virtualAuthenticator
                  : undefined;
              // Always ensure WebAuthn is enabled (idempotent in CDP) — 2.16
              await cdpChannel
                .sendCommand("WebAuthn.enable", { enableUI: false }, slot.sessionId)
                .catch(() => {});
              if (slot.authenticatorId) {
                if (clearExisting) {
                  try {
                    await cdpChannel.sendCommand(
                      "WebAuthn.clearCredentials",
                      { authenticatorId: slot.authenticatorId },
                      slot.sessionId,
                    );
                  } catch {
                    // Authenticator or WebAuthn domain was reset — re-attach cleanly
                    slot.authenticatorId = await attachVirtualAuthenticatorForSession(
                      slot.sessionId,
                      authOpts,
                    ).catch(() => undefined);
                  }
                }
              } else {
                slot.authenticatorId = await attachVirtualAuthenticatorForSession(
                  slot.sessionId,
                  authOpts,
                ).catch(() => undefined);
              }
              activeAuthenticatorId = slot.authenticatorId;
            };

            const ensureActiveSlotHealthy = async (): Promise<boolean> => {
              if (!activeSlot) return false;
              const checkSessionAlive = async (sid: string): Promise<boolean> => {
                try {
                  await cdpChannel.sendCommand(
                    "Runtime.evaluate",
                    { expression: "1", returnByValue: true },
                    sid,
                    2_000,
                  );
                  return true;
                } catch {
                  return false;
                }
              };
              if (activeSlot.tabs.length > 0 && (await checkSessionAlive(activeSlot.sessionId))) {
                return true;
              }
              // Try another surviving tab in the same slot first
              const survivingTabs = activeSlot.tabs.slice();
              for (const tab of survivingTabs) {
                if (
                  tab.sessionId !== activeSlot.sessionId &&
                  (await checkSessionAlive(tab.sessionId))
                ) {
                  activeSlot.targetId = tab.targetId;
                  activeSlot.sessionId = tab.sessionId;
                  cdpChannel.setSessionId(tab.sessionId);
                  return true;
                }
              }
              // Recreate tab-0 inside the existing browserContextId
              try {
                const targetRes = (await cdpChannel.sendCommand(
                  "Target.createTarget",
                  {
                    url: "about:blank",
                    browserContextId: activeSlot.browserContextId,
                    width: initialWidth,
                    height: initialHeight,
                  },
                  null,
                )) as { targetId: string };
                const existing = activeSlot.tabs.find((t) => t.targetId === targetRes.targetId);
                let sid = existing?.sessionId;
                if (!sid) {
                  const attachRes = (await cdpChannel.sendCommand(
                    "Target.attachToTarget",
                    { targetId: targetRes.targetId, flatten: true },
                    null,
                  )) as { sessionId: string };
                  sid = attachRes.sessionId;
                }
                const authId = await configureSession(sid, options.storageState, false);
                const tabId = existing?.tabId ?? `tab-${nextTabSeq++}`;
                activeSlot.targetId = targetRes.targetId;
                activeSlot.sessionId = sid;
                activeSlot.authenticatorId = authId;
                activeSlot.tabs = [{ tabId, targetId: targetRes.targetId, sessionId: sid }];
                cdpChannel.setSessionId(sid);
                isAtBlank = true;
                return false;
              } catch {
                // Browser context itself is gone — recreate the full slot
                activeSlot = await createContextSlot(options.storageState);
                cdpChannel.setSessionId(activeSlot.sessionId);
                activeAuthenticatorId = activeSlot.authenticatorId;
                isAtBlank = true;
                return false;
              }
            };

            const visitedOrigins = new Set<string>(observedOrigins);
            observedOrigins.clear();
            const visitedStorageKeys = new Set<string>(observedStorageKeys);
            observedStorageKeys.clear();
            const activeChildSessions = cdpChannel.getChildSessions();
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
            lastNavigationStatus = null;
            authAttemptedRequestIds.clear();
            dialogHandler = null;
            routeRules.length = 0;
            currentNetworkConditions = undefined;
            heldModifiers = 0;
            pressedMouseButtons = 0;
            lastMouseX = 0;
            lastMouseY = 0;
            width = initialWidth;
            height = initialHeight;
            currentDeviceScaleFactor = initialDeviceScaleFactor;
            currentMobile = initialMobile;
            currentHasTouch = initialHasTouch;
            activeUserAgent = options.emulation?.userAgent;
            activeLocale = options.emulation?.locale;

            const hadSubframeNavigation = hasSubframeNavigation;
            hasSubframeNavigation = false;
            const clearAllDirtyFlags = () => {
              hasDeviceMetricsDirty = false;
              hasTouchEmulationDirty = false;
              hasUserAgentDirty = false;
              hasLocaleDirty = false;
              hasEmulatedMediaDirty = false;
              hasTimezoneDirty = false;
              hasNetworkConditionsDirty = false;
              permissionsMutated = false;
              geolocationMutated = false;
              slotNeedsHealthCheck = false;
            };

            // Remove all flow-scoped init scripts, fake clock init script, and exposed bindings (1.19)
            await cleanupFlowScopedHooks();

            if (useContexts && effectiveFreshContextPerFlow && hasRunFirstFlow) {
              if (contextIsolation === "hot-cache" && activeSlot && !slotHasCustomStorageState) {
                const slotWasHealthy =
                  slotNeedsHealthCheck || activeSlot.tabs.length === 0
                    ? await ensureActiveSlotHealthy()
                    : true;
                slotNeedsHealthCheck = false;
                if (slotWasHealthy && activeSlot) {
                  // Only query Page.getFrameTree + Storage.getStorageKeyForFrame when subframes or
                  // OOPIF child sessions actually existed in the prior flow (avoids 2 serial RTTs
                  // on 99% of flows where observedOrigins already captured all top-level origins).
                  if (hadSubframeNavigation || activeChildSessions.length > 0) {
                    const frameIdsToQuery: Array<{ frameId: string; sid: string }> = [];
                    const frameTreeRes = (await cdpChannel
                      .sendCommand("Page.getFrameTree", {}, activeSlot.sessionId, 1_500)
                      .catch(() => null)) as { frameTree?: any } | null;
                    const collectFrameOrigins = (node: any) => {
                      if (!node) return;
                      const u = node.frame?.url;
                      if (typeof node.frame?.id === "string") {
                        frameIdsToQuery.push({
                          frameId: node.frame.id,
                          sid: activeSlot!.sessionId,
                        });
                      }
                      if (typeof u === "string") {
                        try {
                          const parsed = new URL(u);
                          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                            visitedOrigins.add(parsed.origin);
                          }
                        } catch {
                          // ignore
                        }
                      }
                      if (Array.isArray(node.childFrames)) {
                        for (const child of node.childFrames) collectFrameOrigins(child);
                      }
                    };
                    collectFrameOrigins(frameTreeRes?.frameTree);
                    for (const child of activeChildSessions) {
                      if (child.targetId) {
                        frameIdsToQuery.push({ frameId: child.targetId, sid: child.sessionId });
                      }
                      if (child.url) {
                        try {
                          const parsed = new URL(child.url);
                          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                            visitedOrigins.add(parsed.origin);
                          }
                        } catch {
                          // ignore
                        }
                      }
                    }
                    if (frameIdsToQuery.length > 0) {
                      const skResults = await Promise.all(
                        frameIdsToQuery.map(({ frameId, sid }) =>
                          cdpChannel
                            .sendCommand("Storage.getStorageKeyForFrame", { frameId }, sid, 1_000)
                            .catch(() => null),
                        ),
                      );
                      for (const res of skResults) {
                        const sk = (res as { storageKey?: string } | null)?.storageKey;
                        if (sk) visitedStorageKeys.add(sk);
                      }
                    }
                  }

                  // 1. Wipe OOPIF in-page storage BEFORE navigating the main page to about:blank
                  // (navigating in parallel destroys the OOPIF renderer mid-evaluate and can stall for 10s).
                  if (activeChildSessions.length > 0) {
                    await Promise.all(
                      activeChildSessions.map((child) =>
                        cdpChannel
                          .sendCommand(
                            "Runtime.evaluate",
                            {
                              expression:
                                "try { localStorage.clear(); sessionStorage.clear(); } catch {}",
                              returnByValue: true,
                            },
                            child.sessionId,
                            500,
                          )
                          .catch(() => {}),
                      ),
                    );
                  }
                  // 2. Close any extra tabs opened by the prior flow and return to tab 0 BEFORE clearing page state.
                  const preResetOps: Array<Promise<unknown>> = [];
                  let blankNavFailed = false;
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
                    // Restore any installed fake clock and clear in-page storage/OPFS first, then navigate to about:blank
                    // BEFORE calling Storage.clearDataForOrigin so no JS handle contends with CDP storage deletion.
                    preResetOps.push(
                      cdpChannel
                        .evaluateFast(
                          `(async () => {
                            try { if (window.__spanaClock && typeof window.__spanaClock.resume === "function") window.__spanaClock.resume(); } catch {}
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
                        .then(async () => {
                          const targetSid = activeSlot?.sessionId;
                          const blankWaiter = cdpChannel.waitForEventCancellable(
                            "Page.domContentEventFired",
                            1_500,
                            (_p, sid) => !targetSid || !sid || sid === targetSid,
                          );
                          blankWaiter.promise.catch(() => {});
                          try {
                            await cdpChannel.sendCommand(
                              "Page.navigate",
                              { url: "about:blank" },
                              undefined,
                              4_000,
                            );
                            await blankWaiter.promise.catch(() => {});
                            isAtBlank = true;
                          } catch {
                            blankNavFailed = true;
                          } finally {
                            blankWaiter.cancel();
                          }
                        }),
                    );
                  }
                  if (preResetOps.length > 0) {
                    await Promise.all(preResetOps);
                  }
                  if (blankNavFailed) {
                    const recovered = await ensureActiveSlotHealthy();
                    if (!recovered) {
                      cdpChannel.clearChildSessions();
                      await disableAllFetchInterception();
                      clearAllDirtyFlags();
                      if (activeSlot && options.virtualAuthenticator) {
                        await ensureVirtualAuthenticatorForSlot(activeSlot, true);
                      } else if (activeSlot) {
                        activeAuthenticatorId = activeSlot.authenticatorId;
                      }
                      hasRunFirstFlow = true;
                      return;
                    }
                  }
                  cdpChannel.clearChildSessions();
                  // 3. Now that the page is safely on about:blank (no active document holding storage locks),
                  // wipe cookies, per-origin & partitioned storage keys, and ONLY the dirty emulation/route/network
                  // overrides in parallel (zero redundant CDP round-trips for untouched state!).
                  const resetOps: Array<Promise<unknown>> = [
                    cdpChannel
                      .sendCommand("Network.clearBrowserCookies", {}, undefined, 2_000)
                      .catch(() => {}),
                  ];
                  const storageTypes =
                    "cookies,local_storage,session_storage,indexeddb,cache_storage,service_workers,file_systems";
                  for (const origin of visitedOrigins) {
                    resetOps.push(
                      cdpChannel
                        .sendCommand(
                          "Storage.clearDataForOrigin",
                          { origin, storageTypes },
                          undefined,
                          2_000,
                        )
                        .catch(() => {}),
                    );
                  }
                  for (const storageKey of visitedStorageKeys) {
                    resetOps.push(
                      cdpChannel
                        .sendCommand(
                          "Storage.clearDataForStorageKey",
                          {
                            storageKey,
                            storageTypes,
                          },
                          undefined,
                          2_000,
                        )
                        .catch(() => {}),
                    );
                  }
                  if (permissionsMutated) {
                    permissionsMutated = false;
                    resetOps.push(
                      cdpChannel
                        .sendCommand(
                          "Browser.resetPermissions",
                          { browserContextId: activeSlot.browserContextId },
                          null,
                        )
                        .catch(() => {}),
                    );
                  }
                  if (geolocationMutated) {
                    geolocationMutated = false;
                    resetOps.push(
                      cdpChannel
                        .sendCommand("Emulation.clearGeolocationOverride", {})
                        .catch(() => {}),
                    );
                  }
                  if (fetchEnabledSessions.size > 0 && !activeHttpCredentials) {
                    resetOps.push(disableAllFetchInterception());
                  }
                  if (hasDeviceMetricsDirty || hasTouchEmulationDirty) {
                    const needsTouchReset = hasTouchEmulationDirty;
                    hasDeviceMetricsDirty = false;
                    hasTouchEmulationDirty = false;
                    width = initialWidth;
                    height = initialHeight;
                    currentDeviceScaleFactor = initialDeviceScaleFactor;
                    currentMobile = initialMobile;
                    currentHasTouch = initialHasTouch;
                    if (needsTouchReset) {
                      resetOps.push(
                        (async () => {
                          await cdpChannel
                            .sendCommand("Emulation.clearDeviceMetricsOverride", {})
                            .catch(() => {});
                          await cdpChannel
                            .sendCommand("Emulation.setTouchEmulationEnabled", {
                              enabled: initialHasTouch,
                              ...(initialHasTouch ? { maxTouchPoints: 5 } : {}),
                            })
                            .catch(() => {});
                          if (!initialHasTouch && !initialMobile) {
                            await cdpChannel
                              .sendCommand("Emulation.setEmitTouchEventsForMouse", {
                                enabled: false,
                                configuration: "desktop",
                              })
                              .catch(() => {});
                          }
                          await cdpChannel
                            .sendCommand("Emulation.setDeviceMetricsOverride", {
                              width: initialWidth,
                              height: initialHeight,
                              deviceScaleFactor: initialDeviceScaleFactor,
                              mobile: initialMobile,
                            })
                            .catch(() => {});
                        })(),
                      );
                    } else {
                      resetOps.push(
                        cdpChannel
                          .sendCommand("Emulation.setDeviceMetricsOverride", {
                            width: initialWidth,
                            height: initialHeight,
                            deviceScaleFactor: initialDeviceScaleFactor,
                            mobile: initialMobile,
                          })
                          .catch(() => {}),
                      );
                    }
                  }
                  if (hasLocaleDirty) {
                    hasLocaleDirty = false;
                    activeLocale = options.emulation?.locale;
                    const defaultLocale = options.emulation?.locale ?? "";
                    resetOps.push(
                      cdpChannel
                        .sendCommand("Emulation.setLocaleOverride", { locale: defaultLocale })
                        .catch(() => {}),
                    );
                  }
                  if (hasUserAgentDirty) {
                    hasUserAgentDirty = false;
                    activeUserAgent = options.emulation?.userAgent;
                    const defaultLocale = options.emulation?.locale ?? "";
                    resetOps.push(
                      cdpChannel
                        .sendCommand("Emulation.setUserAgentOverride", {
                          userAgent:
                            options.emulation?.userAgent ||
                            defaultCleanUserAgent ||
                            cachedUserAgent ||
                            "Mozilla/5.0",
                          acceptLanguage: buildAcceptLanguage(defaultLocale) ?? "",
                        })
                        .catch(() => {}),
                    );
                  }
                  if (hasEmulatedMediaDirty) {
                    hasEmulatedMediaDirty = false;
                    resetOps.push(
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
                    );
                  }
                  if (hasTimezoneDirty) {
                    hasTimezoneDirty = false;
                    resetOps.push(
                      cdpChannel
                        .sendCommand("Emulation.setTimezoneOverride", {
                          timezoneId: options.emulation?.timezoneId ?? "",
                        })
                        .catch(() => {}),
                    );
                  }
                  if (hasNetworkConditionsDirty) {
                    hasNetworkConditionsDirty = false;
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
                  }
                  await Promise.all(resetOps);
                  if (options.storageState) {
                    const state = await loadStorageStateFile(options.storageState);
                    if (state?.cookies && state.cookies.length > 0) {
                      await cdpChannel
                        .sendCommand("Network.setCookies", { cookies: state.cookies })
                        .catch(() => {});
                    }
                  }
                } else {
                  cdpChannel.clearChildSessions();
                  await disableAllFetchInterception();
                  clearAllDirtyFlags();
                }
                if (activeSlot && options.virtualAuthenticator) {
                  await ensureVirtualAuthenticatorForSlot(activeSlot, true);
                } else if (activeSlot) {
                  activeAuthenticatorId = activeSlot.authenticatorId;
                }
              } else {
                cdpChannel.clearChildSessions();
                await disableAllFetchInterception();
                clearAllDirtyFlags();
                width = initialWidth;
                height = initialHeight;
                currentDeviceScaleFactor = initialDeviceScaleFactor;
                currentMobile = initialMobile;
                currentHasTouch = initialHasTouch;
                activeUserAgent = options.emulation?.userAgent;
                activeLocale = options.emulation?.locale;
                slotHasCustomStorageState = false;
                isAtBlank = true;
                const previousSlot = activeSlot;
                const pending = prefetchedSlotPromise;
                prefetchedSlotPromise = undefined;
                activeSlot = pending
                  ? await pending
                  : await createContextSlot(options.storageState);
                cdpChannel.setSessionId(activeSlot.sessionId);
                if (options.virtualAuthenticator) {
                  await ensureVirtualAuthenticatorForSlot(activeSlot, false);
                } else {
                  activeAuthenticatorId = activeSlot.authenticatorId;
                }
                if (previousSlot) {
                  disposeSlotInBackground(previousSlot);
                }
              }
            } else if (activeSlot) {
              cdpChannel.clearChildSessions();
              await disableAllFetchInterception();
              if (slotNeedsHealthCheck || activeSlot.tabs.length === 0) {
                await ensureActiveSlotHealthy();
                slotNeedsHealthCheck = false;
              }
              if (activeSlot && options.virtualAuthenticator) {
                await ensureVirtualAuthenticatorForSlot(activeSlot, false);
              } else if (activeSlot) {
                activeAuthenticatorId = activeSlot.authenticatorId;
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
            lastMouseX = x;
            lastMouseY = y;
            // Pipeline move + down + up on the FIFO-ordered CDP WebSocket (1 RTT instead of 3).
            // Always send `buttons: 1` on mousePressed & `buttons: 0` on mouseReleased with
            // `pointerType: "mouse"` so UI libs like @base-ui/react don't misclassify it as a
            // virtual screen-reader press (`isVirtualPointerEvent`).
            await Promise.all([
              cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x,
                y,
                modifiers: heldModifiers,
                pointerType: "mouse",
              }),
              cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mousePressed",
                x,
                y,
                button: "left",
                buttons: 1,
                clickCount: 1,
                modifiers: heldModifiers,
                pointerType: "mouse",
              }),
              cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseReleased",
                x,
                y,
                button: "left",
                buttons: 0,
                clickCount: 1,
                modifiers: heldModifiers,
                pointerType: "mouse",
              }),
            ]);
          },
          catch: (e) => new DriverError({ message: `CDP tap failed at (${x}, ${y}): ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            lastMouseX = x;
            lastMouseY = y;
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              buttons: 1,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              buttons: 0,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              buttons: 1,
              clickCount: 2,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              buttons: 0,
              clickCount: 2,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
          },
          catch: (e) => new DriverError({ message: `CDP doubleTap failed: ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          try: async () => {
            lastMouseX = x;
            lastMouseY = y;
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button: "left",
              buttons: 1,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            await new Promise((r) => setTimeout(r, duration));
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button: "left",
              buttons: 0,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
          },
          catch: (e) => new DriverError({ message: `CDP longPress failed: ${e}` }),
        }),

      swipe: (startX, startY, endX, endY, duration = 300) =>
        Effect.tryPromise({
          try: async () => {
            const totalSteps = Math.max(4, Math.min(20, Math.round((duration || 300) / 20)));
            const stepDelayMs = duration > 0 ? Math.max(0, Math.floor(duration / totalSteps)) : 0;
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: startX,
              y: startY,
            });
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: startX,
              y: startY,
              button: "left",
              buttons: 1,
              clickCount: 1,
            });
            for (let i = 1; i <= totalSteps; i++) {
              const t = i / totalSteps;
              await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: startX + (endX - startX) * t,
                y: startY + (endY - startY) * t,
                button: "left",
                buttons: 1,
              });
              if (stepDelayMs > 0) {
                await new Promise((r) => setTimeout(r, stepDelayMs));
              }
            }
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: endX,
              y: endY,
              button: "left",
              buttons: 0,
              clickCount: 1,
            });
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
              const cp = ch.codePointAt(0) ?? 0;
              if (cp > 0x7e) {
                // Non-ASCII characters (e.g. Swedish åäö, accented Latin, CJK, emoji) have no US
                // virtual keyCode and can be dropped by raw Input.dispatchKeyEvent on Linux Chromium.
                // Dispatch keyDown + Input.insertText + keyUp (matching Playwright CRKeyboard).
                await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
                  type: "keyDown",
                  key: ch,
                  modifiers: 0,
                });
                await cdpChannel.sendCommand("Input.insertText", { text: ch });
                await cdpChannel.sendCommand("Input.dispatchKeyEvent", {
                  type: "keyUp",
                  key: ch,
                  modifiers: 0,
                });
              } else {
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
              }
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
            const desc = parseCdpKeyDescriptor(key, heldModifiers);
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
            const modBit = modifierBitForName(key);
            if (modBit) heldModifiers |= modBit;
            const desc = parseCdpKeyDescriptor(key, heldModifiers);
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
            const modBit = modifierBitForName(key);
            if (modBit) heldModifiers &= ~modBit;
            const desc = parseCdpKeyDescriptor(key, heldModifiers);
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
            const resolvedOpts =
              typeof x === "object" && x !== null
                ? (x as { button?: "left" | "right" | "middle" })
                : opts;
            const targetX = typeof x === "number" && Number.isFinite(x) ? x : lastMouseX;
            const targetY = typeof y === "number" && Number.isFinite(y) ? y : lastMouseY;
            const button = resolvedOpts?.button ?? "left";
            const mask = button === "left" ? 1 : button === "right" ? 2 : 4;
            pressedMouseButtons |= mask;
            lastMouseX = targetX;
            lastMouseY = targetY;
            if (typeof x === "number" && typeof y === "number") {
              await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: targetX,
                y: targetY,
                modifiers: heldModifiers,
                pointerType: "mouse",
              });
            }
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: targetX,
              y: targetY,
              button,
              buttons: pressedMouseButtons,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
          },
          catch: (e) => new DriverError({ message: `CDP mouseDown failed: ${e}` }),
        }),

      mouseUp: (x, y, opts) =>
        Effect.tryPromise({
          try: async () => {
            const resolvedOpts =
              typeof x === "object" && x !== null
                ? (x as { button?: "left" | "right" | "middle" })
                : opts;
            const targetX = typeof x === "number" && Number.isFinite(x) ? x : lastMouseX;
            const targetY = typeof y === "number" && Number.isFinite(y) ? y : lastMouseY;
            const button = resolvedOpts?.button ?? "left";
            const mask = button === "left" ? 1 : button === "right" ? 2 : 4;
            pressedMouseButtons &= ~mask;
            lastMouseX = targetX;
            lastMouseY = targetY;
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: targetX,
              y: targetY,
              button,
              buttons: pressedMouseButtons,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
          },
          catch: (e) => new DriverError({ message: `CDP mouseUp failed: ${e}` }),
        }),

      mouseWheel: (x, y, deltaX, deltaY) =>
        Effect.tryPromise({
          try: async () => {
            lastMouseX = x;
            lastMouseY = y;
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x,
              y,
              deltaX,
              deltaY,
              modifiers: heldModifiers,
              pointerType: "mouse",
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

      hoverAtCoordinate: (x, y, opts) =>
        Effect.tryPromise({
          try: async () => {
            const steps = Math.max(1, Math.round(opts?.steps ?? 1));
            const startX = lastMouseX;
            const startY = lastMouseY;
            const activeButton =
              pressedMouseButtons & 1
                ? "left"
                : pressedMouseButtons & 2
                  ? "right"
                  : pressedMouseButtons & 4
                    ? "middle"
                    : "none";
            for (let i = 1; i <= steps; i++) {
              const t = i / steps;
              const cx = steps === 1 ? x : startX + (x - startX) * t;
              const cy = steps === 1 ? y : startY + (y - startY) * t;
              await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: cx,
                y: cy,
                ...(activeButton !== "none" ? { button: activeButton } : {}),
                ...(pressedMouseButtons ? { buttons: pressedMouseButtons } : {}),
                modifiers: heldModifiers,
                pointerType: "mouse",
              });
              if (steps > 1 && pressedMouseButtons) {
                await new Promise((r) => setTimeout(r, 8));
              }
            }
            lastMouseX = x;
            lastMouseY = y;
          },
          catch: (e) => new DriverError({ message: `CDP hover failed at (${x}, ${y}): ${e}` }),
        }),

      reload: (reloadOpts) =>
        Effect.tryPromise({
          try: async () => {
            const waitUntil = reloadOpts?.waitUntil ?? options.waitUntil ?? "domcontentloaded";
            const targetSid = activeSlot?.sessionId;
            if (waitUntil === "commit") {
              await cdpChannel.sendCommand("Page.reload", {}, undefined, navigationTimeoutMs);
              return;
            }
            const eventName =
              waitUntil === "domcontentloaded"
                ? "Page.domContentEventFired"
                : "Page.loadEventFired";
            const waiter = cdpChannel.waitForEventCancellable(
              eventName,
              navigationTimeoutMs,
              (_p, sid) => !targetSid || !sid || sid === targetSid,
            );
            waiter.promise.catch(() => {});
            try {
              await cdpChannel.sendCommand("Page.reload", {}, undefined, navigationTimeoutMs);
              try {
                await waiter.promise;
              } catch (waitErr) {
                throw new Error(
                  `Page reload timed out waiting for ${waitUntil} after ${navigationTimeoutMs}ms: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`,
                  { cause: waitErr },
                );
              }
            } finally {
              waiter.cancel();
            }
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
      getLastNavigationStatus: () => lastNavigationStatus,

      waitForLoadState: (state = "load", waitOpts) =>
        Effect.tryPromise({
          try: async () => {
            const timeoutMs = waitOpts?.timeout ?? navigationTimeoutMs;
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
            let timer: ReturnType<typeof setTimeout> | undefined;
            let entry:
              | { resolve: (tabId: string) => void; reject: (err: Error) => void }
              | undefined;
            const cleanup = () => {
              if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
              }
              if (entry) {
                const idx = popupWaiters.indexOf(entry);
                if (idx >= 0) popupWaiters.splice(idx, 1);
                entry = undefined;
              }
            };
            const popupPromise = new Promise<string>((resolve, reject) => {
              timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timed out waiting for popup after ${timeoutMs}ms`));
              }, timeoutMs);
              entry = {
                resolve: (tabId) => {
                  cleanup();
                  resolve(tabId);
                },
                reject: (err) => {
                  cleanup();
                  reject(err);
                },
              };
              popupWaiters.push(entry);
            });
            popupPromise.catch(() => {});
            try {
              await triggerFn();
              return await popupPromise;
            } finally {
              cleanup();
            }
          },
          catch: (e) => new DriverError({ message: `CDP waitForPopup failed: ${e}` }),
        }),

      hideKeyboard: () => Effect.void,

      takeScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            let lastErr: unknown;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const res = (await cdpChannel.sendCommand("Page.captureScreenshot", {
                  format: "png",
                })) as { data?: string };
                return new Uint8Array(Buffer.from(res?.data ?? "", "base64"));
              } catch (err) {
                lastErr = err;
                const msg = err instanceof Error ? err.message : String(err);
                if (
                  attempt < 2 &&
                  (msg.includes("Not attached to an active page") ||
                    msg.includes("Unable to capture screenshot"))
                ) {
                  await new Promise((r) => setTimeout(r, 60));
                  continue;
                }
                throw err;
              }
            }
            throw lastErr;
          },
          catch: (e) => new DriverError({ message: `CDP screenshot failed: ${e}` }),
        }),

      takeFullPageScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            let lastErr: unknown;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const res = (await cdpChannel.sendCommand("Page.captureScreenshot", {
                  format: "png",
                  captureBeyondViewport: true,
                  fromSurface: true,
                })) as { data?: string };
                return new Uint8Array(Buffer.from(res?.data ?? "", "base64"));
              } catch (err) {
                lastErr = err;
                const msg = err instanceof Error ? err.message : String(err);
                if (
                  attempt < 2 &&
                  (msg.includes("Not attached to an active page") ||
                    msg.includes("Unable to capture screenshot"))
                ) {
                  await new Promise((r) => setTimeout(r, 60));
                  continue;
                }
                throw err;
              }
            }
            throw lastErr;
          },
          catch: (e) => new DriverError({ message: `CDP fullPage screenshot failed: ${e}` }),
        }),

      setGeolocation: (point) =>
        Effect.tryPromise({
          try: async () => {
            geolocationMutated = true;
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
            permissionsMutated = true;
            const origin = permOpts?.origin;
            const ctxId = activeSlot?.browserContextId;
            if (state === "grant") {
              const grantName = mapPermissionToCdpGrantName(permission);
              await cdpChannel.sendCommand(
                "Browser.grantPermissions",
                {
                  permissions: [grantName],
                  ...(origin ? { origin } : {}),
                  ...(ctxId ? { browserContextId: ctxId } : {}),
                },
                null,
              );
            } else {
              const descriptor = mapPermissionToCdpDescriptor(permission);
              await cdpChannel.sendCommand(
                "Browser.setPermission",
                {
                  permission: descriptor,
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
            const slotToDispose = activeSlot;
            activeSlot = undefined;
            if (useContexts && slotToDispose) {
              await Promise.race([
                cdpChannel
                  .sendCommand(
                    "Target.disposeBrowserContext",
                    { browserContextId: slotToDispose.browserContextId },
                    null,
                  )
                  .catch(() => {}),
                new Promise<void>((r) => setTimeout(r, 1500)),
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
            downloadConfiguredContexts.clear();
            for (const dir of uploadTempDirs.splice(0)) {
              try {
                rmSync(dir, { recursive: true, force: true });
              } catch {
                // ignore temp dir cleanup errors
              }
            }
            if (options._markClosedOnKill) {
              cdpChannel.markClosed("Browser context closed");
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
              const w1 = cdpChannel.waitForEventCancellable(
                eventName,
                navigationTimeoutMs,
                (_p, sid) => !targetSid || !sid || sid === targetSid,
              );
              const w2 = cdpChannel.waitForEventCancellable(
                "Page.navigatedWithinDocument",
                navigationTimeoutMs,
                (_p, sid) => !targetSid || !sid || sid === targetSid,
              );
              const w3 = cdpChannel.waitForEventCancellable(
                "Page.frameNavigated",
                navigationTimeoutMs,
                (p, sid) =>
                  (!targetSid || !sid || sid === targetSid) &&
                  !p?.frame?.parentId &&
                  p?.type === "BackForwardCacheRestore",
              );
              w1.promise.catch(() => {});
              w2.promise.catch(() => {});
              w3.promise.catch(() => {});
              const waiter = Promise.race([w1.promise, w2.promise, w3.promise]);
              waiter.catch(() => {});
              try {
                await cdpChannel.sendCommand(
                  "Page.navigateToHistoryEntry",
                  { entryId: targetEntry.id },
                  undefined,
                  navigationTimeoutMs,
                );
                try {
                  await waiter;
                } catch (waitErr) {
                  throw new Error(
                    `History back navigation timed out after ${navigationTimeoutMs}ms: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`,
                    { cause: waitErr },
                  );
                }
              } finally {
                w1.cancel();
                w2.cancel();
                w3.cancel();
              }
              // Short non-fatal DOM-idle settle wait so back() layout/hydration settles (1.16)
              await cdpChannel
                .evaluateFast(
                  `new Promise((resolve) => {
                    let done = false;
                    const finish = () => { if (!done) { done = true; clearTimeout(maxT); clearTimeout(idleT); obs.disconnect(); resolve(true); } };
                    const maxT = setTimeout(finish, 400);
                    let idleT = setTimeout(finish, 80);
                    const obs = new MutationObserver(() => { clearTimeout(idleT); idleT = setTimeout(finish, 80); });
                    try { obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true }); } catch { finish(); }
                  })`,
                )
                .catch(() => {});
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
              const w1 = cdpChannel.waitForEventCancellable(
                eventName,
                navigationTimeoutMs,
                (_p, sid) => !targetSid || !sid || sid === targetSid,
              );
              const w2 = cdpChannel.waitForEventCancellable(
                "Page.navigatedWithinDocument",
                navigationTimeoutMs,
                (_p, sid) => !targetSid || !sid || sid === targetSid,
              );
              const w3 = cdpChannel.waitForEventCancellable(
                "Page.frameNavigated",
                navigationTimeoutMs,
                (p, sid) =>
                  (!targetSid || !sid || sid === targetSid) &&
                  !p?.frame?.parentId &&
                  p?.type === "BackForwardCacheRestore",
              );
              w1.promise.catch(() => {});
              w2.promise.catch(() => {});
              w3.promise.catch(() => {});
              const waiter = Promise.race([w1.promise, w2.promise, w3.promise]);
              waiter.catch(() => {});
              try {
                await cdpChannel.sendCommand(
                  "Page.navigateToHistoryEntry",
                  { entryId: targetEntry.id },
                  undefined,
                  navigationTimeoutMs,
                );
                try {
                  await waiter;
                } catch (waitErr) {
                  throw new Error(
                    `History forward navigation timed out after ${navigationTimeoutMs}ms: ${waitErr instanceof Error ? waitErr.message : String(waitErr)}`,
                    { cause: waitErr },
                  );
                }
              } finally {
                w1.cancel();
                w2.cancel();
                w3.cancel();
              }
              // Short non-fatal DOM-idle settle wait so forward() layout/hydration settles (1.16)
              await cdpChannel
                .evaluateFast(
                  `new Promise((resolve) => {
                    let done = false;
                    const finish = () => { if (!done) { done = true; clearTimeout(maxT); clearTimeout(idleT); obs.disconnect(); resolve(true); } };
                    const maxT = setTimeout(finish, 400);
                    let idleT = setTimeout(finish, 80);
                    const obs = new MutationObserver(() => { clearTimeout(idleT); idleT = setTimeout(finish, 80); });
                    try { obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true }); } catch { finish(); }
                  })`,
                )
                .catch(() => {});
              return;
            }
            await cdpChannel.evaluate("window.history.forward()");
          },
          catch: (e) => new DriverError({ message: `CDP forward failed: ${e}` }),
        }),

      evaluate: (fn, ...args) =>
        Effect.tryPromise({
          try: async () => {
            const expr =
              typeof fn === "string"
                ? fn
                : `(${fn.toString()})(${args.map((a) => serializeEvaluateArg(a)).join(", ")})`;
            try {
              return (await cdpChannel.evaluateOnce(expr)) as any;
            } catch (firstErr) {
              const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
              // If Chrome threw an immediate protocol error because the new document's execution
              // context wasn't ready yet during a navigation, retry once on the fresh context.
              // (Hung promises aborted by `contextDestroyedPromise` throw `Execution context was destroyed (...)` and are NOT retried.)
              if (/Cannot find context with specified id/i.test(msg)) {
                await new Promise((r) => setTimeout(r, 60));
                return (await cdpChannel.evaluateOnce(expr)) as any;
              }
              throw firstErr;
            }
          },
          catch: (e) => new DriverError({ message: `CDP evaluate failed: ${e}` }),
        }),

      addInitScript: (script, ...args) =>
        Effect.tryPromise({
          try: async () => {
            const source =
              typeof script === "string"
                ? script
                : `(${script.toString()})(${args.map((a) => serializeEvaluateArg(a)).join(", ")});`;
            flowInitScripts.push(source);
            const sessions: Array<string | null> = activeSlot
              ? Array.from(
                  new Set([activeSlot.sessionId, ...activeSlot.tabs.map((t) => t.sessionId)]),
                )
              : [null];
            await Promise.all(
              sessions.map((sid) =>
                cdpChannel
                  .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source }, sid)
                  .then((res) => recordScriptId(flowInitScriptIds, sid, res))
                  .catch(() => {}),
              ),
            );
          },
          catch: (e) => new DriverError({ message: `CDP addInitScript failed: ${e}` }),
        }),

      setClockInitScript: (script: string | null) =>
        Effect.tryPromise({
          try: async () => {
            await removeTrackedScripts(clockInitScriptIds);
            clockInitScript = script;
            if (!script) return;
            const sessions: Array<string | null> = activeSlot
              ? Array.from(
                  new Set([activeSlot.sessionId, ...activeSlot.tabs.map((t) => t.sessionId)]),
                )
              : [null];
            await Promise.all(
              sessions.map((sid) =>
                cdpChannel
                  .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: script }, sid)
                  .then((res) => recordScriptId(clockInitScriptIds, sid, res))
                  .catch(() => {}),
              ),
            );
          },
          catch: (e) => new DriverError({ message: `CDP setClockInitScript failed: ${e}` }),
        }),

      exposeFunction: (name, fn) =>
        Effect.tryPromise({
          try: async () => {
            flowExposedFunctions.set(name, fn);
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

      unroute: (matcher, handler) =>
        Effect.tryPromise({
          try: async () => {
            const matchersEqual = (a: BrowserRouteMatcher, b: BrowserRouteMatcher) =>
              a instanceof RegExp && b instanceof RegExp
                ? a.source === b.source && a.flags === b.flags
                : a === b;
            for (let i = routeRules.length - 1; i >= 0; i--) {
              const r = routeRules[i]!;
              if (matchersEqual(r.matcher, matcher) && (!handler || r.handler === handler)) {
                routeRules.splice(i, 1);
              }
            }
            if (routeRules.length === 0) {
              await disableAllFetchInterception();
            }
          },
          catch: (e) => new DriverError({ message: `CDP unroute failed: ${e}` }),
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
            await disableAllFetchInterception();
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
                    let lastErr: unknown;
                    for (let attempt = 0; attempt < 60; attempt++) {
                      try {
                        const bodyRes = (await cdpChannel.sendCommand(
                          "Network.getResponseBody",
                          { requestId },
                          responseSid,
                        )) as { body?: string; base64Encoded?: boolean };
                        if (bodyRes?.base64Encoded && bodyRes.body) {
                          return Buffer.from(bodyRes.body, "base64").toString("utf8");
                        }
                        return bodyRes?.body ?? "";
                      } catch (err) {
                        lastErr = err;
                        const msg = err instanceof Error ? err.message : String(err);
                        if (
                          !/No resource with given identifier|No data found/i.test(msg) ||
                          attempt >= 59
                        ) {
                          throw err;
                        }
                        await new Promise((r) => setTimeout(r, 25));
                      }
                    }
                    throw lastErr;
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
            const childEmulation =
              ctxOpts?.locale || ctxOpts?.userAgent
                ? {
                    ...options.emulation,
                    ...(ctxOpts.locale ? { locale: ctxOpts.locale } : {}),
                    ...(ctxOpts.userAgent ? { userAgent: ctxOpts.userAgent } : {}),
                  }
                : options.emulation;
            const childDriver = await Effect.runPromise(
              makeLightweightCdpDriver({
                ...options,
                cdpUrl: connectWsUrl ?? options.cdpUrl,
                useBrowserContexts: true,
                freshContextPerFlow: false,
                _markClosedOnKill: true,
                ...(ctxOpts?.viewport ? { viewport: ctxOpts.viewport } : {}),
                ...(ctxOpts?.deviceScaleFactor !== undefined
                  ? { deviceScaleFactor: ctxOpts.deviceScaleFactor }
                  : {}),
                ...(ctxOpts?.mobile !== undefined ? { mobile: ctxOpts.mobile } : {}),
                ...(ctxOpts?.isMobile !== undefined ? { isMobile: ctxOpts.isMobile } : {}),
                ...(ctxOpts?.hasTouch !== undefined ? { hasTouch: ctxOpts.hasTouch } : {}),
                ...(ctxOpts?.httpCredentials ? { httpCredentials: ctxOpts.httpCredentials } : {}),
                ...(childEmulation ? { emulation: childEmulation } : {}),
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
              slotHasCustomStorageState = true;
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
            hasNetworkConditionsDirty = true;
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
            const hasInMemoryPayload = rawItems.some((item) => typeof item !== "string");
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

            if (hasInMemoryPayload) {
              // Preserve explicit mimeType on in-memory UploadFilePayload items via DataTransfer + new File() (3.24)
              const serializedItems: Array<{ name: string; mimeType: string; bytes: number[] }> =
                [];
              for (const item of rawItems) {
                if (typeof item === "string") {
                  const buf = await readFile(item);
                  const base = item.split(/[\\/]/).pop() || "upload.bin";
                  serializedItems.push({
                    name: base,
                    mimeType: "application/octet-stream",
                    bytes: Array.from(new Uint8Array(buf)),
                  });
                } else {
                  serializedItems.push({
                    name: item.name || "upload.bin",
                    mimeType: item.mimeType || "application/octet-stream",
                    bytes: Array.from(new Uint8Array(item.buffer)),
                  });
                }
              }
              await cdpChannel.sendCommand("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: `function(items) {
                  var dt = new DataTransfer();
                  for (var i = 0; i < items.length; i++) {
                    var it = items[i];
                    var f = new File([new Uint8Array(it.bytes)], it.name, { type: it.mimeType });
                    dt.items.add(f);
                  }
                  this.files = dt.files;
                  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
                  this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
                }`,
                arguments: [{ value: serializedItems }],
                returnByValue: true,
              });
              return;
            }

            const files = rawItems as string[];
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
            await ensureDownloadBehaviorForActiveContext();
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
            // Move real pointer to source first so hover-revealed drag handles stay mounted,
            // then check for HTML5 Drag and Drop (`draggable="true"`).
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: fromX,
              y: fromY,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            const hasDraggableSource = await cdpChannel
              .evaluate<boolean>(
                `((fx, fy) => {
                  const hit = document.elementFromPoint(fx, fy);
                  return Boolean(hit && hit.closest && hit.closest('[draggable="true"]'));
                })(${fromX}, ${fromY})`,
              )
              .catch(() => false);
            if (hasDraggableSource) {
              await cdpChannel.evaluate(
                `((fx, fy) => {
                  const hit = document.elementFromPoint(fx, fy);
                  const src = hit && hit.closest ? hit.closest('[draggable="true"]') : null;
                  if (!src) return false;
                  const dt = new DataTransfer();
                  window.__spanaDragState = { src, dt };
                  src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, clientX: fx, clientY: fy, dataTransfer: dt }));
                  return true;
                })(${fromX}, ${fromY})`,
              );
              await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: toX,
                y: toY,
                modifiers: heldModifiers,
                pointerType: "mouse",
              });
              await cdpChannel.evaluate(
                `(async (tx, ty) => {
                  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                  const st = window.__spanaDragState;
                  delete window.__spanaDragState;
                  if (!st) return false;
                  const dst = document.elementFromPoint(tx, ty) || document.body;
                  dst.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: st.dt }));
                  dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: st.dt }));
                  dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: st.dt }));
                  st.src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, clientX: tx, clientY: ty, dataTransfer: st.dt }));
                  return true;
                })(${toX}, ${toY})`,
              );
              lastMouseX = toX;
              lastMouseY = toY;
              return;
            }
            const totalSteps = Math.max(1, Math.round(steps));
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: fromX,
              y: fromY,
              button: "left",
              buttons: 1,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            for (let i = 1; i <= totalSteps; i++) {
              const t = i / totalSteps;
              await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: fromX + (toX - fromX) * t,
                y: fromY + (toY - fromY) * t,
                button: "left",
                buttons: 1,
                modifiers: heldModifiers,
                pointerType: "mouse",
              });
            }
            await cdpChannel.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: toX,
              y: toY,
              button: "left",
              buttons: 0,
              clickCount: 1,
              modifiers: heldModifiers,
              pointerType: "mouse",
            });
            lastMouseX = toX;
            lastMouseY = toY;
          },
          catch: (e) => new DriverError({ message: `CDP dragAndDrop failed: ${e}` }),
        }),

      setViewport: (viewport) =>
        Effect.tryPromise({
          try: async () => {
            width = viewport.width;
            height = viewport.height;
            const wasMobileOrTouch = currentMobile || currentHasTouch;
            const nextDpr = viewport.deviceScaleFactor ?? currentDeviceScaleFactor;
            const nextMobile = viewport.isMobile ?? viewport.mobile ?? currentMobile;
            const nextHasTouch =
              viewport.hasTouch ??
              (viewport.isMobile !== undefined || viewport.mobile !== undefined
                ? nextMobile
                : currentHasTouch);
            currentDeviceScaleFactor = nextDpr;
            currentMobile = nextMobile;
            currentHasTouch = nextHasTouch;
            hasDeviceMetricsDirty = true;
            if (
              nextMobile !== initialMobile ||
              nextHasTouch !== initialHasTouch ||
              wasMobileOrTouch !== (initialMobile || initialHasTouch) ||
              viewport.hasTouch !== undefined ||
              viewport.mobile !== undefined ||
              viewport.isMobile !== undefined
            ) {
              hasTouchEmulationDirty = true;
            }
            if (wasMobileOrTouch && !nextMobile && !nextHasTouch) {
              await cdpChannel
                .sendCommand("Emulation.clearDeviceMetricsOverride", {})
                .catch(() => {});
              await cdpChannel
                .sendCommand("Emulation.setTouchEmulationEnabled", {
                  enabled: false,
                })
                .catch(() => {});
              await cdpChannel
                .sendCommand("Emulation.setEmitTouchEventsForMouse", {
                  enabled: false,
                  configuration: "desktop",
                })
                .catch(() => {});
            }
            await cdpChannel.sendCommand("Emulation.setDeviceMetricsOverride", {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: nextDpr,
              mobile: nextMobile,
            });
            if (nextHasTouch) {
              await cdpChannel
                .sendCommand("Emulation.setTouchEmulationEnabled", {
                  enabled: true,
                  maxTouchPoints: 5,
                })
                .catch(() => {});
            } else if (!wasMobileOrTouch && viewport.hasTouch === false) {
              await cdpChannel
                .sendCommand("Emulation.clearDeviceMetricsOverride", {})
                .catch(() => {});
              await cdpChannel
                .sendCommand("Emulation.setTouchEmulationEnabled", {
                  enabled: false,
                })
                .catch(() => {});
              await cdpChannel
                .sendCommand("Emulation.setEmitTouchEventsForMouse", {
                  enabled: false,
                  configuration: "desktop",
                })
                .catch(() => {});
              await cdpChannel.sendCommand("Emulation.setDeviceMetricsOverride", {
                width: viewport.width,
                height: viewport.height,
                deviceScaleFactor: nextDpr,
                mobile: nextMobile,
              });
            }
          },
          catch: (e) => new DriverError({ message: `CDP setViewport failed: ${e}` }),
        }),

      setEmulation: (emulationOpts: BrowserEmulationOptions) =>
        Effect.tryPromise({
          try: async () => {
            const features: Array<{ name: string; value: string }> = [];
            if (emulationOpts.colorScheme !== undefined) {
              hasEmulatedMediaDirty = true;
              features.push({
                name: "prefers-color-scheme",
                value:
                  emulationOpts.colorScheme === "no-preference" ? "" : emulationOpts.colorScheme,
              });
            }
            if (emulationOpts.reducedMotion !== undefined) {
              hasEmulatedMediaDirty = true;
              features.push({
                name: "prefers-reduced-motion",
                value:
                  emulationOpts.reducedMotion === "no-preference"
                    ? ""
                    : emulationOpts.reducedMotion,
              });
            }
            const emuOps: Array<Promise<unknown>> = [];
            if (features.length > 0) {
              emuOps.push(cdpChannel.sendCommand("Emulation.setEmulatedMedia", { features }));
            }
            if (emulationOpts.userAgent !== undefined) {
              hasUserAgentDirty = true;
              activeUserAgent = emulationOpts.userAgent;
            }
            if (emulationOpts.locale !== undefined) {
              hasLocaleDirty = true;
              hasUserAgentDirty = true;
              activeLocale = emulationOpts.locale;
              emuOps.push(
                cdpChannel
                  .sendCommand("Emulation.setLocaleOverride", { locale: emulationOpts.locale })
                  .catch(() => {}),
              );
            }
            if (emulationOpts.timezoneId !== undefined) {
              hasTimezoneDirty = true;
              emuOps.push(
                cdpChannel
                  .sendCommand("Emulation.setTimezoneOverride", {
                    timezoneId: emulationOpts.timezoneId,
                  })
                  .catch(() => {}),
              );
            }
            if (emulationOpts.locale !== undefined || emulationOpts.userAgent !== undefined) {
              const effectiveUa = await resolveEffectiveUserAgent(
                activeSlot?.sessionId ?? null,
                emulationOpts.userAgent,
              );
              const acceptLanguage = buildAcceptLanguage(activeLocale);
              emuOps.push(
                cdpChannel
                  .sendCommand("Emulation.setUserAgentOverride", {
                    userAgent: effectiveUa,
                    ...(acceptLanguage ? { acceptLanguage } : {}),
                  })
                  .catch(() => {}),
              );
            }
            if (emuOps.length > 0) {
              await Promise.all(emuOps);
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
              permissionsMutated = true;
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
              permissionsMutated = true;
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
            await ensureDownloadBehaviorForActiveContext();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let waiterEntry:
              | {
                  resolve: (dl: CompletedCdpDownload) => void;
                  reject: (err: Error) => void;
                }
              | undefined;
            const cleanup = () => {
              if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
              }
              if (waiterEntry) {
                const idx = downloadWaiters.indexOf(waiterEntry);
                if (idx >= 0) downloadWaiters.splice(idx, 1);
                waiterEntry = undefined;
              }
            };
            const downloadPromise = new Promise<CompletedCdpDownload>((resolve, reject) => {
              timer = setTimeout(() => {
                cleanup();
                reject(new Error(`Timed out waiting for download after ${timeoutMs}ms`));
              }, timeoutMs);
              waiterEntry = {
                resolve: (entry) => {
                  cleanup();
                  resolve(entry);
                },
                reject: (err) => {
                  cleanup();
                  reject(err);
                },
              };
              downloadWaiters.push(waiterEntry);
            });
            downloadPromise.catch(() => {});
            let entry: CompletedCdpDownload;
            try {
              await triggerFn();
              entry = await downloadPromise;
            } finally {
              cleanup();
            }
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
            const targetUrl = url ? await resolveUrlAsync(url) : "about:blank";
            const targetRes = (await cdpChannel.sendCommand(
              "Target.createTarget",
              {
                url: targetUrl,
                browserContextId: activeSlot.browserContextId,
              },
              null,
            )) as { targetId: string };
            // Target.setAutoAttach may have already attached & pushed this targetId — reuse it instead of duplicating! (1.26)
            const autoTracked = activeSlot.tabs.find((t) => t.targetId === targetRes.targetId);
            let sessionId = autoTracked?.sessionId;
            if (!sessionId) {
              const attachRes = (await cdpChannel.sendCommand(
                "Target.attachToTarget",
                { targetId: targetRes.targetId, flatten: true },
                null,
              )) as { sessionId: string };
              sessionId = attachRes.sessionId;
            }
            await configureSession(sessionId, options.storageState, true);
            const existingAfter = activeSlot.tabs.find((t) => t.targetId === targetRes.targetId);
            const tabId = existingAfter?.tabId ?? `tab-${nextTabSeq++}`;
            // Deduplicate by targetId so closeTab() never picks a duplicate entry for the closing target
            activeSlot.tabs = [
              ...activeSlot.tabs.filter((t) => t.targetId !== targetRes.targetId),
              { tabId, targetId: targetRes.targetId, sessionId },
            ];
            activeSlot.targetId = targetRes.targetId;
            activeSlot.sessionId = sessionId;
            cdpChannel.setSessionId(sessionId);
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
            activeSlot.tabs = activeSlot.tabs.filter(
              (t) => t.targetId !== closing.targetId && t.sessionId !== closing.sessionId,
            );
            if (activeSlot.tabs.length === 0) {
              // Ensure tab-0 always exists if all entries pointed at the same targetId
              const targetRes = (await cdpChannel.sendCommand(
                "Target.createTarget",
                {
                  url: "about:blank",
                  browserContextId: activeSlot.browserContextId,
                  width: initialWidth,
                  height: initialHeight,
                },
                null,
              )) as { targetId: string };
              const attachRes = (await cdpChannel.sendCommand(
                "Target.attachToTarget",
                { targetId: targetRes.targetId, flatten: true },
                null,
              )) as { sessionId: string };
              await configureSession(attachRes.sessionId, options.storageState, true);
              activeSlot.tabs = [
                {
                  tabId: `tab-${nextTabSeq++}`,
                  targetId: targetRes.targetId,
                  sessionId: attachRes.sessionId,
                },
              ];
            }
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
