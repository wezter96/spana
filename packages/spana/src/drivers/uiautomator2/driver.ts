import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import { adbLaunchApp, adbForceStop, adbClearApp, adbOpenLink } from "../../device/android.js";
import type { RawDriverService, LaunchOptions } from "../raw-driver.js";
import { UiAutomator2Client } from "./client.js";

export function createUiAutomator2Driver(
  host: string,
  port: number,
  serial: string,
  packageName: string,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const client = new UiAutomator2Client(host, port);

    // Create session — must succeed before we can do anything
    yield* Effect.tryPromise({
      try: () => client.createSession(packageName),
      catch: (e) =>
        new DriverError({
          message: `Failed to create UiAutomator2 session: ${e}`,
        }),
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
          try: () => client.performTap(x, y),
          catch: (e) => new DriverError({ message: `Tap failed: ${e}` }),
        }),

      doubleTapAtCoordinate: (x, y) =>
        Effect.tryPromise({
          try: async () => {
            // Use two quick taps instead of native double-click gesture,
            // because React Native Pressable treats onPress as individual taps
            // and the native double_click gesture doesn't fire onPress twice.
            // Send both taps as fast as possible — the React handler
            // checks Date.now() gap < 400ms between onPress events.
            // Network latency to UiAutomator2 server adds ~100-200ms per tap,
            // so we don't add any extra delay.
            await client.performTap(x, y);
            await client.performTap(x, y);
          },
          catch: (e) => new DriverError({ message: `Double tap failed: ${e}` }),
        }),

      longPressAtCoordinate: (x, y, duration) =>
        Effect.tryPromise({
          try: () => client.performLongPress(x, y, duration),
          catch: (e) => new DriverError({ message: `Long press failed: ${e}` }),
        }),

      swipe: (sx, sy, ex, ey, dur) =>
        Effect.tryPromise({
          try: () => client.performSwipe(sx, sy, ex, ey, dur),
          catch: (e) => new DriverError({ message: `Swipe failed: ${e}` }),
        }),

      pinch: (cx, cy, scale, duration) =>
        Effect.tryPromise({
          try: () => client.performPinch(cx, cy, scale, duration),
          catch: (e) => new DriverError({ message: `Pinch failed: ${e}` }),
        }),

      zoom: (cx, cy, scale, duration) =>
        Effect.tryPromise({
          try: () => client.performZoom(cx, cy, scale, duration),
          catch: (e) => new DriverError({ message: `Zoom failed: ${e}` }),
        }),

      multiTouch: (sequences) =>
        Effect.tryPromise({
          try: () => client.performMultiTouch(sequences),
          catch: (e) => new DriverError({ message: `Multi-touch failed: ${e}` }),
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
          try: () => client.pressKeyCode(parseInt(key, 10) || 0),
          catch: (e) => new DriverError({ message: `Press key failed: ${e}` }),
        }),

      hideKeyboard: () =>
        Effect.tryPromise({
          try: () => client.hideKeyboard(),
          catch: (e) => new DriverError({ message: `Hide keyboard failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Queries
      // -----------------------------------------------------------------------
      takeScreenshot: () =>
        Effect.tryPromise({
          try: async () => {
            const base64 = await client.getScreenshot();
            return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          },
          catch: (e) => new DriverError({ message: `Screenshot failed: ${e}` }),
        }),

      getDeviceInfo: () =>
        Effect.tryPromise({
          try: async () => {
            const size = await client.getWindowSize();
            return {
              platform: "android" as const,
              deviceId: `${host}:${port}`,
              name: "Android Device",
              isEmulator: host === "localhost" || host === "127.0.0.1",
              screenWidth: size.width,
              screenHeight: size.height,
              driverType: "uiautomator2" as const,
            };
          },
          catch: (e) => new DriverError({ message: `Get device info failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // App lifecycle
      // -----------------------------------------------------------------------
      launchApp: (bundleId, opts?: LaunchOptions) =>
        Effect.tryPromise({
          try: async () => {
            if (opts?.clearState) {
              adbClearApp(serial, bundleId);
            }
            if (opts?.clearKeychain) {
              console.warn("clearKeychain is not supported on Android, skipping.");
            }
            if (opts?.deepLink) {
              adbOpenLink(serial, opts.deepLink, bundleId);
              await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
              adbForceStop(serial, bundleId);
              if (opts?.launchArguments && Object.keys(opts.launchArguments).length > 0) {
                const { execFileSync } = await import("node:child_process");
                const { findADB } = await import("../../device/android.js");
                const adb = findADB();
                if (!adb) throw new Error("adb not found");
                const startArgs = [
                  "-s",
                  serial,
                  "shell",
                  "am",
                  "start",
                  "-a",
                  "android.intent.action.MAIN",
                  "-c",
                  "android.intent.category.LAUNCHER",
                  bundleId,
                ];
                for (const [k, v] of Object.entries(opts.launchArguments)) {
                  startArgs.push("--es", k, String(v));
                }
                execFileSync(adb, startArgs, { stdio: "ignore" });
              } else {
                adbLaunchApp(serial, bundleId);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
          },
          catch: (e) => new DriverError({ message: `Launch app failed: ${e}` }),
        }),

      stopApp: (bundleId) =>
        Effect.tryPromise({
          try: async () => {
            adbForceStop(serial, bundleId);
          },
          catch: (e) => new DriverError({ message: `Stop app failed: ${e}` }),
        }),

      killApp: (bundleId) =>
        Effect.tryPromise({
          try: async () => {
            adbForceStop(serial, bundleId);
          },
          catch: (e) => new DriverError({ message: `Kill app failed: ${e}` }),
        }),

      clearAppState: (bundleId) =>
        Effect.tryPromise({
          try: async () => {
            adbForceStop(serial, bundleId);
            adbClearApp(serial, bundleId);
          },
          catch: (e) => new DriverError({ message: `Clear app state failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Navigation
      // -----------------------------------------------------------------------
      openLink: (url) =>
        Effect.tryPromise({
          try: async () => {
            adbOpenLink(serial, url, packageName);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          },
          catch: (e) => new DriverError({ message: `Open link failed: ${e}` }),
        }),

      back: () =>
        Effect.tryPromise({
          // KEYCODE_BACK = 4
          try: () => client.pressKeyCode(4),
          catch: (e) => new DriverError({ message: `Back failed: ${e}` }),
        }),

      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: () =>
            client.executeScript(
              typeof script === "function" ? `return (${script})(...arguments)` : script,
              args,
            ) as Promise<T>,
          catch: (e) => new DriverError({ message: `evaluate() failed: ${e}` }),
        }),

      getContexts: () =>
        Effect.tryPromise({
          try: () => client.getContexts(),
          catch: (e) => new DriverError({ message: `getContexts failed: ${e}` }),
        }),

      getCurrentContext: () =>
        Effect.tryPromise({
          try: () => client.getCurrentContext(),
          catch: (e) => new DriverError({ message: `getCurrentContext failed: ${e}` }),
        }),

      setContext: (contextId: string) =>
        Effect.tryPromise({
          try: () => client.setContext(contextId),
          catch: (e) => new DriverError({ message: `setContext failed: ${e}` }),
        }),
    };

    return service;
  });
}
