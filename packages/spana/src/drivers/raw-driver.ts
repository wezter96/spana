import { Context, Effect } from "effect";
import type { DriverError } from "../errors.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Selector } from "../schemas/selector.js";
import type { DomChannel } from "../channels/dom-channel.js";
import type {
  BiometricOptions,
  Geolocation,
  Orientation,
  PermissionOptions,
  PushPayload,
} from "./device-controls.js";
import type { WasmMetrics, WasmTrap } from "./wasm-utils.js";

export type RawHierarchy = string; // Raw XML (Android/iOS) or JSON (web) — parsed by platform-specific parsers

/**
 * Per-launch device state overrides (language/locale/timeZone) applied at app
 * launch time. Maps to the `appium:language` / `appium:locale` /
 * `appium:timeZone` capabilities on Appium providers; used to drive Expo /
 * React Native localization for the duration of a flow.
 */
export interface DeviceStateConfig {
  language?: string;
  locale?: string;
  timeZone?: string;
}

export interface LaunchOptions<R extends string = string> {
  clearState?: boolean;
  clearKeychain?: boolean;
  /** Native deep link URL (e.g. `spana://playground`). `R` lets projects type it. */
  deepLink?: R;
  launchArguments?: Record<string, unknown>;
  deviceState?: DeviceStateConfig;
}

export type BrowserRouteMatcher = string | RegExp;

export interface BrowserMockResponse {
  status?: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

export interface BrowserRequestInfo {
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType?: string;
  postData(): string | null;
  postDataJSON<T = unknown>(): T | null;
}

export interface BrowserRoute {
  request(): BrowserRequestInfo;
  continue(overrides?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  fulfill(response: BrowserMockResponse): Promise<void>;
  fetch(overrides?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  }): Promise<BrowserResponseInfo>;
}

export type BrowserRouteHandler = (route: BrowserRoute) => void | Promise<void>;

export interface UploadFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer | Uint8Array;
}

export type UploadFileInput = string | string[] | UploadFilePayload | UploadFilePayload[];

export type NetworkProfile = "wifi" | "4g" | "3g" | "2g" | "edge" | "offline";

export interface NetworkConditions {
  profile?: NetworkProfile;
  offline?: boolean;
  latencyMs?: number;
  downloadThroughputKbps?: number;
  uploadThroughputKbps?: number;
}

/** @deprecated Use `NetworkConditions` instead. */
export type BrowserNetworkConditions = NetworkConditions;

export interface BrowserConsoleLogLocation {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface BrowserConsoleLog {
  type: string;
  text: string;
  location?: BrowserConsoleLogLocation;
}

export interface BrowserJSError {
  name?: string;
  message: string;
  stack?: string;
}

export interface BrowserHARHeader {
  name: string;
  value: string;
}

export interface BrowserHAREntry {
  pageref: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: BrowserHARHeader[];
    queryString: BrowserHARHeader[];
    headersSize: number;
    bodySize: number;
    postData?: {
      mimeType: string;
      text?: string;
    };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: BrowserHARHeader[];
    redirectURL: string;
    headersSize: number;
    bodySize: number;
    content: {
      size: number;
      mimeType: string;
    };
  };
  cache: Record<string, never>;
  timings: {
    blocked: number;
    dns: number;
    connect: number;
    ssl: number;
    send: number;
    wait: number;
    receive: number;
  };
  serverIPAddress?: string;
  _resourceType?: string;
  _failureText?: string;
}

export interface BrowserHARPage {
  id: string;
  title: string;
  startedDateTime: string;
  pageTimings: {
    onContentLoad: number;
    onLoad: number;
  };
}

export interface BrowserHAR {
  log: {
    version: "1.2";
    creator: {
      name: "spana";
      version: string;
    };
    browser: {
      name: string;
    };
    pages: BrowserHARPage[];
    entries: BrowserHAREntry[];
  };
}

export type TouchAction =
  | { type: "move"; x: number; y: number; duration?: number }
  | { type: "down" }
  | { type: "up" }
  | { type: "pause"; duration: number };

export interface TouchSequence {
  id: number;
  actions: TouchAction[];
}

