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
import {
  buildLastRunState,
  createLastRunStatePath,
  getGitChangedFiles,
  readLastRunState,
  selectChangedFlowPaths,
  writeLastRunState,
} from "./iteration.js";
import { collectWatchRoots, runWatchLoop } from "./watch-mode.js";

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
  appiumAutoStart?: boolean;
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
  lastFailed?: boolean;
  changed?: boolean;
  watch?: boolean;
  updateBaselines?: boolean;
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

  if (opts.watch && opts.validateConfigOnly) {
    return "Cannot use --watch with --validate-config.";
  }

  return null;
}

async function buildParallelPlatformConfigs(
  platforms: Platform[],
  opts: Pick<
    TestCommandOptions,
    "devices" | "platforms" | "workers" | "debugOnFailure" | "updateBaselines"
  >,
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
            engineConfig: {
              ...result.engineConfig,
              debugOnFailure: opts.debugOnFailure,
              updateBaselines: opts.updateBaselines,
            },
          });
        }

        platformConfigs.push({
          platform,
          driver: primaryResult.runtime.driver,
          engineConfig: {
            ...primaryResult.engineConfig,
            debugOnFailure: opts.debugOnFailure,
            updateBaselines: opts.updateBaselines,
          },
          additionalWorkers: additionalWorkers.length > 0 ? additionalWorkers : undefined,
        });
      } else {
        // Single web runtime (existing behavior)
        const result = await buildWebRuntime(config);
        runtimes.push(result.runtime);
        platformConfigs.push({
          platform,
          driver: result.runtime.driver,
          engineConfig: {
            ...result.engineConfig,
            debugOnFailure: opts.debugOnFailure,
            updateBaselines: opts.updateBaselines,
          },
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
              engineConfig: {
                ...result.engineConfig,
                debugOnFailure: opts.debugOnFailure,
                updateBaselines: opts.updateBaselines,
              },
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
        engineConfig: {
          ...primaryResult.engineConfig,
          debugOnFailure: opts.debugOnFailure,
          updateBaselines: opts.updateBaselines,
        },
        additionalWorkers: additionalWorkers.length > 0 ? additionalWorkers : undefined,
      });
    }
  }

  return platformConfigs;
}

