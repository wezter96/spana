import { Effect } from "effect";
import type { Browser } from "playwright-core";
import type { BridgeConfig, ProvConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import type { EngineConfig } from "../core/engine.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";
import type { DiscoveredDevice } from "../device/discover.js";
import type { RuntimeResult } from "./types.js";
import {
  connectPlaywrightOverCDP,
  connectPlaywrightOverWS,
  ensureWarmBrowserDaemon,
  launchPlaywrightBrowser,
  makePlaywrightDriver,
} from "../drivers/playwright.js";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "../drivers/cdp-browser.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { createUiAutomator2Driver } from "../drivers/uiautomator2/driver.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import { createWDADriver } from "../drivers/wda/driver.js";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { makeElectronDriver } from "../drivers/electron.js";
import { makeElectrobunDriver } from "../drivers/electrobun.js";
import { adbReverse, adbReverseRemove, ensureAndroidDevice } from "../device/android.js";
import { updateWarmDaemonSession } from "./daemon-manager.js";
import {
  ensureIOSSimulator,
  firstIOSPhysicalDevice,
  connectPhysicalDevice,
  ensureAppInstalled,
} from "../device/ios.js";
import { setupUiAutomator2 } from "../drivers/uiautomator2/installer.js";
import { setupWDA } from "../drivers/wda/installer.js";
import { allocatePort } from "../core/port-allocator.js";
import { createSpanaBridgeChannel, type SpanaBridgeChannel } from "../channels/bridge-server.js";

async function safeCleanup(...fns: Array<() => Promise<unknown>>): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      /* swallow */
    }
  }
}

async function maybeStartBridge(
  appBridge?: BridgeConfig,
  globalBridge?: BridgeConfig,
): Promise<SpanaBridgeChannel | undefined> {
  const merged = appBridge ?? globalBridge;
  if (!merged) return undefined;
  const enabled = merged.enabled ?? Boolean(merged.port || merged.url);
  if (!enabled) return undefined;

  const channel = createSpanaBridgeChannel({
    host: merged.host ?? "127.0.0.1",
    port: merged.port ?? 9333,
    connectTimeoutMs: merged.connectTimeout ?? 5000,
  });
  await channel.start();
  return channel;
}

function buildEngineConfig(
  appId: string,
  platform: Platform,
  parseFn: CoordinatorConfig["parse"],
  config: ProvConfig,
  screenSize?: { width: number; height: number },
): EngineConfig {
  return {
    appId,
    platform,
    coordinatorConfig: {
      parse: parseFn,
      defaults: {
        timeout: config.defaults?.waitTimeout,
        pollInterval: config.defaults?.pollInterval,
        settleTimeout: config.defaults?.settleTimeout,
        initialPollInterval: config.defaults?.initialPollInterval,
        tapMode: config.defaults?.tapMode,
        platform,
        failFastWhenIdle: config.defaults?.failFastWhenIdle,
      },
      waitForIdleTimeout: config.defaults?.waitForIdleTimeout,
      typingDelay: config.defaults?.typingDelay,
      hierarchyCacheTtl: config.defaults?.hierarchyCacheTtl,
      screenWidth: screenSize?.width,
      screenHeight: screenSize?.height,
      tapMode: config.defaults?.tapMode,
      platform,
    },
    autoLaunch: true,
    flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
    artifactConfig: config.artifacts,
    launchOptions: config.launchOptions,
    hooks: config.hooks,
    storybook: platform === "web" ? config.execution?.web?.storybook : undefined,
    visualRegression: config.visualRegression,
  };
}

/**
 * Resolve the effective web browser engine.
 * - `"auto"`: automatically selects direct CDP (`"cdp"`, zero Playwright pipe) for Chromium
 *   when no Playwright-only features (`wsEndpoint`, `channel`, `artifacts.har`) are requested,
 *   and falls back seamlessly to `"playwright"` otherwise.
 * - Explicit `"cdp"`, `"playwright"`, or `"lightpanda"` is respected verbatim.
 */
export function resolveWebEngine(config: ProvConfig): "playwright" | "cdp" | "lightpanda" {
  const webExecution = config.execution?.web;
  const requested = webExecution?.engine;
  if (requested === "cdp" || requested === "lightpanda" || requested === "playwright") {
    return requested;
  }
  if (requested === "auto") {
    const isChromium = (webExecution?.browser ?? "chromium") === "chromium";
    const needsPlaywrightOnly = Boolean(
      webExecution?.wsEndpoint || webExecution?.channel || config.artifacts?.har,
    );
    return isChromium && !needsPlaywrightOnly ? "cdp" : "playwright";
  }
  return "playwright";
}

