import { Effect } from "effect";
import { createPromiseApp, type PromiseApp, type PromiseAppOptions } from "../api/app.js";
import { createPromiseExpect, type PromiseExpectFn } from "../api/expect.js";
import type { WebGpuMode, WebResourceBlockType, WebViewportConfig } from "../schemas/config.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";
import { parseWebHierarchy } from "./playwright-parser.js";
import type {
  BrowserEmulationOptions,
  HttpCredentials,
  RawDriverService,
  VirtualAuthenticatorOptions,
} from "./raw-driver.js";

export interface CreateCdpAppOptions<R extends string = string> {
  /**
   * Reuse an existing Direct CDP browser handle (from `launchDirectCdpBrowser()`) or a CDP URL
   * (`ws://.../devtools/browser/...` or `http://127.0.0.1:9222`).
   * When omitted, Spana launches a dedicated Chromium instance and closes it on `close()`.
   */
  browser?: DirectCdpBrowserHandle | string;
  /** Explicit CDP endpoint URL (alias for passing a string to `browser`). */
  cdpUrl?: string;
  /** Base URL used for relative paths in `app.openLink("/path")` and `app.request`. Default: `"about:blank"`. */
  baseUrl?: string;
  /** Run headless (default: `true`). Only used when launching a new browser. */
  headless?: boolean;
  /** GPU rendering mode (`"auto"` | `"swiftshader"` | `"hardware"` | `"disabled"`). */
  gpu?: WebGpuMode;
  /** Enable WebGPU flags (`--enable-unsafe-webgpu`). */
  webgpu?: boolean;
  /** Explicit Chromium executable path. */
  executablePath?: string;
  /** Extra Chromium CLI arguments. */
  args?: string[];
  /** Enable Chromium OS sandbox (default: `false`, matching Playwright on Linux). */
  chromiumSandbox?: boolean;
  /** Browser launch timeout in ms (default: 30_000). */
  launchTimeout?: number;
  /** CDP `Runtime.evaluate` timeout in ms (default: 10_000). */
  evaluateTimeout?: number;
  /** Default element/assertion wait timeout in ms (default: 5_000). */
  timeout?: number;
  /** Consecutive stable animation frames before pointer actions (`0` for fastest clicks). */
  actionStableFrames?: number;
  /** Viewport dimensions & optional mobile metrics (`deviceScaleFactor`, `mobile`/`isMobile`, `hasTouch`). */
  viewport?: WebViewportConfig;
  /** Device pixel ratio override. */
  deviceScaleFactor?: number;
  /** Emulate mobile device metrics. */
  mobile?: boolean;
  /** Playwright-compatible alias for `mobile`. */
  isMobile?: boolean;
  /** Enable touch event emulation. */
  hasTouch?: boolean;
  /** Browser locale / Accept-Language (e.g. `"sv-SE"`, `"en-US"`). */
  locale?: string;
  /** Explicit User-Agent override. */
  userAgent?: string;
  /** IANA timezone ID (e.g. `"Europe/Stockholm"`). */
  timezoneId?: string;
  /** Emulate `prefers-color-scheme`. */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Emulate `prefers-reduced-motion`. */
  reducedMotion?: "reduce" | "no-preference";
  /** HTTP Basic/Digest authentication credentials. */
  httpCredentials?: HttpCredentials;
  /** Optional Playwright-compatible storageState JSON path. */
  storageState?: string;
  /** Navigation wait condition (`"domcontentloaded"` | `"load"` | `"networkidle"` | `"commit"`). */
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  /** Collapse CSS animations/transitions to 0.001ms. */
  instantAnimations?: boolean;
  /** Abort specified resource types before hitting the network. */
  blockResources?: WebResourceBlockType[];
  /** Automatically attach a CDP WebAuthn virtual authenticator. */
  virtualAuthenticator?: boolean | VirtualAuthenticatorOptions;
  /** Context isolation mode when calling `beginFlow()` between tests (`"hot-cache"` | `"fresh"`). */
  contextIsolation?: "fresh" | "hot-cache";
  /** Enable context reset in `beginFlow()` (default: `true`). */
  freshContextPerFlow?: boolean;
  /** Optional JS expression evaluated before fail-fast idle checks. */
  readyExpression?: string;
  /** Additional options forwarded to `createPromiseApp()`. */
  appOptions?: PromiseAppOptions<R>;
}