async function buildSerialPlatformConfigs(
  platforms: Platform[],
  opts: Pick<TestCommandOptions, "capsPath" | "capsJson" | "debugOnFailure" | "updateBaselines">,
  config: ProvConfig,
  runtimes: RuntimeHandle[],
  executionMode: string,
  appiumUrl: string | undefined,
  appiumConfig: import("../schemas/config.js").AppiumExecutionConfig | undefined,
  cloudHelper: Awaited<ReturnType<typeof createCloudProviderHelper>> | undefined,
  targetDevice: import("../device/discover.js").DiscoveredDevice | null,
  resolveFromConfig: (p: string) => string,
): Promise<PlatformConfig[]> {
  const platformConfigs: PlatformConfig[] = [];

  for (const platform of platforms) {
    if (executionMode === "appium" && (platform === "android" || platform === "ios")) {
      // Appium cloud mode — resolve capabilities per-platform so platformCapabilities applies
      const builder = platform === "android" ? buildAppiumAndroidRuntime : buildAppiumIOSRuntime;
      const resolvedCaps = appiumConfig
        ? await resolveCapabilities(appiumConfig, {
            capsPath: opts.capsPath,
            capsJson: opts.capsJson,
            platform,
            launchOptions: config.launchOptions,
          })
        : {};
      const preparedCaps = await cloudHelper!.prepareCapabilities(
        platform,
        { ...resolvedCaps },
        platform === "android" ? config.apps?.android : config.apps?.ios,
      );
      const result = await builder(config, appiumUrl!, preparedCaps);
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: {
          ...result.engineConfig,
          debugOnFailure: opts.debugOnFailure,
          updateBaselines: opts.updateBaselines,
        },
      });
    } else if (platform === "web") {
      const result = await buildWebRuntime(config);
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: {
          ...result.engineConfig,
          debugOnFailure: opts.debugOnFailure,
          updateBaselines: opts.updateBaselines,
        },
      });
    } else if (platform === "android") {
      const result = await buildLocalAndroidRuntime(config, targetDevice, resolveFromConfig);
      if (!result) continue;
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: {
          ...result.engineConfig,
          debugOnFailure: opts.debugOnFailure,
          updateBaselines: opts.updateBaselines,
        },
      });
    } else if (platform === "ios") {
      const result = await buildLocalIOSRuntime(config, targetDevice, resolveFromConfig);
      if (!result) continue;
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: {
          ...result.engineConfig,
          debugOnFailure: opts.debugOnFailure,
          updateBaselines: opts.updateBaselines,
        },
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

interface ExecutionContext {
  config: ProvConfig;
  configPath?: string;
  configDir: string;
  executionMode: string;
  resolveFromConfig: (p: string) => string;
}

async function resolveExecutionContext(
  opts: TestCommandOptions,
): Promise<{ ok: true; context: ExecutionContext } | { ok: false; success: boolean }> {
  let config: ProvConfig = {};
  let loadedConfigPath: string | undefined;
  try {
    const loaded = await loadConfig({ configPath: opts.configPath, allowMissing: true });
    config = loaded.config;
    loadedConfigPath = loaded.configPath;
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return { ok: false, success: false };
  }
  const configDir = dirname(loadedConfigPath ?? resolve("spana.config.ts"));

  if (opts.validateConfigOnly) {
    if (!loadedConfigPath) {
      console.log("No config file found to validate.");
      return { ok: false, success: false };
    }
    console.log(`✓ Config valid (${loadedConfigPath})`);
    return { ok: false, success: true };
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
      return { ok: false, success: false };
    }
  }

  // Validate appium mode requirements
  if (executionMode === "appium") {
    const appiumUrl =
      opts.appiumUrl ?? process.env.SPANA_APPIUM_URL ?? config.execution?.appium?.serverUrl;
    const wantAutoStart = opts.appiumAutoStart ?? config.execution?.appium?.autoStart ?? false;
    if (!appiumUrl && !wantAutoStart) {
      console.log(
        "Appium mode requires a server URL. Set --appium-url, SPANA_APPIUM_URL env var, execution.appium.serverUrl in config, or use --appium-auto-start to spawn a local server.",
      );
      return { ok: false, success: false };
    }
    // Validate --device conflicts with appium mode
    if (opts.device) {
      console.log(
        "Cannot use --device with appium mode. Use --caps or --caps-json to set device capabilities.",
      );
      return { ok: false, success: false };
    }
  }

  return {
    ok: true,
    context: { config, configPath: loadedConfigPath, configDir, executionMode, resolveFromConfig },
  };
}

async function resolveTargetDevice(
  deviceId: string,
  platforms: Platform[],
  cliPlatforms: Platform[],
): Promise<
  | { ok: true; device: import("../device/discover.js").DiscoveredDevice; platforms: Platform[] }
  | { ok: false; success: boolean }
> {
  const { findDeviceById } = await import("../device/discover.js");
  const targetDevice = findDeviceById(deviceId);
  if (!targetDevice) {
    const { discoverDevices } = await import("../device/discover.js");
    const available = discoverDevices(["web", "android", "ios"]);
    console.log(`Device "${deviceId}" not found. Available devices:`);
    for (const d of available) {
      console.log(`  ${d.id.padEnd(30)} ${d.platform.padEnd(8)} ${d.type}`);
    }
    return { ok: false, success: false };
  }
  // If --platform wasn't explicitly passed on CLI, infer from device
  const updatedPlatforms = cliPlatforms.length === 0 ? [targetDevice.platform] : [...platforms];
  // Validate platform match
  if (!updatedPlatforms.includes(targetDevice.platform)) {
    console.log(
      `Device "${deviceId}" is ${targetDevice.platform}, but --platform ${updatedPlatforms.join(",")} was specified.`,
    );
    return { ok: false, success: false };
  }
  return { ok: true, device: targetDevice, platforms: updatedPlatforms };
}

