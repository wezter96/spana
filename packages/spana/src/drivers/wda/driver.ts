import { Effect } from "effect";
import { DriverError } from "../../errors.js";
import { hasLaunchDeviceState } from "../launch-options.js";
import { deviceEffect, iosSimulatorControls } from "../device-controls.js";
import type { RawDriverService, LaunchOptions, NetworkConditions } from "../raw-driver.js";
import { WDAClient } from "./client.js";
import {
  installedUrlSchemesOnSimulator,
  launchOnSimulator,
  launchWithUrlOnSimulator,
  terminateOnSimulator,
  resetSimulatorKeychain,
  pfctlSetOffline,
  pfctlSetThrottle,
  pfctlResetNetwork,
} from "../../device/ios.js";
import { resolveNetworkConditions } from "../network-profiles.js";
import type { DomChannel } from "../../channels/dom-channel.js";
import { createWebKitInspectorChannel } from "../../channels/webkit-inspector.js";
import { createCompositeDomChannel } from "../../channels/bridge-server.js";

export interface WDADriverOptions {
  /** Optional pre-configured DOM channel (e.g. spana-bridge or custom inspector) */
  domChannel?: DomChannel;
  /** WebKit Remote Inspector proxy URL (e.g. http://127.0.0.1:9221) */
  webkitInspectorUrl?: string;
  /** WebKit Remote Inspector proxy port (default: 9221) */
  webkitInspectorPort?: number;
  /** Auto-start ios_webkit_debug_proxy when available */
  autoStartInspectorProxy?: boolean;
  /** Optional warm session ID to reattach to without paying POST /session latency */
  warmSessionId?: string;
  /** Callback fired when a new WDA session is created so callers can persist it */
  onSessionCreated?: (sessionId: string) => void;
  /**
   * When a DOM channel (spana-bridge / WebKit Inspector) is already connected after first launch,
   * reuse the running iOS app via fast storage clear + reload (~40ms) on subsequent `launchApp()`
   * calls instead of terminating and cold-booting the simulator app (~800–2000ms). Default: true.
   */
  fastWebViewReset?: boolean;
}

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

function isSessionError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("session does not exist") ||
    msg.includes("unable to connect") ||
    msg.includes("no active session") ||
    msg.includes("invalid session") ||
    /status[:\s]*404/.test(msg)
  );
}

