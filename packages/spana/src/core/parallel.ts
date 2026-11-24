import type { FlowDefinition } from "../api/flow.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { executeFlow, type TestResult, type EngineConfig } from "./engine.js";

export interface DeviceWorkerConfig {
  id: string;
  name: string;
  driver: RawDriverService;
  engineConfig: EngineConfig;
}

export interface ParallelRunnerConfig {
  workers: DeviceWorkerConfig[];
  flows: FlowDefinition[];
  retries?: number;
  retryDelay?: number;
  bail?: number;
  /**
   * Flashwright-inspired longest-test-first scheduling: pass previous flow durations
   * (`flowName -> ms`) so slow flows start immediately on workers instead of straggling at the tail.
   */
  durationHintsMs?: Record<string, number>;
  onFlowStart?: (name: string, workerName: string) => void;
  onFlowComplete?: (result: TestResult, workerName: string) => void;
}

/** Order flows descending by known duration (longest first) while preserving order on ties. */
export function orderFlowsLongestFirst(
  flows: FlowDefinition[],
  durationHintsMs?: Record<string, number>,
): FlowDefinition[] {
  if (!durationHintsMs || Object.keys(durationHintsMs).length === 0) {
    return flows;
  }
  return flows.toSorted((a, b) => (durationHintsMs[b.name] ?? 0) - (durationHintsMs[a.name] ?? 0));
}

export interface ParallelResult {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  bailedOut?: boolean;
  workerStats: Map<string, { flowCount: number; totalMs: number }>;
}

export async function runParallel(config: ParallelRunnerConfig): Promise<ParallelResult> {
  const {
    workers,
    flows: rawFlows,
    onFlowComplete,
    onFlowStart,
    retries = 0,
    retryDelay = 0,
    bail,
    durationHintsMs,
  } = config;
  const flows = orderFlowsLongestFirst(rawFlows, durationHintsMs);
  const start = Date.now();
  const results: TestResult[] = [];
  let nextFlowIndex = 0;
  let failureCount = 0;
  let bailedOut = false;

  // Each worker pulls from the shared queue
  const workerPromises = workers.map(async (worker) => {
    const stats = { flowCount: 0, totalMs: 0 };

    while (true) {
      // Check bail before picking up a new flow
      if (bail !== undefined && failureCount >= bail) break;

      // Atomic: grab next flow index
      // Safe in single-threaded JS/Bun — no mutex needed (unlike Go).
      // Each worker awaits its flow before grabbing the next, so the
      // increment is naturally sequential.
      const flowIdx = nextFlowIndex++;
      if (flowIdx >= flows.length) break;

      const flow = flows[flowIdx]!;
      let result: TestResult | undefined;
      let attempts = 0;

      onFlowStart?.(flow.name, worker.name);

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0 && retryDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }

        result = await executeFlow(flow, worker.driver, worker.engineConfig);
        attempts++;

        if (result.status === "passed") break;
        // If still failing and more retries remain, continue loop
      }

      // Mark flaky if it eventually passed after failing
      if (result!.status === "passed" && attempts > 1) {
        result!.flaky = true;
      }
      result!.attempts = attempts;

      results.push(result!);
      stats.flowCount++;
      stats.totalMs += result!.durationMs;

      if (result!.status === "failed") {
        failureCount++;
      }

      onFlowComplete?.(result!, worker.name);
    }

    return { workerId: worker.id, stats };
  });

  const workerResults = await Promise.all(workerPromises);

  // Mark remaining un-processed flows as skipped if bailed out
  if (bail !== undefined && failureCount >= bail) {
    bailedOut = true;
    while (nextFlowIndex < flows.length) {
      const flow = flows[nextFlowIndex++]!;
      results.push({
        name: flow.name,
        platform: workers[0]!.engineConfig.platform,
        status: "skipped",
        durationMs: 0,
        attempts: 0,
      });
    }
  }

  const workerStats = new Map<string, { flowCount: number; totalMs: number }>();
  for (const wr of workerResults) {
    workerStats.set(wr.workerId, wr.stats);
  }

  return {
    results,
    totalDurationMs: Date.now() - start,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    flaky: results.filter((r) => r.flaky === true).length,
    bailedOut: bailedOut || undefined,
    workerStats,
  };
}
