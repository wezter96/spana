import { Effect } from "effect";
import type { ProvConfig } from "../schemas/config.js";
import type { EngineConfig } from "../core/engine.js";
import type { DiscoveredDevice } from "../device/discover.js";
import type { RuntimeResult } from "./types.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { createUiAutomator2Driver } from "../drivers/uiautomator2/driver.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import { createWDADriver } from "../drivers/wda/driver.js";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { ensureAndroidDevice } from "../device/android.js";
import {
  ensureIOSSimulator,
  firstIOSPhysicalDevice,
  connectPhysicalDevice,
  ensureAppInstalled,
} from "../device/ios.js";
import { setupUiAutomator2 } from "../drivers/uiautomator2/installer.js";
import { setupWDA } from "../drivers/wda/installer.js";
import { allocatePort } from "../core/port-allocator.js";

async function safeCleanup(...fns: Array<() => Promise<unknown>>): Promise<void> {
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      /* swallow */
    }
  }
}

function buildEngineConfig(
  appId: string,
  platform: "web" | "android" | "ios",
  parseFn: (raw: string) => unknown,
  config: ProvConfig,
): EngineConfig {
  return {
    appId,
    platform,
    coordinatorConfig: {
      parse: parseFn,
      defaults: {
        timeout: config.defaults?.waitTimeout,
        pollInterval: config.defaults?.pollInterval,
      },
    },
    autoLaunch: true,
    flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
    artifactConfig: config.artifacts,
    launchOptions: config.launchOptions,
    hooks: config.hooks,
  };
}

export async function buildWebRuntime(config: ProvConfig): Promise<RuntimeResult> {
  const webUrl = config.apps?.web?.url ?? "http://localhost:3000";
  const driver = await Effect.runPromise(makePlaywrightDriver({ headless: true, baseUrl: webUrl }));

  return {
    runtime: {
      driver,
      cleanup: () => safeCleanup(() => Effect.runPromise(driver.killApp(""))),
      metadata: {
        platform: "web",
        mode: "local",
      },
    },
    engineConfig: buildEngineConfig(webUrl, "web", parseWebHierarchy, config),
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
  try {
    const conn = await setupUiAutomator2(device.serial, hostPort);
    const driver = await Effect.runPromise(
      createUiAutomator2Driver(conn.host, conn.port, device.serial, packageName),
    );

    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => Effect.runPromise(driver.killApp("")),
            () => conn.cleanup?.() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "android",
          mode: "local",
          deviceId: device.serial,
        },
      },
      engineConfig: buildEngineConfig(packageName, "android", parseAndroidHierarchy, config),
    };
  } catch (e) {
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
      const conn = await setupWDA(targetDevice.id, wdaPort);
      const driver = await Effect.runPromise(
        createWDADriver(conn.host, conn.port, bundleId, targetDevice.id),
      );

      return {
        runtime: {
          driver,
          cleanup: () =>
            safeCleanup(
              () => Effect.runPromise(driver.killApp("")),
              () => conn.cleanup?.() ?? Promise.resolve(),
            ),
          metadata: {
            platform: "ios",
            mode: "local",
            deviceId: targetDevice.id,
          },
        },
        engineConfig: buildEngineConfig(bundleId, "ios", parseIOSHierarchy, config),
      };
    } catch (e) {
      console.log(
        `iOS setup failed for device ${targetDevice.id}: ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  // Try physical device first, fall back to simulator
  const physicalDevice = firstIOSPhysicalDevice();
  const signing = config.apps?.ios?.signing;
  if (physicalDevice) {
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

      let conn: { host: string; port: number; cleanup?: () => void };
      if (signing?.teamId) {
        const { setupWDAForDevice } = await import("../drivers/wda/installer.js");
        const wdaPort = allocatePort(8100);
        conn = await setupWDAForDevice(
          physicalDevice.udid,
          wdaPort,
          signing.teamId,
          signing.signingIdentity,
        );
      } else {
        conn = connectPhysicalDevice(physicalDevice.udid);
      }

      const driver = await Effect.runPromise(createWDADriver(conn.host, conn.port, bundleId));

      return {
        runtime: {
          driver,
          cleanup: () =>
            safeCleanup(
              () => Effect.runPromise(driver.killApp("")),
              () => conn.cleanup?.() ?? Promise.resolve(),
            ),
          metadata: {
            platform: "ios",
            mode: "local",
            deviceId: physicalDevice.udid,
          },
        },
        engineConfig: buildEngineConfig(bundleId, "ios", parseIOSHierarchy, config),
      };
    } catch (e) {
      console.log(
        `Physical device setup failed (${physicalDevice.name}): ${e instanceof Error ? e.message : e}. Falling back to simulator.`,
      );
    }
  }

  // Fall back to simulator
  const simulator = ensureIOSSimulator(bundleId);
  if (!simulator) {
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
    const conn = await setupWDA(simulator.udid, wdaPort);
    const driver = await Effect.runPromise(
      createWDADriver(conn.host, conn.port, bundleId, simulator.udid),
    );

    return {
      runtime: {
        driver,
        cleanup: () =>
          safeCleanup(
            () => Effect.runPromise(driver.killApp("")),
            () => conn.cleanup?.() ?? Promise.resolve(),
          ),
        metadata: {
          platform: "ios",
          mode: "local",
          deviceId: simulator.udid,
        },
      },
      engineConfig: buildEngineConfig(bundleId, "ios", parseIOSHierarchy, config),
    };
  } catch (e) {
    console.log(`iOS setup failed on ${simulator.name}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