export interface VirtualAuthenticatorOptions {
  /** WebAuthn protocol. Default: "ctap2". */
  protocol?: "ctap2" | "u2f";
  /** Authenticator transport. Default: "internal" (platform passkey). */
  transport?: "usb" | "nfc" | "ble" | "cable" | "internal";
  /** Support discoverable resident keys (passkeys). Default: true. */
  hasResidentKey?: boolean;
  /** Support user verification (Touch ID / Face ID / PIN). Default: true. */
  hasUserVerification?: boolean;
  /** Automatically pass user verification. Default: true. */
  isUserVerified?: boolean;
  /** Automatically simulate user presence on prompts. Default: true. */
  automaticPresenceSimulation?: boolean;
}

export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  /** Base64-encoded PKCS#8 EC/RSA private key returned by CDP `WebAuthn.getCredentials`. */
  privateKey?: string;
  userHandle?: string;
  userName?: string;
  signCount: number;
}

export interface VirtualCredentialInput {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  /** Base64-encoded PKCS#8 private key (as returned by `getVirtualCredentials()`). */
  privateKey: string;
  userHandle?: string;
  userName?: string;
  signCount?: number;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface BrowserResponseInfo {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  method?: string;
  body?: () => Promise<string>;
  json?: <T = unknown>() => Promise<T>;
}

/** Raw Chrome DevTools Protocol session handle (available on both Direct CDP and Chromium Playwright engines). */
export interface CdpSessionHandle {
  /** Send any CDP command (e.g. `WebAuthn.addCredential`, `Network.setExtraHTTPHeaders`). */
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(event: string, listener: (params: Record<string, unknown>) => void): () => void;
  /** Target session ID when attached to a flat CDP target session. */
  readonly sessionId?: string;
  /** Browser context ID when running in an isolated CDP Target.createBrowserContext. */
  readonly browserContextId?: string;
}

export interface BrowserDialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  accept(promptText?: string): Promise<void>;
  dismiss(): Promise<void>;
}

export type BrowserDialogHandler = (dialog: BrowserDialogInfo) => void | Promise<void>;

export interface BrowserEmulationOptions {
  colorScheme?: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  locale?: string;
  timezoneId?: string;
}

export interface BrowserDownloadInfo {
  suggestedFilename: string;
  path: string;
  url?: string;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
  saveAs(destPath: string): Promise<void>;
}

export interface RawDriverService<_T extends string = string, R extends string = string> {
  // Flow lifecycle
  readonly beginFlow?: (flowName: string) => Effect.Effect<void, DriverError>;
  readonly getDriverLogs?: () => Effect.Effect<string[], DriverError>;

  // Hierarchy
  readonly dumpHierarchy: () => Effect.Effect<RawHierarchy, DriverError>;

  // Coordinate-level actions
  readonly tapAtCoordinate: (x: number, y: number) => Effect.Effect<void, DriverError>;
  readonly doubleTapAtCoordinate: (x: number, y: number) => Effect.Effect<void, DriverError>;
  readonly longPressAtCoordinate: (
    x: number,
    y: number,
    duration: number,
  ) => Effect.Effect<void, DriverError>;
  readonly swipe: (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number,
  ) => Effect.Effect<void, DriverError>;

  // Multi-touch gestures (mobile only)
  readonly pinch?: (
    cx: number,
    cy: number,
    scale: number,
    duration: number,
  ) => Effect.Effect<void, DriverError>;
  readonly zoom?: (
    cx: number,
    cy: number,
    scale: number,
    duration: number,
  ) => Effect.Effect<void, DriverError>;
  readonly multiTouch?: (sequences: TouchSequence[]) => Effect.Effect<void, DriverError>;