export interface PrelaunchedWebBrowser {
  browserPromise: Promise<Browser>;
  ownsBrowser: boolean;
  /** Populated when `execution.web.engine === "cdp"` speculatively launches direct Chromium. */
  cdpBrowserPromise?: Promise<DirectCdpBrowserHandle>;
}

/**
 * Start launching (or connecting to a warm/CDP) browser immediately
 * so browser boot overlaps with flow discovery and TypeScript imports.
 */
export function speculativelyPrelaunchWebBrowser(
  config: ProvConfig,
): PrelaunchedWebBrowser | undefined {
  const webExecution = config.execution?.web;
  const engine = resolveWebEngine(config);
  if (engine === "lightpanda") {
    return undefined;
  }

  if (engine === "cdp") {
    if (webExecution?.cdpUrl) return undefined;
    const useWarm = webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false;
    const cdpBrowserPromise = launchDirectCdpBrowser({
      executablePath: webExecution?.executablePath,
      headless: webExecution?.headless ?? true,
      warmBrowser: useWarm,
      warmBrowserScope: webExecution?.warmBrowserScope
        ? `${webExecution.warmBrowserScope}-w0`
        : undefined,
    });
    cdpBrowserPromise.catch(() => {});
    return {
      browserPromise: Promise.resolve(undefined as unknown as Browser),
      ownsBrowser: false,
      cdpBrowserPromise,
    };
  }

  const useWarm =
    (webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false) &&
    (webExecution?.browser ?? "chromium") === "chromium";
  const ownsBrowser = !useWarm && !webExecution?.cdpUrl && !webExecution?.wsEndpoint;
  const browserPromise = webExecution?.wsEndpoint
    ? connectPlaywrightOverWS(webExecution.wsEndpoint, webExecution.browser)
    : webExecution?.cdpUrl
      ? connectPlaywrightOverCDP(webExecution.cdpUrl)
      : useWarm
        ? ensureWarmBrowserDaemon({
            headless: webExecution?.headless ?? true,
            executablePath: webExecution?.executablePath,
            warmBrowserScope: webExecution?.warmBrowserScope,
          }).then((r) => r.browser)
        : launchPlaywrightBrowser({
            browser: webExecution?.browser,
            headless: webExecution?.headless ?? true,
            executablePath: webExecution?.executablePath,
            channel: webExecution?.channel,
          });

  // Prevent unhandled rejection if CLI exits early before awaiting
  browserPromise.catch(() => {});
  return { browserPromise, ownsBrowser };
}

