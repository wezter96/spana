import { Context, type Effect } from "effect";
import type { DriverError } from "../errors.js";
import type { DeviceInfo } from "../schemas/device.js";

export type RawHierarchy = string; // Raw XML (Android/iOS) or JSON (web) — parsed by platform-specific parsers

export interface LaunchOptions {
  clearState?: boolean;
  clearKeychain?: boolean;
  deepLink?: string;
  launchArguments?: Record<string, unknown>;
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

export interface RawDriverService {
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

  // Text input
  readonly inputText: (text: string) => Effect.Effect<void, DriverError>;
  readonly pressKey: (key: string) => Effect.Effect<void, DriverError>;
  readonly hideKeyboard: () => Effect.Effect<void, DriverError>;

  // Queries
  readonly takeScreenshot: () => Effect.Effect<Uint8Array, DriverError>;
  readonly getDeviceInfo: () => Effect.Effect<DeviceInfo, DriverError>;

  // App lifecycle
  readonly launchApp: (bundleId: string, opts?: LaunchOptions) => Effect.Effect<void, DriverError>;
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
  readonly getConsoleLogs?: () => Effect.Effect<BrowserConsoleLog[], DriverError>;
  readonly getJSErrors?: () => Effect.Effect<BrowserJSError[], DriverError>;
}

export class RawDriver extends Context.Tag("RawDriver")<RawDriver, RawDriverService>() {}
