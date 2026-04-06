import { resolve, dirname } from "node:path";
import {
  discoverFlows,
  loadTestSource,
  loadStepFiles,
  discoverStepFiles,
  filterFlows,
} from "../core/runner.js";
import { orchestrate, type PlatformConfig } from "../core/orchestrator.js";
import type { ProvConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import type { RuntimeHandle } from "../runtime/types.js";
import {
  buildWebRuntime,
  buildLocalAndroidRuntime,
  buildLocalIOSRuntime,
} from "../runtime/local.js";
import { buildAppiumAndroidRuntime, buildAppiumIOSRuntime } from "../runtime/appium.js";

export interface TestCommandOptions {
  platforms: Platform[];
  tags?: string[];
  grep?: string;
  reporter?: string;
  configPath?: string;
  flowPath?: string;
  retries?: number;
  device?: string;
  driver?: "local" | "appium";
  appiumUrl?: string;
  capsPath?: string;
  capsJson?: string;
  noProviderReporting?: boolean;
}

export async function runTestCommand(opts: TestCommandOptions): Promise<boolean> {
  if (opts.driver && opts.driver !== "local" && opts.driver !== "appium") {
    console.log(`Unknown --driver value "${opts.driver}". Use "local" or "appium".`);
    return false;
  }

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

  // Determine execution mode: CLI --driver flag overrides config
  const executionMode = opts.driver ?? config.execution?.mode ?? "local";

  // Validate --caps-json early
  if (opts.capsJson) {
    try {
      JSON.parse(opts.capsJson);
    } catch {
      console.log("Invalid JSON in --caps-json flag.");
      return false;
    }
  }

  // Validate appium mode requirements
  if (executionMode === "appium") {
    const appiumUrl = opts.appiumUrl ?? config.execution?.appium?.serverUrl;
    if (!appiumUrl) {
      console.log(
        "Appium mode requires a server URL. Set --appium-url or execution.appium.serverUrl in config.",
      );
      return false;
    }
    // Validate --device conflicts with appium mode
    if (opts.device) {
      console.log(
        "Cannot use --device with appium mode. Use --caps or --caps-json to set device capabilities.",
      );
      return false;
    }
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

  // 4. Setup platform drivers via runtime builders
  const runtimes: RuntimeHandle[] = [];
  const platformConfigs: PlatformConfig[] = [];

  try {
    const appiumUrl = opts.appiumUrl ?? config.execution?.appium?.serverUrl;
    const appiumConfig = config.execution?.appium;

    for (const platform of platforms) {
      if (executionMode === "appium" && (platform === "android" || platform === "ios")) {
        // Appium cloud mode
        const builder = platform === "android" ? buildAppiumAndroidRuntime : buildAppiumIOSRuntime;
        const result = await builder(config, appiumConfig!, {
          capsPath: opts.capsPath,
          capsJson: opts.capsJson,
        });
        runtimes.push(result.runtime);
        platformConfigs.push({
          platform,
          driver: result.runtime.driver,
          engineConfig: result.engineConfig,
        });
      } else if (platform === "web") {
        const result = await buildWebRuntime(config);
        runtimes.push(result.runtime);
        platformConfigs.push({
          platform,
          driver: result.runtime.driver,
          engineConfig: result.engineConfig,
        });
      } else if (platform === "android") {
        const result = await buildLocalAndroidRuntime(config, targetDevice, resolveFromConfig);
        if (!result) continue;
        runtimes.push(result.runtime);
        platformConfigs.push({
          platform,
          driver: result.runtime.driver,
          engineConfig: result.engineConfig,
        });
      } else if (platform === "ios") {
        const result = await buildLocalIOSRuntime(config, targetDevice, resolveFromConfig);
        if (!result) continue;
        runtimes.push(result.runtime);
        platformConfigs.push({
          platform,
          driver: result.runtime.driver,
          engineConfig: result.engineConfig,
        });
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

    // Report to cloud provider if applicable
    if (!opts.noProviderReporting && appiumUrl) {
      const { detectProvider } = await import("../cloud/provider.js");
      for (const rt of runtimes) {
        if (rt.metadata.mode === "appium" && rt.metadata.provider) {
          const provider = detectProvider(appiumUrl);
          if (provider) {
            try {
              const meta: Record<string, string> = {};
              provider.extractMeta(rt.metadata.sessionId!, rt.metadata.sessionCaps ?? {}, meta);
              await provider.reportResult(appiumUrl, meta, {
                passed: result.failed === 0,
                name: `spana ${platforms.join(",")}`,
              });
            } catch (e) {
              console.log(
                `Warning: Failed to report to ${rt.metadata.provider}: ${e instanceof Error ? e.message : e}`,
              );
            }
          }
        }
      }
    }

    return result.failed === 0;
  } finally {
    // 7. Cleanup — always runs even if orchestration/reporting fails
    for (const rt of runtimes) {
      try {
        await rt.cleanup();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