  // Text input & keyboard / pointer primitives
  readonly inputText: (text: string) => Effect.Effect<void, DriverError>;
  readonly typeText?: (text: string, opts?: { delay?: number }) => Effect.Effect<void, DriverError>;
  readonly pressKey: (key: string) => Effect.Effect<void, DriverError>;
  readonly keyDown?: (key: string) => Effect.Effect<void, DriverError>;
  readonly keyUp?: (key: string) => Effect.Effect<void, DriverError>;
  readonly mouseDown?: (
    x: number,
    y: number,
    opts?: { button?: "left" | "right" | "middle" },
  ) => Effect.Effect<void, DriverError>;
  readonly mouseUp?: (
    x: number,
    y: number,
    opts?: { button?: "left" | "right" | "middle" },
  ) => Effect.Effect<void, DriverError>;
  readonly mouseWheel?: (
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ) => Effect.Effect<void, DriverError>;
  readonly hideKeyboard: () => Effect.Effect<void, DriverError>;
  readonly getWasmMetrics?: () => Effect.Effect<WasmMetrics, DriverError>;
  readonly getWasmTraps?: () => Effect.Effect<WasmTrap[], DriverError>;

  // Queries
  readonly takeScreenshot: () => Effect.Effect<Uint8Array, DriverError>;
  readonly takeFullPageScreenshot?: () => Effect.Effect<Uint8Array, DriverError>;
  readonly getDeviceInfo: () => Effect.Effect<DeviceInfo, DriverError>;
  readonly setGeolocation?: (point: Geolocation) => Effect.Effect<void, DriverError>;
  readonly setSystemTime?: (time: Date | number | string) => Effect.Effect<void, DriverError>;
  readonly setPermission?: (
    appId: string,
    permission: string,
    state: "grant" | "deny",
    options?: PermissionOptions,
  ) => Effect.Effect<void, DriverError>;
  readonly setOrientation?: (orientation: Orientation) => Effect.Effect<void, DriverError>;
  readonly setViewport?: (size: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
  }) => Effect.Effect<void, DriverError>;
  readonly setEmulation?: (opts: BrowserEmulationOptions) => Effect.Effect<void, DriverError>;
  readonly setDialogHandler?: (
    handler: BrowserDialogHandler | null,
  ) => Effect.Effect<void, DriverError>;
  readonly dragAndDrop?: (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    steps?: number,
  ) => Effect.Effect<void, DriverError>;
  readonly getClipboard?: () => Effect.Effect<string, DriverError>;
  readonly setClipboard?: (text: string) => Effect.Effect<void, DriverError>;
  readonly waitForDownload?: (
    trigger: () => Promise<unknown>,
    opts?: { timeout?: number },
  ) => Effect.Effect<BrowserDownloadInfo, DriverError>;
  readonly setBiometricEnrollment?: (enabled: boolean) => Effect.Effect<void, DriverError>;
  readonly simulateBiometric?: (options: BiometricOptions) => Effect.Effect<void, DriverError>;
  readonly sendPushNotification?: (
    appId: string,
    payload: PushPayload,
  ) => Effect.Effect<void, DriverError>;

  // App lifecycle
  readonly launchApp: (
    bundleId: string,
    opts?: LaunchOptions<R>,
  ) => Effect.Effect<void, DriverError>;
  readonly stopApp: (bundleId: string) => Effect.Effect<void, DriverError>;
  readonly killApp: (bundleId: string) => Effect.Effect<void, DriverError>;
  readonly clearAppState: (bundleId: string) => Effect.Effect<void, DriverError>;

  // Navigation
  readonly openLink: (url: string) => Effect.Effect<void, DriverError>;
  readonly back: () => Effect.Effect<void, DriverError>;
  readonly forward?: () => Effect.Effect<void, DriverError>;
  readonly reload?: (opts?: {
    waitUntil?: "load" | "domcontentloaded" | "networkidle";
  }) => Effect.Effect<void, DriverError>;
  readonly hoverAtCoordinate?: (x: number, y: number) => Effect.Effect<void, DriverError>;
  readonly getUrl?: () => Effect.Effect<string, DriverError>;
  readonly getNavigationUrls?: () => string[];
  readonly waitForLoadState?: (
    state?: "load" | "domcontentloaded" | "networkidle",
    opts?: { timeout?: number },
  ) => Effect.Effect<void, DriverError>;
  readonly waitForPopup?: (
    trigger: () => Promise<unknown>,
    opts?: { timeout?: number },
  ) => Effect.Effect<string, DriverError>;

  // Scripting
  readonly evaluate: <T = unknown>(
    script: string | ((...args: any[]) => T),
    ...args: unknown[]
  ) => Effect.Effect<T, DriverError>;
  readonly addInitScript?: (
    script: string | ((...args: any[]) => unknown),
    ...args: unknown[]
  ) => Effect.Effect<void, DriverError>;
  readonly exposeFunction?: (
    name: string,
    fn: (...args: any[]) => any,
  ) => Effect.Effect<void, DriverError>;

  // WebView / hybrid context switching (low-level escape hatch)
  readonly getContexts?: () => Effect.Effect<string[], DriverError>;
  readonly getCurrentContext?: () => Effect.Effect<string, DriverError>;
  readonly setContext?: (contextId: string) => Effect.Effect<void, DriverError>;

  // Web-first DOM channel (spana-bridge, CDP, or WebKit Remote Inspector)
  readonly domChannel?: DomChannel;
  /** Fast reset via bridge storage clear + reload (avoids uninstall/reinstall) */
  readonly resetFast?: () => Effect.Effect<void, DriverError>;

  // Network & browser state helpers
  readonly route?: (
    matcher: BrowserRouteMatcher,
    handler: BrowserRouteHandler,
  ) => Effect.Effect<void, DriverError>;
  readonly mockNetwork?: (
    matcher: BrowserRouteMatcher,
    response: BrowserMockResponse,
  ) => Effect.Effect<void, DriverError>;
  readonly blockNetwork?: (matcher: BrowserRouteMatcher) => Effect.Effect<void, DriverError>;
  readonly clearNetworkMocks?: () => Effect.Effect<void, DriverError>;
  readonly setNetworkConditions?: (
    conditions: NetworkConditions,
  ) => Effect.Effect<void, DriverError>;
  readonly saveCookies?: (path: string) => Effect.Effect<void, DriverError>;
  readonly loadCookies?: (path: string) => Effect.Effect<void, DriverError>;
  readonly getCookies?: (urls?: string[]) => Effect.Effect<BrowserCookie[], DriverError>;
  readonly setCookies?: (cookies: BrowserCookie[]) => Effect.Effect<void, DriverError>;
  readonly clearCookies?: () => Effect.Effect<void, DriverError>;
  readonly saveAuthState?: (path: string) => Effect.Effect<void, DriverError>;
  readonly loadAuthState?: (path: string) => Effect.Effect<void, DriverError>;
  readonly downloadFile?: (path: string) => Effect.Effect<void, DriverError>;
  readonly uploadFile?: (
    selector: Selector,
    path: UploadFileInput,
  ) => Effect.Effect<void, DriverError>;
  readonly onRequest?: (listener: (req: BrowserRequestInfo) => void) => () => void;
  readonly waitForRequest?: (
    matcher: BrowserRouteMatcher | ((req: BrowserRequestInfo) => boolean),
    opts?: { timeout?: number },
  ) => Effect.Effect<BrowserRequestInfo, DriverError>;
  readonly waitForResponse?: (
    matcher: BrowserRouteMatcher | ((res: BrowserResponseInfo) => boolean),
    opts?: { timeout?: number },
  ) => Effect.Effect<BrowserResponseInfo, DriverError>;
  readonly createIsolatedContext?: (opts?: {
    url?: string;
    locale?: string;
    viewport?: { width: number; height: number };
  }) => Effect.Effect<{ driver: RawDriverService; close: () => Promise<void> }, DriverError>;
  readonly newTab?: (url?: string) => Effect.Effect<string, DriverError>;
  readonly switchToTab?: (index: number) => Effect.Effect<void, DriverError>;
  readonly closeTab?: () => Effect.Effect<void, DriverError>;
  readonly getTabIds?: () => Effect.Effect<string[], DriverError>;
  readonly getConsoleLogs?: () => Effect.Effect<BrowserConsoleLog[], DriverError>;
  readonly getJSErrors?: () => Effect.Effect<BrowserJSError[], DriverError>;
  readonly getHAR?: () => Effect.Effect<BrowserHAR, DriverError>;

  // Raw escape hatch & built-in WebAuthn virtual passkey support
  readonly getRawPage?: () => unknown;
  readonly getAriaSnapshot?: (
    selector: Selector,
    timeout?: number,
  ) => Effect.Effect<string, DriverError>;
  readonly startJSCoverage?: () => Effect.Effect<void, DriverError>;
  readonly stopJSCoverage?: () => Effect.Effect<unknown[], DriverError>;
  readonly getCdpSession?: () => CdpSessionHandle | undefined;
  readonly enableVirtualAuthenticator?: (
    opts?: VirtualAuthenticatorOptions,
  ) => Effect.Effect<string, DriverError>;
  readonly removeVirtualAuthenticator?: (
    authenticatorId?: string,
  ) => Effect.Effect<void, DriverError>;
  readonly getVirtualCredentials?: (
    authenticatorId?: string,
  ) => Effect.Effect<VirtualCredential[], DriverError>;
  readonly addVirtualCredential?: (
    credential: VirtualCredentialInput,
    authenticatorId?: string,
  ) => Effect.Effect<void, DriverError>;
  readonly clearVirtualCredentials?: (authenticatorId?: string) => Effect.Effect<void, DriverError>;
}

