import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type {
  RawDriverService,
  LaunchOptions,
  BrowserCookie,
  BrowserDialogHandler,
  BrowserDownloadInfo,
  BrowserEmulationOptions,
  BrowserMockResponse,
  BrowserNetworkConditions,
  BrowserRequestInfo,
  BrowserResponseInfo,
  BrowserRouteHandler,
  BrowserRouteMatcher,
  BrowserHAR,
  BrowserConsoleLog,
  BrowserJSError,
  CdpSessionHandle,
  TouchSequence,
  UploadFileInput,
  VirtualAuthenticatorOptions,
  VirtualCredential,
  VirtualCredentialInput,
} from "../drivers/raw-driver.js";
import type { AccessibilityViolation } from "../core/accessibility-audit.js";
import { compareScreenshots, cropToElement } from "../core/screenshot-compare.js";
import { mergeLaunchOptions } from "../drivers/launch-options.js";
import {
  isWasmTrapError,
  type CrossOriginIsolationReport,
  type WasmMetrics,
  type WasmTrap,
} from "../drivers/wasm-utils.js";
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
  SelectOptionInput,
} from "../channels/dom-channel.js";

export type {
  BackUntilVisibleOptions,
  DismissKeyboardOptions,
  ScrollUntilVisibleOptions,
} from "../smart/coordinator.js";
export type {
  BrowserConsoleLog,
  BrowserCookie,
  BrowserDialogHandler,
  BrowserDialogInfo,
  BrowserDownloadInfo,
  BrowserEmulationOptions,
  BrowserHAR,
  BrowserJSError,
  BrowserResponseInfo,
  CdpSessionHandle,
  VirtualAuthenticatorOptions,
  VirtualCredential,
  VirtualCredentialInput,
} from "../drivers/raw-driver.js";
export type { SelectOptionInput } from "../channels/dom-channel.js";
export type { StorybookOpenOptions } from "./storybook.js";

export interface BrowserRequestOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Multipart form fields (strings, Blobs, or `{ name, mimeType, buffer }` file objects). */
  multipart?: Record<
    string,
    | string
    | number
    | boolean
    | Blob
    | { name: string; mimeType?: string; buffer: Buffer | Uint8Array }
  >;
  /** Maximum redirect hops to follow while updating the browser cookie jar (default: 10). Set `0` to disable redirects. */
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface BrowserKeyboard {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  press(key: string): Promise<void>;
  type(text: string, opts?: { delay?: number }): Promise<void>;
  insertText(text: string): Promise<void>;
}

export interface BrowserMouse {
  move(x: number, y: number): Promise<void>;
  down(x: number, y: number, opts?: { button?: "left" | "right" | "middle" }): Promise<void>;
  up(x: number, y: number, opts?: { button?: "left" | "right" | "middle" }): Promise<void>;
  click(x: number, y: number): Promise<void>;
  /** Dispatch a wheel/scroll event (ideal for zooming/panning WebGL/WASM canvases). */
  wheel(deltaX: number, deltaY: number, opts?: { x?: number; y?: number }): Promise<void>;
}

export interface BrowserClock {
  install(opts?: { time?: Date | number | string }): Promise<void>;
  setFixedTime(time: Date | number | string): Promise<void>;
  fastForward(ticks: number): Promise<void>;
  runFor(ticks: number): Promise<void>;
  /** Advance `count` animation frames (16ms fake-clock ticks when installed, or real `requestAnimationFrame` ticks). */
  nextFrame(count?: number): Promise<void>;
  resume(): Promise<void>;
}

