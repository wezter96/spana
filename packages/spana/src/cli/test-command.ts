import { resolve, dirname } from "node:path";
import {
  discoverFlows,
  loadTestSource,
  loadStepFiles,
  discoverStepFiles,
  filterFlows,
  applyShard,
  type ShardOptions,
} from "../core/runner.js";
import { orchestrate, type PlatformConfig } from "../core/orchestrator.js";
import type { ProvConfig } from "../schemas/config.js";
import type { Reporter } from "../report/types.js";
import type { Platform } from "../schemas/selector.js";
import type { RuntimeHandle } from "../runtime/types.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import { loadConfig } from "./config-loader.js";
import {
  buildWebRuntime,
  buildLocalAndroidRuntime,
  buildLocalIOSRuntime,
} from "../runtime/local.js";
import { buildAppiumAndroidRuntime, buildAppiumIOSRuntime } from "../runtime/appium.js";
import { createCloudProviderHelper } from "../cloud/provider.js";
import type { DeviceWorkerConfig } from "../core/parallel.js";
import { collectDiagnosticSections } from "../report/failure-diagnostics.js";

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
  validateConfigOnly?: boolean;
  shard?: ShardOptions;
  bail?: number;
  debugOnFailure?: boolean;
  quiet?: boolean;
  parallel?: boolean;
  workers?: number;
  devices?: string[];
  verbose?: boolean;
}

function validateOptions(opts: TestCommandOptions): string | null {
  if (opts.driver && opts.driver !== "local" && opts.driver !== "appium") {
    return `Unknown --driver value "${opts.driver}". Use "local" or "appium".`;
  }

  if (opts.shard) {
    const { current, total } = opts.shard;
    if (
      !Number.isInteger(current) ||
      !Number.isInteger(total) ||
      current < 1 ||
      total < 1 ||
      current > total
    ) {
      return "Invalid shard config. Use { current, total } with 1 <= current <= total.";
    }
  }

  if (opts.bail !== undefined && (!Number.isInteger(opts.bail) || opts.bail < 1)) {
    return "Invalid bail config. Use a positive integer.";
  }

  if (opts.parallel && opts.device) {
    return "Cannot use --parallel with --device. Remove --device to auto-discover all devices.";
  }

  if (opts.devices && opts.device) {
    return "Cannot use --devices with --device. Use --devices for multi-device selection.";
  }

  if (opts.device && opts.workers) {
    return "Cannot use --workers with --device. --device targets a single device.";
  }

  return null;
}

