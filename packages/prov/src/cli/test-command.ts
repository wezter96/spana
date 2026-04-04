import { resolve } from "node:path";
import { Effect } from "effect";
import { discoverFlows, loadFlowFile, filterFlows } from "../core/runner.js";
import { orchestrate, type PlatformConfig } from "../core/orchestrator.js";
import type { EngineConfig } from "../core/engine.js";
import type { ProvConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";

export interface TestCommandOptions {
  platforms: Platform[];
  tags?: string[];
  grep?: string;
  reporter: string;
  configPath?: string;
  flowPath?: string;
}

export async function runTestCommand(opts: TestCommandOptions): Promise<boolean> {
  // 1. Load config
  let config: ProvConfig = {};
  try {
    const configPath = resolve(opts.configPath ?? "prov.config.ts");
    const mod = await import(configPath);
    config = mod.default ?? {};
  } catch {
    // No config file, use defaults
  }

  // 2. Discover flows
  const flowDir = opts.flowPath ?? config.flowDir ?? "./flows";
  const flowPaths = await discoverFlows(flowDir);

  if (flowPaths.length === 0) {
    console.log("No flow files found.");
    return true;
  }

  // 3. Load and filter flows
  const flows = [];
  for (const p of flowPaths) {
    flows.push(await loadFlowFile(p));
  }
  const filtered = filterFlows(flows, {
    tags: opts.tags,
    grep: opts.grep,
    platforms: opts.platforms,
  });

  if (filtered.length === 0) {
    console.log("No flows match the given filters.");
    return true;
  }

  console.log(`Running ${filtered.length} flow(s) on ${opts.platforms.join(", ")}...\n`);

  // 4. Setup platform drivers
  const platformConfigs: PlatformConfig[] = [];

  for (const platform of opts.platforms) {
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
        flowTimeout: config.defaults?.waitTimeout
          ? config.defaults.waitTimeout * 10
          : 60_000,
      };
      platformConfigs.push({ platform, driver, engineConfig });
    }
    // Android and iOS drivers will be added in a future release
  }

  // 5. Run
  const result = await orchestrate(filtered, platformConfigs);

  // 6. Report
  const { createConsoleReporter } = await import("../report/console.js");
  const { createJsonReporter } = await import("../report/json.js");

  const reporter =
    opts.reporter === "json" ? createJsonReporter() : createConsoleReporter();

  for (const r of result.results) {
    const flowResult = {
      ...r,
      error: r.error
        ? { message: r.error.message, stack: r.error.stack }
        : undefined,
    };
    if (r.status === "passed") {
      reporter.onFlowPass?.(flowResult);
    } else if (r.status === "failed") {
      reporter.onFlowFail?.(flowResult);
    }
  }

  reporter.onRunComplete({
    total: result.results.length,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    durationMs: result.totalDurationMs,
    results: result.results.map((r) => ({
      ...r,
      error: r.error
        ? { message: r.error.message, stack: r.error.stack }
        : undefined,
    })),
    platforms: opts.platforms,
  });

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
