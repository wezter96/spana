import { Context, Effect } from "effect";
import type { DriverError } from "../errors.js";
import type { DeviceInfo } from "../schemas/device.js";
import type { Selector } from "../schemas/selector.js";

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

export interface BrowserNetworkConditions {
  offline?: boolean;
  latencyMs?: number;
  downloadThroughputKbps?: number;
  uploadThroughputKbps?: number;
}

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

  // Text input
  readonly inputText: (text: string) => Effect.Effect<void, DriverError>;
  readonly pressKey: (key: string) => Effect.Effect<void, DriverError>;
  readonly hideKeyboard: () => Effect.Effect<void, DriverError>;

  // Queries
  readonly takeScreenshot: () => Effect.Effect<Uint8Array, DriverError>;
  readonly getDeviceInfo: () => Effect.Effect<DeviceInfo, DriverError>;

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

  // Scripting
  readonly evaluate: <T = unknown>(
    script: string | ((...args: unknown[]) => T),
    ...args: unknown[]
  ) => Effect.Effect<T, DriverError>;

  // WebView / hybrid context switching (mobile only)
  readonly getContexts?: () => Effect.Effect<string[], DriverError>;
  readonly getCurrentContext?: () => Effect.Effect<string, DriverError>;
  readonly setContext?: (contextId: string) => Effect.Effect<void, DriverError>;

  // Web-only browser state helpers
  readonly mockNetwork?: (
    matcher: BrowserRouteMatcher,
    response: BrowserMockResponse,
  ) => Effect.Effect<void, DriverError>;
  readonly blockNetwork?: (matcher: BrowserRouteMatcher) => Effect.Effect<void, DriverError>;
  readonly clearNetworkMocks?: () => Effect.Effect<void, DriverError>;
  readonly setNetworkConditions?: (
    conditions: BrowserNetworkConditions,
  ) => Effect.Effect<void, DriverError>;
  readonly saveCookies?: (path: string) => Effect.Effect<void, DriverError>;
  readonly loadCookies?: (path: string) => Effect.Effect<void, DriverError>;
  readonly saveAuthState?: (path: string) => Effect.Effect<void, DriverError>;
  readonly loadAuthState?: (path: string) => Effect.Effect<void, DriverError>;
  readonly downloadFile?: (path: string) => Effect.Effect<void, DriverError>;
  readonly uploadFile?: (selector: Selector, path: string) => Effect.Effect<void, DriverError>;
  readonly newTab?: (url?: string) => Effect.Effect<string, DriverError>;
  readonly switchToTab?: (index: number) => Effect.Effect<void, DriverError>;
  readonly closeTab?: () => Effect.Effect<void, DriverError>;
  readonly getTabIds?: () => Effect.Effect<string[], DriverError>;
  readonly getConsoleLogs?: () => Effect.Effect<BrowserConsoleLog[], DriverError>;
  readonly getJSErrors?: () => Effect.Effect<BrowserJSError[], DriverError>;
  readonly getHAR?: () => Effect.Effect<BrowserHAR, DriverError>;
}

// Non-generic Context.Tag — the Effect runtime always resolves to the default
// string-string instantiation; type parameters only matter at the call-site.
export class RawDriver extends Context.Tag("RawDriver")<RawDriver, RawDriverService>() {}

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
    pressKey: wrapLoggedMethod(logs, "pressKey", driver.pressKey),
    hideKeyboard: wrapLoggedMethod(logs, "hideKeyboard", driver.hideKeyboard),
    takeScreenshot: wrapLoggedMethod(logs, "takeScreenshot", driver.takeScreenshot),
    getDeviceInfo: wrapLoggedMethod(logs, "getDeviceInfo", driver.getDeviceInfo),
    launchApp: wrapLoggedMethod(logs, "launchApp", driver.launchApp),
    stopApp: wrapLoggedMethod(logs, "stopApp", driver.stopApp),
    killApp: wrapLoggedMethod(logs, "killApp", driver.killApp),
    clearAppState: wrapLoggedMethod(logs, "clearAppState", driver.clearAppState),
    openLink: wrapLoggedMethod(logs, "openLink", driver.openLink),
    back: wrapLoggedMethod(logs, "back", driver.back),
    evaluate: wrapLoggedMethod(logs, "evaluate", driver.evaluate),
    getContexts: wrapOptionalMethod(logs, "getContexts", driver.getContexts),
    getCurrentContext: wrapOptionalMethod(logs, "getCurrentContext", driver.getCurrentContext),
    setContext: wrapOptionalMethod(logs, "setContext", driver.setContext),
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
    saveAuthState: wrapOptionalMethod(logs, "saveAuthState", driver.saveAuthState),
    loadAuthState: wrapOptionalMethod(logs, "loadAuthState", driver.loadAuthState),
    downloadFile: wrapOptionalMethod(logs, "downloadFile", driver.downloadFile),
    uploadFile: wrapOptionalMethod(logs, "uploadFile", driver.uploadFile),
    newTab: wrapOptionalMethod(logs, "newTab", driver.newTab),
    switchToTab: wrapOptionalMethod(logs, "switchToTab", driver.switchToTab),
    closeTab: wrapOptionalMethod(logs, "closeTab", driver.closeTab),
    getTabIds: wrapOptionalMethod(logs, "getTabIds", driver.getTabIds),
    getConsoleLogs: wrapOptionalMethod(logs, "getConsoleLogs", driver.getConsoleLogs),
    getJSErrors: wrapOptionalMethod(logs, "getJSErrors", driver.getJSErrors),
    getHAR: wrapOptionalMethod(logs, "getHAR", driver.getHAR),
  };
}
