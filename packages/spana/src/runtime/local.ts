import { Effect } from "effect";
import type { BridgeConfig, ProvConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import type { EngineConfig } from "../core/engine.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";
import type { DiscoveredDevice } from "../device/discover.js";
import type { RuntimeResult } from "./types.js";
import { launchPlaywrightBrowser, makePlaywrightDriver } from "../drivers/playwright.js";
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

export async function buildWebRuntime(config: ProvConfig): Promise<RuntimeResult> {
  const webUrl = config.apps?.web?.url ?? "http://localhost:3000";
  const webExecution = config.execution?.web;
  const bridge = await maybeStartBridge(config.apps?.web?.bridge, config.execution?.bridge);

  const rawDriver = await Effect.runPromise(
    makePlaywrightDriver({
      browser: webExecution?.browser,
      headless: webExecution?.headless ?? true,
      baseUrl: webUrl,
      storageState: webExecution?.storageState,
      verboseLogging: webExecution?.verboseLogging,
      recordHar: Boolean(config.artifacts?.har),
    }),
  );
  const driver = bridge ? { ...rawDriver, domChannel: bridge } : rawDriver;
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
 * Launch ONE shared Playwright browser process and create `workerCount`
 * isolated BrowserContext runtimes on top of it (faster startup, lower RAM).
 */
export async function buildWebRuntimePool(
  config: ProvConfig,
  workerCount: number,
): Promise<RuntimeResult[]> {
  if (workerCount <= 1) {
    return [await buildWebRuntime(config)];
  }

  const webUrl = config.apps?.web?.url ?? "http://localhost:3000";
  const webExecution = config.execution?.web;
  const sharedBrowser = await launchPlaywrightBrowser({
    browser: webExecution?.browser,
    headless: webExecution?.headless ?? true,
  });

  let remaining = workerCount;
  const results: RuntimeResult[] = [];

  for (let i = 0; i < workerCount; i++) {
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: webExecution?.browser,
        headless: webExecution?.headless ?? true,
        baseUrl: webUrl,
        storageState: webExecution?.storageState,
        verboseLogging: webExecution?.verboseLogging,
        sharedBrowser,
        recordHar: Boolean(config.artifacts?.har),
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
            remaining -= 1;
            if (remaining <= 0) {
              await sharedBrowser.close();
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
