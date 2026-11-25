import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type {
  RawDriverService,
  LaunchOptions,
  BrowserCookie,
  BrowserMockResponse,
  BrowserNetworkConditions,
  BrowserResponseInfo,
  BrowserRouteMatcher,
  BrowserHAR,
  BrowserConsoleLog,
  BrowserJSError,
  CdpSessionHandle,
  TouchSequence,
  VirtualAuthenticatorOptions,
  VirtualCredential,
  VirtualCredentialInput,
} from "../drivers/raw-driver.js";
import { mergeLaunchOptions } from "../drivers/launch-options.js";
import type {
  BiometricOptions,
  Geolocation,
  Orientation,
  PermissionOptions,
  PushPayload,
} from "../drivers/device-controls.js";
import type { StorybookConfig } from "../schemas/config.js";
import {
  inFrame,
  type ExtendedSelector,
  type Selector,
  type Platform,
} from "../schemas/selector.js";
import {
  createCoordinator,
  type BackUntilVisibleOptions,
  type DismissKeyboardOptions,
  type Direction,
  type CoordinatorConfig,
  type ScrollUntilVisibleOptions,
} from "../smart/coordinator.js";
import { waitForElement, type WaitOptions } from "../smart/auto-wait.js";
import type { StepRecorder } from "../core/step-recorder.js";
import { buildStorybookUrl, type StorybookOpenOptions } from "./storybook.js";
import {
  createPromiseExpect,
  type FlowContext as ExpectFlowContext,
  type PromiseExpectation,
  type PromiseExpectFn,
} from "./expect.js";
import type {
  DomClearStorageOptions,
  DomIdleOptions,
  DomStorageEntries,
} from "../channels/dom-channel.js";

export type {
  BackUntilVisibleOptions,
  DismissKeyboardOptions,
  ScrollUntilVisibleOptions,
} from "../smart/coordinator.js";
export type {
  BrowserConsoleLog,
  BrowserCookie,
  BrowserHAR,
  BrowserJSError,
  BrowserResponseInfo,
  CdpSessionHandle,
  VirtualAuthenticatorOptions,
  VirtualCredential,
  VirtualCredentialInput,
} from "../drivers/raw-driver.js";
export type { StorybookOpenOptions } from "./storybook.js";

export interface BrowserRequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface BrowserRequestResponse<T = unknown> {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  headers: Headers;
  data: T;
  text(): Promise<string>;
  json<U = T>(): Promise<U>;
}

/**
 * Cookie-sharing HTTP API client attached to `app.request` (Playwright `context.request` equivalent).
 * Automatically sends the browser context's cookies and syncs `Set-Cookie` headers back into the browser.
 */
export interface BrowserRequestClient {
  fetch<T = unknown>(
    url: string,
    init?: BrowserRequestOptions & { method?: string },
  ): Promise<BrowserRequestResponse<T>>;
  get<T = unknown>(url: string, opts?: BrowserRequestOptions): Promise<BrowserRequestResponse<T>>;
  post<T = unknown>(
    url: string,
    body?: unknown,
    opts?: BrowserRequestOptions,
  ): Promise<BrowserRequestResponse<T>>;
  put<T = unknown>(
    url: string,
    body?: unknown,
    opts?: BrowserRequestOptions,
  ): Promise<BrowserRequestResponse<T>>;
  patch<T = unknown>(
    url: string,
    body?: unknown,
    opts?: BrowserRequestOptions,
  ): Promise<BrowserRequestResponse<T>>;
  delete<T = unknown>(
    url: string,
    opts?: BrowserRequestOptions,
  ): Promise<BrowserRequestResponse<T>>;
}

/** A second isolated browser context spawned inside a flow via `app.newContext()`. Auto-closed on flow exit. */
export interface IsolatedBrowserContext<T extends string = string, R extends string = string> {
  app: PromiseApp<T, R>;
  expect: PromiseExpectFn<T>;
  close(): Promise<void>;
}

