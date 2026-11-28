import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverFlows,
  loadTestSource,
  loadStepFiles,
  discoverStepFiles,
  filterFlows,
  focusFlows,
  getFlowSkip,
  applyShard,
  type ShardOptions,
} from "../core/runner.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { executeFlow, type EngineConfig, type TestResult } from "../core/engine.js";
import { orchestrate, type PlatformConfig } from "../core/orchestrator.js";
import type { ProvConfig } from "../schemas/config.js";
import type { Reporter } from "../report/types.js";
import type { Platform } from "../schemas/selector.js";
import type { RuntimeHandle, RuntimeResult } from "../runtime/types.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import { loadConfig } from "./config-loader.js";
import {
  buildWebRuntime,
  buildWebRuntimePool,
  buildElectronRuntime,
  buildElectrobunRuntime,
  buildLocalAndroidRuntime,
  buildLocalIOSRuntime,
  createSharedWebWavePool,
  getWebDriverReuseKey,
  resolveWebEngine,
  speculativelyPrelaunchWebBrowser,
  type PrelaunchedWebBrowser,
} from "../runtime/local.js";
import { resolveDriverAdapter } from "../drivers/adapter-registry.js";
import type { createCloudProviderHelper as CreateCloudProviderHelper } from "../cloud/provider.js";
import type { DeviceWorkerConfig } from "../core/parallel.js";
import { collectDiagnosticSections } from "../report/failure-diagnostics.js";
import {
  buildLastRunState,
  createLastRunStatePath,
  extractDurationHints,
  getGitChangedFiles,
  readDurationHintsFile,
  readLastRunState,
  selectChangedFlowPaths,
  writeDurationHintsFile,
  writeLastRunState,
} from "./iteration.js";
import { collectWatchRoots } from "./watch-mode.js";
import {
  createRemoteWorkUnitClaimer,
  planProcessPool,
  runMultiProcessPool,
  startSharedFlowQueueServer,
  writeWorkerProcessReport,
} from "../core/worker-pool.js";
import { buildOrderedWorkUnits } from "../core/parallel.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServers } from "../runtime/web-server.js";
import { filterFlowsForProject, resolveProjectExecutionPlan } from "../core/projects.js";

export interface TestCommandOptions {
  platforms: Platform[];
  tags?: string[];
  grep?: string;
  grepInvert?: string;
  passWithNoTests?: boolean;
  reporter?: string;
  configPath?: string;
  flowPath?: string;
  /** Multiple positional flow file/directory paths passed on CLI. */
  flowPaths?: string[];
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
  /** Portable JSON timings file or directory of shard timing files for balanced `--shard` & longest-first scheduling. */
  timingsFile?: string;
  /** Write/merge observed per-flow durations into a portable JSON manifest after run completion. */
  writeTimingsFile?: string;
  bail?: number;
  debugOnFailure?: boolean;
  quiet?: boolean;
  parallel?: boolean;
  workers?: number;
  /** Number of isolated OS processes sharing a dynamic longest-first queue (`--processes M`). */
  processes?: number;
  /** Override web browser target (`chromium` | `firefox` | `webkit`). */
  browser?: "chromium" | "firefox" | "webkit";
  devices?: string[];
  verbose?: boolean;
  lastFailed?: boolean;
  changed?: boolean;
  /** Git base ref for pluggable CI test filters (e.g. `origin/main`). */
  changedSince?: string;
  /** Enforce deterministic replay cache without invoking LLM executors. */
  strictCache?: boolean;
  watch?: boolean;
  updateBaselines?: boolean;
  jsCoverage?: boolean;
  /** Run web browser in headed mode (overrides `execution.web.headless`). */
  headed?: boolean;
  /** Enable Playwright-style interactive `trace.json` + `trace-viewer.html` generation. */
  trace?: boolean;
  /** Named projects to run (expands transitive `dependencies`). */
  projects?: string[];
  /** Dry-run: list matching flows without launching browsers/devices. */
  listOnly?: boolean;
  /** Emit JSON output for `spana list`. */
  json?: boolean;
  /** Working directory for config discovery, relative paths, and git filters (defaults to `process.cwd()`). */
  cwd?: string;
}

/** Structured result returned by `runTestCommandWithResult()`. */
export interface TestCommandResult {
  success: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  results: import("../core/engine.js").TestResult[];
}

/**
 * Resolve Spana's own CLI entrypoint independent of `process.argv[1]` so calling
 * `runTestCommand({ processes: N })` in-process from Vitest / Bun test / Node scripts
 * spawns Spana's CLI rather than re-invoking the host test runner (1.23).
 */
export function resolveSpanaCliEntrypoint(): string | undefined {
  const candidates = [
    new URL("./cli.js", import.meta.url),
    new URL("../cli.js", import.meta.url),
    new URL("./index.ts", import.meta.url),
    new URL("../cli/index.ts", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const candidatePath = fileURLToPath(url);
      if (existsSync(candidatePath)) return candidatePath;
    } catch {
      // ignore invalid URL
    }
  }
  return process.argv[1];
}

function emptyTestCommandResult(success: boolean, durationMs = 0): TestCommandResult {
  return {
    success,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs,
    results: [],
  };
}

function summarizeTestResults(
  results: import("../core/engine.js").TestResult[],
  durationMs: number,
  successOverride?: boolean,
): TestCommandResult {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const flaky = results.filter((r) => r.flaky).length;
  return {
    success: successOverride ?? failed === 0,
    total: results.length,
    passed,
    failed,
    skipped,
    flaky,
    durationMs,
    results,
  };
}

