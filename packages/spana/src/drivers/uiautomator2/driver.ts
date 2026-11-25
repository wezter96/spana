import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import {
  adbLaunchApp,
  adbForceStop,
  adbClearApp,
  adbOpenLink,
  adbSetAirplaneMode,
  adbSetNetworkProfile,
  adbSetCustomNetwork,
  adbResetNetwork,
  adbSetWifi,
  adbSetData,
} from "../../device/android.js";
import { hasLaunchDeviceState } from "../launch-options.js";
import { androidDeviceControls, deviceEffect } from "../device-controls.js";
import type { RawDriverService, LaunchOptions, NetworkConditions } from "../raw-driver.js";
import { resolveNetworkConditions } from "../network-profiles.js";
import { UiAutomator2Client } from "./client.js";
import type { DomChannel } from "../../channels/dom-channel.js";
import { createAndroidWebViewCdpChannel } from "../../channels/android-cdp.js";
import { createCompositeDomChannel } from "../../channels/bridge-server.js";

export interface UiAutomator2DriverOptions {
  /** Optional pre-configured DOM channel (e.g. spana-bridge) */
  domChannel?: DomChannel;
  /** Optional explicit local TCP port for Android WebView CDP forwarding */
  cdpPort?: number;
  /** Whether to expose the direct Android WebView CDP channel (default: true) */
  enableWebViewCdp?: boolean;
  /**
   * When a DOM channel (spana-bridge or WebView CDP) is already connected after initial boot,
   * reuse the running app via fast storage clear + reload (~40ms) on subsequent `launchApp()`
   * calls instead of cold-killing (`adbForceStop`) and relaunching the entire APK. Default: true.
   */
  fastWebViewReset?: boolean;
}