interface LoadedFlowSource {
  sourcePath: string;
  flow: import("../api/flow.js").FlowDefinition;
}

interface FlowDiscoveryInput {
  flowDir: string;
  configPath?: string;
  tags?: string[];
  grep?: string;
  platforms: Platform[];
  shard?: ShardOptions;
  lastFailed?: boolean;
  changed?: boolean;
  outputDir: string;
}

interface FlowDiscoverySuccess {
  ok: true;
  selectedLoadedFlows: LoadedFlowSource[];
  selectedFlows: import("../api/flow.js").FlowDefinition[];
  watchRoots: string[];
}

interface FlowDiscoveryEarlyExit {
  ok: false;
  success: boolean;
  watchRoots: string[];
}

async function discoverAndFilterFlows(
  input: FlowDiscoveryInput,
): Promise<FlowDiscoverySuccess | FlowDiscoveryEarlyExit> {
  const watchRoots = collectWatchRoots(input.flowDir, input.configPath);
  let flowPaths = await discoverFlows(input.flowDir);

  if (flowPaths.length === 0) {
    console.log("No flow files found.");
    return { ok: false, success: true, watchRoots };
  }

  // Load step definition files before compiling .feature files
  let stepPaths: string[] = [];
  const hasFeatureFiles = flowPaths.some((p) => p.endsWith(".feature"));
  if (hasFeatureFiles) {
    const { stat: statPath } = await import("node:fs/promises");
    const { dirname: dirnameDyn } = await import("node:path");
    const flowDirStats = await statPath(input.flowDir).catch(() => null);
    const stepSearchDir = flowDirStats?.isDirectory() ? input.flowDir : dirnameDyn(input.flowDir);
    stepPaths = await discoverStepFiles(stepSearchDir);
  }

  // Handle --changed flag
  if (input.changed) {
    let changedFiles: string[];
    try {
      changedFiles = getGitChangedFiles(process.cwd());
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return { ok: false, success: false, watchRoots };
    }

    const selection = selectChangedFlowPaths({
      flowPaths,
      changedFiles,
      stepPaths,
      configPath: input.configPath,
    });

    if (selection.mode === "none") {
      console.log(selection.reason);
      return { ok: false, success: true, watchRoots };
    }

    if (selection.mode === "targeted") {
      flowPaths = selection.flowPaths;
      console.log(selection.reason);
    } else {
      console.log(selection.reason);
    }
  }

  if (flowPaths.length === 0) {
    console.log("No flow files found.");
    return { ok: false, success: true, watchRoots };
  }

  if (flowPaths.some((path) => path.endsWith(".feature")) && stepPaths.length > 0) {
    await loadStepFiles(stepPaths);
  }

  // Load and filter flows (supports both .flow.ts and .feature)
  const loadedFlows: LoadedFlowSource[] = [];
  for (const sourcePath of flowPaths) {
    const loaded = await loadTestSource(sourcePath);
    for (const flow of loaded) {
      loadedFlows.push({ sourcePath, flow });
    }
  }

  const filteredFlows = filterFlows(
    loadedFlows.map((l) => l.flow),
    { tags: input.tags, grep: input.grep, platforms: input.platforms },
  );
  const allowedFlows = new Set(filteredFlows);
  let filteredLoadedFlows = loadedFlows.filter((l) => allowedFlows.has(l.flow));

  // Handle --last-failed flag
  if (input.lastFailed) {
    const lastRunStatePath = createLastRunStatePath(input.outputDir);
    const state = await readLastRunState(lastRunStatePath);

    if (!state) {
      console.log(
        "No previous Spana run state found. Run `spana test` once before using --last-failed.",
      );
      return { ok: false, success: true, watchRoots };
    }

    if (state.failedFlowNames.length === 0) {
      console.log("No failed flows were recorded in the last Spana run.");
      return { ok: false, success: true, watchRoots };
    }

    const failedFlowNames = new Set(state.failedFlowNames);
    filteredLoadedFlows = filteredLoadedFlows.filter((l) => failedFlowNames.has(l.flow.name));

    if (filteredLoadedFlows.length === 0) {
      console.log("No last-failed flows match the current filters.");
      return { ok: false, success: true, watchRoots };
    }

    console.log(`Rerunning ${filteredLoadedFlows.length} flow(s) from the last failed run.`);
  }

  const selectedLoadedFlows = applyShard(filteredLoadedFlows, input.shard);
  const selectedFlows = selectedLoadedFlows.map((l) => l.flow);

  if (filteredLoadedFlows.length === 0) {
    console.log("No flows match the given filters.");
    return { ok: false, success: true, watchRoots };
  }

  if (selectedFlows.length === 0) {
    console.log(`No flows assigned to shard ${input.shard!.current}/${input.shard!.total}.`);
    return { ok: false, success: true, watchRoots };
  }

  if (input.shard) {
    console.log(
      `Running shard ${input.shard.current}/${input.shard.total} (${selectedFlows.length}/${filteredLoadedFlows.length} flow(s))...`,
    );
  }

  return { ok: true, selectedLoadedFlows, selectedFlows, watchRoots };
}