function validateOptions(opts: TestCommandOptions): string | null {
  if (opts.driver && opts.driver !== "local" && opts.driver !== "appium") {
    return `Unknown --driver value "${opts.driver}". Use "local" or "appium".`;
  }

  if (
    opts.browser &&
    opts.browser !== "chromium" &&
    opts.browser !== "firefox" &&
    opts.browser !== "webkit"
  ) {
    return `Unknown --browser value "${opts.browser}". Use "chromium", "firefox", or "webkit".`;
  }

  if (opts.processes !== undefined && (!Number.isInteger(opts.processes) || opts.processes < 1)) {
    return "Invalid --processes value. Use a positive integer.";
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
  prelaunchedWeb?: PrelaunchedWebBrowser,
): Promise<PlatformConfig[]> {
  let allDevices: import("../device/discover.js").DiscoveredDevice[] = [];
  const needsMobileDiscovery =
    Boolean(opts.devices && opts.devices.length > 0) ||
    platforms.some((p) => p === "android" || p === "ios");
  if (needsMobileDiscovery) {
    const { discoverDevices, findDeviceById } = await import("../device/discover.js");
    if (opts.devices) {
      // Use explicitly specified devices
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
        // Share ONE browser process with N isolated BrowserContexts
        const pooledResults = await buildWebRuntimePool(config, webWorkers, prelaunchedWeb);
        const primaryResult = pooledResults[0]!;
        runtimes.push(primaryResult.runtime);

        const additionalWorkers: DeviceWorkerConfig[] = [];
        for (let i = 1; i < pooledResults.length; i++) {
          const result = pooledResults[i]!;
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
        const result = await buildWebRuntime(config, prelaunchedWeb);
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
    } else if (platform === "electron") {
      const result = await buildElectronRuntime(config, resolveFromConfig);
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
    } else if (platform === "electrobun") {
      const result = await buildElectrobunRuntime(config, resolveFromConfig);
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
  cloudHelper: Awaited<ReturnType<typeof CreateCloudProviderHelper>> | undefined,
  targetDevice: import("../device/discover.js").DiscoveredDevice | null,
  resolveFromConfig: (p: string) => string,
  prelaunchedWeb?: PrelaunchedWebBrowser,
): Promise<PlatformConfig[]> {
  const platformConfigs: PlatformConfig[] = [];

  for (const platform of platforms) {
    if (executionMode === "appium" && (platform === "android" || platform === "ios")) {
      // Appium cloud mode — resolve capabilities per-platform so platformCapabilities applies
      const { buildAppiumAndroidRuntime, buildAppiumIOSRuntime } =
        await import("../runtime/appium.js");
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
      const result = await buildWebRuntime(config, prelaunchedWeb);
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
    } else if (platform === "electron") {
      const result = await buildElectronRuntime(config, resolveFromConfig);
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
    } else if (platform === "electrobun") {
      const result = await buildElectrobunRuntime(config, resolveFromConfig);
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

const BUILTIN_REPORTERS = new Set(["console", "json", "junit", "html", "allure", "github"]);

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
  opts: Pick<TestCommandOptions, "quiet" | "cwd">,
  filterSummaries: string[] = [],
) {
  const { createRedactor, registerUrlSecrets } = await import("../report/redact.js");
  const redactor = createRedactor();
  if (appiumUrl) registerUrlSecrets(redactor, appiumUrl);

  const { createConsoleReporter } = await import("../report/console.js");
  const { createJsonReporter } = await import("../report/json.js");
  const { createJUnitReporter } = await import("../report/junit.js");
  const { createHtmlReporter } = await import("../report/html.js");
  const { createAllureReporter } = await import("../report/allure.js");
  const { createGitHubPrReporter } = await import("../report/github-pr.js");

  const resolvedOutputDir = config.artifacts?.outputDir ?? resolveFromConfig("./spana-output");
  const reporters: Reporter[] = [];

  for (const name of reporterNames.split(",")) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    // Support `json:<file>` (e.g. `--reporter json:reports/out.json`) and `junit:<file>`
    const colonIdx = trimmed.indexOf(":");
    const reporterKind = colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
    const reporterTarget = colonIdx > 0 ? trimmed.slice(colonIdx + 1) : undefined;

    if (BUILTIN_REPORTERS.has(reporterKind)) {
      const workDir = opts.cwd ? resolve(opts.cwd) : process.cwd();
      switch (reporterKind) {
        case "json":
          reporters.push(
            createJsonReporter(reporterTarget ? resolve(workDir, reporterTarget) : undefined),
          );
          break;
        case "junit":
          reporters.push(
            createJUnitReporter(
              reporterTarget ? resolve(workDir, reporterTarget) : resolvedOutputDir,
            ),
          );
          break;
        case "html":
          reporters.push(
            createHtmlReporter(
              reporterTarget ? resolve(workDir, reporterTarget) : resolvedOutputDir,
            ),
          );
          break;
        case "allure":
          reporters.push(createAllureReporter());
          break;
        case "github":
          reporters.push(createGitHubPrReporter({ outputDir: resolvedOutputDir, filterSummaries }));
          break;
        default: {
          let effectiveWebEngine = resolveWebEngine(config);
          if (!config.execution?.web?.engine && config.projects?.length) {
            const firstProjEngine = config.projects.find((p) => p.use?.engine)?.use?.engine;
            if (firstProjEngine) {
              effectiveWebEngine = resolveWebEngine({
                ...config,
                execution: {
                  ...config.execution,
                  web: { ...config.execution?.web, engine: firstProjEngine },
                },
              });
            }
          }
          reporters.push(
            createConsoleReporter({ quiet: opts.quiet, webEngine: effectiveWebEngine }),
          );
          break;
        }
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
  const workDir = opts.cwd ? resolve(opts.cwd) : process.cwd();
  let config: ProvConfig = {};
  let loadedConfigPath: string | undefined;
  try {
    const loaded = await loadConfig({
      configPath: opts.configPath,
      cwd: workDir,
      allowMissing: true,
    });
    config = loaded.config;
    loadedConfigPath = loaded.configPath;
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    return { ok: false, success: false };
  }
  const configDir = dirname(loadedConfigPath ?? resolve(workDir, "spana.config.ts"));

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
  if (process.env.SPANA_OUTPUT_DIR) {
    config.artifacts = { ...config.artifacts, outputDir: process.env.SPANA_OUTPUT_DIR };
  } else if (config.artifacts?.outputDir) {
    config.artifacts.outputDir = resolveFromConfig(config.artifacts.outputDir);
  }
  if (opts.jsCoverage) config.artifacts = { ...config.artifacts, jsCoverage: true };
  if (opts.trace) config.artifacts = { ...config.artifacts, trace: true };

  // CLI --browser / --headed override and per-process warm daemon isolation scope
  if (opts.browser || opts.headed || process.env.SPANA_WARM_SCOPE) {
    config.execution = {
      ...config.execution,
      web: {
        ...config.execution?.web,
        ...(opts.browser ? { browser: opts.browser } : {}),
        ...(opts.headed ? { headless: false } : {}),
        ...(process.env.SPANA_WARM_SCOPE ? { warmBrowserScope: process.env.SPANA_WARM_SCOPE } : {}),
      },
    };
  }
  if (opts.strictCache) {
    config.replayCache = { ...config.replayCache, mode: "strict" };
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
  flowDirs?: string[];
  cwd?: string;
  configPath?: string;
  tags?: string[];
  grep?: string;
  grepInvert?: string;
  passWithNoTests?: boolean;
  platforms: Platform[];
  shard?: ShardOptions;
  timingsFile?: string;
  lastFailed?: boolean;
  changed?: boolean;
  changedSince?: string;
  filters?: import("../core/filters.js").TestFilter[];
  outputDir: string;
}

interface FlowDiscoverySuccess {
  ok: true;
  selectedLoadedFlows: LoadedFlowSource[];
  selectedFlows: import("../api/flow.js").FlowDefinition[];
  watchRoots: string[];
  filterSummaries: string[];
}

interface FlowDiscoveryEarlyExit {
  ok: false;
  success: boolean;
  watchRoots: string[];
}

async function discoverAndFilterFlows(
  input: FlowDiscoveryInput,
): Promise<FlowDiscoverySuccess | FlowDiscoveryEarlyExit> {
  const searchTargets =
    input.flowDirs && input.flowDirs.length > 0 ? input.flowDirs : [input.flowDir];
  const watchRootSet = new Set<string>();
  for (const target of searchTargets) {
    for (const root of collectWatchRoots(target, input.configPath)) {
      watchRootSet.add(root);
    }
  }
  const watchRoots = [...watchRootSet];

  const discoveredSet = new Set<string>();
  for (const target of searchTargets) {
    for (const p of await discoverFlows(target)) {
      discoveredSet.add(p);
    }
  }
  let flowPaths = [...discoveredSet];

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
    const stepSet = new Set<string>();
    for (const target of searchTargets) {
      const flowDirStats = await statPath(target).catch(() => null);
      const stepSearchDir = flowDirStats?.isDirectory() ? target : dirnameDyn(target);
      for (const sp of await discoverStepFiles(stepSearchDir)) {
        stepSet.add(sp);
      }
    }
    stepPaths = [...stepSet];
  }

  // Handle --changed flag
  if (input.changed) {
    let changedFiles: string[];
    try {
      changedFiles = getGitChangedFiles(input.cwd ?? process.cwd());
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
    {
      tags: input.tags,
      grep: input.grep,
      grepInvert: input.grepInvert,
      platforms: input.platforms,
    },
  );
  const allowedFlows = new Set(focusFlows(filteredFlows));
  let filteredLoadedFlows = loadedFlows.filter((l) => allowedFlows.has(l.flow));
  let filterSummaries: string[] = [];

  // Handle --changed-since <ref> with pluggable CI filters (fail-open)
  if (input.changedSince && !input.filters?.length) {
    console.log(
      `Warning: --changed-since ${input.changedSince} has no effect because spana.config.ts has no \`filters\` — running all flows. Add e.g. \`filters: [pathRuleFilter({ rules: [...] })]\`. See https://spana.antonwester.se/guides/ci-integration/`,
    );
  }
  if (
    input.changedSince &&
    input.filters &&
    input.filters.length > 0 &&
    filteredLoadedFlows.length > 0
  ) {
    const { applyTestFilters, buildFilterCandidates, collectGitChanges, formatFilterSummary } =
      await import("../core/filters.js");
    try {
      const cwd = input.cwd ?? process.cwd();
      const changes = collectGitChanges(input.changedSince, cwd);
      const candidates = buildFilterCandidates(filteredLoadedFlows, cwd);
      const result = await applyTestFilters(filteredLoadedFlows, candidates, input.filters, {
        cwd,
        changes,
        configPath: input.configPath,
        platforms: input.platforms,
      });
      filterSummaries = formatFilterSummary(result.reports);
      for (const line of filterSummaries) {
        console.log(line);
      }
      filteredLoadedFlows = result.kept;
      if (filteredLoadedFlows.length === 0) {
        console.log("All flows were filtered out by --changed-since filters.");
        return { ok: false, success: true, watchRoots };
      }
    } catch (err) {
      console.log(
        `Warning: --changed-since ${input.changedSince} failed (${err instanceof Error ? err.message : String(err)}) — failing open and running all flows.`,
      );
    }
  }

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

  const [lastRunStateForShard, fileHintsForShard] = input.shard
    ? await Promise.all([
        readLastRunState(createLastRunStatePath(input.outputDir)),
        input.timingsFile ? readDurationHintsFile(input.timingsFile) : Promise.resolve({}),
      ])
    : [null, {}];
  const shardDurationHints: Record<string, number> = {
    ...fileHintsForShard,
    ...extractDurationHints(lastRunStateForShard),
  };
  const selectedLoadedFlows = applyShard(
    filteredLoadedFlows,
    input.shard,
    Object.keys(shardDurationHints).length > 0
      ? {
          durationHintsMs: shardDurationHints,
          getName: (entry) => entry.flow.name,
        }
      : undefined,
  );
  const selectedFlows = selectedLoadedFlows.map((l) => l.flow);

  if (filteredLoadedFlows.length === 0) {
    console.log("No flows match the given filters.");
    return { ok: false, success: Boolean(input.passWithNoTests), watchRoots };
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

  return { ok: true, selectedLoadedFlows, selectedFlows, watchRoots, filterSummaries };
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
      } else if (redacted.status === "skipped") {
        reporter.onFlowSkip?.(redacted);
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
  summary: TestCommandResult;
}

async function runTestCommandOnce(opts: TestCommandOptions): Promise<RunTestCommandOnceResult> {
  const runStartedAt = Date.now();
  const validationError = validateOptions(opts);
  if (validationError) {
    console.log(validationError);
    return {
      success: false,
      watchRoots: [],
      summary: emptyTestCommandResult(false, Date.now() - runStartedAt),
    };
  }

  // 1. Load config and resolve execution context
  const ctxResult = await resolveExecutionContext(opts);
  if (!ctxResult.ok) {
    return {
      success: ctxResult.success,
      watchRoots: [],
      summary: emptyTestCommandResult(ctxResult.success, Date.now() - runStartedAt),
    };
  }
  const { config, configPath, configDir, executionMode, resolveFromConfig } = ctxResult.context;

  // Named projects DAG execution (`config.projects` or `--project <name>`)
  if (config.projects && config.projects.length > 0 && !opts.listOnly) {
    let plan;
    try {
      plan = resolveProjectExecutionPlan(config.projects, opts.projects);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return {
        success: false,
        watchRoots: [],
        summary: emptyTestCommandResult(false, Date.now() - runStartedAt),
      };
    }

    const webServers = process.env.SPANA_WORKER_PROCESS
      ? { stopAll: async () => {} }
      : await startWebServers(config.webServer, { cwd: configDir });
    const projReporterNames = opts.reporter?.trim()
      ? opts.reporter
      : config.reporters && config.reporters.length > 0
        ? config.reporters.join(",")
        : "console";
    const { redactor: projRedactor, reporters: projReporters } = await setupReporters(
      projReporterNames,
      config,
      resolveFromConfig,
      opts.appiumUrl,
      opts,
    );
    const allProjectResults: import("../core/engine.js").TestResult[] = [];
    const allProjectPlatforms = new Set<Platform>();
    const projectsStart = Date.now();
    let allPassed = true;
    const cliEntry = resolveSpanaCliEntrypoint();
    const rawCliFlowPaths =
      opts.flowPaths && opts.flowPaths.length > 0
        ? opts.flowPaths
        : opts.flowPath
          ? [opts.flowPath]
          : [];
    const requestedProjectSet = new Set(opts.projects ?? []);
    const dependencyProjectNames = new Set<string>();
    for (const wave of plan.waves) {
      for (const proj of wave) {
        for (const dep of proj.dependencies ?? []) {
          dependencyProjectNames.add(dep);
        }
      }
    }
    const teardownProjectNames = new Set(plan.teardowns.map((t) => t.name));
    try {
      const executeProject = async (
        project: import("../core/projects.js").ProjectConfig,
        allocatedWorkers?: number,
      ) => {
        // Setup dependency projects and teardown projects must NOT be filtered out by
        // CLI --tag, --grep, --grep-invert, or positional flow file filters unless the
        // user explicitly targeted only that project via `--project <dep>`.
        const isDependencyOrTeardown =
          teardownProjectNames.has(project.name) ||
          (dependencyProjectNames.has(project.name) &&
            !(requestedProjectSet.size > 0 && requestedProjectSet.has(project.name)));
        const cliWorkDir = opts.cwd ? resolve(opts.cwd) : process.cwd();
        const projFlowDirs =
          !isDependencyOrTeardown && rawCliFlowPaths.length > 0
            ? rawCliFlowPaths.map((p) => resolve(cliWorkDir, p))
            : [resolveFromConfig(project.flowDir ?? config.flowDir ?? "./flows")];
        const projFlowDir = projFlowDirs[0]!;
        const projPlatforms: Platform[] =
          opts.platforms.length > 0
            ? opts.platforms
            : project.platform
              ? [project.platform]
              : config.platforms && config.platforms.length > 0
                ? config.platforms
                : ["web"];
        for (const p of projPlatforms) allProjectPlatforms.add(p);
        const effectiveTags = isDependencyOrTeardown ? project.tags : (opts.tags ?? project.tags);
        const effectiveGrep = isDependencyOrTeardown ? project.grep : (opts.grep ?? project.grep);
        const effectiveGrepInvert = isDependencyOrTeardown ? undefined : opts.grepInvert;
        const discovered = await discoverAndFilterFlows({
          flowDir: projFlowDir,
          flowDirs: projFlowDirs,
          cwd: cliWorkDir,
          configPath,
          tags: effectiveTags,
          grep: effectiveGrep,
          grepInvert: effectiveGrepInvert,
          passWithNoTests: opts.passWithNoTests ?? true,
          platforms: projPlatforms,
          outputDir: config.artifacts?.outputDir ?? resolveFromConfig("./spana-output"),
        });
        if (!discovered.ok) return discovered.success;
        const matched = filterFlowsForProject(discovered.selectedFlows, project);
        if (matched.length === 0) {
          console.log(`[project:${project.name}] No matching flows, skipping.`);
          return true;
        }
        const projConfig: ProvConfig = {
          ...config,
          projects: undefined,
          webServer: undefined,
          apps: {
            ...config.apps,
            ...(project.baseUrl ? { web: { ...config.apps?.web, url: project.baseUrl } } : {}),
          },
          execution: {
            ...config.execution,
            web: {
              ...config.execution?.web,
              ...project.use,
              ...(project.browser ? { browser: project.browser } : {}),
              ...(project.storageState
                ? { storageState: resolveFromConfig(project.storageState) }
                : {}),
            },
          },
          defaults: {
            ...config.defaults,
            ...(project.retries !== undefined ? { retries: project.retries } : {}),
          },
        };

        const effectiveProjWorkers =
          allocatedWorkers !== undefined
            ? Math.max(1, allocatedWorkers)
            : (opts.workers ?? projConfig.defaults?.workers);
        const scopedProjConfig: ProvConfig =
          effectiveProjWorkers !== undefined
            ? {
                ...projConfig,
                defaults: {
                  ...projConfig.defaults,
                  workers: effectiveProjWorkers,
                },
              }
            : projConfig;
        const scopedOpts: TestCommandOptions =
          allocatedWorkers !== undefined ? { ...opts, workers: effectiveProjWorkers } : opts;

        // Honor --processes / defaults.processes inside project runs too (3.12)
        const projMaxWorkersPerProc = scopedProjConfig.defaults?.maxWorkersPerProcess;
        const projRequestedProcesses = scopedOpts.processes ?? scopedProjConfig.defaults?.processes;
        const projRequestedWorkers = effectiveProjWorkers ?? projRequestedProcesses;
        if (
          projRequestedWorkers &&
          !scopedOpts.shard &&
          !scopedOpts.watch &&
          !scopedOpts.device &&
          !process.env.SPANA_WORKER_PROCESS &&
          cliEntry
        ) {
          const orderedProjUnits = buildOrderedWorkUnits(matched);
          const projPlan = planProcessPool(
            projRequestedWorkers,
            projMaxWorkersPerProc,
            projRequestedProcesses,
          );
          const effectiveProjProcs = Math.min(
            projPlan.processCount,
            Math.max(1, orderedProjUnits.length),
          );
          const effectiveProjPlan = planProcessPool(
            projRequestedWorkers,
            projMaxWorkersPerProc,
            effectiveProjProcs,
          );
          if (effectiveProjPlan.processCount > 1) {
            console.log(
              `\n[project:${project.name}] Running ${matched.length} flow(s) across ${effectiveProjPlan.processCount} OS processes (${effectiveProjPlan.workersPerProcess.join("+")} workers)...`,
            );
            const queueServer = await startSharedFlowQueueServer(
              orderedProjUnits.map((u) => u.map((f) => f.name)),
            );
            const runTag = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
            const baseWarmScope =
              scopedProjConfig.execution?.web?.warmBrowserScope ??
              `mp-proj-${project.name}-${runTag}`;
            let offsetCursor = 0;
            try {
              const poolResult = await runMultiProcessPool({
                totalWorkers: projRequestedWorkers,
                maxWorkersPerProcess: projMaxWorkersPerProc,
                processes: effectiveProjPlan.processCount,
                buildShardCommand: (shardIndex, _shardTotal, workerCount) => {
                  const shardOutDir = join(tmpdir(), `spana-mp-proj-${runTag}-p${shardIndex}`);
                  const reportPath = join(shardOutDir, "results.json");
                  const myOffset = offsetCursor;
                  offsetCursor += workerCount;
                  const args = [
                    cliEntry,
                    "test",
                    ...(!isDependencyOrTeardown && rawCliFlowPaths.length > 0
                      ? rawCliFlowPaths
                      : []),
                    "--project",
                    project.name,
                    "--platform",
                    projPlatforms.join(","),
                    "--workers",
                    String(workerCount),
                    "--reporter",
                    "json",
                    "--pass-with-no-tests",
                    ...(scopedOpts.browser ? ["--browser", scopedOpts.browser] : []),
                    ...(configPath ? ["--config", configPath] : []),
                    ...(!isDependencyOrTeardown && scopedOpts.tags
                      ? scopedOpts.tags.flatMap((t) => ["--tag", t])
                      : []),
                    ...(!isDependencyOrTeardown && scopedOpts.grep
                      ? ["--grep", scopedOpts.grep]
                      : []),
                    ...(!isDependencyOrTeardown && scopedOpts.grepInvert
                      ? ["--grep-invert", scopedOpts.grepInvert]
                      : []),
                    ...(scopedOpts.retries !== undefined
                      ? ["--retries", String(scopedOpts.retries)]
                      : []),
                    ...(scopedOpts.jsCoverage ? ["--js-coverage"] : []),
                    ...(scopedOpts.trace ? ["--trace"] : []),
                    ...(scopedOpts.headed ? ["--headed"] : []),
                    ...(scopedOpts.bail !== undefined ? ["--bail", String(scopedOpts.bail)] : []),
                  ];
                  return {
                    command: process.execPath,
                    args,
                    env: {
                      SPANA_WORKER_PROCESS: "1",
                      SPANA_QUEUE_URL: queueServer.url,
                      SPANA_OUTPUT_DIR: shardOutDir,
                      SPANA_WORKER_REPORT_PATH: reportPath,
                      SPANA_WORKER_INDEX_OFFSET: String(myOffset),
                      SPANA_WARM_SCOPE: `${baseWarmScope}-p${shardIndex}`,
                    },
                    reportJsonPath: reportPath,
                  };
                },
              });
              allProjectResults.push(...poolResult.results);
              console.log(
                `[project:${project.name}] ${poolResult.passed} passed, ${poolResult.failed} failed, ${poolResult.skipped} skipped`,
              );
              return poolResult.failed === 0;
            } finally {
              await queueServer.close();
            }
          }
        }

        console.log(`\n[project:${project.name}] Running ${matched.length} flow(s)...`);
        const runtimes: RuntimeHandle[] = [];
        const useParallelWorkers = Boolean(
          scopedOpts.parallel ||
          scopedOpts.devices ||
          (effectiveProjWorkers !== undefined && effectiveProjWorkers > 1),
        );
        try {
          const platformConfigs =
            executionMode === "local" && useParallelWorkers
              ? await buildParallelPlatformConfigs(
                  projPlatforms,
                  scopedOpts,
                  scopedProjConfig,
                  runtimes,
                  resolveFromConfig,
                )
              : await buildSerialPlatformConfigs(
                  projPlatforms,
                  scopedOpts,
                  scopedProjConfig,
                  runtimes,
                  executionMode,
                  scopedOpts.appiumUrl ??
                    process.env.SPANA_APPIUM_URL ??
                    scopedProjConfig.execution?.appium?.serverUrl,
                  scopedProjConfig.execution?.appium ?? {},
                  undefined,
                  null,
                  resolveFromConfig,
                );
          const redactProjResult = <T extends import("../core/engine.js").TestResult>(r: T): T => {
            if (!r.error) return r;
            return {
              ...r,
              error: {
                ...r.error,
                message: projRedactor.redact(r.error.message),
                stack: r.error.stack ? projRedactor.redact(r.error.stack) : undefined,
                suggestion: r.error.suggestion
                  ? projRedactor.redact(r.error.suggestion)
                  : undefined,
              },
            };
          };
          let claimNextWorkUnit:
            | (() => Promise<import("../api/flow.js").FlowDefinition[] | null>)
            | undefined;
          if (process.env.SPANA_QUEUE_URL) {
            const flowByName = new Map<string, import("../api/flow.js").FlowDefinition[]>();
            for (const f of matched) {
              const list = flowByName.get(f.name) ?? [];
              list.push(f);
              flowByName.set(f.name, list);
            }
            const remoteClaim = createRemoteWorkUnitClaimer(process.env.SPANA_QUEUE_URL);
            claimNextWorkUnit = async () => {
              while (true) {
                const names = await remoteClaim();
                if (!names) return null;
                const unit: import("../api/flow.js").FlowDefinition[] = [];
                for (const name of names) {
                  const bucket = flowByName.get(name);
                  if (bucket && bucket.length > 0) unit.push(bucket.shift()!);
                }
                if (unit.length > 0) return unit;
              }
            };
          }
          const onResult = createResultHandler(projReporters, redactProjResult, projRedactor, opts);
          const orchResult = await orchestrate(matched, platformConfigs, {
            retries: opts.retries ?? projConfig.defaults?.retries ?? 0,
            bail: opts.bail,
            claimNextWorkUnit,
            parallelPlatforms: useParallelWorkers || projConfig.parallelPlatforms,
            onFlowStart(name, platform, workerName) {
              for (const reporter of projReporters) {
                reporter.onFlowStart?.(name, platform, workerName);
              }
            },
            onResult,
          });
          allProjectResults.push(...orchResult.results.map(redactProjResult));
          console.log(
            `[project:${project.name}] ${orchResult.passed} passed, ${orchResult.failed} failed, ${orchResult.skipped} skipped`,
          );
          return orchResult.failed === 0;
        } finally {
          for (const rt of runtimes) {
            await rt.cleanup().catch(() => {});
          }
        }
      };

      // True shared dynamic cross-project worker pool across all projects in each dependency wave:
      // - Strictly caps total concurrent workers across the entire wave to `globalWorkerBudget`.
      // - Eliminates static per-project worker starvation so as soon as smaller projects drain,
      //   all N workers immediately help drain remaining larger projects in the same wave.
      // - Shares warm Chromium browser processes across projects with matching launch configs
      //   and reuses warm drivers with zero switch cost when adjacent projects share driver config.
      const globalWorkerBudget = Math.max(1, opts.workers ?? config.defaults?.workers ?? 1);
      const redactWaveResult = <T extends TestResult>(r: T): T => {
        if (!r.error) return r;
        return {
          ...r,
          error: {
            ...r.error,
            message: projRedactor.redact(r.error.message),
            stack: r.error.stack ? projRedactor.redact(r.error.stack) : undefined,
            suggestion: r.error.suggestion ? projRedactor.redact(r.error.suggestion) : undefined,
          },
        };
      };
      const waveOnResult = createResultHandler(projReporters, redactWaveResult, projRedactor, opts);
      const emitWaveResult = (result: TestResult, workerName?: string) => {
        const payload = workerName ? ({ ...result, workerName } as TestResult) : result;
        waveOnResult(payload);
      };

      const executeWaveDynamicPool = async (
        wave: import("../core/projects.js").ProjectConfig[],
      ): Promise<boolean> => {
        if (wave.length === 1) {
          return executeProject(wave[0]!, globalWorkerBudget);
        }

        interface PreparedSharedWebProject {
          project: import("../core/projects.js").ProjectConfig;
          projConfig: ProvConfig;
          matched: import("../api/flow.js").FlowDefinition[];
          results: TestResult[];
        }

        const sharedWebProjects: PreparedSharedWebProject[] = [];
        const fallbackProjects: import("../core/projects.js").ProjectConfig[] = [];
        let discoveryPassed = true;

        for (const project of wave) {
          const isDependencyOrTeardown =
            teardownProjectNames.has(project.name) ||
            (dependencyProjectNames.has(project.name) &&
              !(requestedProjectSet.size > 0 && requestedProjectSet.has(project.name)));
          const cliWorkDir = opts.cwd ? resolve(opts.cwd) : process.cwd();
          const projFlowDirs =
            !isDependencyOrTeardown && rawCliFlowPaths.length > 0
              ? rawCliFlowPaths.map((p) => resolve(cliWorkDir, p))
              : [resolveFromConfig(project.flowDir ?? config.flowDir ?? "./flows")];
          const projFlowDir = projFlowDirs[0]!;
          const projPlatforms: Platform[] =
            opts.platforms.length > 0
              ? opts.platforms
              : project.platform
                ? [project.platform]
                : config.platforms && config.platforms.length > 0
                  ? config.platforms
                  : ["web"];
          for (const p of projPlatforms) allProjectPlatforms.add(p);

          const projConfig: ProvConfig = {
            ...config,
            projects: undefined,
            webServer: undefined,
            apps: {
              ...config.apps,
              ...(project.baseUrl ? { web: { ...config.apps?.web, url: project.baseUrl } } : {}),
            },
            execution: {
              ...config.execution,
              web: {
                ...config.execution?.web,
                ...project.use,
                ...(project.browser ? { browser: project.browser } : {}),
                ...(project.storageState
                  ? { storageState: resolveFromConfig(project.storageState) }
                  : {}),
              },
            },
            defaults: {
              ...config.defaults,
              ...(project.retries !== undefined ? { retries: project.retries } : {}),
            },
          };

          const requestedProcesses = opts.processes ?? projConfig.defaults?.processes;
          const canUseSharedWebPool =
            executionMode === "local" &&
            !opts.device &&
            !opts.devices &&
            !process.env.SPANA_WORKER_PROCESS &&
            !(requestedProcesses && requestedProcesses > 1) &&
            projPlatforms.length === 1 &&
            projPlatforms[0] === "web" &&
            !projConfig.hooks?.beforeAll &&
            !projConfig.hooks?.afterAll &&
            !projConfig.apps?.web?.bridge &&
            !projConfig.execution?.bridge &&
            !resolveDriverAdapter("web", projConfig.execution?.web?.engine);

          if (!canUseSharedWebPool) {
            fallbackProjects.push(project);
            continue;
          }

          const effectiveTags = isDependencyOrTeardown ? project.tags : (opts.tags ?? project.tags);
          const effectiveGrep = isDependencyOrTeardown ? project.grep : (opts.grep ?? project.grep);
          const effectiveGrepInvert = isDependencyOrTeardown ? undefined : opts.grepInvert;
          const discovered = await discoverAndFilterFlows({
            flowDir: projFlowDir,
            flowDirs: projFlowDirs,
            cwd: cliWorkDir,
            configPath,
            tags: effectiveTags,
            grep: effectiveGrep,
            grepInvert: effectiveGrepInvert,
            passWithNoTests: opts.passWithNoTests ?? true,
            platforms: projPlatforms,
            outputDir: config.artifacts?.outputDir ?? resolveFromConfig("./spana-output"),
          });
          if (!discovered.ok) {
            if (!discovered.success) discoveryPassed = false;
            continue;
          }
          const matched = filterFlowsForProject(discovered.selectedFlows, project);
          if (matched.length === 0) {
            console.log(`[project:${project.name}] No matching flows, skipping.`);
            continue;
          }
          sharedWebProjects.push({
            project,
            projConfig,
            matched,
            results: [],
          });
        }

        let waveOk = discoveryPassed;

        if (sharedWebProjects.length > 0) {
          interface WaveWorkItem {
            projIndex: number;
            unit: import("../api/flow.js").FlowDefinition[];
          }
          const queue: WaveWorkItem[] = [];
          for (let pIdx = 0; pIdx < sharedWebProjects.length; pIdx++) {
            const sp = sharedWebProjects[pIdx]!;
            const focused = focusFlows(sp.matched);
            const units = buildOrderedWorkUnits(focused);
            console.log(`\n[project:${sp.project.name}] Running ${focused.length} flow(s)...`);
            for (const unit of units) {
              queue.push({ projIndex: pIdx, unit });
            }
          }

          if (queue.length > 0) {
            const workerCount = Math.min(globalWorkerBudget, queue.length);
            const wavePool = createSharedWebWavePool(workerCount);
            const workerOffset =
              Number.parseInt(process.env.SPANA_WORKER_INDEX_OFFSET ?? "0", 10) || 0;
            const bailLimit = opts.bail;
            let nextItemIdx = 0;
            let failureCount = 0;

            const runPoolWorker = async (slotIdx: number) => {
              const workerName = workerCount > 1 ? `Chromium #${slotIdx + 1}` : "web";
              const workerIndex = workerOffset + slotIdx;
              let currentDriverKey: string | null = null;
              let currentRuntime: RuntimeResult | null = null;

              try {
                while (true) {
                  if (bailLimit !== undefined && failureCount >= bailLimit) break;
                  const itemIdx = nextItemIdx++;
                  if (itemIdx >= queue.length) break;
                  const { projIndex, unit } = queue[itemIdx]!;
                  const sp = sharedWebProjects[projIndex]!;

                  if (unit.every((f) => Boolean(getFlowSkip(f, "web")))) {
                    for (const f of unit) {
                      const skip = getFlowSkip(f, "web")!;
                      sp.results.push(skip);
                      emitWaveResult(skip, workerName);
                    }
                    continue;
                  }

                  const neededKey = getWebDriverReuseKey(sp.projConfig, workerIndex);
                  if (currentDriverKey !== neededKey || !currentRuntime) {
                    if (currentRuntime) {
                      await currentRuntime.runtime.cleanup().catch(() => {});
                      currentRuntime = null;
                      currentDriverKey = null;
                    }
                    currentRuntime = await wavePool.acquireRuntime(
                      slotIdx,
                      sp.projConfig,
                      workerIndex,
                    );
                    currentDriverKey = neededKey;
                  }

                  const flowEngineConfig: EngineConfig = {
                    ...currentRuntime.engineConfig,
                    debugOnFailure: opts.debugOnFailure,
                    updateBaselines: opts.updateBaselines,
                    workerIndex,
                    parallelIndex: workerIndex,
                  };
                  const projRetries = opts.retries ?? sp.projConfig.defaults?.retries ?? 0;
                  let serialFailed = false;

                  for (const flow of unit) {
                    if (serialFailed) {
                      const skipped: TestResult = {
                        name: flow.name,
                        platform: "web",
                        status: "skipped",
                        skipReason: "Skipped because an earlier flow in this serial suite failed",
                        durationMs: 0,
                        ...(flow.config.tags ? { tags: flow.config.tags } : {}),
                        ...(flow.config.annotations
                          ? { annotations: flow.config.annotations }
                          : {}),
                      };
                      sp.results.push(skipped);
                      emitWaveResult(skipped, workerName);
                      continue;
                    }
                    if (bailLimit !== undefined && failureCount >= bailLimit) break;
                    const skip = getFlowSkip(flow, "web");
                    if (skip) {
                      sp.results.push(skip);
                      emitWaveResult(skip, workerName);
                      continue;
                    }

                    const flowRetries = flow.config.retries ?? projRetries;
                    for (const reporter of projReporters) {
                      reporter.onFlowStart?.(flow.name, "web", workerName);
                    }
                    let res = await executeFlow(
                      flow,
                      currentRuntime.runtime.driver,
                      flowEngineConfig,
                    );
                    let attempts = 1;
                    while (res.status === "failed" && attempts <= flowRetries) {
                      if (bailLimit !== undefined && failureCount >= bailLimit) break;
                      res = await executeFlow(
                        flow,
                        currentRuntime.runtime.driver,
                        flowEngineConfig,
                      );
                      attempts++;
                    }
                    if (res.status === "passed" && attempts > 1) {
                      res.flaky = true;
                    }
                    res.attempts = attempts;
                    const redacted = redactWaveResult(res);
                    sp.results.push(redacted);
                    if (redacted.status === "failed") {
                      failureCount++;
                      if (unit.length > 1) serialFailed = true;
                    }
                    emitWaveResult(redacted, workerName);
                  }
                }
              } finally {
                if (currentRuntime) {
                  await currentRuntime.runtime.cleanup().catch(() => {});
                }
              }
            };

            try {
              await Promise.all(Array.from({ length: workerCount }, (_, s) => runPoolWorker(s)));

              if (bailLimit !== undefined && failureCount >= bailLimit) {
                while (nextItemIdx < queue.length) {
                  const { projIndex, unit } = queue[nextItemIdx++]!;
                  const sp = sharedWebProjects[projIndex]!;
                  for (const flow of unit) {
                    const skipped: TestResult = getFlowSkip(flow, "web") ?? {
                      name: flow.name,
                      platform: "web",
                      status: "skipped",
                      skipReason: "Skipped due to bail limit",
                      durationMs: 0,
                      attempts: 0,
                      ...(flow.config.tags ? { tags: flow.config.tags } : {}),
                    };
                    sp.results.push(skipped);
                    waveOnResult(skipped);
                  }
                }
              }
            } finally {
              await wavePool.closeAll();
            }
          }

          for (const sp of sharedWebProjects) {
            allProjectResults.push(...sp.results);
            const passed = sp.results.filter((r) => r.status === "passed").length;
            const failed = sp.results.filter((r) => r.status === "failed").length;
            const skipped = sp.results.filter((r) => r.status === "skipped").length;
            console.log(
              `[project:${sp.project.name}] ${passed} passed, ${failed} failed, ${skipped} skipped`,
            );
            if (failed > 0) waveOk = false;
          }
        }

        if (fallbackProjects.length > 0) {
          const maxConcurrentProjects = Math.min(fallbackProjects.length, globalWorkerBudget);
          const baseWorkersPerProj = Math.max(
            1,
            Math.floor(globalWorkerBudget / maxConcurrentProjects),
          );
          const extraWorkerSlots =
            fallbackProjects.length <= globalWorkerBudget
              ? globalWorkerBudget - baseWorkersPerProj * maxConcurrentProjects
              : 0;
          const fallbackOutcomes: boolean[] = Array.from(
            { length: fallbackProjects.length },
            () => true,
          );
          let nextFbIdx = 0;
          const runFbSlot = async (slotIdx: number) => {
            const slotBudget = baseWorkersPerProj + (slotIdx < extraWorkerSlots ? 1 : 0);
            while (true) {
              const idx = nextFbIdx++;
              if (idx >= fallbackProjects.length) break;
              fallbackOutcomes[idx] = await executeProject(fallbackProjects[idx]!, slotBudget);
            }
          };
          await Promise.all(Array.from({ length: maxConcurrentProjects }, (_, s) => runFbSlot(s)));
          if (fallbackOutcomes.some((ok) => !ok)) waveOk = false;
        }

        return waveOk;
      };

      for (const wave of plan.waves) {
        const wavePassed = await executeWaveDynamicPool(wave);
        if (!wavePassed) {
          allPassed = false;
          break;
        }
      }
      for (const td of plan.teardowns) {
        const tdOk = await executeProject(td, globalWorkerBudget);
        if (!tdOk) allPassed = false;
      }

      const projDurationMs = Date.now() - projectsStart;
      const projSummary = summarizeTestResults(allProjectResults, projDurationMs, allPassed);
      for (const reporter of projReporters) {
        reporter.onRunComplete({
          total: projSummary.total,
          passed: projSummary.passed,
          failed: projSummary.failed,
          skipped: projSummary.skipped,
          flaky: projSummary.flaky,
          durationMs: projDurationMs,
          platformDurations:
            allProjectPlatforms.size === 1
              ? { [[...allProjectPlatforms][0]!]: projDurationMs }
              : undefined,
          results: allProjectResults,
          platforms: [...allProjectPlatforms],
        });
      }
      await writeWorkerProcessReport(allProjectResults);
      return {
        success: allPassed,
        watchRoots: collectWatchRoots(resolveFromConfig(config.flowDir ?? "./flows"), configPath),
        summary: projSummary,
      };
    } finally {
      await webServers.stopAll();
    }
  }

  const platforms: Platform[] =
    opts.platforms.length > 0
      ? opts.platforms
      : config.platforms && config.platforms.length > 0
        ? config.platforms
        : ["web"];

  const workDir = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const resolvedTimingsFile = opts.timingsFile
    ? resolve(workDir, opts.timingsFile)
    : config.defaults?.timingsFile;
  const resolvedWriteTimingsFile = opts.writeTimingsFile
    ? resolve(workDir, opts.writeTimingsFile)
    : undefined;
  const rawCliPaths =
    opts.flowPaths && opts.flowPaths.length > 0
      ? opts.flowPaths
      : opts.flowPath
        ? [opts.flowPath]
        : [];
  const flowDirs =
    rawCliPaths.length > 0
      ? rawCliPaths.map((p) => resolve(workDir, p))
      : [resolveFromConfig(config.flowDir ?? "./flows")];
  const flowDir = flowDirs[0]!;

  if (opts.listOnly) {
    const listed = await discoverAndFilterFlows({
      flowDir,
      flowDirs,
      cwd: workDir,
      configPath,
      tags: opts.tags,
      grep: opts.grep,
      grepInvert: opts.grepInvert,
      passWithNoTests: opts.passWithNoTests,
      platforms,
      shard: opts.shard,
      timingsFile: resolvedTimingsFile,
      lastFailed: opts.lastFailed,
      changed: opts.changed,
      changedSince: opts.changedSince,
      filters: config.filters as import("../core/filters.js").TestFilter[] | undefined,
      outputDir: config.artifacts?.outputDir ?? resolveFromConfig("./spana-output"),
    });
    if (!listed.ok) {
      return {
        success: listed.success,
        watchRoots: listed.watchRoots,
        summary: emptyTestCommandResult(listed.success, Date.now() - runStartedAt),
      };
    }
    const items = listed.selectedLoadedFlows.map((item) => ({
      name: item.flow.name,
      sourcePath: item.sourcePath,
      tags: item.flow.config.tags ?? [],
      platforms: item.flow.config.platforms ?? platforms,
      skip: Boolean(item.flow.config.skip),
      fixme: Boolean(item.flow.config.fixme),
      only: Boolean(item.flow.config.only),
    }));
    if (opts.json) {
      console.log(JSON.stringify({ count: items.length, flows: items }, null, 2));
    } else {
      console.log(`Found ${items.length} flow(s):`);
      for (const item of items) {
        const tagsText = item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : "";
        const flags = [item.only ? "only" : "", item.skip ? "skip" : "", item.fixme ? "fixme" : ""]
          .filter(Boolean)
          .join(",");
        const flagText = flags ? ` (${flags})` : "";
        console.log(`  • ${item.name}${tagsText}${flagText} — ${item.sourcePath}`);
      }
    }
    return {
      success: true,
      watchRoots: listed.watchRoots,
      summary: emptyTestCommandResult(true, Date.now() - runStartedAt),
    };
  }

  // Resolve explicit device targeting
  let targetDevice: import("../device/discover.js").DiscoveredDevice | null = null;
  if (opts.device) {
    const deviceResult = await resolveTargetDevice(opts.device, platforms, opts.platforms);
    if (!deviceResult.ok) {
      return {
        success: deviceResult.success,
        watchRoots: collectWatchRoots(flowDir, configPath),
        summary: emptyTestCommandResult(deviceResult.success, Date.now() - runStartedAt),
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

  // 2. Discover flows & step definitions while speculatively pre-launching web browser
  //    and loading prior run duration hints for longest-first parallel scheduling.
  const outputDir = config.artifacts?.outputDir ?? resolveFromConfig("./spana-output");

  // Dynamic multi-process worker pool: triggered explicitly via `--processes M`
  // OR automatically when `--workers` exceeds `maxWorkersPerProcess` (default 8).
  // Uses a shared loopback HTTP longest-first work-stealing queue so every OS process
  // gets isolated JS heap + warm daemon scope with zero static-shard tail stragglers.
  const maxWorkersPerProcess = config.defaults?.maxWorkersPerProcess;
  const requestedProcesses = opts.processes ?? config.defaults?.processes;
  const requestedWorkers = opts.workers ?? config.defaults?.workers ?? requestedProcesses;
  const cliEntrypoint = resolveSpanaCliEntrypoint();
  if (
    requestedWorkers &&
    !opts.shard &&
    !opts.watch &&
    !opts.validateConfigOnly &&
    !opts.device &&
    !process.env.SPANA_WORKER_PROCESS &&
    cliEntrypoint
  ) {
    const plan = planProcessPool(requestedWorkers, maxWorkersPerProcess, requestedProcesses);
    if (plan.processCount > 1) {
      const [mpFlowResult, mpPriorRunState, mpTimingsHints] = await Promise.all([
        discoverAndFilterFlows({
          flowDir,
          flowDirs,
          cwd: workDir,
          configPath,
          tags: opts.tags,
          grep: opts.grep,
          grepInvert: opts.grepInvert,
          passWithNoTests: opts.passWithNoTests,
          platforms,
          timingsFile: resolvedTimingsFile,
          lastFailed: opts.lastFailed,
          changed: opts.changed,
          changedSince: opts.changedSince,
          filters: config.filters as import("../core/filters.js").TestFilter[] | undefined,
          outputDir,
        }),
        readLastRunState(createLastRunStatePath(outputDir)),
        resolvedTimingsFile ? readDurationHintsFile(resolvedTimingsFile) : Promise.resolve({}),
      ]);
      if (!mpFlowResult.ok) {
        return {
          success: mpFlowResult.success,
          watchRoots: mpFlowResult.watchRoots,
          summary: emptyTestCommandResult(mpFlowResult.success, Date.now() - runStartedAt),
        };
      }

      const mpDurationHints = {
        ...mpTimingsHints,
        ...extractDurationHints(mpPriorRunState),
      };
      // Group serial suites FIRST before sorting units by duration hints so serial groups stay intact across --processes (2.5)
      const orderedUnits = buildOrderedWorkUnits(mpFlowResult.selectedFlows, mpDurationHints);
      const totalFlowCountMp = orderedUnits.reduce((acc, u) => acc + u.length, 0);
      const effectiveProcesses = Math.min(plan.processCount, Math.max(1, orderedUnits.length));
      const effectivePlan = planProcessPool(
        requestedWorkers,
        maxWorkersPerProcess,
        effectiveProcesses,
      );

      if (effectivePlan.processCount > 1) {
        console.log(
          `Running ${totalFlowCountMp} flow(s) across ${effectivePlan.processCount} OS processes (${effectivePlan.workersPerProcess.join("+")} workers, dynamic longest-first queue)...\n`,
        );
        const { redactor, reporters } = await setupReporters(
          reporterNames,
          config,
          resolveFromConfig,
          opts.appiumUrl,
          opts,
          mpFlowResult.filterSummaries,
        );
        const queueServer = await startSharedFlowQueueServer(
          orderedUnits.map((unit) => unit.map((f) => f.name)),
        );
        const runTag = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
        const baseWarmScope = config.execution?.web?.warmBrowserScope ?? `mp-${runTag}`;
        const shardOutDirs: string[] = [];
        let workerIndexOffsetCursor = 0;

        // Build a real parent hook runtime when beforeAll/afterAll is configured in --processes mode (3.11)
        const hookPlatform = platforms[0] ?? "web";
        let parentHookRuntime: RuntimeResult | undefined;
        const createParentHookContext = async () => {
          if (!parentHookRuntime) {
            if (hookPlatform === "web") {
              parentHookRuntime = await buildWebRuntime(config);
            } else if (hookPlatform === "electron") {
              parentHookRuntime = await buildElectronRuntime(config, resolveFromConfig);
            } else if (hookPlatform === "electrobun") {
              parentHookRuntime = await buildElectrobunRuntime(config, resolveFromConfig);
            } else if (hookPlatform === "android") {
              parentHookRuntime =
                (await buildLocalAndroidRuntime(config, null, resolveFromConfig)) ?? undefined;
            } else if (hookPlatform === "ios") {
              parentHookRuntime =
                (await buildLocalIOSRuntime(config, null, resolveFromConfig)) ?? undefined;
            }
          }
          if (!parentHookRuntime) {
            return {
              app: undefined,
              expect: undefined,
              platform: hookPlatform,
              workerIndex: 0,
              parallelIndex: 0,
            };
          }
          const { runtime: hookRt, engineConfig: hookEngineCfg } = parentHookRuntime;
          const hookApp = createPromiseApp(
            hookRt.driver,
            hookEngineCfg.appId,
            hookEngineCfg.coordinatorConfig,
            undefined,
            {
              platform: hookPlatform,
              storybook: hookEngineCfg.storybook,
              launchOptions: hookEngineCfg.launchOptions,
              visualRegression: hookEngineCfg.visualRegression,
            },
          );
          const hookExpect = createPromiseExpect(
            hookRt.driver,
            hookEngineCfg.coordinatorConfig,
            undefined,
            {
              flowFilePath: "",
              flowName: "beforeAll/afterAll",
              platform: hookPlatform,
              updateBaselines: opts.updateBaselines ?? false,
            },
            hookEngineCfg.visualRegression,
          );
          return {
            app: hookApp,
            expect: hookExpect,
            platform: hookPlatform,
            workerIndex: 0,
            parallelIndex: 0,
          };
        };

        try {
          // Run global config.hooks.beforeAll once in parent process (3.11)
          if (config.hooks?.beforeAll) {
            const hookCtx = await createParentHookContext();
            await config.hooks.beforeAll(hookCtx as any);
            // If no afterAll hook exists, release the hook runtime before spawning child workers
            if (!config.hooks.afterAll && parentHookRuntime) {
              await parentHookRuntime.runtime.cleanup().catch(() => {});
              parentHookRuntime = undefined;
            }
          }
          const poolResult = await runMultiProcessPool({
            totalWorkers: requestedWorkers,
            maxWorkersPerProcess,
            processes: effectivePlan.processCount,
            buildShardCommand: (shardIndex, _shardTotal, workerCount) => {
              const shardOutDir = join(tmpdir(), `spana-mp-${runTag}-p${shardIndex}`);
              const reportPath = join(shardOutDir, "results.json");
              const myOffset = workerIndexOffsetCursor;
              workerIndexOffsetCursor += workerCount;
              shardOutDirs.push(shardOutDir);
              const args = [
                cliEntrypoint,
                "test",
                ...(rawCliPaths.length > 0 ? rawCliPaths : []),
                "--platform",
                platforms.join(","),
                "--workers",
                String(workerCount),
                "--reporter",
                "json",
                "--pass-with-no-tests",
                ...(opts.browser ? ["--browser", opts.browser] : []),
                ...(opts.configPath ? ["--config", opts.configPath] : []),
                ...(opts.tags?.flatMap((t) => ["--tag", t]) ?? []),
                ...(opts.grep ? ["--grep", opts.grep] : []),
                ...(opts.grepInvert ? ["--grep-invert", opts.grepInvert] : []),
                ...(opts.changedSince ? ["--changed-since", opts.changedSince] : []),
                ...(opts.retries !== undefined ? ["--retries", String(opts.retries)] : []),
                ...(opts.jsCoverage ? ["--js-coverage"] : []),
                ...(opts.trace ? ["--trace"] : []),
                ...(opts.headed ? ["--headed"] : []),
                ...(opts.bail !== undefined ? ["--bail", String(opts.bail)] : []),
              ];
              return {
                command: process.execPath,
                args,
                env: {
                  SPANA_WORKER_PROCESS: "1",
                  SPANA_QUEUE_URL: queueServer.url,
                  SPANA_OUTPUT_DIR: shardOutDir,
                  SPANA_WORKER_REPORT_PATH: reportPath,
                  SPANA_WORKER_INDEX_OFFSET: String(myOffset),
                  SPANA_WARM_SCOPE: `${baseWarmScope}-p${shardIndex}`,
                },
                reportJsonPath: reportPath,
              };
            },
          });

          // Move child artifacts from temp shardOutDirs into the parent run outputDir and rewrite attachment paths
          const {
            cp,
            mkdir: mkdirFs,
            readdir: readdirFs,
            rm: rmFs,
          } = await import("node:fs/promises");
          const pathRewrites: Array<[string, string]> = [];
          await mkdirFs(outputDir, { recursive: true });
          for (const shardDir of shardOutDirs) {
            try {
              const entries = await readdirFs(shardDir);
              for (const entry of entries) {
                if (entry === "results.json" || entry === ".spana") continue;
                const src = join(shardDir, entry);
                const dest = join(outputDir, entry);
                await cp(src, dest, { recursive: true, force: true });
                pathRewrites.push([src, dest]);
              }
            } catch {
              // shard wrote no artifacts
            } finally {
              await rmFs(shardDir, { recursive: true, force: true }).catch(() => {});
            }
          }
          const rewriteAttachmentPath = (p: string): string => {
            for (const [src, dest] of pathRewrites) {
              if (p === src || p.startsWith(`${src}/`) || p.startsWith(`${src}\\`)) {
                return dest + p.slice(src.length);
              }
            }
            return p;
          };
          const mergedResults = poolResult.results.map((r) => ({
            ...r,
            ...(r.attachments
              ? {
                  attachments: r.attachments.map((a) => ({
                    ...a,
                    path: rewriteAttachmentPath(a.path),
                  })),
                }
              : {}),
          }));

          const redactedResults = mergedResults.map((r) =>
            r.error
              ? {
                  ...r,
                  error: {
                    ...r.error,
                    message: redactor.redact(r.error.message),
                    stack: r.error.stack ? redactor.redact(r.error.stack) : undefined,
                    suggestion: r.error.suggestion
                      ? redactor.redact(r.error.suggestion)
                      : undefined,
                  },
                }
              : r,
          );
          for (const reporter of reporters) {
            reporter.onRunComplete({
              total: redactedResults.length,
              passed: poolResult.passed,
              failed: poolResult.failed,
              skipped: poolResult.skipped,
              flaky: poolResult.flaky,
              durationMs: poolResult.totalDurationMs,
              platformDurations:
                platforms.length === 1
                  ? { [platforms[0]!]: poolResult.totalDurationMs }
                  : undefined,
              results: redactedResults,
              platforms,
            });
          }

          if (config.hooks?.afterAll) {
            try {
              const afterHookCtx = await createParentHookContext();
              await config.hooks.afterAll({
                ...afterHookCtx,
                summary: { results: redactedResults },
              } as any);
            } catch (hookError) {
              console.warn(
                `afterAll hook failed: ${hookError instanceof Error ? hookError.message : hookError}`,
              );
            }
          }

          const sourcePathsByFlowName = new Map(
            mpFlowResult.selectedLoadedFlows.map((loaded) => [loaded.flow.name, loaded.sourcePath]),
          );
          try {
            await writeLastRunState(
              createLastRunStatePath(outputDir),
              buildLastRunState({
                flowDir,
                platforms,
                results: mergedResults,
                sourcePathsByFlowName,
              }),
            );
          } catch {
            // best-effort state save
          }

          return {
            success: poolResult.failed === 0,
            watchRoots: mpFlowResult.watchRoots,
            summary: summarizeTestResults(
              redactedResults,
              poolResult.totalDurationMs,
              poolResult.failed === 0,
            ),
          };
        } finally {
          if (parentHookRuntime) {
            await parentHookRuntime.runtime.cleanup().catch(() => {});
          }
          await queueServer.close();
        }
      }
    }
  }

  const prelaunchedWeb =
    executionMode === "local" && platforms.includes("web")
      ? speculativelyPrelaunchWebBrowser(config)
      : undefined;
  const closePrelaunchedWeb = async () => {
    if (!prelaunchedWeb?.ownsBrowser) return;
    await prelaunchedWeb.browserPromise.then((b) => b?.close?.()).catch(() => {});
    await prelaunchedWeb.cdpBrowserPromise?.then((h) => h.close()).catch(() => {});
  };

  let flowResult;
  let priorRunState;
  let externalTimingsHints: Record<string, number> = {};
  try {
    [flowResult, priorRunState, externalTimingsHints] = await Promise.all([
      discoverAndFilterFlows({
        flowDir,
        flowDirs,
        cwd: workDir,
        configPath,
        tags: opts.tags,
        grep: opts.grep,
        grepInvert: opts.grepInvert,
        passWithNoTests: opts.passWithNoTests,
        platforms,
        shard: opts.shard,
        timingsFile: resolvedTimingsFile,
        lastFailed: opts.lastFailed,
        changed: opts.changed,
        changedSince: opts.changedSince,
        filters: config.filters as import("../core/filters.js").TestFilter[] | undefined,
        outputDir,
      }),
      readLastRunState(createLastRunStatePath(outputDir)),
      resolvedTimingsFile ? readDurationHintsFile(resolvedTimingsFile) : Promise.resolve({}),
    ]);
  } catch (err) {
    await closePrelaunchedWeb();
    throw err;
  }
  if (!flowResult.ok) {
    await closePrelaunchedWeb();
    return {
      success: flowResult.success,
      watchRoots: flowResult.watchRoots,
      summary: emptyTestCommandResult(flowResult.success, Date.now() - runStartedAt),
    };
  }
  const { selectedLoadedFlows, selectedFlows, watchRoots, filterSummaries } = flowResult;
  const durationHintsMs: Record<string, number> = {
    ...externalTimingsHints,
    ...extractDurationHints(priorRunState),
  };

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
    if (config.webServer && !process.env.SPANA_WORKER_PROCESS) {
      const startedServers = await startWebServers(config.webServer, { cwd: configDir });
      runCleanups.push(() => startedServers.stopAll());
    }

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
        ? await (
            await import("../cloud/provider.js")
          ).createCloudProviderHelper(appiumUrl, appiumConfig)
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
          prelaunchedWeb,
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
          prelaunchedWeb,
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
      filterSummaries,
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
      if (!r.error) return r.skipReason ? { ...r, skipReason: redactor.redact(r.skipReason) } : r;
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

    // 5. Run with real-time reporter callbacks (pull indivisible work units from dynamic shared queue if spawned by multi-process pool)
    let claimNextWorkUnit:
      | (() => Promise<import("../api/flow.js").FlowDefinition[] | null>)
      | undefined;
    if (process.env.SPANA_QUEUE_URL) {
      const flowByName = new Map<string, import("../api/flow.js").FlowDefinition[]>();
      for (const f of selectedFlows) {
        const list = flowByName.get(f.name) ?? [];
        list.push(f);
        flowByName.set(f.name, list);
      }
      const remoteClaim = createRemoteWorkUnitClaimer(process.env.SPANA_QUEUE_URL);
      claimNextWorkUnit = async () => {
        while (true) {
          const names = await remoteClaim();
          if (!names) return null;
          const unit: import("../api/flow.js").FlowDefinition[] = [];
          for (const name of names) {
            const bucket = flowByName.get(name);
            if (bucket && bucket.length > 0) {
              unit.push(bucket.shift()!);
            }
          }
          if (unit.length > 0) return unit;
        }
      };
    }

    const retries = opts.retries ?? config.defaults?.retries ?? 0;
    const retryDelay = config.defaults?.retryDelay ?? 0;
    const onResult = createResultHandler(reporters, redactResult, redactor, opts);
    const result = await orchestrate(selectedFlows, platformConfigs, {
      retries,
      retryDelay,
      bail: opts.bail,
      durationHintsMs: Object.keys(durationHintsMs).length > 0 ? durationHintsMs : undefined,
      claimNextWorkUnit,
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
        platformDurations: result.platformDurations,
        results: redactedResults,
        platforms,
        bailedOut: result.bailedOut,
        bailLimit: result.bailLimit,
        workerStats: result.workerStats,
      });
    }

    await writeWorkerProcessReport(redactedResults);

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

    if (resolvedWriteTimingsFile) {
      try {
        await writeDurationHintsFile(resolvedWriteTimingsFile, result.results);
      } catch (error) {
        console.log(
          `Warning: Failed to write timings file at ${resolvedWriteTimingsFile}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    // Report to cloud provider if applicable
    if (shouldReportToProvider && appiumUrl) {
      await reportToCloudProvider(runtimes, appiumUrl, result, platforms);
    }

    return {
      success: result.failed === 0,
      watchRoots,
      summary: summarizeTestResults(redactedResults, result.totalDurationMs, result.failed === 0),
    };
  } finally {
    // 7. Cleanup — always runs in parallel even if orchestration/reporting fails
    await Promise.allSettled(runtimes.map((rt) => rt.cleanup()));
    await Promise.allSettled(runCleanups.map((cleanup) => cleanup()));
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

export async function runTestCommandWithResult(
  opts: TestCommandOptions,
): Promise<TestCommandResult> {
  if (!opts.watch) {
    return (await runTestCommandOnce(opts)).summary;
  }

  let lastResult = await runTestCommandOnce({ ...opts, watch: false });
  if (lastResult.watchRoots.length === 0) {
    return lastResult.summary;
  }

  console.log(
    `Watching ${lastResult.watchRoots.length} path(s) for changes. Press Ctrl+C to stop.`,
  );
  const { runWatchLoop } = await import("./watch-mode.js");
  await runWatchLoop({
    roots: lastResult.watchRoots,
    onChange: async (changedPaths) => {
      console.log(`\nChange detected:\n${changedPaths.map((path) => `  ${path}`).join("\n")}\n`);
      lastResult = await runTestCommandOnce({ ...opts, watch: false });
    },
  });

  return lastResult.summary;
}

export async function runTestCommand(opts: TestCommandOptions): Promise<boolean> {
  return (await runTestCommandWithResult(opts)).success;
}
