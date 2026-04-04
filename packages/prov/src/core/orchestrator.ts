import type { RawDriverService } from "../drivers/raw-driver.js";
import type { FlowDefinition } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";
import { executeFlow, type TestResult, type EngineConfig } from "./engine.js";

export interface PlatformConfig {
  platform: Platform;
  driver: RawDriverService;
  engineConfig: EngineConfig;
}

export interface OrchestratorResult {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
}

export async function orchestrate(
  flows: FlowDefinition[],
  platforms: PlatformConfig[],
): Promise<OrchestratorResult> {
  const start = Date.now();

  // Run all platforms in parallel, flows serial within each
  const platformResults = await Promise.all(
    platforms.map(async ({ platform, driver, engineConfig }) => {
      const results: TestResult[] = [];
      // Filter flows for this platform
      const platformFlows = flows.filter((f) => {
        const fp = f.config.platforms;
        return !fp || fp.includes(platform);
      });

      for (const flow of platformFlows) {
        const result = await executeFlow(flow, driver, engineConfig);
        results.push(result);
      }
      return results;
    }),
  );

  const allResults = platformResults.flat();

  return {
    results: allResults,
    totalDurationMs: Date.now() - start,
    passed: allResults.filter((r) => r.status === "passed").length,
    failed: allResults.filter((r) => r.status === "failed").length,
    skipped: allResults.filter((r) => r.status === "skipped").length,
  };
}
