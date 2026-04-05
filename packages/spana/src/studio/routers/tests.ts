import { z } from "zod";
import { resolve } from "node:path";
import { publicProcedure } from "../api.js";
import {
  discoverFlows,
  loadTestSource,
  filterFlows,
  discoverStepFiles,
  loadStepFiles,
} from "../../core/runner.js";
import { orchestrate, type PlatformConfig } from "../../core/orchestrator.js";
import type { FlowResult, RunSummary } from "../../report/types.js";
import type { Platform } from "../../schemas/selector.js";
import type { FlowDefinition } from "../../api/flow.js";
import type { EngineConfig } from "../../core/engine.js";
import type { ProvConfig } from "../../schemas/config.js";
import { Effect } from "effect";

// ---------------------------------------------------------------------------
// In-memory run tracking
// ---------------------------------------------------------------------------

interface ActiveRun {
  id: string;
  status: "running" | "completed";
  results: FlowResult[];
  summary?: RunSummary;
}

const activeRuns = new Map<string, ActiveRun>();

let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `run-${Date.now()}-${runCounter}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const platformEnum = z.enum(["web", "android", "ios"]);

async function discoverAndLoad(flowDir: string): Promise<FlowDefinition[]> {
  const dir = resolve(flowDir);
  const flowPaths = await discoverFlows(dir);

  // Load step definitions for .feature files
  const hasFeature = flowPaths.some((p) => p.endsWith(".feature"));
  if (hasFeature) {
    const stepPaths = await discoverStepFiles(dir);
    if (stepPaths.length > 0) {
      await loadStepFiles(stepPaths);
    }
  }

  const flows: FlowDefinition[] = [];
  for (const p of flowPaths) {
    const loaded = await loadTestSource(p);
    flows.push(...loaded);
  }
  return flows;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const testsRouter = {
  /** Discover flows and return metadata */
  listFlows: publicProcedure
    .input(
      z
        .object({
          flowDir: z.string().optional(),
          tags: z.array(z.string()).optional(),
          platforms: z.array(platformEnum).optional(),
          grep: z.string().optional(),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const flowDir = input?.flowDir ?? "./flows";
      let flows: FlowDefinition[];
      try {
        flows = await discoverAndLoad(flowDir);
      } catch {
        return { flows: [] };
      }

      if (flows.length === 0) return { flows: [] };

      const filtered = filterFlows(flows, {
        tags: input?.tags,
        grep: input?.grep,
        platforms: input?.platforms as Platform[] | undefined,
      });

      return {
        flows: filtered.map((f) => ({
          name: f.name,
          tags: f.config.tags ?? [],
          platforms: f.config.platforms ?? [],
        })),
      };
    }),

  /** Start a test run in the background, return a run ID */
  run: publicProcedure
    .input(
      z.object({
        platforms: z.array(platformEnum).min(1),
        flowDir: z.string().optional(),
        tags: z.array(z.string()).optional(),
        grep: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const runId = nextRunId();
      const run: ActiveRun = { id: runId, status: "running", results: [] };
      activeRuns.set(runId, run);

      // Fire-and-forget: run tests in background
      void (async () => {
        try {
          const flowDir = input.flowDir ?? "./flows";
          const flows = await discoverAndLoad(flowDir);
          const platforms = input.platforms as Platform[];
          const filtered = filterFlows(flows, {
            tags: input.tags,
            grep: input.grep,
            platforms,
          });

          if (filtered.length === 0) {
            run.status = "completed";
            run.summary = {
              total: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
              durationMs: 0,
              results: [],
              platforms,
            };
            return;
          }

          // Build platform configs — requires driver setup per platform
          const platformConfigs = await buildPlatformConfigs(platforms);

          if (platformConfigs.length === 0) {
            run.status = "completed";
            run.summary = {
              total: 0,
              passed: 0,
              failed: 0,
              skipped: 0,
              durationMs: 0,
              results: [],
              platforms,
            };
            return;
          }

          const result = await orchestrate(filtered, platformConfigs);

          // Map results to FlowResult (serializable)
          run.results = result.results.map((r) => ({
            name: r.name,
            platform: r.platform,
            status: r.status,
            durationMs: r.durationMs,
            error: r.error ? { message: r.error.message, stack: r.error.stack } : undefined,
            steps: r.steps,
          }));

          run.summary = {
            total: result.results.length,
            passed: result.passed,
            failed: result.failed,
            skipped: result.skipped,
            durationMs: result.totalDurationMs,
            results: run.results,
            platforms,
          };
          run.status = "completed";

          // Cleanup drivers
          for (const pc of platformConfigs) {
            try {
              await Effect.runPromise(pc.driver.killApp(""));
            } catch {
              // ignore cleanup errors
            }
          }
        } catch {
          run.status = "completed";
          run.results = [];
          run.summary = {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            durationMs: 0,
            results: [],
            platforms: input.platforms as Platform[],
          };
        }
      })();

      return { runId };
    }),

  /** Poll for run progress */
  status: publicProcedure.input(z.object({ runId: z.string() })).handler(({ input }) => {
    const run = activeRuns.get(input.runId);
    if (!run) {
      return { status: "not_found" as const, results: [] };
    }
    return {
      status: run.status,
      results: run.results,
      summary: run.summary,
    };
  }),

  /** Get final results for a completed run */
  results: publicProcedure.input(z.object({ runId: z.string() })).handler(({ input }) => {
    const run = activeRuns.get(input.runId);
    if (!run || run.status !== "completed") {
      return null;
    }
    return run.summary ?? null;
  }),
};

// ---------------------------------------------------------------------------
// Platform config builder (simplified — loads config if available)
// ---------------------------------------------------------------------------

async function buildPlatformConfigs(platforms: Platform[]): Promise<PlatformConfig[]> {
  const configs: PlatformConfig[] = [];

  // Try loading project config
  let provConfig: ProvConfig = {};
  try {
    const configPath = resolve("spana.config.ts");
    const mod = await import(configPath);
    provConfig = mod.default ?? {};
  } catch {
    // No config, use defaults
  }

  for (const platform of platforms) {
    try {
      if (platform === "web") {
        const { makePlaywrightDriver } = await import("../../drivers/playwright.js");
        const { parseWebHierarchy } = await import("../../drivers/playwright-parser.js");
        const webUrl = provConfig.apps?.web?.url ?? "http://localhost:3000";
        const driver = await Effect.runPromise(
          makePlaywrightDriver({ headless: true, baseUrl: webUrl }),
        );
        const engineConfig: EngineConfig = {
          appId: webUrl,
          platform: "web",
          coordinatorConfig: {
            parse: parseWebHierarchy,
            defaults: {
              timeout: provConfig.defaults?.waitTimeout,
              pollInterval: provConfig.defaults?.pollInterval,
            },
          },
          autoLaunch: true,
          flowTimeout: provConfig.defaults?.waitTimeout
            ? provConfig.defaults.waitTimeout * 10
            : 60_000,
          artifactConfig: provConfig.artifacts,
        };
        configs.push({ platform, driver, engineConfig });
      }

      if (platform === "android") {
        const { firstAndroidDevice } = await import("../../device/android.js");
        const { setupUiAutomator2 } = await import("../../drivers/uiautomator2/installer.js");
        const { createUiAutomator2Driver } = await import("../../drivers/uiautomator2/driver.js");
        const { parseAndroidHierarchy } = await import("../../drivers/uiautomator2/pagesource.js");

        const device = firstAndroidDevice();
        if (!device) continue;

        const packageName = provConfig.apps?.android?.packageName ?? "";
        const hostPort = 8200 + Math.floor(Math.random() * 100);
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
              timeout: provConfig.defaults?.waitTimeout,
              pollInterval: provConfig.defaults?.pollInterval,
            },
          },
          autoLaunch: true,
          flowTimeout: provConfig.defaults?.waitTimeout
            ? provConfig.defaults.waitTimeout * 10
            : 60_000,
          artifactConfig: provConfig.artifacts,
        };
        configs.push({ platform, driver, engineConfig });
      }

      if (platform === "ios") {
        const { firstIOSSimulatorWithApp, bootSimulator } = await import("../../device/ios.js");
        const { setupWDA } = await import("../../drivers/wda/installer.js");
        const { createWDADriver } = await import("../../drivers/wda/driver.js");
        const { parseIOSHierarchy } = await import("../../drivers/wda/pagesource.js");

        const bundleId = provConfig.apps?.ios?.bundleId ?? "";
        const simulator = firstIOSSimulatorWithApp(bundleId);
        if (!simulator) continue;

        if (simulator.state !== "Booted") {
          bootSimulator(simulator.udid);
        }

        const wdaPort = 8100 + Math.floor(Math.random() * 100);
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
              timeout: provConfig.defaults?.waitTimeout,
              pollInterval: provConfig.defaults?.pollInterval,
            },
          },
          autoLaunch: true,
          flowTimeout: provConfig.defaults?.waitTimeout
            ? provConfig.defaults.waitTimeout * 10
            : 60_000,
          artifactConfig: provConfig.artifacts,
        };
        configs.push({ platform, driver, engineConfig });
      }
    } catch {
      // Skip platform on setup failure
    }
  }

  return configs;
}