// Non-generic Context.Service — the Effect runtime always resolves to the default
// string-string instantiation; type parameters only matter at the call-site.
export class RawDriver extends Context.Service<RawDriver, RawDriverService>()("RawDriver") {}

type DriverEffect<A> = Effect.Effect<A, DriverError>;

function appendDriverLog(logs: string[], message: string): void {
  logs.push(`[${new Date().toISOString()}] ${message}`);
}

function wrapLoggedMethod<Args extends unknown[], A>(
  logs: string[],
  methodName: string,
  fn: (...args: Args) => DriverEffect<A>,
): (...args: Args) => DriverEffect<A> {
  return (...args: Args) => {
    const startedAt = Date.now();
    appendDriverLog(logs, `${methodName} started`);

    return fn(...args).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          appendDriverLog(logs, `${methodName} succeeded (${Date.now() - startedAt}ms)`);
        }),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          appendDriverLog(
            logs,
            `${methodName} failed (${Date.now() - startedAt}ms): ${error.message}`,
          );
        }),
      ),
    );
  };
}

function wrapOptionalMethod<Args extends unknown[], A>(
  logs: string[],
  methodName: string,
  fn: ((...args: Args) => DriverEffect<A>) | undefined,
): ((...args: Args) => DriverEffect<A>) | undefined {
  return fn ? wrapLoggedMethod(logs, methodName, fn) : undefined;
}