function createResultHandler(
  reporters: Reporter[],
  redactResult: <T extends import("../core/engine.js").TestResult>(r: T) => T,
  redactor: { redact: (s: string) => string },
  opts: { verbose?: boolean },
): (r: import("../core/engine.js").TestResult) => void {
  return (r) => {
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
  };
}

async function reportToCloudProvider(
  runtimes: RuntimeHandle[],
  appiumUrl: string,
  result: { failed: number },
  platforms: Platform[],
): Promise<void> {
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

interface RunTestCommandOnceResult {
  success: boolean;
  watchRoots: string[];
}

async function runTestCommandOnce(opts: TestCommandOptions): Promise<RunTestCommandOnceResult> {
  const validationError = validateOptions(opts);
  if (validationError) {
    console.log(validationError);
    return { success: false, watchRoots: [] };
  }

  // 1. Load config and resolve execution context
  const ctxResult = await resolveExecutionContext(opts);
  if (!ctxResult.ok) return { success: ctxResult.success, watchRoots: [] };
  const { config, configPath, executionMode, resolveFromConfig } = ctxResult.context;

  const platforms: Platform[] =
    opts.platforms.length > 0
      ? opts.platforms
      : config.platforms && config.platforms.length > 0
        ? config.platforms
        : ["web"];

  const flowDir = opts.flowPath ?? resolveFromConfig(config.flowDir ?? "./flows");

  // Resolve explicit device targeting
  let targetDevice: import("../device/discover.js").DiscoveredDevice | null = null;
  if (opts.device) {
    const deviceResult = await resolveTargetDevice(opts.device, platforms, opts.platforms);
    if (!deviceResult.ok) {
      return {
        success: deviceResult.success,
        watchRoots: collectWatchRoots(flowDir, configPath),
      };
    }
    targetDevice = deviceResult.device;
    platforms.length = 0;
    platforms.push(...deviceResult.platforms);
  }

  const reporterNames = opts.reporter?.trim()
    ? opts.reporter
    : config.reporters && config.reporters.length > 0
      ? config.reporters.join(",")
      : "console";

  // 2. Discover flows and step definitions
  const outputDir = config.artifacts?.outputDir ?? resolveFromConfig("./spana-output");
  const flowResult = await discoverAndFilterFlows({
    flowDir,
    configPath,
    tags: opts.tags,
    grep: opts.grep,
    platforms,
    shard: opts.shard,
    lastFailed: opts.lastFailed,
    changed: opts.changed,
    outputDir,
  });
  if (!flowResult.ok) return { success: flowResult.success, watchRoots: flowResult.watchRoots };
  const { selectedLoadedFlows, selectedFlows, watchRoots } = flowResult;

  console.log(`Running ${selectedFlows.length} flow(s) on ${platforms.join(", ")}...\n`);

  // 3. Setup platform drivers via runtime builders
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
    const appiumConfig = config.execution?.appium ?? {};
    const wantAutoStart =
      executionMode === "appium" && (opts.appiumAutoStart ?? appiumConfig.autoStart ?? false);

    let appiumUrl =
      opts.appiumUrl ?? process.env.SPANA_APPIUM_URL ?? config.execution?.appium?.serverUrl;

    if (wantAutoStart) {
      if (opts.appiumUrl || process.env.SPANA_APPIUM_URL || appiumConfig.serverUrl) {
        console.log(
          "Appium auto-start is enabled; ignoring --appium-url / SPANA_APPIUM_URL / execution.appium.serverUrl.",
        );
      }
      const { startLocalAppium } = await import("../runtime/appium-server.js");
      const started = await startLocalAppium({
        binary: appiumConfig.autoStartBinary,
        extraArgs: appiumConfig.autoStartArgs,
        log: (line) => console.log(line),
      });
      appiumUrl = started.url;
      runCleanups.push(() => started.stop());
    }

    const shouldReportToProvider =
      !opts.noProviderReporting && appiumConfig.reportToProvider !== false;
    const cloudHelper =
      executionMode === "appium" && appiumUrl
        ? await createCloudProviderHelper(appiumUrl, appiumConfig)
        : undefined;
    // Capabilities are resolved per-platform inside the platform loop so that
    // platformCapabilities merging can apply. We pass appiumConfig through.

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
          appiumConfig,
          cloudHelper,
          targetDevice,
          resolveFromConfig,
        )),
      );
    }

    // 4. Set up redactor and reporters (before run for real-time streaming)
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

    // 5. Run with real-time reporter callbacks
    const retries = opts.retries ?? config.defaults?.retries ?? 0;
    const retryDelay = config.defaults?.retryDelay ?? 0;
    const onResult = createResultHandler(reporters, redactResult, redactor, opts);
    const result = await orchestrate(selectedFlows, platformConfigs, {
      retries,
      retryDelay,
      bail: opts.bail,
      parallelPlatforms:
        opts.parallel || config.parallelPlatforms || !!opts.workers || !!opts.devices,
      onFlowStart(name, platform, workerName) {
        for (const reporter of reporters) {
          reporter.onFlowStart?.(name, platform, workerName);
        }
      },
      onResult,
    });

    // 6. Final summary
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

    // Write last run state for --last-failed support
    const sourcePathsByFlowName = new Map(
      selectedLoadedFlows.map((loaded) => [loaded.flow.name, loaded.sourcePath]),
    );
    const iterationStatePath = createLastRunStatePath(outputDir);
    try {
      await writeLastRunState(
        iterationStatePath,
        buildLastRunState({
          flowDir,
          platforms,
          results: result.results,
          sourcePathsByFlowName,
        }),
      );
    } catch (error) {
      console.log(
        `Warning: Failed to update last run state at ${iterationStatePath}: ${error instanceof Error ? error.message : error}`,
      );
    }

    // Report to cloud provider if applicable
    if (shouldReportToProvider && appiumUrl) {
      await reportToCloudProvider(runtimes, appiumUrl, result, platforms);
    }

    return { success: result.failed === 0, watchRoots };
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

export async function runTestCommand(opts: TestCommandOptions): Promise<boolean> {
  if (!opts.watch) {
    return (await runTestCommandOnce(opts)).success;
  }

  let lastResult = await runTestCommandOnce({ ...opts, watch: false });
  if (lastResult.watchRoots.length === 0) {
    return lastResult.success;
  }

  console.log(
    `Watching ${lastResult.watchRoots.length} path(s) for changes. Press Ctrl+C to stop.`,
  );
  await runWatchLoop({
    roots: lastResult.watchRoots,
    onChange: async (changedPaths) => {
      console.log(`\nChange detected:\n${changedPaths.map((path) => `  ${path}`).join("\n")}\n`);
      lastResult = await runTestCommandOnce({ ...opts, watch: false });
    },
  });

  return lastResult.success;
}