export interface AccessibilityAuditOptions {
  rules?: string[];
  disableRules?: string[];
  tags?: string[];
  include?: string[];
  exclude?: string[];
  targetSelector?: string;
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
  clear(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  check(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  uncheck(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  selectOption(
    selector: Selector<T>,
    option: SelectOptionInput,
    opts?: WaitOptions,
  ): Promise<string[]>;
  focus(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  blur(selector: Selector<T>, opts?: WaitOptions): Promise<void>;
  dragTo(source: Selector<T>, target: Selector<T>, opts?: WaitOptions): Promise<void>;
  uploadFile(selector: Selector<T>, path: UploadFileInput): Promise<void>;
  getText(selector: Selector<T>, opts?: WaitOptions): Promise<string>;
  getAttribute(
    selector: Selector<T>,
    name: string,
    opts?: WaitOptions,
  ): Promise<string | undefined>;
  isVisible(selector: Selector<T>, opts?: { timeout?: number }): Promise<boolean>;
  isEnabled(selector: Selector<T>, opts?: WaitOptions): Promise<boolean>;
  /** Count visible elements matching `selector` inside this frame (returns `0` when none exist). */
  count(selector: Selector<T>, opts?: WaitOptions): Promise<number>;
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
  /** Type text character-by-character dispatching keyDown/keyUp events (triggers per-key listeners). */
  type(text: string, opts?: { delay?: number }): Promise<void>;
  /** Low-level keyboard primitives (`down`, `up`, `press`, `type`, `insertText`). */
  readonly keyboard: BrowserKeyboard;
  /** Low-level pointer primitives (`move`, `down`, `up`, `click`). */
  readonly mouse: BrowserMouse;
  /** Deterministic fake clock (`install`, `setFixedTime`, `fastForward`, `runFor`, `resume`) on both CDP and Playwright. */
  readonly clock: BrowserClock;
  /** Run an axe-core accessibility audit and return `{ violations }` for custom inspection. */
  accessibilityAudit(
    opts?: AccessibilityAuditOptions,
  ): Promise<{ violations: AccessibilityViolation[] }>;
  /** Atomic 1-round-trip form fill: waits for actionability, focuses, replaces value, and dispatches input/change. */
  fill(selector: ExtendedSelector<T>, value: string, opts?: WaitOptions): Promise<void>;
  /** Clear the text value of an input, textarea, or contenteditable element. */
  clear(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  /** Ensure a checkbox, radio button, or ARIA switch is checked (idempotent). */
  check(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  /** Ensure a checkbox or ARIA switch is unchecked (idempotent). */
  uncheck(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  /** Select one or more options in a `<select>` element by value, label, or index. Returns selected option values. */
  selectOption(
    selector: ExtendedSelector<T>,
    option: SelectOptionInput,
    opts?: WaitOptions,
  ): Promise<string[]>;
  /** Focus an element. */
  focus(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  /** Remove focus from an element (triggers blur/change validation). */
  blur(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<void>;
  /** Drag a source element onto a target element. */
  dragTo(
    source: ExtendedSelector<T>,
    target: ExtendedSelector<T>,
    opts?: WaitOptions,
  ): Promise<void>;
  /** Resize the active browser viewport dynamically mid-flow. */
  setViewport(viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }): Promise<void>;
  /** Emulate CSS media (`colorScheme`, `reducedMotion`), locale, or timezone dynamically mid-flow. */
  setEmulation(options: BrowserEmulationOptions): Promise<void>;
  /** Register a custom handler for JS alert/confirm/prompt/beforeunload dialogs (pass `null` to restore auto-handling). */
  onDialog(handler: BrowserDialogHandler | null): Promise<void>;
  /** Accept the next JS dialog (optionally passing prompt text) and resolve with the dialog metadata. */
  acceptNextDialog(promptText?: string): Promise<void>;
  /** Dismiss the next JS dialog. */
  dismissNextDialog(): Promise<void>;
  /** Read plain text from the browser clipboard. */
  getClipboard(): Promise<string>;
  /** Write plain text to the browser clipboard. */
  setClipboard(text: string): Promise<void>;
  /** Wait for a file download triggered by `triggerFn` and return rich download metadata & helpers. */
  waitForDownload(
    triggerFn: () => Promise<unknown>,
    opts?: { timeout?: number },
  ): Promise<BrowserDownloadInfo>;
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
  /** Navigate forward in browser session history. */
  forward(): Promise<void>;
  /** Reload the current page and wait for navigation readiness. */
  reload(opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<void>;
  /** Return the current page URL. */
  url(): Promise<string>;
  /** Wait until the current page URL matches a substring/exact string or RegExp. */
  waitForURL(expected: string | RegExp, opts?: WaitOptions): Promise<void>;
  /** Wait for page load state (`load`, `domcontentloaded`, or `networkidle`). */
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    opts?: { timeout?: number },
  ): Promise<void>;
  /** Subscribe to outgoing network requests. Returns an unsubscribe function. */
  onRequest(listener: (req: BrowserRequestInfo) => void): () => void;
  /** Wait for an outgoing HTTP request matching a URL substring, RegExp, or predicate. */
  waitForRequest(
    matcher: BrowserRouteMatcher | ((req: BrowserRequestInfo) => boolean),
    opts?: { timeout?: number },
  ): Promise<BrowserRequestInfo>;
  /** Wait for an HTTP response matching a URL substring, RegExp, or predicate. */
  waitForResponse(
    matcher: BrowserRouteMatcher | ((res: BrowserResponseInfo) => boolean),
    opts?: { timeout?: number },
  ): Promise<BrowserResponseInfo>;
  /** Poll a predicate function in the page until it returns a truthy value. */
  waitForFunction<Result = unknown>(
    fn: ((...args: any[]) => Result | Promise<Result>) | string,
    arg?: unknown,
    opts?: { timeout?: number; pollInterval?: number },
  ): Promise<Awaited<Result>>;
  /** Wait for a popup tab opened by `triggerFn` and return its tab ID. */
  waitForPopup(triggerFn: () => Promise<unknown>, opts?: { timeout?: number }): Promise<string>;
  /** Inject a script to run before every new document load in the context. */
  addInitScript(script: string | ((...args: any[]) => unknown), ...args: unknown[]): Promise<void>;
  /** Expose a Node/Bun callback function onto `window[name]` in the browser page. */
  exposeFunction(name: string, fn: (...args: any[]) => any): Promise<void>;
  takeScreenshot(name?: string): Promise<Uint8Array>;
  evaluate<Result = unknown>(fn: () => Result | Promise<Result>): Promise<Awaited<Result>>;
  evaluate<Arg, Result = unknown>(
    fn: (arg: Arg) => Result | Promise<Result>,
    arg: Arg,
  ): Promise<Awaited<Result>>;
  evaluate<Result = unknown>(
    fn: ((...args: any[]) => Result | Promise<Result>) | string,
    ...args: any[]
  ): Promise<Awaited<Result>>;
  /** Register a dynamic request interceptor callback (`route.continue`, `route.fulfill`, `route.abort`, `route.fetch`). */
  route(matcher: BrowserRouteMatcher, handler: BrowserRouteHandler): Promise<void>;
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
  uploadFile(selector: Selector<T>, path: UploadFileInput): Promise<void>;
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
  newContext(opts?: {
    url?: string;
    locale?: string;
    viewport?: { width: number; height: number };
  }): Promise<IsolatedBrowserContext<T, R>>;
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
  /** Return the number of currently visible elements matching `selector` (returns `0` without throwing when none exist). */
  count(selector: ExtendedSelector<T>, opts?: WaitOptions): Promise<number>;

  // Web-first bridge & fast state helpers (works across web, Capacitor, Electron, Electrobun)
  /** Wait for in-flight fetch/XHR, animations, and framework renders to settle via spana-bridge. */
  waitForIdle(opts?: DomIdleOptions): Promise<void>;
  /** Inject storage/auth state directly through the DOM bridge (avoids slow UI login flows). */
  setStorage(entries: DomStorageEntries): Promise<void>;
  /** Clear localStorage, sessionStorage, cookies, IndexedDB, and Capacitor Preferences. */
  clearStorage(opts?: DomClearStorageOptions): Promise<void>;
  /** Fast reset: clear storage via bridge and reload in milliseconds (avoids uninstall/reinstall). */
  resetFast(): Promise<void>;

  // Canvas & WebAssembly (WASM) helpers
  /** Smooth pointer drag between viewport coordinates (ideal for canvas editors, WebGL cameras, and games). */
  dragXY(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    opts?: { steps?: number },
  ): Promise<void>;
  /** Tap at an `(dx, dy)` offset relative to the top-left of a matched element (e.g. a `<canvas>`). */
  tapOffset(
    selector: ExtendedSelector<T>,
    dx: number,
    dy: number,
    opts?: WaitOptions,
  ): Promise<void>;
  /**
   * Wait until consecutive screenshots (full viewport or cropped to `selector`) stabilize
   * within `maxDiffPixelRatio` for `quietMs`, using Spana's Rust FFI visual diff engine.
   */
  waitForCanvasStable(
    selector?: ExtendedSelector<T>,
    opts?: {
      quietMs?: number;
      timeout?: number;
      intervalMs?: number;
      maxDiffPixelRatio?: number;
      threshold?: number;
    },
  ): Promise<void>;
  /** Wait until WebAssembly module(s) finish instantiating (or `window.__SPANA_WASM_READY__` becomes true). */
  waitForWasmReady(opts?: { minModules?: number; timeout?: number }): Promise<void>;
  /** Read live WASM metrics (modules, linear memory bytes/pages, peak bytes, optional FPS sample, traps, COOP/COEP). */
  getWasmMetrics(opts?: { sampleFpsMs?: number }): Promise<WasmMetrics>;
  /** Return all captured WebAssembly traps from main thread and attached Web Workers. */
  getWasmTraps(): Promise<WasmTrap[]>;
  /** Inspect cross-origin isolation (`crossOriginIsolated` & `SharedArrayBuffer`) needed for multi-threaded WASM. */
  checkCrossOriginIsolation(): Promise<CrossOriginIsolationReport>;
  /** Activate Flutter Web's hidden `<flt-semantics-placeholder>` so CanvasKit/Skwasm apps expose ARIA nodes. */
  enableFlutterSemantics(): Promise<boolean>;

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
        .pipe(Effect.catch(() => Effect.succeed(""))),
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
    let currentUrl = await resolveRequestUrl(rawUrl);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) currentUrl.searchParams.set(k, String(v));
      }
    }

    const baseHeaders: Record<string, string> = { ...init?.headers };
    const hasExplicitCookie = Object.keys(baseHeaders).some((k) => k.toLowerCase() === "cookie");

    let currentMethod = method.toUpperCase();
    let requestBody: string | FormData | Blob | Uint8Array | undefined;
    if (init?.multipart) {
      const form = new FormData();
      for (const [fieldName, fieldVal] of Object.entries(init.multipart)) {
        if (fieldVal instanceof Blob) {
          form.append(fieldName, fieldVal);
        } else if (
          fieldVal &&
          typeof fieldVal === "object" &&
          "buffer" in fieldVal &&
          "name" in fieldVal
        ) {
          const blob = new Blob([new Uint8Array(fieldVal.buffer)], {
            type: fieldVal.mimeType ?? "application/octet-stream",
          });
          form.append(fieldName, blob, fieldVal.name);
        } else {
          form.append(fieldName, String(fieldVal));
        }
      }
      requestBody = form;
      // Remove any explicit content-type so fetch generates the multipart boundary
      for (const key of Object.keys(baseHeaders)) {
        if (key.toLowerCase() === "content-type") delete baseHeaders[key];
      }
    } else if (init?.body !== undefined) {
      if (
        typeof init.body === "string" ||
        init.body instanceof FormData ||
        init.body instanceof Blob ||
        init.body instanceof Uint8Array
      ) {
        requestBody = init.body;
      } else {
        requestBody = JSON.stringify(init.body);
        if (!Object.keys(baseHeaders).some((k) => k.toLowerCase() === "content-type")) {
          baseHeaders["content-type"] = "application/json";
        }
      }
    }

    const maxRedirects = init?.maxRedirects ?? 10;
    let res!: Response;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const hopHeaders: Record<string, string> = { ...baseHeaders };
      if (!hasExplicitCookie && driver.getCookies) {
        const cookies = await run(driver.getCookies([currentUrl.toString()])).catch(() => []);
        if (cookies.length > 0) {
          hopHeaders["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        }
      }

      res = await fetch(currentUrl.toString(), {
        method: currentMethod,
        headers: hopHeaders,
        redirect: "manual",
        ...(requestBody !== undefined ? { body: requestBody as never } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
      });

      // Sync any Set-Cookie headers on EVERY hop (including 3xx redirects!) back into the browser context (2.12)
      if (driver.setCookies) {
        const rawSetCookies: string[] =
          typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie ===
          "function"
            ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
            : res.headers.get("set-cookie")
              ? [res.headers.get("set-cookie")!]
              : [];
        const parsedCookies = rawSetCookies
          .map((line) => parseSetCookieHeader(line, currentUrl))
          .filter((c): c is BrowserCookie => c !== null);
        if (parsedCookies.length > 0) {
          await run(driver.setCookies(parsedCookies)).catch(() => {});
        }
      }

      const isRedirect =
        res.status === 301 ||
        res.status === 302 ||
        res.status === 303 ||
        res.status === 307 ||
        res.status === 308;
      const location = res.headers.get("location");
      if (!isRedirect || !location || hop === maxRedirects) {
        break;
      }

      currentUrl = new URL(location, currentUrl);
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        requestBody = undefined;
        for (const key of Object.keys(baseHeaders)) {
          if (key.toLowerCase() === "content-type") delete baseHeaders[key];
        }
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
      url: res.url || currentUrl.toString(),
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

  const buildFakeClockScript = (initialMs: number) => `(() => {
    if (window.__spanaClock) {
      window.__spanaClock.setFixedTime(${initialMs});
      return;
    }
    const OrigDate = window.Date;
    const origSetTimeout = window.setTimeout.bind(window);
    const origClearTimeout = window.clearTimeout.bind(window);
    const origSetInterval = window.setInterval.bind(window);
    const origClearInterval = window.clearInterval.bind(window);
    const origPerfNow = window.performance && window.performance.now ? window.performance.now.bind(window.performance) : null;
    let fakeNow = ${initialMs};
    let installed = true;
    let nextTimerId = 100000;
    const timers = new Map();

    function FakeDate(...args) {
      if (!(this instanceof FakeDate)) return new OrigDate(fakeNow).toString();
      if (args.length === 0) return new OrigDate(fakeNow);
      return new OrigDate(...args);
    }
    FakeDate.prototype = OrigDate.prototype;
    FakeDate.now = () => (installed ? fakeNow : OrigDate.now());
    FakeDate.parse = OrigDate.parse;
    FakeDate.UTC = OrigDate.UTC;
    Object.setPrototypeOf(FakeDate, OrigDate);
    window.Date = FakeDate;

    const basePerf = origPerfNow ? origPerfNow() : 0;
    const baseEpoch = fakeNow;
    if (window.performance) {
      try {
        window.performance.now = () => (installed ? basePerf + (fakeNow - baseEpoch) : (origPerfNow ? origPerfNow() : 0));
      } catch {}
    }

    window.setTimeout = (fn, delay = 0, ...args) => {
      if (!installed) return origSetTimeout(fn, delay, ...args);
      const id = nextTimerId++;
      const d = Math.max(0, Number(delay) || 0);
      timers.set(id, { id, fn, args, due: fakeNow + d, interval: null });
      return id;
    };
    window.clearTimeout = (id) => {
      timers.delete(id);
      origClearTimeout(id);
    };
    window.setInterval = (fn, delay = 0, ...args) => {
      if (!installed) return origSetInterval(fn, delay, ...args);
      const id = nextTimerId++;
      const d = Math.max(1, Number(delay) || 1);
      timers.set(id, { id, fn, args, due: fakeNow + d, interval: d });
      return id;
    };
    window.clearInterval = (id) => {
      timers.delete(id);
      origClearInterval(id);
    };

    const runDue = (targetTime, fireTimers) => {
      while (true) {
        let next = null;
        for (const t of timers.values()) {
          if (t.due <= targetTime && (!next || t.due < next.due)) next = t;
        }
        if (!next) break;
        fakeNow = next.due;
        if (next.interval !== null) {
          next.due += next.interval;
        } else {
          timers.delete(next.id);
        }
        if (fireTimers) {
          try {
            if (typeof next.fn === "function") next.fn(...next.args);
          } catch {}
        }
      }
      fakeNow = targetTime;
    };

    window.__spanaClock = {
      setFixedTime(ms) {
        fakeNow = ms;
      },
      fastForward(ms) {
        runDue(fakeNow + Math.max(0, Number(ms) || 0), true);
      },
      runFor(ms) {
        runDue(fakeNow + Math.max(0, Number(ms) || 0), true);
      },
      resume() {
        installed = false;
        window.Date = OrigDate;
        window.setTimeout = origSetTimeout;
        window.clearTimeout = origClearTimeout;
        window.setInterval = origSetInterval;
        window.clearInterval = origClearInterval;
        if (window.performance && origPerfNow) {
          try { window.performance.now = origPerfNow; } catch {}
        }
        timers.clear();
        delete window.__spanaClock;
      },
    };
  })();`;

  const parseClockTime = (time?: Date | number | string): number => {
    if (time === undefined) return Date.now();
    if (time instanceof Date) return time.getTime();
    if (typeof time === "number") return time;
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : Date.now();
  };

  const clockClient: BrowserClock = {
    install: (opts) =>
      runStep("clock.install", async () => {
        const initialMs = parseClockTime(opts?.time);
        const script = buildFakeClockScript(initialMs);
        if (driver.addInitScript) {
          await run(driver.addInitScript(script));
        }
        await run(driver.evaluate(script)).catch(() => {});
      }),
    setFixedTime: (time) =>
      runStep("clock.setFixedTime", async () => {
        const ms = parseClockTime(time);
        const script = buildFakeClockScript(ms);
        if (driver.addInitScript) {
          await run(driver.addInitScript(script));
        }
        await run(driver.evaluate(script)).catch(() => {});
      }),
    fastForward: (ticks) =>
      runStep(`clock.fastForward(${ticks})`, async () => {
        await run(
          driver.evaluate(
            `(() => { if (!window.__spanaClock) throw new Error("Call app.clock.install() before app.clock.fastForward()"); window.__spanaClock.fastForward(${Number(ticks) || 0}); })()`,
          ),
        );
      }),
    runFor: (ticks) =>
      runStep(`clock.runFor(${ticks})`, async () => {
        await run(
          driver.evaluate(
            `(() => { if (!window.__spanaClock) throw new Error("Call app.clock.install() before app.clock.runFor()"); window.__spanaClock.runFor(${Number(ticks) || 0}); })()`,
          ),
        );
      }),
    nextFrame: (count = 1) =>
      runStep(`clock.nextFrame(${count})`, async () => {
        const frames = Math.max(1, Math.round(count));
        await run(
          driver.evaluate(
            `(async () => {
              if (window.__spanaClock) {
                for (let i = 0; i < ${frames}; i++) {
                  window.__spanaClock.runFor(16);
                }
                return;
              }
              if (typeof requestAnimationFrame === "function") {
                for (let i = 0; i < ${frames}; i++) {
                  await new Promise((r) => requestAnimationFrame(() => r()));
                }
              }
            })()`,
          ),
        );
      }),
    resume: () =>
      runStep("clock.resume", async () => {
        await run(
          driver.evaluate(`(() => { if (window.__spanaClock) window.__spanaClock.resume(); })()`),
        );
      }),
  };

  const keyboardClient: BrowserKeyboard = {
    down: (key) =>
      runStep(`keyboard.down(${key})`, () =>
        run(optionalMethod("keyboard.down", driver.keyDown)(key)),
      ),
    up: (key) =>
      runStep(`keyboard.up(${key})`, () => run(optionalMethod("keyboard.up", driver.keyUp)(key))),
    press: (key) => runStep(`keyboard.press(${key})`, () => run(coord.pressKey(key))),
    type: (text, opts) =>
      runStep("keyboard.type", async () => {
        if (driver.typeText) {
          await run(driver.typeText(text, opts));
          return;
        }
        for (const ch of Array.from(text)) {
          await run(driver.pressKey(ch));
          if (opts?.delay && opts.delay > 0) {
            await new Promise((r) => setTimeout(r, opts.delay));
          }
        }
      }),
    insertText: (text) => runStep("keyboard.insertText", () => run(coord.inputText(text))),
  };

  const mouseClient: BrowserMouse = {
    move: (x, y) =>
      runStep(`mouse.move(${x},${y})`, () =>
        run(optionalMethod("mouse.move", driver.hoverAtCoordinate)(x, y)),
      ),
    down: (x, y, opts) =>
      runStep(`mouse.down(${x},${y})`, () =>
        run(optionalMethod("mouse.down", driver.mouseDown)(x, y, opts)),
      ),
    up: (x, y, opts) =>
      runStep(`mouse.up(${x},${y})`, () =>
        run(optionalMethod("mouse.up", driver.mouseUp)(x, y, opts)),
      ),
    click: (x, y) => runStep(`mouse.click(${x},${y})`, () => run(coord.tapXY(x, y))),
    wheel: (deltaX, deltaY, opts) =>
      runStep(`mouse.wheel(${deltaX},${deltaY})`, async () => {
        const x = opts?.x ?? 0;
        const y = opts?.y ?? 0;
        if (driver.mouseWheel) {
          await run(driver.mouseWheel(x, y, deltaX, deltaY));
          return;
        }
        await run(
          driver.evaluate(
            `(() => {
              const target = (typeof document !== "undefined" && document.elementFromPoint(${x}, ${y})) || document.body || window;
              if (target && typeof target.dispatchEvent === "function") {
                target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y}, deltaX: ${deltaX}, deltaY: ${deltaY} }));
              }
            })()`,
          ),
        );
      }),
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
    type: (text, opts) => keyboardClient.type(text, opts),
    keyboard: keyboardClient,
    mouse: mouseClient,
    clock: clockClient,
    accessibilityAudit: (auditOpts) =>
      runStep("accessibilityAudit", () =>
        run(
          coord.runAccessibilityAudit(platform ?? "web", {
            rules: auditOpts?.rules,
            disableRules: auditOpts?.disableRules,
            tags: auditOpts?.tags,
            targetSelector: auditOpts?.targetSelector,
            includeSelectors: auditOpts?.include,
            excludeSelectors: auditOpts?.exclude,
          }),
        ),
      ),
    fill: (selector, value, opts) =>
      runStep("fill", () => run(coord.fill(selector, value, opts)), {
        selector,
        captureScreenshot: true,
      }),
    clear: (selector, opts) =>
      runStep("clear", () => run(coord.fill(selector, "", opts)), {
        selector,
        captureScreenshot: true,
      }),
    check: (selector, opts) =>
      runStep("check", () => run(coord.check(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    uncheck: (selector, opts) =>
      runStep("uncheck", () => run(coord.uncheck(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    selectOption: (selector, option, opts) =>
      runStep("selectOption", () => run(coord.selectOption(selector, option, opts)), {
        selector: { target: selector, option },
        captureScreenshot: true,
      }),
    focus: (selector, opts) =>
      runStep("focus", () => run(coord.focus(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    blur: (selector, opts) =>
      runStep("blur", () => run(coord.blur(selector, opts)), {
        selector,
        captureScreenshot: true,
      }),
    dragTo: (source, target, opts) =>
      runStep("dragTo", () => run(coord.dragTo(source, target, opts)), {
        selector: { source, target },
        captureScreenshot: true,
      }),
    setViewport: (viewport) =>
      runStep(`setViewport(${viewport.width}x${viewport.height})`, () =>
        run(optionalMethod("setViewport", driver.setViewport)(viewport)),
      ),
    setEmulation: (emulationOpts) =>
      runStep(
        "setEmulation",
        () => run(optionalMethod("setEmulation", driver.setEmulation)(emulationOpts)),
        { selector: emulationOpts },
      ),
    onDialog: (handler) =>
      runStep("onDialog", () => run(optionalMethod("onDialog", driver.setDialogHandler)(handler))),
    acceptNextDialog: (promptText) =>
      runStep("acceptNextDialog", () =>
        run(
          optionalMethod(
            "acceptNextDialog",
            driver.setDialogHandler,
          )(async (dialog) => {
            await dialog.accept(promptText);
            if (driver.setDialogHandler) {
              await run(driver.setDialogHandler(null)).catch(() => {});
            }
          }),
        ),
      ),
    dismissNextDialog: () =>
      runStep("dismissNextDialog", () =>
        run(
          optionalMethod(
            "dismissNextDialog",
            driver.setDialogHandler,
          )(async (dialog) => {
            await dialog.dismiss();
            if (driver.setDialogHandler) {
              await run(driver.setDialogHandler(null)).catch(() => {});
            }
          }),
        ),
      ),
    getClipboard: () =>
      runStep("getClipboard", () => run(optionalMethod("getClipboard", driver.getClipboard)())),
    setClipboard: (text) =>
      runStep("setClipboard", () => run(optionalMethod("setClipboard", driver.setClipboard)(text))),
    waitForDownload: (triggerFn, opts) =>
      runStep("waitForDownload", () =>
        run(optionalMethod("waitForDownload", driver.waitForDownload)(triggerFn, opts)),
      ),
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
    forward: () =>
      runStep(
        "forward",
        async () => {
          if (driver.forward) {
            await run(driver.forward());
            return;
          }
          await run(driver.evaluate("window.history.forward()"));
        },
        { captureScreenshot: true },
      ),
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
    waitForLoadState: (state = "load", opts) =>
      runStep(`waitForLoadState(${state})`, () =>
        run(optionalMethod("waitForLoadState", driver.waitForLoadState)(state, opts)),
      ),
    onRequest: (listener) => {
      if (!driver.onRequest) {
        throw new DriverError({ message: "onRequest() is only supported on the web platform" });
      }
      return driver.onRequest(listener);
    },
    waitForRequest: (matcher, opts) =>
      runStep(
        `waitForRequest(${typeof matcher === "function" ? "<predicate>" : describeMatcher(matcher)})`,
        () => run(optionalMethod("waitForRequest", driver.waitForRequest)(matcher, opts)),
      ),
    waitForResponse: (matcher, opts) =>
      runStep(
        `waitForResponse(${typeof matcher === "function" ? "<predicate>" : describeMatcher(matcher)})`,
        () => run(optionalMethod("waitForResponse", driver.waitForResponse)(matcher, opts)),
      ),
    waitForFunction: (<Result = unknown>(
      fn: ((...args: any[]) => Result | Promise<Result>) | string,
      arg?: unknown,
      opts?: { timeout?: number; pollInterval?: number },
    ): Promise<Awaited<Result>> =>
      runStep(`waitForFunction`, async () => {
        const timeout = opts?.timeout ?? config.defaults?.timeout ?? 5000;
        const pollInterval = opts?.pollInterval ?? 100;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const val =
            arg === undefined
              ? await run(driver.evaluate(fn as any))
              : await run(driver.evaluate(fn as any, arg));
          if (val) return val;
          await new Promise((r) => setTimeout(r, pollInterval));
        }
        throw new DriverError({ message: `waitForFunction() timed out after ${timeout}ms` });
      }) as Promise<Awaited<Result>>) as PromiseApp<T, R>["waitForFunction"],
    waitForPopup: (triggerFn, opts) =>
      runStep("waitForPopup", () =>
        run(optionalMethod("waitForPopup", driver.waitForPopup)(triggerFn, opts)),
      ),
    addInitScript: (script, ...args) =>
      runStep("addInitScript", () =>
        run(optionalMethod("addInitScript", driver.addInitScript)(script, ...args)),
      ),
    exposeFunction: (name, fn) =>
      runStep(`exposeFunction(${name})`, () =>
        run(optionalMethod("exposeFunction", driver.exposeFunction)(name, fn)),
      ),
    takeScreenshot: (name) =>
      runScreenshotStep(
        name ? `takeScreenshot(${name})` : "takeScreenshot",
        () => run(driver.takeScreenshot()),
        { name },
      ),
    evaluate: ((fn: ((...args: any[]) => any) | string, ...args: any[]) =>
      runStep(formatEvaluateCommand(fn), () =>
        run(driver.evaluate(fn as any, ...args)),
      )) as PromiseApp<T, R>["evaluate"],
    route: (matcher, handler) =>
      runStep(
        "route",
        () =>
          driver.route ? run(driver.route(matcher, handler)) : unsupportedNetworkFeature("route"),
        { selector: { matcher: describeMatcher(matcher) } },
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
        clear: (sel, opts) => appObj.clear(scoped(sel), opts),
        check: (sel, opts) => appObj.check(scoped(sel), opts),
        uncheck: (sel, opts) => appObj.uncheck(scoped(sel), opts),
        selectOption: (sel, option, opts) => appObj.selectOption(scoped(sel), option, opts),
        focus: (sel, opts) => appObj.focus(scoped(sel), opts),
        blur: (sel, opts) => appObj.blur(scoped(sel), opts),
        dragTo: (source, target, opts) => appObj.dragTo(scoped(source), scoped(target), opts),
        uploadFile: (sel, path) => appObj.uploadFile(scoped(sel), path),
        getText: (sel, opts) => appObj.getText(scoped(sel), opts),
        getAttribute: (sel, name, opts) => appObj.getAttribute(scoped(sel), name, opts),
        isVisible: (sel, opts) => appObj.isVisible(scoped(sel), opts),
        isEnabled: (sel, opts) => appObj.isEnabled(scoped(sel), opts),
        count: (sel, opts) => appObj.count(scoped(sel), opts),
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
          const result = yield* Effect.result(
            waitForElement(
              driver,
              selector,
              config.parse,
              { timeout, pollInterval: 100 },
              undefined,
            ),
          );
          return result._tag === "Success";
        }),
      );
    },
    isEnabled: (selector, opts) =>
      runStep("isEnabled", () => run(coord.isElementEnabled(selector, opts)), { selector }),
    count: (selector, opts) =>
      runStep("count", () => run(coord.count(selector, opts)), { selector }),

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

    dragXY: (fromX, fromY, toX, toY, opts) =>
      runStep(`dragXY(${fromX},${fromY}->${toX},${toY})`, async () => {
        const steps = opts?.steps ?? 10;
        if (driver.dragAndDrop) {
          await run(driver.dragAndDrop(fromX, fromY, toX, toY, steps));
          return;
        }
        await run(driver.swipe(fromX, fromY, toX, toY, Math.max(100, steps * 16)));
      }),

    tapOffset: (selector, dx, dy, opts) =>
      runStep(
        `tapOffset(${dx},${dy})`,
        async () => {
          const el = await run(coord.assertVisible(selector, opts));
          const x = Math.round(el.bounds.x + dx);
          const y = Math.round(el.bounds.y + dy);
          await run(driver.tapAtCoordinate(x, y));
        },
        { selector, captureScreenshot: true },
      ),

    waitForCanvasStable: (selector, opts) =>
      runStep("waitForCanvasStable", async () => {
        const quietMs = opts?.quietMs ?? 200;
        const timeout = opts?.timeout ?? 5000;
        const intervalMs = opts?.intervalMs ?? 50;
        const maxDiffPixelRatio = opts?.maxDiffPixelRatio ?? 0.001;
        const threshold = opts?.threshold ?? 0.05;
        const deadline = Date.now() + timeout;
        let bounds: { x: number; y: number; width: number; height: number } | undefined;
        if (selector) {
          const el = await run(coord.assertVisible(selector, { timeout }));
          bounds = el.bounds;
        }
        const capture = async (): Promise<Uint8Array> => {
          const full = await run(driver.takeScreenshot());
          if (bounds && bounds.width > 0 && bounds.height > 0 && full.byteLength > 0) {
            return await cropToElement(full, bounds);
          }
          return full;
        };
        let prev = await capture();
        let stableSince = Date.now();
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, intervalMs));
          const next = await capture();
          if (prev.byteLength === 0 || next.byteLength === 0) {
            return;
          }
          const diff = compareScreenshots(prev, next, { threshold, maxDiffPixelRatio });
          if (diff.match) {
            if (Date.now() - stableSince >= quietMs) {
              return;
            }
          } else {
            stableSince = Date.now();
          }
          prev = next;
        }
        throw new Error(
          `Canvas did not stabilize within ${timeout}ms (quietMs=${quietMs}, maxDiffPixelRatio=${maxDiffPixelRatio})`,
        );
      }),

    waitForWasmReady: (opts) =>
      runStep("waitForWasmReady", async () => {
        const minModules = opts?.minModules ?? 1;
        const timeout = opts?.timeout ?? 15_000;
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (driver.getWasmMetrics) {
            const m = await run(driver.getWasmMetrics());
            if (m.pendingCount === 0 && m.moduleCount >= minModules) {
              return;
            }
          }
          const ready = await run(
            driver.evaluate<boolean>(
              `(() => {
                if (globalThis.__spanaWasm) return globalThis.__spanaWasm.isReady(${minModules});
                if (typeof globalThis.__SPANA_WASM_READY__ === "function") return Boolean(globalThis.__SPANA_WASM_READY__());
                return globalThis.__SPANA_WASM_READY__ === true;
              })()`,
            ),
          ).catch(() => false);
          if (ready) return;
          await new Promise((r) => setTimeout(r, 40));
        }
        throw new Error(
          `Timed out waiting for WebAssembly readiness after ${timeout}ms (expected at least ${minModules} instantiated module(s))`,
        );
      }),

    getWasmMetrics: (opts) =>
      runStep("getWasmMetrics", async () => {
        let metrics: WasmMetrics;
        if (driver.getWasmMetrics) {
          metrics = await run(driver.getWasmMetrics());
        } else {
          metrics = await run(
            driver.evaluate<WasmMetrics>(
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
            ),
          );
        }
        if (opts?.sampleFpsMs && opts.sampleFpsMs > 0 && driver.evaluate) {
          const sampleMs = Math.max(50, Math.round(opts.sampleFpsMs));
          const fps = await run(
            driver.evaluate<number>(
              `(() => new Promise((resolve) => {
                if (typeof requestAnimationFrame !== "function") { resolve(0); return; }
                let frames = 0;
                const start = performance.now();
                function tick(now) {
                  frames++;
                  const elapsed = now - start;
                  if (elapsed >= ${sampleMs}) {
                    resolve(Math.round((frames * 1000) / Math.max(1, elapsed)));
                    return;
                  }
                  requestAnimationFrame(tick);
                }
                requestAnimationFrame(tick);
              }))()`,
            ),
          ).catch(() => undefined);
          if (typeof fps === "number") {
            metrics = { ...metrics, fps };
          }
        }
        return metrics;
      }),

    getWasmTraps: () =>
      runStep("getWasmTraps", async () => {
        if (driver.getWasmTraps) {
          return await run(driver.getWasmTraps());
        }
        const jsErrors = driver.getJSErrors ? await run(driver.getJSErrors()) : [];
        return jsErrors
          .filter((e) => isWasmTrapError(e))
          .map((e) => ({
            name: e.name ?? "WebAssembly.RuntimeError",
            message: e.message,
            source: "main" as const,
            stack: e.stack,
            timestamp: Date.now(),
          }));
      }),

    checkCrossOriginIsolation: () =>
      runStep("checkCrossOriginIsolation", async () => {
        const res = await run(
          driver.evaluate<CrossOriginIsolationReport>(
            `(() => {
              const isolated = Boolean(globalThis.crossOriginIsolated);
              const sab = typeof SharedArrayBuffer !== "undefined";
              return {
                crossOriginIsolated: isolated,
                sharedArrayBufferAvailable: sab,
                hint: isolated
                  ? undefined
                  : "Serve responses with 'Cross-Origin-Opener-Policy: same-origin' and 'Cross-Origin-Embedder-Policy: require-corp' to enable SharedArrayBuffer / multi-threaded WASM."
              };
            })()`,
          ),
        );
        return res;
      }),

    enableFlutterSemantics: () =>
      runStep("enableFlutterSemantics", async () => {
        return await run(
          driver.evaluate<boolean>(
            `(() => {
              if (typeof document === "undefined") return false;
              const el = document.querySelector("flt-semantics-placeholder")
                || (document.querySelector("flt-glass-pane") && document.querySelector("flt-glass-pane").shadowRoot && document.querySelector("flt-glass-pane").shadowRoot.querySelector("flt-semantics-placeholder"));
              if (!el) return false;
              if (typeof el.click === "function") { el.click(); return true; }
              el.dispatchEvent(new Event("click", { bubbles: true }));
              return true;
            })()`,
          ),
        );
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
