import { resolve, dirname } from "node:path";
import { Effect } from "effect";
import {
  discoverFlows,
  loadTestSource,
  loadStepFiles,
  discoverStepFiles,
  filterFlows,
} from "../core/runner.js";
import { orchestrate, type PlatformConfig } from "../core/orchestrator.js";
import type { EngineConfig } from "../core/engine.js";
import type { ProvConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import { createUiAutomator2Driver } from "../drivers/uiautomator2/driver.js";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { createWDADriver } from "../drivers/wda/driver.js";
import { ensureAndroidDevice } from "../device/android.js";
import {
  ensureIOSSimulator,
  firstIOSPhysicalDevice,
  connectPhysicalDevice,
  ensureAppInstalled,
} from "../device/ios.js";
import { setupUiAutomator2 } from "../drivers/uiautomator2/installer.js";
import { setupWDA } from "../drivers/wda/installer.js";

export interface TestCommandOptions {
  platforms: Platform[];
  tags?: string[];
  grep?: string;
  reporter?: string;
  configPath?: string;
  flowPath?: string;
  retries?: number;
  device?: string;
}

export async function runTestCommand(opts: TestCommandOptions): Promise<boolean> {
  // 1. Load config
  let config: ProvConfig = {};
  const configPath = resolve(opts.configPath ?? "spana.config.ts");
  const configDir = dirname(configPath);
  try {
    const mod = await import(configPath);
    config = mod.default ?? {};
  } catch {
    // No config file, use defaults
  }

  // Resolve paths relative to config file location
  const resolveFromConfig = (p: string) => resolve(configDir, p);
  if (config.artifacts?.outputDir) {
    config.artifacts.outputDir = resolveFromConfig(config.artifacts.outputDir);
  }

  const platforms: Platform[] =
    opts.platforms.length > 0
      ? opts.platforms
      : config.platforms && config.platforms.length > 0
        ? config.platforms
        : ["web"];

  // Resolve explicit device targeting
  let targetDevice: import("../device/discover.js").DiscoveredDevice | null = null;
  if (opts.device) {
    const { findDeviceById } = await import("../device/discover.js");
    targetDevice = findDeviceById(opts.device);
    if (!targetDevice) {
      const { discoverDevices } = await import("../device/discover.js");
      const available = discoverDevices(["web", "android", "ios"]);
      console.log(`Device "${opts.device}" not found. Available devices:`);
      for (const d of available) {
        console.log(`  ${d.id.padEnd(30)} ${d.platform.padEnd(8)} ${d.type}`);
      }
      return false;
    }
    // If --platform wasn't explicitly passed on CLI, infer from device
    if (opts.platforms.length === 0) {
      platforms.length = 0;
      platforms.push(targetDevice.platform);
    }
    // Validate platform match
    if (!platforms.includes(targetDevice.platform)) {
      console.log(
        `Device "${opts.device}" is ${targetDevice.platform}, but --platform ${platforms.join(",")} was specified.`,
      );
      return false;
    }
  }

  const reporterNames = opts.reporter?.trim()
    ? opts.reporter
    : config.reporters && config.reporters.length > 0
      ? config.reporters.join(",")
      : "console";

  // 2. Discover flows and step definitions
  const flowDir = opts.flowPath ?? resolveFromConfig(config.flowDir ?? "./flows");
  const flowPaths = await discoverFlows(flowDir);

  if (flowPaths.length === 0) {
    console.log("No flow files found.");
    return true;
  }

  // Load step definition files before compiling .feature files
  const hasFeatureFiles = flowPaths.some((p) => p.endsWith(".feature"));
  if (hasFeatureFiles) {
    // When flowDir is a file, search for steps in its parent directory
    const { stat: statPath } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const flowDirStats = await statPath(flowDir).catch(() => null);
    const stepSearchDir = flowDirStats?.isDirectory() ? flowDir : dirname(flowDir);
    const stepPaths = await discoverStepFiles(stepSearchDir);
    if (stepPaths.length > 0) {
      await loadStepFiles(stepPaths);
    }
  }

  // 3. Load and filter flows (supports both .flow.ts and .feature)
  const flows = [];
  for (const p of flowPaths) {
    const loaded = await loadTestSource(p);
    flows.push(...loaded);
  }
  const filtered = filterFlows(flows, {
    tags: opts.tags,
    grep: opts.grep,
    platforms,
  });

  if (filtered.length === 0) {
    console.log("No flows match the given filters.");
    return true;
  }

  console.log(`Running ${filtered.length} flow(s) on ${platforms.join(", ")}...\n`);

  // 4. Setup platform drivers
  const platformConfigs: PlatformConfig[] = [];

  for (const platform of platforms) {
    if (platform === "web") {
      const webUrl = config.apps?.web?.url ?? "http://localhost:3000";
      const driver = await Effect.runPromise(
        makePlaywrightDriver({ headless: true, baseUrl: webUrl }),
      );
      const engineConfig: EngineConfig = {
        appId: webUrl,
        platform: "web",
        coordinatorConfig: {
          parse: parseWebHierarchy,
          defaults: {
            timeout: config.defaults?.waitTimeout,
            pollInterval: config.defaults?.pollInterval,
          },
        },
        autoLaunch: true,
        flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
        artifactConfig: config.artifacts,
        launchOptions: config.launchOptions,
      };
      platformConfigs.push({ platform, driver, engineConfig });
    }
    if (platform === "android") {
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
        continue;
      }
      const packageName = config.apps?.android?.packageName ?? "";
      const androidAppPath = config.apps?.android?.appPath;
      if (androidAppPath && packageName) {
        // Check if app is installed, install if not
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
      const hostPort = 8200 + Math.floor(Math.random() * 100);
      try {
        // Auto-setup: start server, forward port
        const conn = await setupUiAutomator2(device.serial, hostPort);
        const driver = await Effect.runPromise(
          createUiAutomator2Driver(conn.host, conn.port, device.serial, packageName),
        );
        const engineConfig: EngineConfig = {
          appId: packageName,
          platform: "android",
          coordinatorConfig: {
            parse: parseAndroidHierarchy,
            defaults: {
              timeout: config.defaults?.waitTimeout,
              pollInterval: config.defaults?.pollInterval,
            },
          },
          autoLaunch: true,
          flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
          artifactConfig: config.artifacts,
          launchOptions: config.launchOptions,
        };
        platformConfigs.push({ platform, driver, engineConfig });
      } catch (e) {
        console.log(
          `Android setup failed on ${device.serial}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    if (platform === "ios") {
      const bundleId = config.apps?.ios?.bundleId ?? "";

      const iosAppPath = config.apps?.ios?.appPath;

      // If a specific device was targeted, use it directly
      if (targetDevice?.platform === "ios" && targetDevice.type === "simulator") {
        if (iosAppPath && bundleId) {
          ensureAppInstalled({
            udid: targetDevice.id,
            bundleId,
            appPath: resolveFromConfig(iosAppPath),
            isPhysicalDevice: false,
          });
        }
        const wdaPort = 8100 + Math.floor(Math.random() * 100);
        try {
          const conn = await setupWDA(targetDevice.id, wdaPort);
          const driver = await Effect.runPromise(
            createWDADriver(conn.host, conn.port, bundleId, targetDevice.id),
          );
          const engineConfig: EngineConfig = {
            appId: bundleId,
            platform: "ios",
            coordinatorConfig: {
              parse: parseIOSHierarchy,
              defaults: {
                timeout: config.defaults?.waitTimeout,
                pollInterval: config.defaults?.pollInterval,
              },
            },
            autoLaunch: true,
            flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
            artifactConfig: config.artifacts,
            launchOptions: config.launchOptions,
          };
          platformConfigs.push({ platform, driver, engineConfig });
          continue;
        } catch (e) {
          console.log(
            `iOS setup failed for device ${targetDevice.id}: ${e instanceof Error ? e.message : e}`,
          );
          continue;
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
            // Full automated setup: build WDA with signing, start on device, tunnel
            const { setupWDAForDevice } = await import("../drivers/wda/installer.js");
            const wdaPort = 8100 + Math.floor(Math.random() * 100);
            conn = await setupWDAForDevice(
              physicalDevice.udid,
              wdaPort,
              signing.teamId,
              signing.signingIdentity,
            );
          } else {
            // WDA assumed to be running already (started manually via Xcode)
            conn = connectPhysicalDevice(physicalDevice.udid);
          }

          const driver = await Effect.runPromise(createWDADriver(conn.host, conn.port, bundleId));
          const engineConfig: EngineConfig = {
            appId: bundleId,
            platform: "ios",
            coordinatorConfig: {
              parse: parseIOSHierarchy,
              defaults: {
                timeout: config.defaults?.waitTimeout,
                pollInterval: config.defaults?.pollInterval,
              },
            },
            autoLaunch: true,
            flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
            artifactConfig: config.artifacts,
            launchOptions: config.launchOptions,
          };
          platformConfigs.push({ platform, driver, engineConfig });
          continue;
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
        continue;
      }
      if (iosAppPath && bundleId) {
        ensureAppInstalled({
          udid: simulator.udid,
          bundleId,
          appPath: resolveFromConfig(iosAppPath),
          isPhysicalDevice: false,
        });
      }
      const wdaPort = 8100 + Math.floor(Math.random() * 100);
      try {
        const conn = await setupWDA(simulator.udid, wdaPort);
        const driver = await Effect.runPromise(
          createWDADriver(conn.host, conn.port, bundleId, simulator.udid),
        );
        const engineConfig: EngineConfig = {
          appId: bundleId,
          platform: "ios",
          coordinatorConfig: {
            parse: parseIOSHierarchy,
            defaults: {
              timeout: config.defaults?.waitTimeout,
              pollInterval: config.defaults?.pollInterval,
            },
          },
          autoLaunch: true,
          flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
          artifactConfig: config.artifacts,
          launchOptions: config.launchOptions,
        };
        platformConfigs.push({ platform, driver, engineConfig });
      } catch (e) {
        console.log(`iOS setup failed on ${simulator.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // 5. Run
  const retries = opts.retries ?? config.defaults?.retries ?? 0;
  const result = await orchestrate(filtered, platformConfigs, { retries });

  // 6. Report
  const { createConsoleReporter } = await import("../report/console.js");
  const { createJsonReporter } = await import("../report/json.js");
  const { createJUnitReporter } = await import("../report/junit.js");
  const { createHtmlReporter } = await import("../report/html.js");
  const { createAllureReporter } = await import("../report/allure.js");

  const resolvedOutputDir = config.artifacts?.outputDir ?? resolveFromConfig("./spana-output");
  const reporters = reporterNames.split(",").map((r) => {
    switch (r.trim()) {
      case "json":
        return createJsonReporter();
      case "junit":
        return createJUnitReporter(resolvedOutputDir);
      case "html":
        return createHtmlReporter(resolvedOutputDir);
      case "allure":
        return createAllureReporter();
      default:
        return createConsoleReporter();
    }
  });

  for (const r of result.results) {
    const flowResult = {
      ...r,
      error: r.error ? { message: r.error.message, stack: r.error.stack } : undefined,
    };
    for (const reporter of reporters) {
      if (r.status === "passed") {
        reporter.onFlowPass?.(flowResult);
      } else if (r.status === "failed") {
        reporter.onFlowFail?.(flowResult);
      }
    }
  }

  for (const reporter of reporters) {
    reporter.onRunComplete({
      total: result.results.length,
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      flaky: result.flaky,
      durationMs: result.totalDurationMs,
      results: result.results.map((r) => ({
        ...r,
        error: r.error ? { message: r.error.message, stack: r.error.stack } : undefined,
      })),
      platforms,
    });
  }

  // 7. Cleanup
  for (const pc of platformConfigs) {
    try {
      await Effect.runPromise(pc.driver.killApp(""));
    } catch {
      // ignore cleanup errors
    }
  }

  return result.failed === 0;
}
