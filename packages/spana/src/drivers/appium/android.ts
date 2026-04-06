/**
 * Android raw driver implemented on top of the generic Appium client.
 *
 * All operations go through Appium HTTP endpoints --- no adb, no local
 * device tooling. This makes the driver suitable for cloud providers
 * (BrowserStack, Sauce Labs, etc.) as well as remote Appium servers.
 */

import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import type { RawDriverService, LaunchOptions } from "../raw-driver.js";
import type { AppiumClient } from "./client.js";

export function createAppiumAndroidDriver(
  client: AppiumClient,
): Effect.Effect<RawDriverService, DriverError> {
  const service: RawDriverService = {
    // -----------------------------------------------------------------------
    // Hierarchy
    // -----------------------------------------------------------------------
    dumpHierarchy: () =>
      Effect.tryPromise({
        try: () => client.request<string>("GET", client.sessionPath("/source")),
        catch: (e) => new DriverError({ message: `Failed to get page source: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // Coordinate-level actions
    // -----------------------------------------------------------------------
    tapAtCoordinate: (x, y) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/appium/gestures/click"), {
            offset: { x, y },
          }),
        catch: (e) => new DriverError({ message: `Tap failed: ${e}` }),
      }),

    doubleTapAtCoordinate: (x, y) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/appium/gestures/double_click"), {
            offset: { x, y },
          }),
        catch: (e) => new DriverError({ message: `Double tap failed: ${e}` }),
      }),

    longPressAtCoordinate: (x, y, duration) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/appium/gestures/long_click"), {
            offset: { x, y },
            duration,
          }),
        catch: (e) => new DriverError({ message: `Long press failed: ${e}` }),
      }),

    swipe: (sx, sy, ex, ey, dur) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/actions"), {
            actions: [
              {
                type: "pointer",
                id: "finger1",
                parameters: { pointerType: "touch" },
                actions: [
                  { type: "pointerMove", duration: 0, x: sx, y: sy },
                  { type: "pointerDown", button: 0 },
                  { type: "pointerMove", duration: dur, x: ex, y: ey },
                  { type: "pointerUp", button: 0 },
                ],
              },
            ],
          }),
        catch: (e) => new DriverError({ message: `Swipe failed: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // Text input
    // -----------------------------------------------------------------------
    inputText: (text) =>
      Effect.tryPromise({
        try: () => {
          const keyActions: Array<{ type: string; value?: string }> = [];
          for (const ch of text) {
            keyActions.push({ type: "keyDown", value: ch });
            keyActions.push({ type: "keyUp", value: ch });
          }
          return client.request("POST", client.sessionPath("/actions"), {
            actions: [
              {
                type: "key",
                id: "keyboard",
                actions: keyActions,
              },
            ],
          });
        },
        catch: (e) => new DriverError({ message: `Input text failed: ${e}` }),
      }),

    pressKey: (key) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/appium/device/press_keycode"), {
            keycode: parseInt(key, 10) || 0,
          }),
        catch: (e) => new DriverError({ message: `Press key failed: ${e}` }),
      }),

    hideKeyboard: () =>
      Effect.tryPromise({
        try: () => client.request("POST", client.sessionPath("/appium/device/hide_keyboard")),
        catch: (e) => new DriverError({ message: `Hide keyboard failed: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------
    takeScreenshot: () =>
      Effect.tryPromise({
        try: async () => {
          const base64 = await client.request<string>("GET", client.sessionPath("/screenshot"));
          return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        },
        catch: (e) => new DriverError({ message: `Screenshot failed: ${e}` }),
      }),

    getDeviceInfo: () =>
      Effect.tryPromise({
        try: async () => {
          const size = await client.request<{ width: number; height: number }>(
            "GET",
            client.sessionPath("/window/size"),
          );
          const caps = client.getSessionCaps();
          return {
            platform: "android" as const,
            deviceId: client.getSessionId() ?? "appium",
            name: (caps["deviceName"] as string) ?? "Android Device (Appium)",
            isEmulator: false,
            screenWidth: size.width,
            screenHeight: size.height,
            driverType: "appium" as const,
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
            // Terminate -> clearApp -> activate (clean launch without uninstalling)
            try {
              await client.request("POST", client.sessionPath("/appium/device/terminate_app"), {
                appId: bundleId,
              });
            } catch {
              /* app may not be running */
            }
            await client.request("POST", client.sessionPath("/appium/execute_mobile/clearApp"), {
              appId: bundleId,
            });
            await client.request("POST", client.sessionPath("/appium/device/activate_app"), {
              appId: bundleId,
            });
          } else {
            await client.request("POST", client.sessionPath("/appium/device/activate_app"), {
              appId: bundleId,
            });
          }

          if (opts?.clearKeychain) {
            console.warn("clearKeychain is not supported on Android, skipping.");
          }

          if (opts?.launchArguments && Object.keys(opts.launchArguments).length > 0) {
            throw new DriverError({
              message:
                "launchArguments are not supported in Appium Android mode. " +
                "Remove launchArguments from your config or use local mode.",
            });
          }

          if (opts?.deepLink) {
            await client.request("POST", client.sessionPath("/url"), {
              url: opts.deepLink,
            });
          }
        },
        catch: (e) => new DriverError({ message: `Launch app failed: ${e}` }),
      }),

    stopApp: (bundleId) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/appium/device/terminate_app"), {
            appId: bundleId,
          }),
        catch: (e) => new DriverError({ message: `Stop app failed: ${e}` }),
      }),

    killApp: (bundleId) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/appium/device/terminate_app"), {
            appId: bundleId,
          }),
        catch: (e) => new DriverError({ message: `Kill app failed: ${e}` }),
      }),

    clearAppState: (bundleId) =>
      Effect.tryPromise({
        try: async () => {
          try {
            await client.request("POST", client.sessionPath("/appium/device/terminate_app"), {
              appId: bundleId,
            });
          } catch {
            /* app may not be running */
          }
          await client.request("POST", client.sessionPath("/appium/execute_mobile/clearApp"), {
            appId: bundleId,
          });
        },
        catch: (e) => new DriverError({ message: `Clear app state failed: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------
    openLink: (url) =>
      Effect.tryPromise({
        try: () => client.request("POST", client.sessionPath("/url"), { url }),
        catch: (e) => new DriverError({ message: `Open link failed: ${e}` }),
      }),

    back: () =>
      Effect.tryPromise({
        try: () => client.request("POST", client.sessionPath("/back")),
        catch: (e) => new DriverError({ message: `Back failed: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // Scripting
    // -----------------------------------------------------------------------
    evaluate: () =>
      Effect.fail(
        new DriverError({
          message: "evaluate() is not supported in Appium mode",
        }),
      ),
  };

  return Effect.succeed(service);
}