export function createUiAutomator2Driver(
  host: string,
  port: number,
  serial: string,
  packageName: string,
  driverOptions?: UiAutomator2DriverOptions,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const client = new UiAutomator2Client(host, port);
    let currentContext = "NATIVE_APP";
    let hasLaunchedOnce = false;

    const waitForAndroidReady = async (maxMs: number): Promise<void> => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        try {
          await client.getWindowSize();
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
    };

    const cdpChannel =
      driverOptions?.enableWebViewCdp === false
        ? undefined
        : createAndroidWebViewCdpChannel({
            serial,
            packageName: packageName || undefined,
            localPort: driverOptions?.cdpPort,
          });

    const channels: DomChannel[] = [];
    if (driverOptions?.domChannel) channels.push(driverOptions.domChannel);
    if (cdpChannel) channels.push(cdpChannel);
    const domChannel: DomChannel | undefined =
      channels.length === 0
        ? undefined
        : channels.length === 1
          ? channels[0]
          : createCompositeDomChannel(channels);

    // Create session — must succeed before we can do anything
    yield* Effect.tryPromise({
      try: () => client.createSession(packageName),
      catch: (e) =>
        new DriverError({
          message: `Failed to create UiAutomator2 session: ${e}`,
        }),
    });

    const service: RawDriverService = {
      domChannel,
      ...androidDeviceControls(serial),
      setOrientation: (orientation) =>
        deviceEffect("setOrientation", () =>
          client.setOrientation(orientation === "portrait" ? "PORTRAIT" : "LANDSCAPE"),
        ),

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
            return new Uint8Array(Buffer.from(base64, "base64"));
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
            // Fast WebView reset path: skip cold adbForceStop + APK restart (~1–2s) when
            // a DOM channel (spana-bridge / WebView CDP) is live and no native relaunch flags are requested.
            const canFastReset =
              hasLaunchedOnce &&
              driverOptions?.fastWebViewReset !== false &&
              domChannel?.isConnected() &&
              !opts?.deepLink &&
              !opts?.clearKeychain &&
              !hasLaunchDeviceState(opts?.deviceState) &&
              !(opts?.launchArguments && Object.keys(opts.launchArguments).length > 0);
            if (canFastReset) {
              try {
                if (opts?.clearState && domChannel!.clearStorage) {
                  await domChannel!.clearStorage({
                    localStorage: true,
                    sessionStorage: true,
                    cookies: true,
                    indexedDB: true,
                    capacitorPreferences: true,
                  });
                }
                if (domChannel!.reload) {
                  await domChannel!.reload();
                } else {
                  await domChannel!.evaluate("window.location.reload()");
                }
                return;
              } catch {
                // Fall back to full native relaunch if WebView reload fails
              }
            }

            if (opts?.clearState) {
              adbClearApp(serial, bundleId);
            }
            if (opts?.clearKeychain) {
              console.warn("clearKeychain is not supported on Android, skipping.");
            }
            if (hasLaunchDeviceState(opts?.deviceState)) {
              console.warn(
                "deviceState launch overrides are not supported in local Android mode yet. " +
                  "Use Appium Android mode for language/locale/timeZone session defaults.",
              );
            }
            if (opts?.deepLink) {
              adbOpenLink(serial, opts.deepLink, bundleId);
              await waitForAndroidReady(500);
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
              await waitForAndroidReady(800);
            }
            hasLaunchedOnce = true;
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
            await domChannel?.disconnect().catch(() => {});
            if (!bundleId) return;
            adbForceStop(serial, bundleId);
          },
          catch: (e) => new DriverError({ message: `Kill app failed: ${e}` }),
        }),

      clearAppState: (bundleId) =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel?.isConnected() && domChannel.clearStorage) {
              await domChannel.clearStorage({
                localStorage: true,
                sessionStorage: true,
                cookies: true,
                indexedDB: true,
                capacitorPreferences: true,
              });
              if (domChannel.reload) {
                await domChannel.reload();
              }
              return;
            }
            adbForceStop(serial, bundleId);
            adbClearApp(serial, bundleId);
          },
          catch: (e) => new DriverError({ message: `Clear app state failed: ${e}` }),
        }),

      resetFast: () =>
        Effect.tryPromise({
          try: async () => {
            if (!domChannel) {
              throw new Error("resetFast() requires a connected DOM channel (spana-bridge or CDP)");
            }
            if (domChannel.clearStorage) {
              await domChannel.clearStorage({
                localStorage: true,
                sessionStorage: true,
                cookies: true,
                indexedDB: true,
                capacitorPreferences: true,
              });
            } else {
              await domChannel.evaluate(`(() => {
                try { localStorage.clear(); } catch {}
                try { sessionStorage.clear(); } catch {}
              })()`);
            }
            if (domChannel.reload) {
              await domChannel.reload();
            } else {
              await domChannel.evaluate("window.location.reload()");
            }
          },
          catch: (e) => new DriverError({ message: `Fast reset failed: ${e}` }),
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

      // -----------------------------------------------------------------------
      // Direct DOM evaluation via spana-bridge or Android WebView CDP,
      // falling back to UiAutomator2 /execute/sync when no DOM channel attaches.
      // -----------------------------------------------------------------------
      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel) {
              try {
                return await domChannel.evaluate<T>(script, ...args);
              } catch (domErr) {
                // Fall back to UiAutomator2 executeScript if direct CDP/bridge isn't reachable
                if (typeof client.executeScript === "function") {
                  try {
                    return (await client.executeScript(
                      typeof script === "function" ? `return (${script})(...arguments)` : script,
                      args,
                    )) as T;
                  } catch {
                    throw domErr;
                  }
                }
                throw domErr;
              }
            }
            return (await client.executeScript(
              typeof script === "function" ? `return (${script})(...arguments)` : script,
              args,
            )) as T;
          },
          catch: (e) => new DriverError({ message: `evaluate() failed: ${e}` }),
        }),

      getContexts: () =>
        Effect.tryPromise({
          try: async () => {
            const contexts = new Set<string>(["NATIVE_APP"]);
            if (domChannel?.listTargets) {
              try {
                const targets = await domChannel.listTargets();
                for (const target of targets) {
                  contexts.add(`WEBVIEW_${target.id}`);
                }
              } catch {
                // Ignore if no debuggable webview is active
              }
            }
            if (typeof client.getContexts === "function") {
              try {
                const uaContexts = await client.getContexts();
                for (const ctx of uaContexts) contexts.add(ctx);
              } catch {
                // Direct UiAutomator2 server may not implement /contexts
              }
            }
            return Array.from(contexts);
          },
          catch: (e) => new DriverError({ message: `getContexts failed: ${e}` }),
        }),

      getCurrentContext: () =>
        Effect.tryPromise({
          try: async () => {
            if (currentContext !== "NATIVE_APP") return currentContext;
            if (typeof client.getCurrentContext === "function") {
              try {
                return await client.getCurrentContext();
              } catch {
                return currentContext;
              }
            }
            return currentContext;
          },
          catch: (e) => new DriverError({ message: `getCurrentContext failed: ${e}` }),
        }),

      setContext: (contextId: string) =>
        Effect.tryPromise({
          try: async () => {
            if (contextId === "NATIVE_APP") {
              currentContext = "NATIVE_APP";
              if (typeof client.setContext === "function") {
                await client.setContext("NATIVE_APP").catch(() => {});
              }
              return;
            }
            if (contextId.startsWith("WEBVIEW_") && domChannel) {
              const targetId = contextId.slice("WEBVIEW_".length);
              if (domChannel.selectTarget) {
                try {
                  await domChannel.selectTarget(targetId);
                  currentContext = contextId;
                  return;
                } catch {
                  // Fall through to client.setContext
                }
              }
            }
            await client.setContext(contextId);
            currentContext = contextId;
          },
          catch: (e) => new DriverError({ message: `setContext failed: ${e}` }),
        }),

      mockNetwork: (matcher, response) =>
        Effect.tryPromise({
          try: async () => {
            if (!domChannel?.mockNetwork) {
              throw new Error("mockNetwork() on Android requires spana-bridge");
            }
            await domChannel.mockNetwork(matcher, response);
          },
          catch: (e) => new DriverError({ message: `mockNetwork failed: ${e}` }),
        }),

      blockNetwork: (matcher) =>
        Effect.tryPromise({
          try: async () => {
            if (!domChannel?.blockNetwork) {
              throw new Error("blockNetwork() on Android requires spana-bridge");
            }
            await domChannel.blockNetwork(matcher);
          },
          catch: (e) => new DriverError({ message: `blockNetwork failed: ${e}` }),
        }),

      clearNetworkMocks: () =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel?.clearNetworkMocks) {
              await domChannel.clearNetworkMocks();
            }
          },
          catch: (e) => new DriverError({ message: `clearNetworkMocks failed: ${e}` }),
        }),

      getConsoleLogs: () =>
        Effect.tryPromise({
          try: async () => (domChannel?.getConsoleLogs ? domChannel.getConsoleLogs() : []),
          catch: (e) => new DriverError({ message: `getConsoleLogs failed: ${e}` }),
        }),

      getJSErrors: () =>
        Effect.tryPromise({
          try: async () => (domChannel?.getJSErrors ? domChannel.getJSErrors() : []),
          catch: (e) => new DriverError({ message: `getJSErrors failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Network conditions
      // -----------------------------------------------------------------------
      setNetworkConditions: (conditions: NetworkConditions) =>
        Effect.tryPromise({
          try: async () => {
            const isEmulator = serial.startsWith("emulator-");
            const resolved = resolveNetworkConditions(conditions);
            const hasThrottling =
              conditions.profile !== undefined ||
              conditions.latencyMs !== undefined ||
              conditions.downloadThroughputKbps !== undefined ||
              conditions.uploadThroughputKbps !== undefined;

            // Reset case: no profile, no offline, no custom values
            if (!resolved.offline && !hasThrottling) {
              if (isEmulator) {
                adbResetNetwork(serial);
              } else {
                adbSetAirplaneMode(serial, false);
              }
              return;
            }

            // Offline
            if (resolved.offline) {
              if (isEmulator) {
                adbSetWifi(serial, false);
                adbSetData(serial, false);
              } else {
                adbSetAirplaneMode(serial, true);
              }
              return;
            }

            // Throttling
            if (hasThrottling) {
              if (!isEmulator) {
                throw new DriverError({
                  message:
                    "Network throttling is not supported on physical Android devices. " +
                    "Use an emulator or a cloud provider.",
                });
              }

              // Ensure wifi/data are on
              adbSetWifi(serial, true);
              adbSetData(serial, true);

              if (conditions.profile) {
                adbSetNetworkProfile(serial, conditions.profile);
              } else {
                adbSetCustomNetwork(
                  serial,
                  resolved.downloadThroughputKbps,
                  resolved.uploadThroughputKbps,
                  resolved.latencyMs,
                );
              }
            }
          },
          catch: (e) => {
            if (e instanceof DriverError) return e;
            return new DriverError({ message: `setNetworkConditions failed: ${e}` });
          },
        }),
    };

    return service;
  });
}
