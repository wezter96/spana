import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import type { RawDriverService, LaunchOptions } from "../raw-driver.js";
import { WDAClient } from "./client.js";
import {
  installedUrlSchemesOnSimulator,
  launchOnSimulator,
  launchWithUrlOnSimulator,
  terminateOnSimulator,
} from "../../device/ios.js";

/**
 * Converts a millisecond duration (spana convention) to seconds (WDA convention).
 */
function msToSec(ms: number): number {
  return ms / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replaceUrlScheme(url: string, scheme: string): string | null {
  const match = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/.*)$/);
  if (!match) return null;
  return `${scheme}:${match[2]}`;
}

export function createWDADriver(
  host: string,
  port: number,
  bundleId: string,
  simulatorUdid?: string,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const client = new WDAClient(host, port);

    const activateSimulatorApp = async (targetBundleId: string) => {
      if (!targetBundleId) return;
      await client.activateApp(targetBundleId);
      await sleep(1000);
    };

    const openSimulatorUrl = async (url: string, targetBundleId = bundleId) => {
      if (!simulatorUdid) {
        await client.openUrl(url);
        return;
      }

      const fallbackSchemes = installedUrlSchemesOnSimulator(simulatorUdid, targetBundleId);
      const candidates = [
        url,
        ...fallbackSchemes
          .map((scheme) => replaceUrlScheme(url, scheme))
          .filter((candidate): candidate is string => Boolean(candidate)),
      ].filter((candidate, index, all) => all.indexOf(candidate) === index);

      let lastError: unknown;

      for (const candidate of candidates) {
        try {
          // Terminate app first, then launch with URL to bypass system dialog
          terminateOnSimulator(simulatorUdid, targetBundleId);
          await sleep(500);
          launchWithUrlOnSimulator(simulatorUdid, targetBundleId, candidate);
          await sleep(1500);
          // Re-create WDA session to attach to the freshly launched app
          try {
            await client.deleteSession();
          } catch {
            /* old session may be stale */
          }
          await client.createSession(targetBundleId);
          await client.disableQuiescence();
          await sleep(500);
          return;
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError ?? new Error(`Failed to open URL: ${url}`);
    };

    // Create session — must succeed before we can do anything
    yield* Effect.tryPromise({
      try: () => client.createSession(bundleId || undefined),
      catch: (e) => new DriverError({ message: `Failed to create WDA session: ${e}` }),
    });

    // Disable quiescence to prevent XCTest crashes on animated UIs
    yield* Effect.tryPromise({
      try: () => client.disableQuiescence(),
      catch: (e) => new DriverError({ message: `Failed to disable quiescence: ${e}` }),
    });

    const service: RawDriverService = {
      // -----------------------------------------------------------------------
      // Hierarchy
      // -----------------------------------------------------------------------
      dumpHierarchy: () =>
        Effect.tryPromise({
          try: () => client.getSource(),
          catch: (e) => new DriverError({ message: `Failed to get page source: ${e}` }),
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
          catch: (e) => new DriverError({ message: `Double tap failed: ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          // duration arrives in ms (spana convention) → convert to seconds for WDA
          try: () => client.longPress(x, y, msToSec(duration)),
          catch: (e) => new DriverError({ message: `Long press failed: ${e}` }),
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
          catch: (e) => new DriverError({ message: `Input text failed: ${e}` }),
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
          catch: (e) => new DriverError({ message: `Press key failed: ${e}` }),
        }),

      hideKeyboard: () =>
        Effect.tryPromise({
          // WDA hides the keyboard when no text field has focus; pressing home
          // is the most reliable cross-version approach.
          try: () => client.pressHome(),
          catch: (e) => new DriverError({ message: `Hide keyboard failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Queries
      // -----------------------------------------------------------------------
      takeScreenshot: () =>
        Effect.tryPromise({
          try: () => client.getScreenshot(),
          catch: (e) => new DriverError({ message: `Screenshot failed: ${e}` }),
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
          catch: (e) => new DriverError({ message: `Get device info failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // App lifecycle
      // -----------------------------------------------------------------------
      launchApp: (appBundleId, opts?: LaunchOptions) =>
        Effect.tryPromise({
          try: async () => {
            if (simulatorUdid) {
              if (opts?.deepLink) {
                await openSimulatorUrl(opts.deepLink, appBundleId);
              } else {
                launchOnSimulator(simulatorUdid, appBundleId);
                await sleep(500);
                await activateSimulatorApp(appBundleId);
              }
              return;
            }

            await (opts?.deepLink ? client.openUrl(opts.deepLink) : client.launchApp(appBundleId));
          },
          catch: (e) => new DriverError({ message: `Launch app failed: ${e}` }),
        }),

      stopApp: (appBundleId) =>
        Effect.tryPromise({
          try: () => {
            if (simulatorUdid) {
              terminateOnSimulator(simulatorUdid, appBundleId);
              return Promise.resolve();
            }

            return client.terminateApp(appBundleId);
          },
          catch: (e) => new DriverError({ message: `Stop app failed: ${e}` }),
        }),

      killApp: (appBundleId) =>
        Effect.tryPromise({
          try: () => {
            if (simulatorUdid) {
              terminateOnSimulator(simulatorUdid, appBundleId);
              return Promise.resolve();
            }

            return client.terminateApp(appBundleId);
          },
          catch: (e) => new DriverError({ message: `Kill app failed: ${e}` }),
        }),

      clearAppState: (appBundleId) =>
        Effect.tryPromise({
          try: async () => {
            if (simulatorUdid) {
              terminateOnSimulator(simulatorUdid, appBundleId);
              return;
            }

            await client.terminateApp(appBundleId);
            // Full state clear (data + keychain) requires simctl / idb, which
            // are outside the scope of the HTTP-only client.
          },
          catch: (e) => new DriverError({ message: `Clear app state failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Navigation
      // -----------------------------------------------------------------------
      openLink: (url) =>
        Effect.tryPromise({
          try: async () => {
            if (simulatorUdid) {
              await openSimulatorUrl(url);
              return;
            }

            await client.openUrl(url);
          },
          catch: (e) => new DriverError({ message: `Open link failed: ${e}` }),
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
