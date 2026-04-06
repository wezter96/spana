import type { RawDriverService } from "../drivers/raw-driver.js";
import type { FlowDefinition } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";
import { executeFlow, type TestResult, type EngineConfig } from "./engine.js";
import { classifyError } from "../report/classify-error.js";
import { runParallel, type DeviceWorkerConfig } from "./parallel.js";

export interface PlatformConfig {
  platform: Platform;
  driver: RawDriverService;
  engineConfig: EngineConfig;
  /** Additional workers for parallel execution within this platform. */
  additionalWorkers?: DeviceWorkerConfig[];
}

export interface OrchestrateOptions {
  retries?: number;
  /** Delay in ms between retry attempts. Default: 0 (immediate). */
  retryDelay?: number;
  bail?: number;
  /** Run platforms concurrently instead of serially. Default: false. */
  parallelPlatforms?: boolean;
  /** Called before each flow starts executing. */
  onFlowStart?: (name: string, platform: Platform, workerName?: string) => void;
  /** Called after each flow finishes (pass, fail, or skip). */
  onResult?: (result: TestResult) => void;
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
  workerStats?: Map<string, { flowCount: number; totalMs: number }>;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPlatform(
  flows: FlowDefinition[],
  platformConfig: PlatformConfig,
  options: OrchestrateOptions | undefined,
  shouldBail: () => boolean,
  noteFailure: (count?: number) => void,
): Promise<{
  results: TestResult[];
  workerStats?: Map<string, { flowCount: number; totalMs: number }>;
}> {
  const { platform, driver, engineConfig } = platformConfig;
  const retries = options?.retries ?? 0;
  const retryDelay = options?.retryDelay ?? 0;
  const results: TestResult[] = [];

  const platformFlows = flows.filter((f) => {
    const fp = f.config.platforms;
    return !fp || fp.includes(platform);
  });

  if (shouldBail()) {
    for (const flow of platformFlows) {
      results.push({ name: flow.name, platform, status: "skipped", durationMs: 0 });
    }
    return { results };
  }

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
          error: classifyError(error instanceof Error ? error : new Error(String(error))),
        });
      }
      noteFailure(platformFlows.length);
      return { results };
    }
  }

  // If we have multiple workers, delegate to parallel runner
  if (platformConfig.additionalWorkers && platformConfig.additionalWorkers.length > 0) {
    const allWorkers: DeviceWorkerConfig[] = [
      {
        id: `${platform}-primary`,
        name: platform,
        driver,
        engineConfig,
      },
      ...platformConfig.additionalWorkers,
    ];

    const parallelResult = await runParallel({
      workers: allWorkers,
      flows: platformFlows,
      retries: options?.retries ?? 0,
      retryDelay: options?.retryDelay ?? 0,
      bail: options?.bail,
      onFlowStart: (name, workerName) => {
        options?.onFlowStart?.(name, platform, workerName);
      },
      onFlowComplete: (result, workerName) => {
        const resultWithWorker = { ...result, workerName };
        options?.onResult?.(resultWithWorker);
        if (result.status === "failed") noteFailure();
      },
    });

    // Run afterAll hook
    if (hooks?.afterAll) {
      try {
        await hooks.afterAll({
          app: undefined,
          platform,
          summary: { results: parallelResult.results },
        } as any);
      } catch (hookError) {
        console.warn(
          `afterAll hook failed: ${hookError instanceof Error ? hookError.message : hookError}`,
        );
      }
    }

    return { results: parallelResult.results, workerStats: parallelResult.workerStats };
  }

  for (let index = 0; index < platformFlows.length; index++) {
    const flow = platformFlows[index]!;
    if (shouldBail()) {
      for (const skippedFlow of platformFlows.slice(index)) {
        results.push({ name: skippedFlow.name, platform, status: "skipped", durationMs: 0 });
      }
      break;
    }

    options?.onFlowStart?.(flow.name, platform);
    let result = await executeFlow(flow, driver, engineConfig);
    let attempts = 1;

    if (result.status === "failed" && retries > 0) {
      for (let retry = 0; retry < retries; retry++) {
        if (shouldBail()) break;
        await sleep(retryDelay);
        const retryResult = await executeFlow(flow, driver, engineConfig);
        attempts++;
        if (retryResult.status === "passed") {
          result = { ...retryResult, flaky: true, attempts };
          break;
        }
        result = { ...retryResult, attempts };
      }
      if (result.status === "failed") {
        result = { ...result, attempts };
      }
    }

    results.push(result);
    options?.onResult?.(result);
    if (result.status === "failed") {
      noteFailure();
    }
  }

  if (hooks?.afterAll) {
    try {
      await hooks.afterAll({ app: undefined, platform, summary: { results } } as any);
    } catch (hookError) {
      console.warn(
        `afterAll hook failed: ${hookError instanceof Error ? hookError.message : hookError}`,
      );
    }
  }

  return { results };
}

export async function orchestrate(
  flows: FlowDefinition[],
  platforms: PlatformConfig[],
  options?: OrchestrateOptions,
): Promise<OrchestratorResult> {
  const start = Date.now();
  const bail = options?.bail;
  let failureCount = 0;
  let bailedOut = false;

  const shouldBail = () => {
    if (bail !== undefined && failureCount >= bail) {
      bailedOut = true;
      return true;
    }
    return false;
  };

  const noteFailure = (count = 1) => {
    failureCount += count;
  };

  let platformResults: {
    results: TestResult[];
    workerStats?: Map<string, { flowCount: number; totalMs: number }>;
  }[];

  if (options?.parallelPlatforms && platforms.length > 1) {
    // Run all platforms concurrently
    platformResults = await Promise.all(
      platforms.map((pc) => runPlatform(flows, pc, options, shouldBail, noteFailure)),
    );
  } else {
    // Run platforms serially so each runtime has exclusive access to its
    // simulator/emulator/browser resources.
    platformResults = [];
    for (const pc of platforms) {
      const pr = await runPlatform(flows, pc, options, shouldBail, noteFailure);
      platformResults.push(pr);
    }
  }

  const allResults = platformResults.flatMap((pr) => pr.results);

  const allWorkerStats = new Map<string, { flowCount: number; totalMs: number }>();
  for (const pr of platformResults) {
    if (pr.workerStats) {
      for (const [id, stats] of pr.workerStats) {
        allWorkerStats.set(id, stats);
      }
    }
  }

  return {
    results: allResults,
    totalDurationMs: Date.now() - start,
    passed: allResults.filter((r) => r.status === "passed").length,
    failed: allResults.filter((r) => r.status === "failed").length,
    skipped: allResults.filter((r) => r.status === "skipped").length,
    flaky: allResults.filter((r) => r.flaky).length,
    bailedOut,
    bailLimit: bail,
    workerStats: allWorkerStats.size > 0 ? allWorkerStats : undefined,
  };
}
