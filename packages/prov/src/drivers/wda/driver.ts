import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import type { RawDriverService, LaunchOptions } from "../raw-driver.js";
import { WDAClient } from "./client.js";

/**
 * Converts a millisecond duration (prov convention) to seconds (WDA convention).
 */
function msToSec(ms: number): number {
  return ms / 1000;
}

export function createWDADriver(
  host: string,
  port: number,
  bundleId: string,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const client = new WDAClient(host, port);

    // Create session — must succeed before we can do anything
    yield* Effect.tryPromise({
      try: () => client.createSession(), // Don't attach to app during session creation — launchApp handles it
      catch: (e) =>
        new DriverError({ message: `Failed to create WDA session: ${e}` }),
    });

    // Disable quiescence to prevent XCTest crashes on animated UIs
    yield* Effect.tryPromise({
      try: () => client.disableQuiescence(),
      catch: (e) =>
        new DriverError({ message: `Failed to disable quiescence: ${e}` }),
    });

    const service: RawDriverService = {
      // -----------------------------------------------------------------------
      // Hierarchy
      // -----------------------------------------------------------------------
      dumpHierarchy: () =>
        Effect.tryPromise({
          try: () => client.getSource(),
          catch: (e) =>
            new DriverError({ message: `Failed to get page source: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Coordinate-level actions
      // -----------------------------------------------------------------------
      tapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => client.tap(x, y),
          catch: (e) => new DriverError({ message: `Tap failed: ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => client.doubleTap(x, y),
          catch: (e) =>
            new DriverError({ message: `Double tap failed: ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          // duration arrives in ms (prov convention) → convert to seconds for WDA
          try: () => client.longPress(x, y, msToSec(duration)),
          catch: (e) =>
            new DriverError({ message: `Long press failed: ${e}` }),
        }),

      swipe: (sx, sy, ex, ey, dur) =>
        Effect.tryPromise({
          // dur arrives in ms → convert to seconds for WDA
          try: () => client.swipe(sx, sy, ex, ey, msToSec(dur)),
          catch: (e) => new DriverError({ message: `Swipe failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Text input
      // -----------------------------------------------------------------------
      inputText: (text) =>
        Effect.tryPromise({
          try: () => client.sendKeys(text),
          catch: (e) =>
            new DriverError({ message: `Input text failed: ${e}` }),
        }),

      pressKey: (key) =>
        Effect.tryPromise({
          // WDA uses named hardware buttons; map common names, fall back to home
          try: async () => {
            const buttonMap: Record<string, string> = {
              home: "home",
              volumeup: "volumeUp",
              volumedown: "volumeDown",
            };
            const button = buttonMap[key.toLowerCase()];
            if (button) {
              await client.pressButton(button);
            }
            // Keys not mappable to a WDA button are silently ignored — callers
            // targeting Android key codes should use the UiAutomator2 driver.
          },
          catch: (e) =>
            new DriverError({ message: `Press key failed: ${e}` }),
        }),

      hideKeyboard: () =>
        Effect.tryPromise({
          // WDA hides the keyboard when no text field has focus; pressing home
          // is the most reliable cross-version approach.
          try: () => client.pressHome(),
          catch: (e) =>
            new DriverError({ message: `Hide keyboard failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Queries
      // -----------------------------------------------------------------------
      takeScreenshot: () =>
        Effect.tryPromise({
          try: () => client.getScreenshot(),
          catch: (e) =>
            new DriverError({ message: `Screenshot failed: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.tryPromise({
          try: async () => {
            const size = await client.getWindowSize();
            return {
              platform: "ios" as const,
              deviceId: `${host}:${port}`,
              name: "iOS Device",
              isEmulator: host === "localhost" || host === "127.0.0.1",
              screenWidth: size.width,
              screenHeight: size.height,
              driverType: "wda" as const,
            };
          },
          catch: (e) =>
            new DriverError({ message: `Get device info failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // App lifecycle
      // -----------------------------------------------------------------------
      launchApp: (appBundleId, _opts?: LaunchOptions) =>
        Effect.tryPromise({
          try: () => client.launchApp(appBundleId),
          catch: (e) =>
            new DriverError({ message: `Launch app failed: ${e}` }),
        }),

      stopApp: (appBundleId) =>
        Effect.tryPromise({
          try: () => client.terminateApp(appBundleId),
          catch: (e) =>
            new DriverError({ message: `Stop app failed: ${e}` }),
        }),

      killApp: (appBundleId) =>
        Effect.tryPromise({
          try: () => client.terminateApp(appBundleId),
          catch: (e) =>
            new DriverError({ message: `Kill app failed: ${e}` }),
        }),

      clearAppState: (appBundleId) =>
        Effect.tryPromise({
          try: async () => {
            await client.terminateApp(appBundleId);
            // Full state clear (data + keychain) requires simctl / idb, which
            // are outside the scope of the HTTP-only client.
          },
          catch: (e) =>
            new DriverError({ message: `Clear app state failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Navigation
      // -----------------------------------------------------------------------
      openLink: (url) =>
        Effect.tryPromise({
          try: () => client.openUrl(url),
          catch: (e) =>
            new DriverError({ message: `Open link failed: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          // iOS has no hardware back button; pressing home is the closest
          // equivalent for dismissing the current context.
          try: () => client.pressHome(),
          catch: (e) => new DriverError({ message: `Back failed: ${e}` }),
        }),
    };

    return service;
  });
}
