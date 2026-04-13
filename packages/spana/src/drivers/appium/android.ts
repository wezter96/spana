/**
 * Android raw driver implemented on top of the generic Appium client.
 *
 * All operations go through Appium HTTP endpoints --- no adb, no local
 * device tooling. This makes the driver suitable for cloud providers
 * (BrowserStack, Sauce Labs, etc.) as well as remote Appium servers.
 *
 * ## Endpoint conventions
 *
 * See `docs/internals/appium-endpoints.md` for the full allow/avoid list.
 *
 * Summary: prefer W3C-standard endpoints (`/actions`, `/execute/sync` with
 * `mobile:` commands, `/source`, `/screenshot`) over Appium-proprietary
 * extensions like `/appium/gestures/*` or `/appium/execute_mobile/*`.
 * Proprietary extensions diverge across Appium versions and cloud providers.
 */

import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import { splitGraphemes } from "../../core/graphemes.js";
import { hasLaunchDeviceState } from "../launch-options.js";
import type { RawDriverService, LaunchOptions, NetworkConditions } from "../raw-driver.js";
import { resolveNetworkConditions } from "../network-profiles.js";
import type { AppiumClient } from "./client.js";
import { getAppiumWindowSize } from "./window-size.js";

export function createAppiumAndroidDriver(
  client: AppiumClient,
  defaultBundleId?: string,
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
          client.request("POST", client.sessionPath("/actions"), {
            actions: [
              {
                type: "pointer",
                id: "finger1",
                parameters: { pointerType: "touch" },
                actions: [
                  { type: "pointerMove", duration: 0, x, y },
                  { type: "pointerDown", button: 0 },
                  { type: "pointerUp", button: 0 },
                ],
              },
            ],
          }),
        catch: (e) => new DriverError({ message: `Tap failed: ${e}` }),
      }),

    doubleTapAtCoordinate: (x, y) =>
      Effect.tryPromise({
        try: async () => {
          const tapSequence = [
            {
              type: "pointer" as const,
              id: "finger1",
              parameters: { pointerType: "touch" as const },
              actions: [
                { type: "pointerMove", duration: 0, x, y },
                { type: "pointerDown", button: 0 },
                { type: "pointerUp", button: 0 },
              ],
            },
          ];
          // Two separate tap requests with a short gap so Android treats
          // them as independent gestures rather than a hold.
          await client.request("POST", client.sessionPath("/actions"), { actions: tapSequence });
          await new Promise((resolve) => setTimeout(resolve, 100));
          await client.request("POST", client.sessionPath("/actions"), { actions: tapSequence });
        },
        catch: (e) => new DriverError({ message: `Double tap failed: ${e}` }),
      }),

    longPressAtCoordinate: (x, y, duration) =>
      Effect.tryPromise({
        try: () =>
          client.request("POST", client.sessionPath("/actions"), {
            actions: [
              {
                type: "pointer",
                id: "finger1",
                parameters: { pointerType: "touch" },
                actions: [
                  { type: "pointerMove", duration: 0, x, y },
                  { type: "pointerDown", button: 0 },
                  { type: "pause", duration },
                  { type: "pointerUp", button: 0 },
                ],
              },
            ],
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
          for (const segment of splitGraphemes(text)) {
            keyActions.push({ type: "keyDown", value: segment });
            keyActions.push({ type: "keyUp", value: segment });
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
          const size = await getAppiumWindowSize(client);
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
            // Terminate + clearApp wipes app data so the next launch is cold.
            try {
              await client.request("POST", client.sessionPath("/appium/device/terminate_app"), {
                appId: bundleId,
              });
            } catch {
              /* app may not be running */
            }
            await client.executeScript("mobile: clearApp", [{ appId: bundleId }]);
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

          if (hasLaunchDeviceState(opts?.deviceState)) {
            console.warn(
              "deviceState launch overrides are not supported during Appium Android relaunches. " +
                "Set launchOptions.deviceState in config to apply Android language/locale/timeZone at session start.",
            );
          }

          if (opts?.deepLink) {
            // Deep link launches the app at the target route in one intent.
            // Use mobile: deepLink (Android Appium 2.x) rather than W3C POST /url,
            // which many cloud providers (BrowserStack) do not route to native apps.
            await client.executeScript("mobile: deepLink", [
              { url: opts.deepLink, package: bundleId },
            ]);
          } else {
            // No deep link — activate the main intent.
            await client.request("POST", client.sessionPath("/appium/device/activate_app"), {
              appId: bundleId,
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
          await client.executeScript("mobile: clearApp", [{ appId: bundleId }]);
        },
        catch: (e) => new DriverError({ message: `Clear app state failed: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------
    openLink: (url) =>
      Effect.tryPromise({
        try: () => {
          const args: { url: string; package?: string } = { url };
          if (defaultBundleId) args.package = defaultBundleId;
          return client.executeScript("mobile: deepLink", [args]);
        },
        catch: (e) => new DriverError({ message: `Open link failed: ${e}` }),
      }),

    back: () =>
      Effect.tryPromise({
        try: () => client.request("POST", client.sessionPath("/back")),
        catch: (e) => new DriverError({ message: `Back failed: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // Scripting (works when switched to a WebView context)
    // -----------------------------------------------------------------------
    evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
      Effect.tryPromise({
        try: () =>
          client.executeScript(
            typeof script === "function" ? `return (${script})(...arguments)` : script,
            args,
          ) as Promise<T>,
        catch: (e) => new DriverError({ message: `evaluate() failed: ${e}` }),
      }),

    // -----------------------------------------------------------------------
    // WebView / hybrid context switching
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Network conditions
    // -----------------------------------------------------------------------
    setNetworkConditions: (conditions: NetworkConditions) =>
      Effect.tryPromise({
        try: () => {
          const resolved = resolveNetworkConditions(conditions);
          const hasAnyValue =
            conditions.profile !== undefined ||
            conditions.offline !== undefined ||
            conditions.latencyMs !== undefined ||
            conditions.downloadThroughputKbps !== undefined ||
            conditions.uploadThroughputKbps !== undefined;

          if (!hasAnyValue) {
            // Reset: restore full connectivity
            return client.executeScript("mobile: setConnectivity", [
              { wifi: true, data: true, airplaneMode: false },
            ]);
          }

          if (resolved.offline) {
            return client.executeScript("mobile: setConnectivity", [
              { wifi: false, data: false, airplaneMode: true },
            ]);
          }

          // Non-offline (profile or custom values): set connectivity to online.
          // True throttling requires provider-specific commands.
          return client.executeScript("mobile: setConnectivity", [
            { wifi: true, data: true, airplaneMode: false },
          ]);
        },
        catch: (e) => new DriverError({ message: `setNetworkConditions failed: ${e}` }),
      }),
  };

  return Effect.succeed(service);
}