export function withBufferedDriverLogs(driver: RawDriverService): RawDriverService {
  const logs: string[] = [];

  return {
    ...driver,
    beginFlow: (flowName: string) => {
      logs.length = 0;
      appendDriverLog(logs, `beginFlow ${flowName}`);

      const startedAt = Date.now();
      const effect = driver.beginFlow ? driver.beginFlow(flowName) : Effect.void;

      return effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            appendDriverLog(logs, `beginFlow ready (${Date.now() - startedAt}ms)`);
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            appendDriverLog(
              logs,
              `beginFlow failed (${Date.now() - startedAt}ms): ${error.message}`,
            );
          }),
        ),
      );
    },
    getDriverLogs: () => Effect.succeed([...logs]),
    dumpHierarchy: wrapLoggedMethod(logs, "dumpHierarchy", driver.dumpHierarchy),
    tapAtCoordinate: wrapLoggedMethod(logs, "tapAtCoordinate", driver.tapAtCoordinate),
    doubleTapAtCoordinate: wrapLoggedMethod(
      logs,
      "doubleTapAtCoordinate",
      driver.doubleTapAtCoordinate,
    ),
    longPressAtCoordinate: wrapLoggedMethod(
      logs,
      "longPressAtCoordinate",
      driver.longPressAtCoordinate,
    ),
    swipe: wrapLoggedMethod(logs, "swipe", driver.swipe),
    pinch: wrapOptionalMethod(logs, "pinch", driver.pinch),
    zoom: wrapOptionalMethod(logs, "zoom", driver.zoom),
    multiTouch: wrapOptionalMethod(logs, "multiTouch", driver.multiTouch),
    inputText: wrapLoggedMethod(logs, "inputText", driver.inputText),
    typeText: wrapOptionalMethod(logs, "typeText", driver.typeText),
    pressKey: wrapLoggedMethod(logs, "pressKey", driver.pressKey),
    keyDown: wrapOptionalMethod(logs, "keyDown", driver.keyDown),
    keyUp: wrapOptionalMethod(logs, "keyUp", driver.keyUp),
    mouseDown: wrapOptionalMethod(logs, "mouseDown", driver.mouseDown),
    mouseUp: wrapOptionalMethod(logs, "mouseUp", driver.mouseUp),
    hideKeyboard: wrapLoggedMethod(logs, "hideKeyboard", driver.hideKeyboard),
    takeScreenshot: wrapLoggedMethod(logs, "takeScreenshot", driver.takeScreenshot),
    takeFullPageScreenshot: wrapOptionalMethod(
      logs,
      "takeFullPageScreenshot",
      driver.takeFullPageScreenshot,
    ),
    getDeviceInfo: wrapLoggedMethod(logs, "getDeviceInfo", driver.getDeviceInfo),
    setGeolocation: wrapOptionalMethod(logs, "setGeolocation", driver.setGeolocation),
    setSystemTime: wrapOptionalMethod(logs, "setSystemTime", driver.setSystemTime),
    setPermission: wrapOptionalMethod(logs, "setPermission", driver.setPermission),
    setOrientation: wrapOptionalMethod(logs, "setOrientation", driver.setOrientation),
    setViewport: wrapOptionalMethod(logs, "setViewport", driver.setViewport),
    setEmulation: wrapOptionalMethod(logs, "setEmulation", driver.setEmulation),
    setDialogHandler: wrapOptionalMethod(logs, "setDialogHandler", driver.setDialogHandler),
    dragAndDrop: wrapOptionalMethod(logs, "dragAndDrop", driver.dragAndDrop),
    getClipboard: wrapOptionalMethod(logs, "getClipboard", driver.getClipboard),
    setClipboard: wrapOptionalMethod(logs, "setClipboard", driver.setClipboard),
    waitForDownload: wrapOptionalMethod(logs, "waitForDownload", driver.waitForDownload),
    setBiometricEnrollment: wrapOptionalMethod(
      logs,
      "setBiometricEnrollment",
      driver.setBiometricEnrollment,
    ),
    simulateBiometric: wrapOptionalMethod(logs, "simulateBiometric", driver.simulateBiometric),
    sendPushNotification: wrapOptionalMethod(
      logs,
      "sendPushNotification",
      driver.sendPushNotification,
    ),
    launchApp: wrapLoggedMethod(logs, "launchApp", driver.launchApp),
    stopApp: wrapLoggedMethod(logs, "stopApp", driver.stopApp),
    killApp: wrapLoggedMethod(logs, "killApp", driver.killApp),
    clearAppState: wrapLoggedMethod(logs, "clearAppState", driver.clearAppState),
    openLink: wrapLoggedMethod(logs, "openLink", driver.openLink),
    back: wrapLoggedMethod(logs, "back", driver.back),
    forward: wrapOptionalMethod(logs, "forward", driver.forward),
    reload: wrapOptionalMethod(logs, "reload", driver.reload),
    hoverAtCoordinate: wrapOptionalMethod(logs, "hoverAtCoordinate", driver.hoverAtCoordinate),
    getUrl: wrapOptionalMethod(logs, "getUrl", driver.getUrl),
    getNavigationUrls: driver.getNavigationUrls,
    waitForLoadState: wrapOptionalMethod(logs, "waitForLoadState", driver.waitForLoadState),
    waitForPopup: wrapOptionalMethod(logs, "waitForPopup", driver.waitForPopup),
    evaluate: wrapLoggedMethod(logs, "evaluate", driver.evaluate),
    addInitScript: wrapOptionalMethod(logs, "addInitScript", driver.addInitScript),
    exposeFunction: wrapOptionalMethod(logs, "exposeFunction", driver.exposeFunction),
    getContexts: wrapOptionalMethod(logs, "getContexts", driver.getContexts),
    getCurrentContext: wrapOptionalMethod(logs, "getCurrentContext", driver.getCurrentContext),
    setContext: wrapOptionalMethod(logs, "setContext", driver.setContext),
    domChannel: driver.domChannel,
    resetFast: wrapOptionalMethod(logs, "resetFast", driver.resetFast),
    route: wrapOptionalMethod(logs, "route", driver.route),
    mockNetwork: wrapOptionalMethod(logs, "mockNetwork", driver.mockNetwork),
    blockNetwork: wrapOptionalMethod(logs, "blockNetwork", driver.blockNetwork),
    clearNetworkMocks: wrapOptionalMethod(logs, "clearNetworkMocks", driver.clearNetworkMocks),
    setNetworkConditions: wrapOptionalMethod(
      logs,
      "setNetworkConditions",
      driver.setNetworkConditions,
    ),
    saveCookies: wrapOptionalMethod(logs, "saveCookies", driver.saveCookies),
    loadCookies: wrapOptionalMethod(logs, "loadCookies", driver.loadCookies),
    getCookies: wrapOptionalMethod(logs, "getCookies", driver.getCookies),
    setCookies: wrapOptionalMethod(logs, "setCookies", driver.setCookies),
    clearCookies: wrapOptionalMethod(logs, "clearCookies", driver.clearCookies),
    saveAuthState: wrapOptionalMethod(logs, "saveAuthState", driver.saveAuthState),
    loadAuthState: wrapOptionalMethod(logs, "loadAuthState", driver.loadAuthState),
    downloadFile: wrapOptionalMethod(logs, "downloadFile", driver.downloadFile),
    uploadFile: wrapOptionalMethod(logs, "uploadFile", driver.uploadFile),
    onRequest: driver.onRequest,
    waitForRequest: wrapOptionalMethod(logs, "waitForRequest", driver.waitForRequest),
    waitForResponse: wrapOptionalMethod(logs, "waitForResponse", driver.waitForResponse),
    createIsolatedContext: wrapOptionalMethod(
      logs,
      "createIsolatedContext",
      driver.createIsolatedContext,
    ),
    newTab: wrapOptionalMethod(logs, "newTab", driver.newTab),
    switchToTab: wrapOptionalMethod(logs, "switchToTab", driver.switchToTab),
    closeTab: wrapOptionalMethod(logs, "closeTab", driver.closeTab),
    getTabIds: wrapOptionalMethod(logs, "getTabIds", driver.getTabIds),
    getConsoleLogs: wrapOptionalMethod(logs, "getConsoleLogs", driver.getConsoleLogs),
    getJSErrors: wrapOptionalMethod(logs, "getJSErrors", driver.getJSErrors),
    getHAR: wrapOptionalMethod(logs, "getHAR", driver.getHAR),
    getRawPage: driver.getRawPage,
    getAriaSnapshot: wrapOptionalMethod(logs, "getAriaSnapshot", driver.getAriaSnapshot),
    startJSCoverage: wrapOptionalMethod(logs, "startJSCoverage", driver.startJSCoverage),
    stopJSCoverage: wrapOptionalMethod(logs, "stopJSCoverage", driver.stopJSCoverage),
    getCdpSession: driver.getCdpSession,
    enableVirtualAuthenticator: wrapOptionalMethod(
      logs,
      "enableVirtualAuthenticator",
      driver.enableVirtualAuthenticator,
    ),
    removeVirtualAuthenticator: wrapOptionalMethod(
      logs,
      "removeVirtualAuthenticator",
      driver.removeVirtualAuthenticator,
    ),
    getVirtualCredentials: wrapOptionalMethod(
      logs,
      "getVirtualCredentials",
      driver.getVirtualCredentials,
    ),
    addVirtualCredential: wrapOptionalMethod(
      logs,
      "addVirtualCredential",
      driver.addVirtualCredential,
    ),
    clearVirtualCredentials: wrapOptionalMethod(
      logs,
      "clearVirtualCredentials",
      driver.clearVirtualCredentials,
    ),
  };
}