export function createWDADriver(
  host: string,
  port: number,
  bundleId: string,
  simulatorUdid?: string,
  snapshotMaxDepth = 100,
  driverOptions?: WDADriverOptions,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.gen(function* () {
    const client = new WDAClient(host, port);
    let currentContext = "NATIVE_APP";
    let hasLaunchedOnce = false;

    const waitForWdaReady = async (maxMs: number): Promise<void> => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        try {
          await client.getWindowSize();
          return;
        } catch {
          await sleep(40);
        }
      }
    };

    const inspectorChannel = createWebKitInspectorChannel({
      endpointUrl: driverOptions?.webkitInspectorUrl,
      port: driverOptions?.webkitInspectorPort,
      udid: simulatorUdid,
      bundleId: bundleId || undefined,
      autoStartProxy: driverOptions?.autoStartInspectorProxy ?? false,
    });

    const domChannel: DomChannel = driverOptions?.domChannel
      ? createCompositeDomChannel([driverOptions.domChannel, inspectorChannel])
      : inspectorChannel;

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
      await waitForWdaReady(400);
    };

    const openSimulatorUrl = async (url: string, targetBundleId = bundleId) => {
      if (!simulatorUdid) {
        await client.openUrl(url);
        return;
      }

      try {
        await activateSimulatorApp(targetBundleId);
        await client.openUrl(url);
        await waitForWdaReady(400);
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
          await waitForWdaReady(400);
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

    // Reuse a warm WDA session if provided and still alive (~1-3s faster than POST /session)
    let reusedWarmSession = false;
    if (driverOptions?.warmSessionId && typeof client.attachSession === "function") {
      client.attachSession(driverOptions.warmSessionId);
      const alive = yield* Effect.tryPromise({
        try: () => client.isSessionAlive(),
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      reusedWarmSession = alive;
    }

    if (!reusedWarmSession) {
      // Create session — must succeed before we can do anything
      const createdId = yield* Effect.tryPromise({
        try: () => createSessionWithRetry(bundleId || undefined),
        catch: (e) => new DriverError({ message: `Failed to create WDA session: ${e}` }),
      });
      driverOptions?.onSessionCreated?.(createdId);

      // Disable quiescence to prevent XCTest crashes on animated UIs
      yield* Effect.tryPromise({
        try: () => client.disableQuiescence(),
        catch: (e) => new DriverError({ message: `Failed to disable quiescence: ${e}` }),
      });

      // Set snapshot depth to support deep React Native trees
      yield* Effect.tryPromise({
        try: () => client.setSnapshotMaxDepth(snapshotMaxDepth),
        catch: (e) => new DriverError({ message: `Failed to set snapshot depth: ${e}` }),
      });
    }

    const service: RawDriverService = {
      ...iosSimulatorControls(simulatorUdid),
      setOrientation: (orientation) =>
        deviceEffect("setOrientation", () =>
          withSessionRecovery(() =>
            client.setOrientation(orientation === "portrait" ? "PORTRAIT" : "LANDSCAPE"),
          ),
        ),
      domChannel,

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

      pinch: (cx, cy, scale, duration) =>
        Effect.tryPromise({
          try: () => withSessionRecovery(() => client.pinch(cx, cy, scale, msToSec(duration))),
          catch: (e) => new DriverError({ message: `Pinch failed: ${e}` }),
        }),

      zoom: (cx, cy, scale, duration) =>
        Effect.tryPromise({
          try: () => withSessionRecovery(() => client.zoom(cx, cy, scale, msToSec(duration))),
          catch: (e) => new DriverError({ message: `Zoom failed: ${e}` }),
        }),

      multiTouch: (sequences) =>
        Effect.tryPromise({
          try: () => withSessionRecovery(() => client.multiTouch(sequences)),
          catch: (e) => new DriverError({ message: `Multi-touch failed: ${e}` }),
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
            // Fast WebView reset: when a DOM channel (spana-bridge / WebKit Inspector) is live
            // after initial launch, reset storage & reload (~40ms) instead of killing & rebooting iOS app.
            const canFastReset =
              hasLaunchedOnce &&
              driverOptions?.fastWebViewReset !== false &&
              domChannel.isConnected() &&
              !opts?.deepLink &&
              !opts?.clearKeychain &&
              !hasLaunchDeviceState(opts?.deviceState) &&
              !(opts?.launchArguments && Object.keys(opts.launchArguments).length > 0);
            if (canFastReset) {
              try {
                if (opts?.clearState && domChannel.clearStorage) {
                  await domChannel.clearStorage({
                    localStorage: true,
                    sessionStorage: true,
                    cookies: true,
                    indexedDB: true,
                    capacitorPreferences: true,
                  });
                }
                if (domChannel.reload) {
                  await domChannel.reload();
                } else {
                  await domChannel.evaluate("window.location.reload()");
                }
                return;
              } catch {
                // Fall back to full native relaunch
              }
            }

            if (opts?.clearState && simulatorUdid) {
              terminateOnSimulator(simulatorUdid, appBundleId);
              try {
                const { execFileSync } = await import("node:child_process");
                execFileSync(
                  "xcrun",
                  ["simctl", "privacy", simulatorUdid, "reset", "all", appBundleId],
                  {
                    stdio: "ignore",
                  },
                );
              } catch {
                // Ignore — privacy reset may not be available on older Xcode
              }
            }
            if (opts?.clearKeychain && simulatorUdid) {
              resetSimulatorKeychain(simulatorUdid);
            } else if (opts?.clearKeychain) {
              console.warn("clearKeychain is only supported on iOS simulators, skipping.");
            }
            if (
              hasLaunchDeviceState(opts?.deviceState) ||
              (opts?.launchArguments && Object.keys(opts.launchArguments).length > 0)
            ) {
              console.warn(
                "launchArguments and deviceState are not supported in local iOS WDA mode yet. " +
                  "Use Appium iOS mode when you need launch-time localization, timezone, or custom process arguments.",
              );
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
                // Relaunch via WDA to keep session attached
                try {
                  await client.launchApp(appBundleId);
                  await waitForWdaReady(500);
                } catch {
                  // WDA launch failed — fall back to simctl + session recreation
                  launchOnSimulator(simulatorUdid, appBundleId);
                  await sleep(250);
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
              hasLaunchedOnce = true;
              return;
            }

            await (opts?.deepLink ? client.openUrl(opts.deepLink) : client.launchApp(appBundleId));
            hasLaunchedOnce = true;
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
          try: async () => {
            await domChannel.disconnect().catch(() => {});
            if (!appBundleId) return;
            if (simulatorUdid) {
              terminateOnSimulator(simulatorUdid, appBundleId);
              return;
            }

            await client.terminateApp(appBundleId);
          },
          catch: (e) => new DriverError({ message: `Kill app failed: ${e}` }),
        }),

      clearAppState: (appBundleId) =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel.isConnected() && domChannel.clearStorage) {
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
            if (simulatorUdid) {
              terminateOnSimulator(simulatorUdid, appBundleId);
              return;
            }

            await client.terminateApp(appBundleId);
          },
          catch: (e) => new DriverError({ message: `Clear app state failed: ${e}` }),
        }),

      resetFast: () =>
        Effect.tryPromise({
          try: async () => {
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

      // -----------------------------------------------------------------------
      // Direct DOM evaluation via spana-bridge or WebKit Remote Inspector
      // (no Appium required)
      // -----------------------------------------------------------------------
      evaluate: <T = unknown>(script: string | ((...args: unknown[]) => T), ...args: unknown[]) =>
        Effect.tryPromise({
          try: () => domChannel.evaluate<T>(script, ...args),
          catch: (e) =>
            new DriverError({
              message:
                `iOS direct WDA evaluate() failed via ${domChannel.kind}: ${e instanceof Error ? e.message : e}. ` +
                `Ensure WKWebView.isInspectable = true (iOS 16.4+) with ios_webkit_debug_proxy running, or include spana-bridge in test builds.`,
            }),
        }),

      getContexts: () =>
        Effect.tryPromise({
          try: async () => {
            const contexts = ["NATIVE_APP"];
            if (domChannel.listTargets) {
              try {
                const targets = await domChannel.listTargets();
                for (const target of targets) {
                  contexts.push(`WEBVIEW_${target.id}`);
                }
              } catch {
                // No inspectable webviews right now
              }
            }
            if (domChannel.isConnected() && contexts.length === 1) {
              contexts.push(`WEBVIEW_${domChannel.kind}`);
            }
            return contexts;
          },
          catch: (e) => new DriverError({ message: `getContexts failed: ${e}` }),
        }),

      getCurrentContext: () => Effect.succeed(currentContext),

      setContext: (contextId: string) =>
        Effect.tryPromise({
          try: async () => {
            if (contextId === "NATIVE_APP") {
              currentContext = "NATIVE_APP";
              return;
            }
            if (contextId.startsWith("WEBVIEW_")) {
              const targetId = contextId.slice("WEBVIEW_".length);
              if (
                domChannel.selectTarget &&
                targetId !== "bridge" &&
                targetId !== "webkit-inspector"
              ) {
                await domChannel.selectTarget(targetId);
              } else {
                await domChannel.connect();
              }
              currentContext = contextId;
              return;
            }
            throw new Error(`Unknown context "${contextId}"`);
          },
          catch: (e) => new DriverError({ message: `setContext failed: ${e}` }),
        }),

      mockNetwork: (matcher, response) =>
        Effect.tryPromise({
          try: async () => {
            if (!domChannel.mockNetwork) {
              throw new Error(
                "mockNetwork() is not supported on native iOS traffic; install spana-bridge in your WebView to intercept JavaScript requests",
              );
            }
            await domChannel.mockNetwork(matcher, response);
          },
          catch: (e) => new DriverError({ message: `mockNetwork failed: ${e}` }),
        }),

      blockNetwork: (matcher) =>
        Effect.tryPromise({
          try: async () => {
            if (!domChannel.blockNetwork) {
              throw new Error(
                "blockNetwork() is not supported on native iOS traffic; install spana-bridge in your WebView to intercept JavaScript requests",
              );
            }
            await domChannel.blockNetwork(matcher);
          },
          catch: (e) => new DriverError({ message: `blockNetwork failed: ${e}` }),
        }),

      clearNetworkMocks: () =>
        Effect.tryPromise({
          try: async () => {
            if (domChannel.clearNetworkMocks) {
              await domChannel.clearNetworkMocks();
            }
          },
          catch: (e) => new DriverError({ message: `clearNetworkMocks failed: ${e}` }),
        }),

      getConsoleLogs: () =>
        Effect.tryPromise({
          try: async () => (domChannel.getConsoleLogs ? domChannel.getConsoleLogs() : []),
          catch: (e) => new DriverError({ message: `getConsoleLogs failed: ${e}` }),
        }),

      getJSErrors: () =>
        Effect.tryPromise({
          try: async () => (domChannel.getJSErrors ? domChannel.getJSErrors() : []),
          catch: (e) => new DriverError({ message: `getJSErrors failed: ${e}` }),
        }),

      // -----------------------------------------------------------------------
      // Network simulation
      // -----------------------------------------------------------------------
      setNetworkConditions: (conditions: NetworkConditions) =>
        Effect.tryPromise({
          try: async () => {
            if (!simulatorUdid) {
              throw new DriverError({
                message:
                  "Network simulation is not supported on physical iOS devices. Use a cloud provider (BrowserStack, SauceLabs) for network profiles.",
              });
            }

            const hasProfile = !!conditions.profile;
            const hasOffline = conditions.offline !== undefined;
            const hasCustom =
              conditions.latencyMs !== undefined ||
              conditions.downloadThroughputKbps !== undefined ||
              conditions.uploadThroughputKbps !== undefined;

            // Reset case: no profile, no offline, no custom values
            if (!hasProfile && !hasOffline && !hasCustom) {
              pfctlResetNetwork();
              return;
            }

            // Offline case
            if (hasOffline && conditions.offline) {
              pfctlSetOffline(true);
              return;
            }

            // Throttling case (profile or custom values)
            if (hasProfile || hasCustom) {
              const resolved = resolveNetworkConditions(conditions);
              if (resolved.offline) {
                pfctlSetOffline(true);
                return;
              }
              const throughput =
                resolved.downloadThroughputKbps === -1 ? 0 : resolved.downloadThroughputKbps;
              pfctlSetThrottle(throughput, resolved.latencyMs);
              return;
            }

            // Non-throttling online (offline explicitly set to false)
            pfctlSetOffline(false);
          },
          catch: (e) => {
            if (e instanceof DriverError) return e;
            return new DriverError({ message: `Set network conditions failed: ${e}` });
          },
        }),
    };

    return service;
  });
}