export async function buildWebRuntime(
  config: ProvConfig,
  prelaunched?: PrelaunchedWebBrowser,
): Promise<RuntimeResult> {
  const webUrl = config.apps?.web?.url ?? "http://localhost:3000";
  const webExecution = config.execution?.web;
  const bridge = await maybeStartBridge(config.apps?.web?.bridge, config.execution?.bridge);

  const prelaunchedBrowser =
    prelaunched && !prelaunched.cdpBrowserPromise ? await prelaunched.browserPromise : undefined;
  let launchedDirectCdp: DirectCdpBrowserHandle | undefined;

  let rawDriver;
  const engine = resolveWebEngine(config);
  if (engine === "cdp" || engine === "lightpanda") {
    let targetCdpUrl = webExecution?.cdpUrl;
    const useContexts = engine === "cdp";
    if (!targetCdpUrl && engine === "cdp") {
      launchedDirectCdp = prelaunched?.cdpBrowserPromise
        ? await prelaunched.cdpBrowserPromise
        : await launchDirectCdpBrowser({
            executablePath: webExecution?.executablePath,
            headless: webExecution?.headless ?? true,
            warmBrowser:
              webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false,
            warmBrowserScope: webExecution?.warmBrowserScope
              ? `${webExecution.warmBrowserScope}-w0`
              : undefined,
          });
      targetCdpUrl = launchedDirectCdp.browserWsUrl;
    }
    rawDriver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: targetCdpUrl ?? "http://127.0.0.1:9222",
        baseUrl: webUrl,
        engineLabel: engine,
        useBrowserContexts: useContexts,
        freshContextPerFlow: webExecution?.freshContextPerFlow,
        contextIsolation: webExecution?.contextIsolation,
        waitUntil: webExecution?.waitUntil,
        instantAnimations: webExecution?.instantAnimations,
        blockResources: webExecution?.blockResources,
        virtualAuthenticator: webExecution?.virtualAuthenticator,
        storageState: webExecution?.storageState,
      }),
    );
  } else {
    rawDriver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: webExecution?.browser,
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        channel: webExecution?.channel,
        baseUrl: webUrl,
        storageState: webExecution?.storageState,
        verboseLogging: webExecution?.verboseLogging,
        recordHar: Boolean(config.artifacts?.har),
        waitUntil: webExecution?.waitUntil,
        instantAnimations: webExecution?.instantAnimations,
        blockResources: webExecution?.blockResources,
        freshContextPerFlow: webExecution?.freshContextPerFlow,
        virtualAuthenticator: webExecution?.virtualAuthenticator,
        warmBrowserScope: webExecution?.warmBrowserScope,
        sharedBrowser: prelaunchedBrowser,
        cdpEndpoint: prelaunchedBrowser ? undefined : webExecution?.cdpUrl,
        wsEndpoint: prelaunchedBrowser ? undefined : webExecution?.wsEndpoint,
        warmBrowser: prelaunchedBrowser
          ? false
          : (webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false),
      }),
    );
  }
  const driver = bridge ? { ...rawDriver, domChannel: bridge } : rawDriver;
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  return {
    runtime: {
      driver,
      cleanup: () =>
        safeCleanup(
          () => Effect.runPromise(driver.killApp("")),
          () =>
            prelaunchedBrowser && prelaunched?.ownsBrowser
              ? prelaunchedBrowser.close()
              : Promise.resolve(),
          () => (launchedDirectCdp ? launchedDirectCdp.close() : Promise.resolve()),
          () => bridge?.disconnect() ?? Promise.resolve(),
        ),
      metadata: {
        platform: "web",
        mode: "local",
      },
    },
    engineConfig: buildEngineConfig(webUrl, "web", parseWebHierarchy, config, {
      width: deviceInfo.screenWidth,
      height: deviceInfo.screenHeight,
    }),
  };
}

/**
 * Create `workerCount` isolated web runtimes sharded across
 * `Math.ceil(workerCount / maxContextsPerBrowser)` browser processes
 * (default: 2 contexts per browser, so 4 workers run on 2 Chromium processes × 2 contexts
 * — avoiding single-browser CDP/IO contention while keeping startup fast!).
 * Supports both direct CDP (`engine: "cdp"`, zero Playwright pipe) and Playwright.
 */
