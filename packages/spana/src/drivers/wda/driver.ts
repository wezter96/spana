import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import type { RawDriverService, LaunchOptions } from "../raw-driver.js";
import { WDAClient } from "./client.js";
import {
  installedUrlSchemesOnSimulator,
  launchOnSimulator,
  launchWithUrlOnSimulator,
  terminateOnSimulator,
  resetSimulatorKeychain,
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

    const createSessionWithRetry = async (targetBundleId?: string) => {
      let lastError: unknown;

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await client.createSession(targetBundleId);
        } catch (error) {
          lastError = error;
          if (attempt === 4) {
            throw error;
          }
          await sleep(1000);
        }
      }

      throw lastError ?? new Error("Failed to create WDA session");
    };

    const isSessionError = (error: unknown): boolean => {
      const msg = String(error).toLowerCase();
      return (
        msg.includes("session does not exist") ||
        msg.includes("unable to connect") ||
        msg.includes("no active session") ||
        msg.includes("invalid session") ||
        /status[:\s]*404/.test(msg)
      );
    };

    const withSessionRecovery = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (!isSessionError(error)) throw error;
        // Session lost — recreate and retry
        try {
          await client.deleteSession();
        } catch {
          /* already gone */
        }
        await createSessionWithRetry(bundleId || undefined);
        try {
          await client.disableQuiescence();
        } catch {
          /* non-critical — quiescence setting may fail on fresh sessions */
        }
        return await fn();
      }
    };

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

      try {
        await activateSimulatorApp(targetBundleId);
        await client.openUrl(url);
        await sleep(1000);
        return;
      } catch {
        // Some simulator sessions lose their WDA attachment while the app stays
        // alive. Recreate the session and retry /url once before falling back
        // to a simulator relaunch.
        try {
          await client.deleteSession();
        } catch {
          /* old session may already be gone */
        }

        try {
          await createSessionWithRetry(targetBundleId);
          await client.disableQuiescence();
          await activateSimulatorApp(targetBundleId);
          await client.openUrl(url);
          await sleep(1000);
          return;
        } catch {
          // Fall back to simulator relaunch below if WDA still can't route the
          // URL through the active session on this environment.
        }
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
          // Terminate app first, then relaunch with the URL to bypass the
          // system confirmation dialog that simctl openurl can trigger.
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
          await createSessionWithRetry(targetBundleId);
          await client.disableQuiescence();
          await activateSimulatorApp(targetBundleId);
          return;
        } catch (error) {
          lastError = error;
        }
      }

      // All candidates failed — ensure we still have a valid session
      // so subsequent operations don't fail with "no active session"
      if (!client.hasSession()) {
        try {
          await createSessionWithRetry(targetBundleId);
          await client.disableQuiescence();
        } catch {
          // Session recovery failed — will surface on next operation
        }
      }

      throw lastError ?? new Error(`Failed to open URL: ${url}`);
    };

    // Create session — must succeed before we can do anything
    yield* Effect.tryPromise({
      try: () => createSessionWithRetry(bundleId || undefined),
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
          try: () => withSessionRecovery(() => client.getSource()),
          catch: (e) => new DriverError({ message: `Failed to get page source: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Coordinate-level actions
      // -----------------------------------------------------------------------
      tapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => withSessionRecovery(() => client.tap(x, y)),
          catch: (e) => new DriverError({ message: `Tap failed: ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: () => withSessionRecovery(() => client.doubleTap(x, y)),
          catch: (e) => new DriverError({ message: `Double tap failed: ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          // duration arrives in ms (spana convention) → convert to seconds for WDA
          try: () => withSessionRecovery(() => client.longPress(x, y, msToSec(duration))),
          catch: (e) => new DriverError({ message: `Long press failed: ${e}` }),
        }),

      swipe: (sx, sy, ex, ey, dur) =>
        Effect.tryPromise({
          // dur arrives in ms → convert to seconds for WDA.
          // Clamp Y to avoid iOS system gesture zones (home indicator / App Switcher).
          try: async () => {
            let csy = sy;
            let cey = ey;
            try {
              const size = await client.getWindowSize();
              const minY = size.height * 0.15;
              const maxY = size.height * 0.85;
              csy = Math.max(minY, Math.min(maxY, sy));
              cey = Math.max(minY, Math.min(maxY, ey));
            } catch {
              /* use original coordinates if getWindowSize fails */
            }
            await client.swipe(sx, csy, ex, cey, msToSec(dur));
          },
          catch: (e) => new DriverError({ message: `Swipe failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Text input
      // -----------------------------------------------------------------------
      inputText: (text) =>
        Effect.tryPromise({
          try: () => withSessionRecovery(() => client.sendKeys(text)),
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
          // Dismiss keyboard by tapping above the keyboard area.
          // The previous approach (pressHome) backgrounds the app on iOS.
          try: async () => {
            const size = await client.getWindowSize();
            await client.tap(size.width / 2, Math.round(size.height * 0.2));
            await sleep(300);
          },
          catch: (e) => new DriverError({ message: `Hide keyboard failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Queries
      // -----------------------------------------------------------------------
      takeScreenshot: () =>
        Effect.tryPromise({
          try: () => withSessionRecovery(() => client.getScreenshot()),
          catch: (e) => new DriverError({ message: `Screenshot failed: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.tryPromise({
          try: async () => {
            const size = await withSessionRecovery(() => client.getWindowSize());
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
            if (opts?.clearState && simulatorUdid) {
              terminateOnSimulator(simulatorUdid, appBundleId);
              try {
                const { execSync } = await import("node:child_process");
                execSync(`xcrun simctl privacy ${simulatorUdid} reset all ${appBundleId}`, {
                  stdio: "ignore",
                });
              } catch {
                // Ignore — privacy reset may not be available on older Xcode
              }
            }
            if (opts?.clearKeychain && simulatorUdid) {
              resetSimulatorKeychain(simulatorUdid);
            } else if (opts?.clearKeychain) {
              console.warn("clearKeychain is only supported on iOS simulators, skipping.");
            }

            if (simulatorUdid) {
              if (opts?.deepLink) {
                await openSimulatorUrl(opts.deepLink, appBundleId);
              } else {
                // Terminate first to reset navigation state (ignore errors —
                // app may not be running or session may be stale).
                try {
                  await client.terminateApp(appBundleId);
                } catch {
                  try {
                    terminateOnSimulator(simulatorUdid, appBundleId);
                  } catch {
                    /* app may not be running */
                  }
                }
                await sleep(300);
                // Relaunch via WDA to keep session attached
                try {
                  await client.launchApp(appBundleId);
                  await sleep(500);
                } catch {
                  // WDA launch failed — fall back to simctl + session recreation
                  launchOnSimulator(simulatorUdid, appBundleId);
                  await sleep(500);
                  try {
                    await client.deleteSession();
                  } catch {
                    /* old session may be gone */
                  }
                  await createSessionWithRetry(appBundleId);
                  try {
                    await client.disableQuiescence();
                  } catch {
                    /* non-critical */
                  }
                }
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

      evaluate: () =>
        Effect.fail(
          new DriverError({
            message:
              "evaluate() requires a WebView context. Use Appium mode (--driver appium) for iOS WebView support.",
          }),
        ),

      getContexts: () =>
        Effect.fail(
          new DriverError({
            message:
              "WebView context switching requires Appium mode. Use --driver appium with an Appium server that supports XCUITest.",
          }),
        ),

      getCurrentContext: () => Effect.succeed("NATIVE_APP"),

      setContext: (contextId: string) =>
        contextId === "NATIVE_APP"
          ? Effect.void
          : Effect.fail(
              new DriverError({
                message:
                  "WebView context switching requires Appium mode. Use --driver appium with an Appium server that supports XCUITest.",
              }),
            ),
    };

    return service;
  });
}
