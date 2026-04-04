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
  onFlowComplete?: (result: TestResult, workerName: string) => void;
}

export interface ParallelResult {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  workerStats: Map<string, { flowCount: number; totalMs: number }>;
}

export async function runParallel(config: ParallelRunnerConfig): Promise<ParallelResult> {
  const { workers, flows, onFlowComplete } = config;
  const start = Date.now();
  const results: TestResult[] = [];
  let nextFlowIndex = 0;

  // Each worker pulls from the shared queue
  const workerPromises = workers.map(async (worker) => {
    const stats = { flowCount: 0, totalMs: 0 };

    while (true) {
      // Atomic: grab next flow index
      // Safe in single-threaded JS/Bun — no mutex needed (unlike Go).
      // Each worker awaits its flow before grabbing the next, so the
      // increment is naturally sequential.
      const flowIdx = nextFlowIndex++;
      if (flowIdx >= flows.length) break;

      const flow = flows[flowIdx]!;
      const result = await executeFlow(flow, worker.driver, worker.engineConfig);

      results.push(result);
      stats.flowCount++;
      stats.totalMs += result.durationMs;

      onFlowComplete?.(result, worker.name);
    }

    return { workerId: worker.id, stats };
  });

  const workerResults = await Promise.all(workerPromises);

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
    workerStats,
  };
}