/** Frame-scoped helper returned by `app.frame(frameSelector)` (Playwright `frameLocator` equivalent). */
export interface FrameScope<T extends string = string> {
  tap(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  doubleTap(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  longPress(selector: Selector<T>, opts?: { duration?: number } & WaitOptions): Promise<void>;
  hover(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  fill(selector: Selector<T>, value: string, opts?: WaitOptions): Promise<void>;
  uploadFile(selector: Selector<T>, path: string | string[]): Promise<void>;
  getText(selector: Selector<T>, opts?: WaitOptions): Promise<string>;
  getAttribute(
    selector: Selector<T>,
    name: string,
    opts?: WaitOptions,
  ): Promise<string | undefined>;
  isVisible(selector: Selector<T>, opts?: { timeout?: number }): Promise<boolean>;
  isEnabled(selector: Selector<T>, opts?: WaitOptions): Promise<boolean>;
  expect(selector: Selector<T>): PromiseExpectation<T>;
}

export interface PromiseApp<T extends string = string, R extends string = string> {
  tap(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  tapXY(x: number, y: number): Promise<void>;
  doubleTap(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  longPress(
    selector: ExtendedSelector<T>,
    opts?: { duration?: number } & WaitOptions,
  ): Promise<void>;
  longPressXY(x: number, y: number, opts?: { duration?: number }): Promise<void>;
  /** Move pointer over an actionable element (triggers hover tooltips/menus). */
  hover(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  inputText(text: string): Promise<void>;
  /** Atomic 1-round-trip form fill: waits for actionability, focuses, replaces value, and dispatches input/change. */
  fill(selector: ExtendedSelector<T>, value: string, opts?: WaitOptions): Promise<void>;
  pressKey(key: string): Promise<void>;
  hideKeyboard(): Promise<void>;
  dismissKeyboard(opts?: DismissKeyboardOptions): Promise<void>;
  swipe(direction: Direction, opts?: { duration?: number }): Promise<void>;
  scroll(direction: Direction): Promise<void>;
  scrollUntilVisible(
    selector: ExtendedSelector<T>,
    opts?: ScrollUntilVisibleOptions<T>,
  ): Promise<void>;
  backUntilVisible(selector: ExtendedSelector<T>, opts?: BackUntilVisibleOptions<T>): Promise<void>;
  launch(opts?: LaunchOptions<R>): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  clearState(): Promise<void>;
  openLink(url: R): Promise<void>;
  openStory(storyId: string, opts?: StorybookOpenOptions): Promise<void>;
  back(): Promise<void>;
  /** Reload the current page and wait for navigation readiness. */
  reload(opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<void>;
  /** Return the current page URL. */
  url(): Promise<string>;
  /** Wait until the current page URL matches a substring/exact string or RegExp. */
  waitForURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Wait for an HTTP response matching a URL substring, RegExp, or predicate. */
  waitForResponse(
    matcher: BrowserRouteMatcher | ((res: BrowserResponseInfo) => boolean),
    opts?: { timeout?: number },
  ): Promise<BrowserResponseInfo>;
  takeScreenshot(name?: string): Promise<Uint8Array>;
  evaluate<Result = unknown>(
    fn: ((...args: any[]) => Result) | string,
    ...args: any[]
  ): Promise<Result>;
  mockNetwork(matcher: BrowserRouteMatcher, response: BrowserMockResponse): Promise<void>;
  setGeolocation(point: Geolocation): Promise<void>;
  setSystemTime(time: Date | number | string): Promise<void>;
  grantPermission(permission: string, options?: PermissionOptions): Promise<void>;
  denyPermission(permission: string, options?: PermissionOptions): Promise<void>;
  setOrientation(orientation: Orientation): Promise<void>;
  setBiometricEnrollment(enabled: boolean): Promise<void>;
  simulateBiometric(options: BiometricOptions): Promise<void>;
  sendPushNotification(payload: PushPayload): Promise<void>;
  blockNetwork(matcher: BrowserRouteMatcher): Promise<void>;
  clearNetworkMocks(): Promise<void>;
  setNetworkConditions(conditions: BrowserNetworkConditions): Promise<void>;
  /** Convenience toggle for browser offline mode (works on Chromium, Firefox, and WebKit). */
  setOffline(offline: boolean): Promise<void>;
  saveCookies(path: string): Promise<void>;
  loadCookies(path: string): Promise<void>;
  /** Read cookies from the active browser context (optionally filtered by URLs). */
  getCookies(urls?: string[]): Promise<BrowserCookie[]>;
  /** Add or update cookies in the active browser context. */
  setCookies(cookies: BrowserCookie[]): Promise<void>;
  /** Clear all cookies in the active browser context. */
  clearCookies(): Promise<void>;
  saveAuthState(path: string): Promise<void>;
  loadAuthState(path: string): Promise<void>;
  downloadFile(path: string): Promise<void>;
  uploadFile(selector: Selector<T>, path: string | string[]): Promise<void>;
  newTab(url?: R): Promise<string>;
  switchToTab(index: number): Promise<void>;
  closeTab(): Promise<void>;
  getTabIds(): Promise<string[]>;
  getConsoleLogs(): Promise<BrowserConsoleLog[]>;
  getJSErrors(): Promise<BrowserJSError[]>;
  getHAR(): Promise<BrowserHAR>;
  /** Cookie-sharing API request client (Playwright `context.request` equivalent). */
  readonly request: BrowserRequestClient;
  /** Spawn a second isolated browser context inside this flow (auto-closed when flow ends). */
  newContext(opts?: { url?: string }): Promise<IsolatedBrowserContext<T, R>>;
  /** Scope all subsequent selectors/actions/assertions inside a matching iframe (`frameLocator` equivalent). */
  frame(frameSelector: Selector<T>): FrameScope<T>;
  /** Escape hatch: access the underlying Playwright `Page` (or CDP session) on web runs. */
  getPage<PageType = unknown>(): PageType;
  /** Raw Chrome DevTools Protocol session handle (available on both Direct CDP and Playwright Chromium). */
  cdp(): CdpSessionHandle;
  /** Enable a CDP WebAuthn virtual authenticator (passkey / platform authenticator) for this context. */
  enableVirtualAuthenticator(opts?: VirtualAuthenticatorOptions): Promise<string>;
  /** Remove an active virtual WebAuthn authenticator (defaults to the latest enabled one). */
  removeVirtualAuthenticator(authenticatorId?: string): Promise<void>;
  /** List credentials stored inside the active virtual WebAuthn authenticator. */
  getVirtualCredentials(authenticatorId?: string): Promise<VirtualCredential[]>;
  /** Import an existing WebAuthn passkey credential into the active virtual authenticator (CDP `WebAuthn.addCredential`). */
  addVirtualCredential(credential: VirtualCredentialInput, authenticatorId?: string): Promise<void>;
  /** Clear all credentials stored inside the active virtual WebAuthn authenticator. */
  clearVirtualCredentials(authenticatorId?: string): Promise<void>;

  pinch(
    selector: ExtendedSelector<T>,
    opts?: { scale?: number; duration?: number } & WaitOptions,
  ): Promise<void>;
  zoom(
    selector: ExtendedSelector<T>,
    opts?: { scale?: number; duration?: number } & WaitOptions,
  ): Promise<void>;
  multiTouch(sequences: TouchSequence[]): Promise<void>;

  getText(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<string>;
  getAttribute(
    selector: ExtendedSelector<T>,
    name: string,
    opts?: WaitOptions,
  ): Promise<string | undefined>;
  isVisible(selector: ExtendedSelector<T>, opts?: { timeout?: number }): Promise<boolean>;
  isEnabled(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<boolean>;

  // Web-first bridge & fast state helpers (works across web, Capacitor, Electron, Electrobun)
  /** Wait for in-flight fetch/XHR, animations, and framework renders to settle via spana-bridge. */
  waitForIdle(opts?: DomIdleOptions): Promise<void>;
  /** Inject storage/auth state directly through the DOM bridge (avoids slow UI login flows). */
  setStorage(entries: DomStorageEntries): Promise<void>;
  /** Clear localStorage, sessionStorage, cookies, IndexedDB, and Capacitor Preferences. */
  clearStorage(opts?: DomClearStorageOptions): Promise<void>;
  /** Fast reset: clear storage via bridge and reload in milliseconds (avoids uninstall/reinstall). */
  resetFast(): Promise<void>;

  // WebView / hybrid context switching (low-level escape hatches — normal flows hide channels)
  /** @internal Low-level escape hatch: list available contexts (e.g. ["NATIVE_APP", "WEBVIEW_..."]). */
  getContexts(): Promise<string[]>;
  /** @internal Low-level escape hatch: get the current context ID. */
  getCurrentContext(): Promise<string>;
  /** @internal Low-level escape hatch: switch to a specific context by ID. */
  switchToContext(contextId: string): Promise<void>;
  /** @internal Low-level escape hatch: switch to the first available WebView context. */
  switchToWebView(): Promise<void>;
  /** @internal Low-level escape hatch: switch back to the native app context. */
  switchToNativeApp(): Promise<void>;
}

export interface PromiseAppOptions<R extends string = string> {
  platform?: Platform;
  storybook?: StorybookConfig;
  launchOptions?: LaunchOptions<R>;
  /** Register an automatic teardown hook executed when the owning flow finishes (used by `app.newContext()`). */
  onRegisterCleanup?: (fn: () => Promise<void>) => void;
  /** Flow metadata forwarded to `expect` inside `app.frame()` and `app.newContext()`. */
  flowContext?: ExpectFlowContext;
  visualRegression?: {
    threshold?: number;
    maxDiffPixelRatio?: number;
    baselinesDir?: string;
  };
}

const describeMatcher = (matcher: BrowserRouteMatcher) =>
  typeof matcher === "string" ? matcher : matcher.toString();

function formatEvaluateCommand(fn: ((...args: any[]) => unknown) | string): string {
  const raw = typeof fn === "string" ? fn : fn.toString();
  const compact = raw.replaceAll(/\s+/g, " ").trim();
  const snippet = compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
  return `evaluate(${snippet})`;
}

function parseSetCookieHeader(headerValue: string, originUrl: URL): BrowserCookie | null {
  const parts = headerValue.split(";").map((p) => p.trim());
  const first = parts[0];
  if (!first) return null;
  const eqIdx = first.indexOf("=");
  if (eqIdx <= 0) return null;
  const name = first.slice(0, eqIdx).trim();
  const value = first.slice(eqIdx + 1).trim();
  const cookie: BrowserCookie = {
    name,
    value,
    url: `${originUrl.origin}/`,
    path: "/",
  };
  for (const attr of parts.slice(1)) {
    const [rawK, ...rest] = attr.split("=");
    const k = (rawK ?? "").trim().toLowerCase();
    const v = rest.join("=").trim();
    if (k === "path" && v) cookie.path = v;
    else if (k === "domain" && v) {
      cookie.domain = v;
      delete cookie.url;
    } else if (k === "httponly") cookie.httpOnly = true;
    else if (k === "secure") cookie.secure = true;
    else if (k === "samesite") {
      const norm = v.toLowerCase();
      if (norm === "strict") cookie.sameSite = "Strict";
      else if (norm === "lax") cookie.sameSite = "Lax";
      else if (norm === "none") cookie.sameSite = "None";
    } else if (k === "max-age") {
      const sec = Number.parseInt(v, 10);
      if (Number.isFinite(sec)) cookie.expires = Math.floor(Date.now() / 1000) + sec;
    } else if (k === "expires") {
      const ts = Date.parse(v);
      if (Number.isFinite(ts)) cookie.expires = Math.floor(ts / 1000);
    }
  }
  return cookie;
}

const RECORDED_RAW_PAGE_METHODS = new Set([
  "goto",
  "reload",
  "click",
  "dblclick",
  "fill",
  "hover",
  "press",
  "type",
  "check",
  "uncheck",
  "selectOption",
  "setInputFiles",
  "waitForURL",
  "waitForResponse",
  "waitForSelector",
  "evaluate",
]);

function wrapRawPageWithStepRecording<PageType>(
  rawPage: PageType,
  recorder?: StepRecorder,
): PageType {
  if (!recorder || !rawPage || typeof rawPage !== "object") return rawPage;
  const candidate = rawPage as Record<string, unknown>;
  // Only proxy Playwright-like Page objects (leave direct CDP descriptor objects untouched)
  if (typeof candidate["goto"] !== "function" || typeof candidate["click"] !== "function") {
    return rawPage;
  }
  return new Proxy(candidate, {
    get(target, prop, receiver) {
      if (prop === "then") return undefined;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && RECORDED_RAW_PAGE_METHODS.has(prop)) {
        return (...callArgs: unknown[]) => {
          const argHint =
            typeof callArgs[0] === "string"
              ? callArgs[0].length > 60
                ? `${callArgs[0].slice(0, 57)}...`
                : callArgs[0]
              : undefined;
          const cmd = argHint ? `page.${prop}(${JSON.stringify(argHint)})` : `page.${prop}`;
          return recorder.runStep(cmd, () => Promise.resolve(value.apply(target, callArgs)), {
            captureScreenshot: false,
          });
        };
      }
      return value.bind(target);
    },
  }) as unknown as PageType;
}

export function createPromiseApp<T extends string = string, R extends string = string>(
  driver: RawDriverService<T, R>,
  appId: string,
  config: CoordinatorConfig,
  recorder?: StepRecorder,
  options: PromiseAppOptions<R> = {},
): PromiseApp<T, R> {
  const coord = createCoordinator<T, R>(driver, config);
  const platform =
    options.platform ??
    (appId.startsWith("http://") || appId.startsWith("https://") ? "web" : undefined);

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const unsupportedWebFeature = (feature: string) =>
    Effect.fail(new DriverError({ message: `${feature}() is only supported on the web platform` }));

  const optionalMethod = <A extends any[], Ret>(
    name: string,
    method: ((...args: A) => Effect.Effect<Ret, DriverError>) | undefined,
  ): ((...args: A) => Effect.Effect<Ret, DriverError>) =>
    method ?? ((..._args: A) => unsupportedWebFeature(name));

  const unsupportedNetworkFeature = async (name: string): Promise<never> => {
    const target = platform ?? (await run(driver.getDeviceInfo())).platform;
    throw new DriverError({
      message: `${name}() is not supported on ${target} with the current driver`,
    });
  };

  const runStep = <A>(
    command: string,
    action: () => Promise<A>,
    opts?: { selector?: unknown; captureScreenshot?: boolean },
  ) => (recorder ? recorder.runStep(command, action, opts) : action());

  const runDeviceStep = <A extends unknown[]>(
    name: string,
    method: ((...args: A) => Effect.Effect<void, DriverError>) | undefined,
    ...args: A
  ) =>
    runStep(name, async () => {
      if (!method) {
        const target = platform ?? (await run(driver.getDeviceInfo())).platform;
        throw new DriverError({ message: `${name}() is not supported on ${target}` });
      }
      await run(method(...args));
    });

  const runScreenshotStep = (
    command: string,
    action: () => Promise<Uint8Array>,
    opts?: { selector?: unknown; name?: string },
  ) => (recorder ? recorder.runScreenshotStep(command, action, opts) : action());

  const getCurrentUrl = async (): Promise<string> => {
    if (driver.getUrl) {
      return run(driver.getUrl());
    }
    return run(
      driver
        .evaluate<string>(
          "typeof window !== 'undefined' && window.location ? String(window.location.href || '') : ''",
        )
        .pipe(Effect.catchAll(() => Effect.succeed(""))),
    );
  };

  const resolveRequestUrl = async (rawUrl: string): Promise<URL> => {
    if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
      return new URL(rawUrl);
    }
    const pageUrl = await getCurrentUrl();
    const base =
      pageUrl && (pageUrl.startsWith("http://") || pageUrl.startsWith("https://"))
        ? pageUrl
        : appId.startsWith("http://") || appId.startsWith("https://")
          ? appId
          : "http://localhost";
    return new URL(rawUrl, base);
  };

  const performBrowserRequest = async <Res = unknown>(
    method: string,
    rawUrl: string,
    init?: BrowserRequestOptions,
  ): Promise<BrowserRequestResponse<Res>> => {
    const targetUrl = await resolveRequestUrl(rawUrl);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) targetUrl.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { ...init?.headers };
    const hasCookieHeader = Object.keys(headers).some((k) => k.toLowerCase() === "cookie");
    if (!hasCookieHeader && driver.getCookies) {
      const cookies = await run(driver.getCookies([targetUrl.toString()])).catch(() => []);
      if (cookies.length > 0) {
        headers["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    }

    let requestBody: string | undefined;
    if (init?.body !== undefined) {
      if (typeof init.body === "string") {
        requestBody = init.body;
      } else {
        requestBody = JSON.stringify(init.body);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    }

    const res = await fetch(targetUrl.toString(), {
      method,
      headers,
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });

    // Sync any Set-Cookie headers back into the browser context
    if (driver.setCookies) {
      const rawSetCookies: string[] =
        typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie ===
        "function"
          ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
          : res.headers.get("set-cookie")
            ? [res.headers.get("set-cookie")!]
            : [];
      const parsedCookies = rawSetCookies
        .map((line) => parseSetCookieHeader(line, targetUrl))
        .filter((c): c is BrowserCookie => c !== null);
      if (parsedCookies.length > 0) {
        await run(driver.setCookies(parsedCookies)).catch(() => {});
      }
    }

    const rawText = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let data: unknown = rawText;
    if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }
    } else if (rawText.trim().startsWith("{") || rawText.trim().startsWith("[")) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = rawText;
      }
    }

    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      url: res.url || targetUrl.toString(),
      headers: res.headers,
      data: data as Res,
      text: async () => rawText,
      json: async <U = Res>() => JSON.parse(rawText) as U,
    };
  };

  const requestClient: BrowserRequestClient = {
    fetch: <Res = unknown>(url: string, init?: BrowserRequestOptions & { method?: string }) => {
      const method = (init?.method ?? "GET").toUpperCase();
      return runStep(`request.${method}(${url})`, () =>
        performBrowserRequest<Res>(method, url, init),
      );
    },
    get: <Res = unknown>(url: string, opts?: BrowserRequestOptions) =>
      runStep(`request.GET(${url})`, () => performBrowserRequest<Res>("GET", url, opts)),
    post: <Res = unknown>(url: string, body?: unknown, opts?: BrowserRequestOptions) =>
      runStep(`request.POST(${url})`, () =>
        performBrowserRequest<Res>("POST", url, { ...opts, body }),
      ),
    put: <Res = unknown>(url: string, body?: unknown, opts?: BrowserRequestOptions) =>
      runStep(`request.PUT(${url})`, () =>
        performBrowserRequest<Res>("PUT", url, { ...opts, body }),
      ),
    patch: <Res = unknown>(url: string, body?: unknown, opts?: BrowserRequestOptions) =>
      runStep(`request.PATCH(${url})`, () =>
        performBrowserRequest<Res>("PATCH", url, { ...opts, body }),
      ),
    delete: <Res = unknown>(url: string, opts?: BrowserRequestOptions) =>
      runStep(`request.DELETE(${url})`, () => performBrowserRequest<Res>("DELETE", url, opts)),
  };

  const appExpect = createPromiseExpect<T, R>(
    driver,
    config,
    recorder,
    options.flowContext,
    options.visualRegression,
  );

  const appObj: PromiseApp<T, R> = {
    setGeolocation: (point) => runDeviceStep("setGeolocation", driver.setGeolocation, point),
    setSystemTime: (time) => runDeviceStep("setSystemTime", driver.setSystemTime, time),
    grantPermission: (permission, opts) =>
      runDeviceStep("grantPermission", driver.setPermission, appId, permission, "grant", opts),
    denyPermission: (permission, opts) =>
      runDeviceStep("denyPermission", driver.setPermission, appId, permission, "deny", opts),
    setOrientation: (orientation) =>
      runDeviceStep("setOrientation", driver.setOrientation, orientation),
    setBiometricEnrollment: (enabled) =>
      runDeviceStep("setBiometricEnrollment", driver.setBiometricEnrollment, enabled),
    simulateBiometric: (opts) => runDeviceStep("simulateBiometric", driver.simulateBiometric, opts),
    sendPushNotification: (payload) =>
      runDeviceStep("sendPushNotification", driver.sendPushNotification, appId, payload),
    tap: (selector, opts) =>
      runStep("tap", () => run(coord.tap(selector, opts)), { selector, captureScreenshot: true }),
    tapXY: (x, y) =>
      runStep("tapXY", () => run(coord.tapXY(x, y)), {
        selector: { point: { x, y } },
        captureScreenshot: true,
      }),
    doubleTap: (selector, opts) =>
      runStep("doubleTap", () => run(coord.doubleTap(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    longPress: (selector, opts) =>
      runStep("longPress", () => run(coord.longPress(selector, opts?.duration, opts)), {
        selector,
        captureScreenshot: true,
      }),
    longPressXY: (x, y, opts) =>
      runStep("longPressXY", () => run(coord.longPressXY(x, y, opts?.duration)), {
        selector: { point: { x, y } },
        captureScreenshot: true,
      }),
    hover: (selector, opts) =>
      runStep("hover", () => run(coord.hover(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    inputText: (text) =>
      runStep("inputText", () => run(coord.inputText(text)), { captureScreenshot: true }),
    fill: (selector, value, opts) =>
      runStep("fill", () => run(coord.fill(selector, value, opts)), {
        selector,
        captureScreenshot: true,
      }),
    pressKey: (key) =>
      runStep(`pressKey(${key})`, () => run(coord.pressKey(key)), { captureScreenshot: true }),
    hideKeyboard: () =>
      runStep("hideKeyboard", () => run(coord.hideKeyboard()), { captureScreenshot: true }),
    dismissKeyboard: (opts) =>
      runStep(
        `dismissKeyboard(${opts?.strategy ?? "auto"})`,
        () => run(coord.dismissKeyboard(opts)),
        {
          selector: { strategy: opts?.strategy ?? "auto" },
          captureScreenshot: true,
        },
      ),
    swipe: (direction, opts) =>
      runStep(`swipe(${direction})`, () => run(coord.swipe(direction, opts)), {
        captureScreenshot: true,
      }),
    scroll: (direction) =>
      runStep(`scroll(${direction})`, () => run(coord.scroll(direction)), {
        captureScreenshot: true,
      }),
    scrollUntilVisible: (selector, opts) =>
      runStep(
        `scrollUntilVisible(${opts?.direction ?? "down"})`,
        () => run(coord.scrollUntilVisible(selector, opts)),
        {
          selector: {
            target: selector,
            ...opts,
            direction: opts?.direction ?? "down",
            maxScrolls: opts?.maxScrolls ?? 5,
          },
          captureScreenshot: true,
        },
      ),
    backUntilVisible: (selector, opts) =>
      runStep(
        `backUntilVisible(${opts?.maxBacks ?? 3})`,
        () => run(coord.backUntilVisible(selector, opts)),
        {
          selector: {
            target: selector,
            ...opts,
            maxBacks: opts?.maxBacks ?? 3,
          },
          captureScreenshot: true,
        },
      ),
    launch: (opts) => {
      const mergedLaunchOptions = mergeLaunchOptions(options.launchOptions, opts);
      return runStep("launch", () => run(driver.launchApp(appId, mergedLaunchOptions)), {
        selector: mergedLaunchOptions,
        captureScreenshot: true,
      });
    },
    stop: () => runStep("stop", () => run(driver.stopApp(appId)), { captureScreenshot: true }),
    kill: () => runStep("kill", () => run(driver.killApp(appId)), { captureScreenshot: true }),
    clearState: () =>
      runStep("clearState", () => run(driver.clearAppState(appId)), { captureScreenshot: true }),
    openLink: (url) =>
      runStep("openLink", () => run(driver.openLink(url)), {
        selector: { url },
        captureScreenshot: true,
      }),
    openStory: (storyId, opts) =>
      runStep(
        `openStory(${storyId})`,
        async () => {
          if (platform !== "web") {
            await run(unsupportedWebFeature("openStory"));
            return;
          }

          const url = buildStorybookUrl(storyId, opts, {
            appBaseUrl: appId,
            storybook: options.storybook,
          });
          await run(driver.openLink(url));
        },
        {
          selector: {
            storyId,
            viewMode: opts?.viewMode ?? "story",
            args: opts?.args,
            globals: opts?.globals,
            baseUrl: opts?.baseUrl,
          },
          captureScreenshot: true,
        },
      ),
    back: () => runStep("back", () => run(driver.back()), { captureScreenshot: true }),
    reload: (opts) =>
      runStep(
        "reload",
        async () => {
          if (driver.reload) {
            await run(driver.reload(opts));
            return;
          }
          if (driver.domChannel?.reload) {
            await driver.domChannel.reload();
            return;
          }
          await run(driver.evaluate("window.location.reload()"));
        },
        { captureScreenshot: true },
      ),
    url: () => runStep("url", () => getCurrentUrl()),
    waitForURL: (expected, opts) =>
      runStep(
        `waitForURL(${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)})`,
        () => run(coord.waitForURL(expected, opts)),
      ),
    waitForResponse: (matcher, opts) =>
      runStep(
        `waitForResponse(${typeof matcher === "function" ? "<predicate>" : describeMatcher(matcher)})`,
        () => run(optionalMethod("waitForResponse", driver.waitForResponse)(matcher, opts)),
      ),
    takeScreenshot: (name) =>
      runScreenshotStep(
        name ? `takeScreenshot(${name})` : "takeScreenshot",
        () => run(driver.takeScreenshot()),
        { name },
      ),
    evaluate: <Result = unknown>(fn: ((...args: any[]) => Result) | string, ...args: any[]) =>
      runStep(
        formatEvaluateCommand(fn),
        () => run(driver.evaluate(fn as any, ...args)) as Promise<Result>,
      ),
    mockNetwork: (matcher, response) =>
      runStep(
        "mockNetwork",
        () =>
          driver.mockNetwork
            ? run(driver.mockNetwork(matcher, response))
            : unsupportedNetworkFeature("mockNetwork"),
        {
          selector: { matcher: describeMatcher(matcher), response },
        },
      ),
    blockNetwork: (matcher) =>
      runStep(
        "blockNetwork",
        () =>
          driver.blockNetwork
            ? run(driver.blockNetwork(matcher))
            : unsupportedNetworkFeature("blockNetwork"),
        {
          selector: { matcher: describeMatcher(matcher) },
        },
      ),
    clearNetworkMocks: () =>
      runStep("clearNetworkMocks", () =>
        driver.clearNetworkMocks
          ? run(driver.clearNetworkMocks())
          : unsupportedNetworkFeature("clearNetworkMocks"),
      ),
    setNetworkConditions: (conditions) =>
      runStep(
        "setNetworkConditions",
        () => run(optionalMethod("setNetworkConditions", driver.setNetworkConditions)(conditions)),
        { selector: conditions },
      ),
    setOffline: (offline) =>
      runStep(
        `setOffline(${offline})`,
        () => run(optionalMethod("setOffline", driver.setNetworkConditions)({ offline })),
        { selector: { offline } },
      ),
    saveCookies: (path) =>
      runStep("saveCookies", () => run(optionalMethod("saveCookies", driver.saveCookies)(path)), {
        selector: { path },
      }),
    loadCookies: (path) =>
      runStep("loadCookies", () => run(optionalMethod("loadCookies", driver.loadCookies)(path)), {
        selector: { path },
      }),
    getCookies: (urls) =>
      runStep("getCookies", () => run(optionalMethod("getCookies", driver.getCookies)(urls))),
    setCookies: (cookies) =>
      runStep("setCookies", () => run(optionalMethod("setCookies", driver.setCookies)(cookies)), {
        selector: { count: cookies.length },
      }),
    clearCookies: () =>
      runStep("clearCookies", () => run(optionalMethod("clearCookies", driver.clearCookies)())),
    saveAuthState: (path) =>
      runStep(
        "saveAuthState",
        () => run(optionalMethod("saveAuthState", driver.saveAuthState)(path)),
        { selector: { path } },
      ),
    loadAuthState: (path) =>
      runStep(
        "loadAuthState",
        () => run(optionalMethod("loadAuthState", driver.loadAuthState)(path)),
        { selector: { path } },
      ),
    downloadFile: (path) =>
      runStep(
        "downloadFile",
        () => run(optionalMethod("downloadFile", driver.downloadFile)(path)),
        { selector: { path } },
      ),
    uploadFile: (selector, path) =>
      runStep(
        "uploadFile",
        () => run(optionalMethod("uploadFile", driver.uploadFile)(selector, path)),
        {
          selector: { target: selector, path },
          captureScreenshot: true,
        },
      ),
    newTab: (url) =>
      runStep("newTab", () => run(optionalMethod("newTab", driver.newTab)(url)), {
        selector: url ? { url } : undefined,
        captureScreenshot: true,
      }),
    switchToTab: (index) =>
      runStep(
        `switchToTab(${index})`,
        () => run(optionalMethod("switchToTab", driver.switchToTab)(index)),
        {
          selector: { index },
          captureScreenshot: true,
        },
      ),
    closeTab: () =>
      runStep("closeTab", () => run(optionalMethod("closeTab", driver.closeTab)()), {
        captureScreenshot: true,
      }),
    getTabIds: () =>
      runStep("getTabIds", () => run(optionalMethod("getTabIds", driver.getTabIds)())),
    getConsoleLogs: () =>
      runStep("getConsoleLogs", () =>
        run(optionalMethod("getConsoleLogs", driver.getConsoleLogs)()),
      ),
    getJSErrors: () =>
      runStep("getJSErrors", () => run(optionalMethod("getJSErrors", driver.getJSErrors)())),
    getHAR: () => runStep("getHAR", () => run(optionalMethod("getHAR", driver.getHAR)())),
    request: requestClient,
    newContext: (ctxOpts) =>
      runStep(
        "newContext",
        async (): Promise<IsolatedBrowserContext<T, R>> => {
          const created = await run(
            optionalMethod("newContext", driver.createIsolatedContext)(ctxOpts),
          );
          let closed = false;
          const safeClose = async () => {
            if (closed) return;
            closed = true;
            await created.close();
          };
          options.onRegisterCleanup?.(safeClose);
          const childDriver = created.driver as RawDriverService<T, R>;
          const childApp = createPromiseApp<T, R>(childDriver, appId, config, recorder, options);
          const childExpect = createPromiseExpect<T, R>(
            childDriver,
            config,
            recorder,
            options.flowContext,
            options.visualRegression,
          );
          return { app: childApp, expect: childExpect, close: safeClose };
        },
        { selector: ctxOpts },
      ),
    frame: (frameSelector: Selector<T>): FrameScope<T> => {
      const scoped = (sel: Selector<T>): Selector<T> => inFrame<T>(frameSelector, sel);
      return {
        tap: (sel, opts) => appObj.tap(scoped(sel), opts),
        doubleTap: (sel, opts) => appObj.doubleTap(scoped(sel), opts),
        longPress: (sel, opts) => appObj.longPress(scoped(sel), opts),
        hover: (sel, opts) => appObj.hover(scoped(sel), opts),
        fill: (sel, value, opts) => appObj.fill(scoped(sel), value, opts),
        uploadFile: (sel, path) => appObj.uploadFile(scoped(sel), path),
        getText: (sel, opts) => appObj.getText(scoped(sel), opts),
        getAttribute: (sel, name, opts) => appObj.getAttribute(scoped(sel), name, opts),
        isVisible: (sel, opts) => appObj.isVisible(scoped(sel), opts),
        isEnabled: (sel, opts) => appObj.isEnabled(scoped(sel), opts),
        expect: (sel) => appExpect(scoped(sel)),
      };
    },
    getPage: <PageType = unknown>(): PageType => {
      if (!driver.getRawPage) {
        throw new DriverError({
          message:
            "getPage() is only available when running with a browser driver that exposes a raw page.",
        });
      }
      return wrapRawPageWithStepRecording(driver.getRawPage() as PageType, recorder);
    },
    cdp: (): CdpSessionHandle => {
      const raw = driver.getCdpSession?.();
      if (!raw) {
        throw new DriverError({
          message:
            "app.cdp() is only available on Chromium web drivers (Direct CDP or Playwright Chromium).",
        });
      }
      return {
        send: <Res = Record<string, unknown>>(
          method: string,
          params?: Record<string, unknown>,
        ): Promise<Res> =>
          runStep(`cdp.${method}`, () => raw.send<Res>(method, params), {
            selector: params,
          }),
        on: (event, listener) => raw.on(event, listener),
        get sessionId() {
          return raw.sessionId;
        },
        get browserContextId() {
          return raw.browserContextId;
        },
      };
    },
    enableVirtualAuthenticator: (opts) =>
      runStep(
        "enableVirtualAuthenticator",
        () =>
          run(
            optionalMethod("enableVirtualAuthenticator", driver.enableVirtualAuthenticator)(opts),
          ),
        { selector: opts },
      ),
    removeVirtualAuthenticator: (authenticatorId) =>
      runStep("removeVirtualAuthenticator", () =>
        run(
          optionalMethod(
            "removeVirtualAuthenticator",
            driver.removeVirtualAuthenticator,
          )(authenticatorId),
        ),
      ),
    getVirtualCredentials: (authenticatorId) =>
      runStep("getVirtualCredentials", () =>
        run(optionalMethod("getVirtualCredentials", driver.getVirtualCredentials)(authenticatorId)),
      ),
    addVirtualCredential: (credential, authenticatorId) =>
      runStep(
        "addVirtualCredential",
        () =>
          run(
            optionalMethod("addVirtualCredential", driver.addVirtualCredential)(
              credential,
              authenticatorId,
            ),
          ),
        { selector: { credentialId: credential.credentialId, rpId: credential.rpId } },
      ),
    clearVirtualCredentials: (authenticatorId) =>
      runStep("clearVirtualCredentials", () =>
        run(
          optionalMethod(
            "clearVirtualCredentials",
            driver.clearVirtualCredentials,
          )(authenticatorId),
        ),
      ),

    pinch: (selector, opts) =>
      runStep("pinch", () => run(coord.pinch(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    zoom: (selector, opts) =>
      runStep("zoom", () => run(coord.zoom(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    multiTouch: (sequences) =>
      runStep("multiTouch", () => run(coord.multiTouch(sequences)), { captureScreenshot: true }),

    getText: (selector, opts) =>
      runStep("getText", () => run(coord.getText(selector, opts)), { selector }),
    getAttribute: (selector, name, opts) =>
      runStep(`getAttribute(${name})`, () => run(coord.getAttribute(selector, name, opts)), {
        selector,
      }),
    isVisible: (selector, opts) => {
      const timeout = opts?.timeout ?? 1000;
      return run(
        Effect.gen(function* () {
          const result = yield* Effect.either(
            waitForElement(
              driver,
              selector,
              config.parse,
              { timeout, pollInterval: 100 },
              undefined,
            ),
          );
          return result._tag === "Right";
        }),
      );
    },
    isEnabled: (selector, opts) =>
      runStep("isEnabled", () => run(coord.isElementEnabled(selector, opts)), { selector }),

    // Web-first bridge & fast state helpers
    waitForIdle: (opts) =>
      runStep("waitForIdle", async () => {
        if (driver.domChannel?.waitForIdle) {
          await driver.domChannel.waitForIdle(opts);
        }
      }),

    setStorage: (entries) =>
      runStep("setStorage", async () => {
        if (driver.domChannel?.setStorage) {
          await driver.domChannel.setStorage(entries);
          return;
        }
        const serialized = JSON.stringify(entries);
        await run(
          driver.evaluate(
            `((payload) => {
              if (payload.localStorage) {
                for (const [k, v] of Object.entries(payload.localStorage)) {
                  window.localStorage.setItem(k, v);
                }
              }
              if (payload.sessionStorage) {
                for (const [k, v] of Object.entries(payload.sessionStorage)) {
                  window.sessionStorage.setItem(k, v);
                }
              }
              if (payload.cookies) {
                for (const c of payload.cookies) {
                  const path = c.path ? '; path=' + c.path : '; path=/';
                  const domain = c.domain ? '; domain=' + c.domain : '';
                  document.cookie = encodeURIComponent(c.name) + '=' + encodeURIComponent(c.value) + path + domain;
                }
              }
            })(${serialized})`,
          ),
        );
      }),

    clearStorage: (opts) =>
      runStep("clearStorage", async () => {
        if (driver.domChannel?.clearStorage) {
          await driver.domChannel.clearStorage(opts);
          return;
        }
        const serialized = JSON.stringify(opts ?? {});
        await run(
          driver.evaluate(
            `((clearOpts) => {
              if (clearOpts.localStorage !== false) {
                try { window.localStorage.clear(); } catch {}
              }
              if (clearOpts.sessionStorage !== false) {
                try { window.sessionStorage.clear(); } catch {}
              }
            })(${serialized})`,
          ),
        );
      }),

    resetFast: () =>
      runStep("resetFast", async () => {
        if (driver.resetFast) {
          await run(driver.resetFast());
          return;
        }
        if (driver.domChannel?.clearStorage) {
          await driver.domChannel.clearStorage({
            localStorage: true,
            sessionStorage: true,
            cookies: true,
            indexedDB: true,
            capacitorPreferences: true,
          });
          if (driver.domChannel.reload) {
            await driver.domChannel.reload();
          }
          return;
        }
        await run(driver.clearAppState(appId));
      }),

    // WebView / hybrid context switching (low-level escape hatches)
    getContexts: () =>
      runStep("getContexts", () =>
        run((driver.getContexts ?? (() => Effect.succeed(["NATIVE_APP"] as string[])))()),
      ),

    getCurrentContext: () =>
      runStep("getCurrentContext", () =>
        run((driver.getCurrentContext ?? (() => Effect.succeed("NATIVE_APP")))()),
      ),

    switchToContext: (contextId) =>
      runStep(`switchToContext(${contextId})`, () =>
        run((driver.setContext ?? ((_id) => Effect.void))(contextId)),
      ),

    switchToWebView: () =>
      runStep("switchToWebView", async () => {
        const contexts = await run(
          (driver.getContexts ?? (() => Effect.succeed(["NATIVE_APP"] as string[])))(),
        );
        const webview = contexts.find((c) => c.startsWith("WEBVIEW_"));
        if (!webview) {
          throw new DriverError({
            message: `No WebView context found. Available contexts: ${contexts.join(", ")}`,
          });
        }
        await run((driver.setContext ?? ((_id) => Effect.void))(webview));
      }),

    switchToNativeApp: () =>
      runStep("switchToNativeApp", () =>
        run((driver.setContext ?? ((_id) => Effect.void))("NATIVE_APP")),
      ),
  };

  return appObj;
}