export async function buildWebRuntimePool(
  config: ProvConfig,
  workerCount: number,
  prelaunched?: PrelaunchedWebBrowser,
): Promise<RuntimeResult[]> {
  const webExecution = config.execution?.web;
  const engine = resolveWebEngine(config);
  if (workerCount <= 1 || engine === "lightpanda") {
    return [await buildWebRuntime(config, prelaunched)];
  }

  const webUrl = config.apps?.web?.url ?? "http://localhost:3000";
  const maxPerBrowser = Math.max(
    1,
    webExecution?.maxContextsPerBrowser ?? (engine === "cdp" ? 1 : 2),
  );

  // Direct CDP multi-browser worker pool (zero Playwright Node client↔server pipe!)
  if (engine === "cdp") {
    const useExternalCdp = Boolean(webExecution?.cdpUrl);
    const browserCount = useExternalCdp ? 1 : Math.ceil(workerCount / maxPerBrowser);
    const handles: Array<{
      cdpUrl: string;
      handle?: DirectCdpBrowserHandle;
      remaining: number;
    }> = [];

    if (useExternalCdp) {
      handles.push({ cdpUrl: webExecution!.cdpUrl!, remaining: workerCount });
    } else {
      const useWarm = webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false;
      const baseScope = webExecution?.warmBrowserScope ?? "pool";
      const launched = await Promise.all(
        Array.from({ length: browserCount }, (_v, bIdx) =>
          bIdx === 0 && prelaunched?.cdpBrowserPromise
            ? prelaunched.cdpBrowserPromise
            : launchDirectCdpBrowser({
                executablePath: webExecution?.executablePath,
                headless: webExecution?.headless ?? true,
                warmBrowser: useWarm,
                warmBrowserScope: `${baseScope}-w${bIdx}`,
              }),
        ),
      );
      for (const h of launched) {
        handles.push({ cdpUrl: h.browserWsUrl, handle: h, remaining: 0 });
      }
      for (let i = 0; i < workerCount; i++) {
        handles[i % handles.length]!.remaining += 1;
      }
    }

    const results: RuntimeResult[] = [];
    for (let i = 0; i < workerCount; i++) {
      const bucket = handles[i % handles.length]!;
      const driver = await Effect.runPromise(
        makeLightweightCdpDriver({
          cdpUrl: bucket.cdpUrl,
          baseUrl: webUrl,
          engineLabel: "cdp",
          useBrowserContexts: true,
          freshContextPerFlow: webExecution?.freshContextPerFlow,
          contextIsolation: webExecution?.contextIsolation,
          waitUntil: webExecution?.waitUntil,
          instantAnimations: webExecution?.instantAnimations,
          blockResources: webExecution?.blockResources,
          virtualAuthenticator: webExecution?.virtualAuthenticator,
          storageState: webExecution?.storageState,
        }),
      );
      const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
      let cleaned = false;
      results.push({
        runtime: {
          driver,
          cleanup: () =>
            safeCleanup(async () => {
              if (cleaned) return;
              cleaned = true;
              await Effect.runPromise(driver.killApp(""));
              bucket.remaining -= 1;
              if (bucket.remaining <= 0 && bucket.handle) {
                await bucket.handle.close();
              }
            }),
          metadata: {
            platform: "web",
            mode: "local",
            deviceId: `cdp-context-${i + 1}`,
          },
        },
        engineConfig: buildEngineConfig(webUrl, "web", parseWebHierarchy, config, {
          width: deviceInfo.screenWidth,
          height: deviceInfo.screenHeight,
        }),
      });
    }
    return results;
  }

  const useWarm =
    (webExecution?.warmBrowser ?? config.execution?.warmDaemons?.enabled ?? false) &&
    (webExecution?.browser ?? "chromium") === "chromium";
  const singleExternalEndpoint = Boolean(webExecution?.cdpUrl || webExecution?.wsEndpoint);
  const browserCount = singleExternalEndpoint ? 1 : Math.ceil(workerCount / maxPerBrowser);

  const launchOneBrowser = async (
    idx: number,
  ): Promise<{ browser: Browser; owns: boolean; remaining: number }> => {
    if (idx === 0 && prelaunched) {
      return {
        browser: await prelaunched.browserPromise,
        owns: prelaunched.ownsBrowser,
        remaining: 0,
      };
    }
    if (webExecution?.wsEndpoint) {
      return {
        browser: await connectPlaywrightOverWS(webExecution.wsEndpoint, webExecution.browser),
        owns: false,
        remaining: 0,
      };
    }
    if (webExecution?.cdpUrl) {
      return {
        browser: await connectPlaywrightOverCDP(webExecution.cdpUrl),
        owns: false,
        remaining: 0,
      };
    }
    if (idx === 0 && useWarm) {
      const warm = await ensureWarmBrowserDaemon({
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        warmBrowserScope: webExecution?.warmBrowserScope,
      });
      return { browser: warm.browser, owns: false, remaining: 0 };
    }
    return {
      browser: await launchPlaywrightBrowser({
        browser: webExecution?.browser,
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        channel: webExecution?.channel,
      }),
      owns: true,
      remaining: 0,
    };
  };

  const browserBuckets = await Promise.all(
    Array.from({ length: browserCount }, (_v, idx) => launchOneBrowser(idx)),
  );
  for (let i = 0; i < workerCount; i++) {
    browserBuckets[i % browserBuckets.length]!.remaining += 1;
  }

  const results: RuntimeResult[] = [];
  for (let i = 0; i < workerCount; i++) {
    const bucket = browserBuckets[i % browserBuckets.length]!;
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: webExecution?.browser,
        headless: webExecution?.headless ?? true,
        executablePath: webExecution?.executablePath,
        channel: webExecution?.channel,
        baseUrl: webUrl,
        storageState: webExecution?.storageState,
        verboseLogging: webExecution?.verboseLogging,
        sharedBrowser: bucket.browser,
        recordHar: Boolean(config.artifacts?.har),
        waitUntil: webExecution?.waitUntil,
        instantAnimations: webExecution?.instantAnimations,
        blockResources: webExecution?.blockResources,
        freshContextPerFlow: webExecution?.freshContextPerFlow,
        virtualAuthenticator: webExecution?.virtualAuthenticator,
        warmBrowserScope: webExecution?.warmBrowserScope,
      }),
    );
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());
    let cleaned = false;

    results.push({
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(async () => {
            if (cleaned) return;
            cleaned = true;
            await Effect.runPromise(driver.killApp(""));
            bucket.remaining -= 1;
            if (bucket.remaining <= 0 && bucket.owns) {
              await bucket.browser.close();
            }
          }),
        metadata: {
          platform: "web",
          mode: "local",
          deviceId: `playwright-context-${i + 1}`,
        },
      },
      engineConfig: buildEngineConfig(webUrl, "web", parseWebHierarchy, config, {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      }),
    });
  }

  return results;
}