async function buildParallelPlatformConfigs(
  platforms: Platform[],
  opts: Pick<TestCommandOptions, "devices" | "platforms" | "workers" | "debugOnFailure">,
  config: ProvConfig,
  runtimes: RuntimeHandle[],
  resolveFromConfig: (p: string) => string,
): Promise<PlatformConfig[]> {
  const { discoverDevices, findDeviceById } = await import("../device/discover.js");

  let allDevices;
  if (opts.devices) {
    // Use explicitly specified devices
    allDevices = [];
    for (const id of opts.devices) {
      const found = findDeviceById(id);
      if (found) {
        allDevices.push(found);
      } else {
        console.log(`Warning: Device "${id}" not found, skipping.`);
      }
    }
    // Infer platforms from selected devices if not explicitly set
    if (opts.platforms.length === 0) {
      const inferredPlatforms = [...new Set(allDevices.map((d) => d.platform))];
      platforms.length = 0;
      platforms.push(...inferredPlatforms);
    }
  } else {
    allDevices = discoverDevices(platforms);
  }

  const maxWorkers = opts.workers ?? config.defaults?.workers;
  const platformConfigs: PlatformConfig[] = [];

  for (const platform of platforms) {
    let platformDevices = allDevices.filter((d) => d.platform === platform);

    // Cap to maxWorkers if set
    if (maxWorkers && platformDevices.length > maxWorkers) {
      platformDevices = platformDevices.slice(0, maxWorkers);
    }

    if (platform === "web") {
      const webWorkers = maxWorkers ?? 1;
      if (webWorkers > 1) {
        // Build primary web runtime
        const primaryResult = await buildWebRuntime(config);
        runtimes.push(primaryResult.runtime);

        // Build additional web contexts
        const additionalWorkers: DeviceWorkerConfig[] = [];
        for (let i = 1; i < webWorkers; i++) {
          const result = await buildWebRuntime(config);
          runtimes.push(result.runtime);
          additionalWorkers.push({
            id: `web-context-${i + 1}`,
            name: `Chromium #${i + 1}`,
            driver: result.runtime.driver,
            engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
          });
        }

        platformConfigs.push({
          platform,
          driver: primaryResult.runtime.driver,
          engineConfig: { ...primaryResult.engineConfig, debugOnFailure: opts.debugOnFailure },
          additionalWorkers: additionalWorkers.length > 0 ? additionalWorkers : undefined,
        });
      } else {
        // Single web runtime (existing behavior)
        const result = await buildWebRuntime(config);
        runtimes.push(result.runtime);
        platformConfigs.push({
          platform,
          driver: result.runtime.driver,
          engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
        });
      }
    } else if (platformDevices.length === 0) {
      console.log(`No ${platform} devices found. Skipping ${platform} platform.`);
    } else {
      if (platformDevices.length === 1) {
        console.log(
          `ℹ Only 1 ${platform} device found — connect more devices for parallel execution.`,
        );
      }

      // Build runtime for first device (primary worker)
      const builder = platform === "android" ? buildLocalAndroidRuntime : buildLocalIOSRuntime;
      const primaryResult = await builder(config, platformDevices[0]!, resolveFromConfig);
      if (!primaryResult) continue;
      runtimes.push(primaryResult.runtime);

      // Build runtimes for additional devices (additional workers)
      const additionalWorkers: DeviceWorkerConfig[] = [];
      for (const device of platformDevices.slice(1)) {
        try {
          const result = await builder(config, device, resolveFromConfig);
          if (result) {
            runtimes.push(result.runtime);
            additionalWorkers.push({
              id: device.id,
              name: device.name,
              driver: result.runtime.driver,
              engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
            });
          }
        } catch (err) {
          console.log(
            `Warning: Failed to set up ${platform} device ${device.name}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      platformConfigs.push({
        platform,
        driver: primaryResult.runtime.driver,
        engineConfig: { ...primaryResult.engineConfig, debugOnFailure: opts.debugOnFailure },
        additionalWorkers: additionalWorkers.length > 0 ? additionalWorkers : undefined,
      });
    }
  }

  return platformConfigs;
}

async function buildSerialPlatformConfigs(
  platforms: Platform[],
  opts: Pick<TestCommandOptions, "capsPath" | "capsJson" | "debugOnFailure">,
  config: ProvConfig,
  runtimes: RuntimeHandle[],
  executionMode: string,
  appiumUrl: string | undefined,
  baseAppiumCaps: Record<string, unknown> | undefined,
  cloudHelper: Awaited<ReturnType<typeof createCloudProviderHelper>> | undefined,
  targetDevice: import("../device/discover.js").DiscoveredDevice | null,
  resolveFromConfig: (p: string) => string,
): Promise<PlatformConfig[]> {
  const platformConfigs: PlatformConfig[] = [];

  for (const platform of platforms) {
    if (executionMode === "appium" && (platform === "android" || platform === "ios")) {
      // Appium cloud mode
      const builder = platform === "android" ? buildAppiumAndroidRuntime : buildAppiumIOSRuntime;
      const preparedCaps = await cloudHelper!.prepareCapabilities(
        platform,
        { ...baseAppiumCaps },
        platform === "android" ? config.apps?.android : config.apps?.ios,
      );
      const result = await builder(config, appiumUrl!, preparedCaps);
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    } else if (platform === "web") {
      const result = await buildWebRuntime(config);
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    } else if (platform === "android") {
      const result = await buildLocalAndroidRuntime(config, targetDevice, resolveFromConfig);
      if (!result) continue;
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    } else if (platform === "ios") {
      const result = await buildLocalIOSRuntime(config, targetDevice, resolveFromConfig);
      if (!result) continue;
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    }
  }

  return platformConfigs;
}

const BUILTIN_REPORTERS = new Set(["console", "json", "junit", "html", "allure"]);

/**
 * Load a custom reporter from a module path.
 * The module must have a default export that is either a Reporter object
 * or a factory function (options: { outputDir: string }) => Reporter.
 */
export async function loadCustomReporter(modulePath: string, configDir: string): Promise<Reporter> {
  const resolvedPath = modulePath.startsWith(".") ? resolve(configDir, modulePath) : modulePath;

  let mod: Record<string, unknown>;
  try {
    mod = await import(resolvedPath);
  } catch (err) {
    throw new Error(
      `Failed to load custom reporter from "${modulePath}" (resolved: ${resolvedPath}): ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
  }

  const exported = mod.default;
  if (!exported) {
    throw new Error(
      `Custom reporter "${modulePath}" has no default export. Export a Reporter object or a (options) => Reporter factory function.`,
    );
  }

  if (typeof exported === "function") {
    return exported({ outputDir: configDir }) as Reporter;
  }

  if (typeof exported === "object") {
    return exported as Reporter;
  }

  throw new Error(
    `Custom reporter "${modulePath}" default export must be a Reporter object or factory function, got ${typeof exported}.`,
  );
}

async function setupReporters(
  reporterNames: string,
  config: ProvConfig,
  resolveFromConfig: (p: string) => string,
  appiumUrl: string | undefined,
  opts: Pick<TestCommandOptions, "quiet">,
) {
  const { createRedactor, registerUrlSecrets } = await import("../report/redact.js");
  const redactor = createRedactor();
  if (appiumUrl) registerUrlSecrets(redactor, appiumUrl);

  const { createConsoleReporter } = await import("../report/console.js");
  const { createJsonReporter } = await import("../report/json.js");
  const { createJUnitReporter } = await import("../report/junit.js");
  const { createHtmlReporter } = await import("../report/html.js");
  const { createAllureReporter } = await import("../report/allure.js");

  const resolvedOutputDir = config.artifacts?.outputDir ?? resolveFromConfig("./spana-output");
  const reporters: Reporter[] = [];

  for (const name of reporterNames.split(",")) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    if (BUILTIN_REPORTERS.has(trimmed)) {
      switch (trimmed) {
        case "json":
          reporters.push(createJsonReporter());
          break;
        case "junit":
          reporters.push(createJUnitReporter(resolvedOutputDir));
          break;
        case "html":
          reporters.push(createHtmlReporter(resolvedOutputDir));
          break;
        case "allure":
          reporters.push(createAllureReporter());
          break;
        default:
          reporters.push(createConsoleReporter({ quiet: opts.quiet }));
          break;
      }
    } else {
      const configDir = resolve(resolveFromConfig("."));
      try {
        const custom = await loadCustomReporter(trimmed, configDir);
        reporters.push(custom);
      } catch (err) {
        console.log(err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
  }

  return { redactor, reporters };
}

export async function runTestCommand(opts: TestCommandOptions): Promise<boolean> {
  const validationError = validateOptions(opts);
  if (validationError) {
    console.log(validationError);
    return false;
  }

  // 1. Load config
  let config: ProvConfig = {};
  let loadedConfigPath: string | undefined;
  try {
    const loaded = await loadConfig({ configPath: opts.configPath, allowMissing: true });
    config = loaded.config;
    loadedConfigPath = loaded.configPath;
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return false;
  }
  const configDir = dirname(loadedConfigPath ?? resolve("spana.config.ts"));

  if (opts.validateConfigOnly) {
    if (!loadedConfigPath) {
      console.log("No config file found to validate.");
      return false;
    }
    console.log(`✓ Config valid (${loadedConfigPath})`);
    return true;
  }

  // Resolve paths relative to config file location
  const resolveFromConfig = (p: string) => resolve(configDir, p);
  if (config.artifacts?.outputDir) {
    config.artifacts.outputDir = resolveFromConfig(config.artifacts.outputDir);
  }

  // Determine execution mode: CLI --driver flag overrides config
  const executionMode =
    opts.driver ?? (opts.appiumUrl ? "appium" : undefined) ?? config.execution?.mode ?? "local";

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
    const { dirname: dirnameDyn } = await import("node:path");
    const flowDirStats = await statPath(flowDir).catch(() => null);
    const stepSearchDir = flowDirStats?.isDirectory() ? flowDir : dirnameDyn(flowDir);
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
  const selectedFlows = applyShard(filtered, opts.shard);

  if (filtered.length === 0) {
    console.log("No flows match the given filters.");
    return true;
  }

  if (selectedFlows.length === 0) {
    console.log(`No flows assigned to shard ${opts.shard!.current}/${opts.shard!.total}.`);
    return true;
  }

  if (opts.shard) {
    console.log(
      `Running shard ${opts.shard.current}/${opts.shard.total} (${selectedFlows.length}/${filtered.length} flow(s))...`,
    );
  }
  console.log(`Running ${selectedFlows.length} flow(s) on ${platforms.join(", ")}...\n`);

  // 4. Setup platform drivers via runtime builders
  const runtimes: RuntimeHandle[] = [];
  const platformConfigs: PlatformConfig[] = [];
  const runCleanups: Array<() => Promise<void>> = [];

  // Signal handling for graceful cleanup
  const handleSignal = () => {
    for (const cleanup of runCleanups) {
      try {
        void cleanup();
      } catch {
        /* ignore */
      }
    }
    for (const rt of runtimes) {
      try {
        void rt.cleanup();
      } catch {
        /* ignore */
      }
    }
    process.exit(1);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    const appiumUrl = opts.appiumUrl ?? config.execution?.appium?.serverUrl;
    const appiumConfig = config.execution?.appium ?? {};
    const shouldReportToProvider =
      !opts.noProviderReporting && appiumConfig.reportToProvider !== false;
    const cloudHelper =
      executionMode === "appium" && appiumUrl
        ? await createCloudProviderHelper(appiumUrl, appiumConfig)
        : undefined;
    const baseAppiumCaps =
      executionMode === "appium" && appiumUrl
        ? await resolveCapabilities(appiumConfig, {
            capsPath: opts.capsPath,
            capsJson: opts.capsJson,
          })
        : undefined;

    if (cloudHelper) {
      runCleanups.push(() => cloudHelper.cleanup());
    }

    if (opts.parallel || opts.workers || opts.devices) {
      platformConfigs.push(
        ...(await buildParallelPlatformConfigs(
          platforms,
          opts,
          config,
          runtimes,
          resolveFromConfig,
        )),
      );
    } else {
      platformConfigs.push(
        ...(await buildSerialPlatformConfigs(
          platforms,
          opts,
          config,
          runtimes,
          executionMode,
          appiumUrl,
          baseAppiumCaps,
          cloudHelper,
          targetDevice,
          resolveFromConfig,
        )),
      );
    }

    // 5. Set up redactor and reporters (before run for real-time streaming)
    const { redactor, reporters } = await setupReporters(
      reporterNames,
      config,
      resolveFromConfig,
      appiumUrl,
      opts,
    );

    // Set flow count for progress display
    const totalFlowCount = selectedFlows.length * platforms.length;
    for (const reporter of reporters) {
      if (reporter.flowCount !== undefined || "flowCount" in reporter) {
        reporter.flowCount = totalFlowCount;
      }
    }

    // Set per-platform flow counts for detailed progress
    const platformCounts: Partial<Record<Platform, number>> = {};
    for (const p of platforms) {
      platformCounts[p] = selectedFlows.length;
    }
    for (const reporter of reporters) {
      if ("platformFlowCounts" in reporter) {
        reporter.platformFlowCounts = platformCounts;
      }
    }

    // Redact sensitive data from a result before it reaches reporters
    type ResultLike = (typeof platformConfigs)[number]["engineConfig"] extends unknown
      ? import("../core/engine.js").TestResult
      : never;
    const redactResult = <T extends ResultLike>(r: T): T => {
      if (!r.error) return r;
      return {
        ...r,
        error: {
          ...r.error,
          message: redactor.redact(r.error.message),
          stack: r.error.stack ? redactor.redact(r.error.stack) : undefined,
          suggestion: r.error.suggestion ? redactor.redact(r.error.suggestion) : undefined,
        },
      };
    };

    // 6. Run with real-time reporter callbacks
    const retries = opts.retries ?? config.defaults?.retries ?? 0;
    const retryDelay = config.defaults?.retryDelay ?? 0;
    const result = await orchestrate(selectedFlows, platformConfigs, {
      retries,
      retryDelay,
      bail: opts.bail,
      parallelPlatforms: opts.parallel || !!opts.workers || !!opts.devices,
      onFlowStart(name, platform, workerName) {
        for (const reporter of reporters) {
          reporter.onFlowStart?.(name, platform, workerName);
        }
      },
      onResult(r) {
        const redacted = redactResult(r);
        for (const reporter of reporters) {
          if (redacted.status === "passed") {
            reporter.onFlowPass?.(redacted);
          } else if (redacted.status === "failed") {
            reporter.onFlowFail?.(redacted);
            if (opts.verbose && redacted.error) {
              console.log(
                `\n[verbose] Failure details for "${redacted.name}" on ${redacted.platform}:`,
              );
              console.log(`  Category: ${redacted.error.category}`);
              console.log(`  Message: ${redacted.error.message}`);
              if (redacted.error.suggestion) {
                console.log(`  Suggestion: ${redacted.error.suggestion}`);
              }
              for (const section of collectDiagnosticSections(redacted.attachments, {
                verbose: true,
              })) {
                console.log(`  ${section.title}: ${redactor.redact(section.path)}`);
                console.log(
                  section.body
                    .split("\n")
                    .map((line) => `    ${redactor.redact(line)}`)
                    .join("\n"),
                );
              }
              if (redacted.error.stack) {
                console.log(
                  `  Stack:\n${redacted.error.stack
                    .split("\n")
                    .map((l: string) => `    ${l}`)
                    .join("\n")}`,
                );
              }
            }
          }
        }
      },
    });

    // 7. Final summary
    const redactedResults = result.results.map(redactResult);
    for (const reporter of reporters) {
      reporter.onRunComplete({
        total: result.results.length,
        passed: result.passed,
        failed: result.failed,
        skipped: result.skipped,
        flaky: result.flaky,
        durationMs: result.totalDurationMs,
        results: redactedResults,
        platforms,
        bailedOut: result.bailedOut,
        bailLimit: result.bailLimit,
        workerStats: result.workerStats,
      });
    }

    // Report to cloud provider if applicable
    if (shouldReportToProvider && appiumUrl) {
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
    for (const cleanup of runCleanups) {
      try {
        await cleanup();
      } catch {
        // ignore cleanup errors
      }
    }
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}
