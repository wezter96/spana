import type { RawDriverService } from "../drivers/raw-driver.js";
import type { FlowDefinition } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";
import { executeFlow, type TestResult, type EngineConfig } from "./engine.js";

export interface PlatformConfig {
  platform: Platform;
  driver: RawDriverService;
  engineConfig: EngineConfig;
}

export interface OrchestrateOptions {
  retries?: number;
  bail?: number;
}

export interface OrchestratorResult {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  bailedOut?: boolean;
  bailLimit?: number;
}

export async function orchestrate(
  flows: FlowDefinition[],
  platforms: PlatformConfig[],
  options?: OrchestrateOptions,
): Promise<OrchestratorResult> {
  const start = Date.now();
  const retries = options?.retries ?? 0;
  const bail = options?.bail;
  let failureCount = 0;
  let bailedOut = false;

  const shouldBail = () => bail !== undefined && failureCount >= bail;

  const noteFailure = (count = 1) => {
    failureCount += count;
    if (shouldBail()) {
      bailedOut = true;
    }
  };

  // Run all platforms in parallel, flows serial within each
  const platformResults = await Promise.all(
    platforms.map(async ({ platform, driver, engineConfig }) => {
      const results: TestResult[] = [];
      // Filter flows for this platform
      const platformFlows = flows.filter((f) => {
        const fp = f.config.platforms;
        return !fp || fp.includes(platform);
      });

      // beforeAll hook
      const hooks = engineConfig.hooks;
      if (hooks?.beforeAll) {
        try {
          await hooks.beforeAll({ app: undefined, platform } as any);
        } catch (error) {
          for (const flow of platformFlows) {
            results.push({
              name: flow.name,
              platform,
              status: "failed",
              durationMs: 0,
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }
          noteFailure(platformFlows.length);
          return results;
        }
      }

      for (let index = 0; index < platformFlows.length; index++) {
        const flow = platformFlows[index]!;
        if (shouldBail()) {
          bailedOut = true;
          for (const skippedFlow of platformFlows.slice(index)) {
            results.push({
              name: skippedFlow.name,
              platform,
              status: "skipped",
              durationMs: 0,
            });
          }
          break;
        }

        let result = await executeFlow(flow, driver, engineConfig);
        let attempts = 1;

        // Retry failed flows
        if (result.status === "failed" && retries > 0) {
          for (let retry = 0; retry < retries; retry++) {
            if (shouldBail()) {
              bailedOut = true;
              break;
            }
            const retryResult = await executeFlow(flow, driver, engineConfig);
            attempts++;
            if (retryResult.status === "passed") {
              // Passed on retry — mark as flaky
              result = { ...retryResult, flaky: true, attempts };
              break;
            }
            // Still failing — keep the latest result
            result = { ...retryResult, attempts };
          }
          // If never passed, mark attempts on the final failure
          if (result.status === "failed") {
            result = { ...result, attempts };
          }
        }

        results.push(result);
        if (result.status === "failed") {
          noteFailure();
        }
      }

      // afterAll hook
      if (hooks?.afterAll) {
        try {
          await hooks.afterAll({ app: undefined, platform, summary: { results } } as any);
        } catch (hookError) {
          console.warn(
            `afterAll hook failed: ${hookError instanceof Error ? hookError.message : hookError}`,
          );
        }
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
    flaky: allResults.filter((r) => r.flaky).length,
    bailedOut,
    bailLimit: bail,
  };
}
