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

export interface RawDriverService {
  // Hierarchy
  readonly dumpHierarchy: () => Effect.Effect<RawHierarchy, DriverError>;

  // Coordinate-level actions
  readonly tapAtCoordinate: (x: number, y: number) => Effect.Effect<void, DriverError>;
  readonly doubleTapAtCoordinate: (x: number, y: number) => Effect.Effect<void, DriverError>;
  readonly longPressAtCoordinate: (x: number, y: number, duration: number) => Effect.Effect<void, DriverError>;
  readonly swipe: (startX: number, startY: number, endX: number, endY: number, duration: number) => Effect.Effect<void, DriverError>;

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
}

export class RawDriver extends Context.Tag("RawDriver")<RawDriver, RawDriverService>() {}