export async function buildElectronRuntime(
  config: ProvConfig,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult> {
  const electronCfg = config.apps?.electron ?? {};
  const bridge = await maybeStartBridge(electronCfg.bridge, config.execution?.bridge);

  const driver = await Effect.runPromise(
    makeElectronDriver({
      entry: electronCfg.entry ? resolveFromConfig(electronCfg.entry) : undefined,
      executablePath: electronCfg.executablePath
        ? resolveFromConfig(electronCfg.executablePath)
        : undefined,
      args: electronCfg.args,
      cwd: electronCfg.cwd ? resolveFromConfig(electronCfg.cwd) : undefined,
      env: {
        ...electronCfg.env,
        ...(bridge?.url ? { SPANA_BRIDGE: "1", SPANA_BRIDGE_URL: bridge.url } : {}),
      },
      cdpUrl: electronCfg.cdpUrl,
      cdpPort: electronCfg.cdpPort,
      url: electronCfg.url,
      domChannel: bridge,
    }),
  );
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  return {
    runtime: {
      driver,
      cleanup: () =>
        safeCleanup(
          () => Effect.runPromise(driver.killApp("")),
          () => bridge?.disconnect() ?? Promise.resolve(),
        ),
      metadata: {
        platform: "electron",
        mode: "local",
        deviceId: deviceInfo.deviceId,
      },
    },
    engineConfig: buildEngineConfig(
      electronCfg.url ?? electronCfg.entry ?? "electron",
      "electron",
      parseWebHierarchy,
      config,
      {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      },
    ),
  };
}

export async function buildElectrobunRuntime(
  config: ProvConfig,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult> {
  const electrobunCfg = config.apps?.electrobun ?? {};
  const bridge = await maybeStartBridge(electrobunCfg.bridge, config.execution?.bridge);

  const driver = await Effect.runPromise(
    makeElectrobunDriver({
      executablePath: electrobunCfg.executablePath
        ? resolveFromConfig(electrobunCfg.executablePath)
        : undefined,
      appDir: electrobunCfg.appDir ? resolveFromConfig(electrobunCfg.appDir) : undefined,
      args: electrobunCfg.args,
      cwd: electrobunCfg.cwd ? resolveFromConfig(electrobunCfg.cwd) : undefined,
      env: {
        ...electrobunCfg.env,
        ...(bridge?.url ? { SPANA_BRIDGE: "1", SPANA_BRIDGE_URL: bridge.url } : {}),
      },
      renderer: electrobunCfg.renderer,
      cdpUrl: electrobunCfg.cdpUrl,
      cdpPort: electrobunCfg.cdpPort,
      webkitInspectorPort: electrobunCfg.webkitInspectorPort,
      url: electrobunCfg.url,
      domChannel: bridge,
    }),
  );
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  return {
    runtime: {
      driver,
      cleanup: () =>
        safeCleanup(
          () => Effect.runPromise(driver.killApp("")),
          () => bridge?.disconnect() ?? Promise.resolve(),
        ),
      metadata: {
        platform: "electrobun",
        mode: "local",
        deviceId: deviceInfo.deviceId,
      },
    },
    engineConfig: buildEngineConfig(
      electrobunCfg.url ?? electrobunCfg.executablePath ?? "electrobun",
      "electrobun",
      parseWebHierarchy,
      config,
      {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      },
    ),
  };
}

export async function buildLocalAndroidRuntime(
  config: ProvConfig,
  targetDevice: DiscoveredDevice | null,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult | null> {
  const device =
    targetDevice?.platform === "android"
      ? {
          serial: targetDevice.id,
          state: "device" as const,
          type: targetDevice.type as "emulator" | "device",
        }
      : ensureAndroidDevice();
  if (!device) {
    console.log("No Android device/emulator available. Skipping android platform.");
    return null;
  }
  const packageName = config.apps?.android?.packageName ?? "";
  const androidAppPath = config.apps?.android?.appPath;
  if (androidAppPath && packageName) {
    try {
      const { adbShell, adbInstall } = await import("../device/android.js");
      const output = adbShell(device.serial, `pm list packages ${packageName}`);
      if (!output.includes(packageName)) {
        console.log(`Installing ${packageName} on Android device...`);
        adbInstall(device.serial, resolveFromConfig(androidAppPath));
      }
    } catch {
      console.log(`Installing ${packageName} on Android device...`);
      const { adbInstall } = await import("../device/android.js");
      adbInstall(device.serial, resolveFromConfig(androidAppPath));
    }
  }
  const hostPort = allocatePort(8200);
  const warmDaemons = config.execution?.warmDaemons;
  const bridge = await maybeStartBridge(config.apps?.android?.bridge, config.execution?.bridge);

  // Automatically reverse-forward the bridge port over USB/ADB so both physical
  // Android phones and emulators can connect directly to ws://127.0.0.1:<port>.
  const reversedBridgePort = bridge?.port ?? null;
  if (reversedBridgePort !== null) {
    try {
      adbReverse(device.serial, reversedBridgePort, reversedBridgePort);
    } catch {
      // Best-effort — emulators still reach host via 10.0.2.2
    }
  }

  try {
    const conn = await setupUiAutomator2(device.serial, hostPort, {
      warm: warmDaemons?.enabled,
      daemonStateFile: warmDaemons?.stateFile,
    });
    const driver = await Effect.runPromise(
      createUiAutomator2Driver(conn.host, conn.port, device.serial, packageName, {
        domChannel: bridge,
        cdpPort: config.apps?.android?.cdpPort,
      }),
    );
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => Effect.runPromise(driver.killApp("")),
            () => bridge?.disconnect() ?? Promise.resolve(),
            () => {
              if (reversedBridgePort !== null) {
                adbReverseRemove(device.serial, reversedBridgePort);
              }
              return Promise.resolve();
            },
            () => conn.cleanup?.() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "android",
          mode: "local",
          deviceId: device.serial,
        },
      },
      engineConfig: buildEngineConfig(packageName, "android", parseAndroidHierarchy, config, {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      }),
    };
  } catch (e) {
    await bridge?.disconnect().catch(() => {});
    console.log(`Android setup failed on ${device.serial}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function buildLocalIOSRuntime(
  config: ProvConfig,
  targetDevice: DiscoveredDevice | null,
  resolveFromConfig: (p: string) => string,
): Promise<RuntimeResult | null> {
  const bundleId = config.apps?.ios?.bundleId ?? "";
  const iosAppPath = config.apps?.ios?.appPath;
  const signing = config.apps?.ios?.signing;
  const snapshotMaxDepth = config.defaults?.snapshotMaxDepth ?? 100;
  const warmDaemons = config.execution?.warmDaemons;
  const bridge = await maybeStartBridge(config.apps?.ios?.bridge, config.execution?.bridge);

  const createIOSRuntime = async (
    deviceId: string,
    conn: { host: string; port: number; cleanup?: () => void; warmSessionId?: string },
    simulatorUdid?: string,
  ): Promise<RuntimeResult> => {
    const reuseSession = warmDaemons?.enabled && warmDaemons.reuseSession !== false;
    const driver = await Effect.runPromise(
      createWDADriver(conn.host, conn.port, bundleId, simulatorUdid, snapshotMaxDepth, {
        domChannel: bridge,
        webkitInspectorUrl: config.apps?.ios?.webkitInspectorUrl,
        webkitInspectorPort: config.apps?.ios?.webkitInspectorPort,
        autoStartInspectorProxy: true,
        warmSessionId: reuseSession ? conn.warmSessionId : undefined,
        onSessionCreated: reuseSession
          ? (sessionId) =>
              updateWarmDaemonSession("wda", deviceId, sessionId, bundleId, warmDaemons?.stateFile)
          : undefined,
      }),
    );
    const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => Effect.runPromise(driver.killApp("")),
            () => bridge?.disconnect() ?? Promise.resolve(),
            () => conn.cleanup?.() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "ios",
          mode: "local",
          deviceId,
        },
      },
      engineConfig: buildEngineConfig(bundleId, "ios", parseIOSHierarchy, config, {
        width: deviceInfo.screenWidth,
        height: deviceInfo.screenHeight,
      }),
    };
  };

  const connectPhysicalRuntime = async (
    physicalDevice: { udid: string; name: string },
    allowSimulatorFallback: boolean,
  ): Promise<RuntimeResult | null> => {
    let conn: { host: string; port: number; cleanup?: () => void } | undefined;

    try {
      console.log(`Found physical iOS device: ${physicalDevice.name} (${physicalDevice.udid})`);
      if (iosAppPath && bundleId) {
        ensureAppInstalled({
          udid: physicalDevice.udid,
          bundleId,
          appPath: resolveFromConfig(iosAppPath),
          isPhysicalDevice: true,
        });
      }

      if (signing?.teamId) {
        const { setupWDAForDevice } = await import("../drivers/wda/installer.js");
        const wdaPort = allocatePort(8100);
        conn = await setupWDAForDevice(
          physicalDevice.udid,
          wdaPort,
          signing.teamId,
          signing.signingIdentity,
          { warm: warmDaemons?.enabled, daemonStateFile: warmDaemons?.stateFile },
        );
      } else {
        conn = connectPhysicalDevice(physicalDevice.udid);
      }

      return await createIOSRuntime(physicalDevice.udid, conn);
    } catch (e) {
      if (conn?.cleanup) {
        try {
          await conn.cleanup();
        } catch (cleanupError) {
          console.warn(
            `Failed to clean up physical device tunnel: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
          );
        }
      }

      if (!allowSimulatorFallback) {
        await bridge?.disconnect().catch(() => {});
        console.log(
          `iOS setup failed for device ${physicalDevice.udid}: ${e instanceof Error ? e.message : e}`,
        );
        return null;
      }

      console.log(
        `Physical device setup failed (${physicalDevice.name}): ${e instanceof Error ? e.message : e}. Falling back to simulator.`,
      );
      return null;
    }
  };

  // If a specific simulator was targeted, use it directly
  if (targetDevice?.platform === "ios" && targetDevice.type === "simulator") {
    if (iosAppPath && bundleId) {
      ensureAppInstalled({
        udid: targetDevice.id,
        bundleId,
        appPath: resolveFromConfig(iosAppPath),
        isPhysicalDevice: false,
      });
    }
    const wdaPort = allocatePort(8100);
    try {
      const conn = await setupWDA(targetDevice.id, wdaPort, {
        warm: warmDaemons?.enabled,
        daemonStateFile: warmDaemons?.stateFile,
      });
      return await createIOSRuntime(targetDevice.id, conn, targetDevice.id);
    } catch (e) {
      await bridge?.disconnect().catch(() => {});
      console.log(
        `iOS setup failed for device ${targetDevice.id}: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  if (targetDevice?.platform === "ios" && targetDevice.type === "device") {
    return connectPhysicalRuntime({ udid: targetDevice.id, name: targetDevice.name }, false);
  }

  // Try physical device first, fall back to simulator
  const physicalDevice = firstIOSPhysicalDevice();
  if (physicalDevice) {
    const runtime = await connectPhysicalRuntime(physicalDevice, true);
    if (runtime) {
      return runtime;
    }
  }

  // Fall back to simulator
  const simulator = ensureIOSSimulator(bundleId);
  if (!simulator) {
    await bridge?.disconnect().catch(() => {});
    console.log("No iOS simulator or physical device available. Skipping ios platform.");
    return null;
  }
  if (iosAppPath && bundleId) {
    ensureAppInstalled({
      udid: simulator.udid,
      bundleId,
      appPath: resolveFromConfig(iosAppPath),
      isPhysicalDevice: false,
    });
  }
  const wdaPort = allocatePort(8100);
  try {
    const conn = await setupWDA(simulator.udid, wdaPort, {
      warm: warmDaemons?.enabled,
      daemonStateFile: warmDaemons?.stateFile,
    });
    return await createIOSRuntime(simulator.udid, conn, simulator.udid);
  } catch (e) {
    await bridge?.disconnect().catch(() => {});
    console.log(`iOS setup failed on ${simulator.name}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