export interface DirectCdpAppHandle<T extends string = string, R extends string = string> {
  /** Full Spana Promise-based browser API (`openLink`, `tap`, `fill`, `route`, `evaluate`, `cdp`, ...). */
  readonly app: PromiseApp<T, R>;
  /** Spana auto-retrying assertion API (`expect(selector).toBeVisible()`, `toPassAccessibilityAudit()`, ...). */
  readonly expect: PromiseExpectFn<T>;
  /** Underlying driver service (rarely needed directly). */
  readonly driver: RawDriverService<T, R>;
  /** Owned browser handle (undefined when attached to an external browser/URL). */
  readonly browser?: DirectCdpBrowserHandle;
  /** Reset cookies, storage, routes, viewport, and emulation cleanly between tests in `bun:test` / `vitest`. */
  readonly beginFlow: (flowName?: string) => Promise<void>;
  /** Dispose the browser context/session (and close the Chromium process if owned by this handle). */
  readonly close: () => Promise<void>;
  /** Enables `await using session = await createCdpApp(...)`. */
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Promise-only Direct CDP embedding helper for `bun:test`, `vitest`, Node scripts, and
 * standalone suites that do NOT depend on `effect` or Spana's flow runner.
 *
 * Launches (or attaches to) Chromium over Direct CDP with an isolated `BrowserContext`
 * and returns `{ app, expect, beginFlow, close }`.
 */
export async function createCdpApp<T extends string = string, R extends string = string>(
  options: CreateCdpAppOptions<R> = {},
): Promise<DirectCdpAppHandle<T, R>> {
  let ownedBrowser: DirectCdpBrowserHandle | undefined;
  let cdpUrl = options.cdpUrl;

  if (!cdpUrl && options.browser) {
    cdpUrl = typeof options.browser === "string" ? options.browser : options.browser.browserWsUrl;
  }

  if (!cdpUrl) {
    ownedBrowser = await launchDirectCdpBrowser({
      executablePath: options.executablePath,
      headless: options.headless ?? true,
      chromiumSandbox: options.chromiumSandbox,
      gpu: options.gpu,
      webgpu: options.webgpu,
      args: options.args,
      launchTimeout: options.launchTimeout,
    });
    cdpUrl = ownedBrowser.browserWsUrl;
  }

  const emulation: BrowserEmulationOptions | undefined =
    options.colorScheme !== undefined ||
    options.reducedMotion !== undefined ||
    options.locale !== undefined ||
    options.timezoneId !== undefined ||
    options.userAgent !== undefined
      ? {
          colorScheme: options.colorScheme,
          reducedMotion: options.reducedMotion,
          locale: options.locale,
          timezoneId: options.timezoneId,
          userAgent: options.userAgent,
        }
      : undefined;

  const baseUrl = options.baseUrl ?? "about:blank";
  const cleanups: Array<() => Promise<void>> = [];

  let driver: RawDriverService;
  try {
    driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl,
        baseUrl,
        engineLabel: "cdp",
        viewport: options.viewport,
        deviceScaleFactor: options.deviceScaleFactor,
        mobile: options.mobile,
        isMobile: options.isMobile,
        hasTouch: options.hasTouch,
        httpCredentials: options.httpCredentials,
        evaluateTimeout: options.evaluateTimeout,
        useBrowserContexts: true,
        freshContextPerFlow: options.freshContextPerFlow ?? true,
        contextIsolation: options.contextIsolation ?? "hot-cache",
        waitUntil: options.waitUntil ?? "domcontentloaded",
        instantAnimations: options.instantAnimations,
        blockResources: options.blockResources,
        virtualAuthenticator: options.virtualAuthenticator,
        storageState: options.storageState,
        emulation,
        sanitizeHeadlessUserAgent: !(
          options.headless === false || options.args?.some((a) => /^--user-agent(?:=|$)/i.test(a))
        ),
        readyExpression: options.readyExpression,
      }),
    );
  } catch (err) {
    if (ownedBrowser) {
      await ownedBrowser.close().catch(() => {});
    }
    throw err;
  }

  const coordConfig: CoordinatorConfig = {
    parse: parseWebHierarchy,
    platform: "web",
    defaults: {
      timeout: options.timeout ?? 5_000,
      platform: "web",
      ...(options.actionStableFrames !== undefined
        ? { actionStableFrames: options.actionStableFrames }
        : {}),
    },
    screenWidth: options.viewport?.width ?? 1280,
    screenHeight: options.viewport?.height ?? 720,
  };

  const typedDriver = driver as RawDriverService<T, R>;
  const app = createPromiseApp<T, R>(typedDriver, baseUrl, coordConfig, undefined, {
    platform: "web",
    ...options.appOptions,
    onRegisterCleanup: (fn) => {
      cleanups.push(fn);
      options.appOptions?.onRegisterCleanup?.(fn);
    },
  });
  const expect = createPromiseExpect<T, R>(typedDriver, coordConfig);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups.splice(0).toReversed()) {
      await fn().catch(() => {});
    }
    await Effect.runPromise(driver.killApp("")).catch(() => {});
    if (ownedBrowser) {
      await ownedBrowser.close().catch(() => {});
    }
  };

  return {
    app,
    expect,
    driver: typedDriver,
    ...(ownedBrowser ? { browser: ownedBrowser } : {}),
    beginFlow: async (flowName = "embedded-flow") => {
      if (driver.beginFlow) {
        await Effect.runPromise(driver.beginFlow(flowName));
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** Alias for `createCdpApp` for Playwright-style `launchDirectCdpPage` ergonomics. */
export const launchDirectCdpPage: <T extends string = string, R extends string = string>(
  options?: CreateCdpAppOptions<R>,
) => Promise<DirectCdpAppHandle<T, R>> = createCdpApp;
