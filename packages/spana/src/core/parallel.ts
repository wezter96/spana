import type { FlowDefinition } from "../api/flow.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { executeFlow, type TestResult, type EngineConfig } from "./engine.js";
import { focusFlows, getFlowSkip } from "./runner.js";

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
  /** Optional dynamic cross-process queue claimer (used by `spana test --workers N --processes M`). */
  claimNextFlow?: () => Promise<FlowDefinition | null>;
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
    claimNextFlow,
  } = config;
  const orderedFlows = orderFlowsLongestFirst(focusFlows(rawFlows), durationHintsMs);
  // Group serial suites into indivisible work units so serial flows run in order on one worker
  // and skip the remaining flows in that serial suite after the first failure.
  type WorkUnit = FlowDefinition[];
  const workUnits: WorkUnit[] = [];
  if (!claimNextFlow) {
    const serialIndexByGroup = new Map<string, number>();
    for (const f of orderedFlows) {
      const sg = f.config.serialGroup;
      if (sg) {
        const existingIdx = serialIndexByGroup.get(sg);
        if (existingIdx !== undefined) {
          workUnits[existingIdx]!.push(f);
        } else {
          serialIndexByGroup.set(sg, workUnits.length);
          workUnits.push([f]);
        }
      } else {
        workUnits.push([f]);
      }
    }
  }
  const start = Date.now();
  const results: TestResult[] = [];
  let nextUnitIndex = 0;
  let failureCount = 0;
  let bailedOut = false;
  const workerOffset = Number.parseInt(process.env.SPANA_WORKER_INDEX_OFFSET ?? "0", 10) || 0;

  // Each worker pulls from the shared queue (local or cross-process HTTP work-stealing)
  const workerPromises = workers.map(async (worker, localIdx) => {
    const stats = { flowCount: 0, totalMs: 0 };
    const workerEngineConfig: EngineConfig = {
      ...worker.engineConfig,
      workerIndex: worker.engineConfig.workerIndex ?? workerOffset + localIdx,
      parallelIndex: worker.engineConfig.parallelIndex ?? localIdx,
    };

    const runOne = async (flow: FlowDefinition): Promise<TestResult> => {
      const skip = getFlowSkip(flow, workerEngineConfig.platform);
      if (skip) {
        results.push(skip);
        onFlowComplete?.(skip, worker.name);
        return skip;
      }
      const flowRetries = flow.config.retries ?? retries;
      onFlowStart?.(flow.name, worker.name);

      let result = await executeFlow(flow, worker.driver, workerEngineConfig);
      let attempts = 1;
      while (result.status === "failed" && attempts <= flowRetries) {
        if (retryDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }

        result = await executeFlow(flow, worker.driver, workerEngineConfig);
        attempts++;
      }

      if (result.status === "passed" && attempts > 1) {
        result.flaky = true;
      }
      result.attempts = attempts;

      results.push(result);
      stats.flowCount++;
      stats.totalMs += result.durationMs;

      if (result.status === "failed") {
        failureCount++;
      }

      onFlowComplete?.(result, worker.name);
      return result;
    };

    while (true) {
      // Check bail before picking up a new unit
      if (bail !== undefined && failureCount >= bail) break;

      if (claimNextFlow) {
        const claimed = await claimNextFlow();
        if (!claimed) break;
        await runOne(claimed);
        continue;
      }

      const unitIdx = nextUnitIndex++;
      if (unitIdx >= workUnits.length) break;
      const unit = workUnits[unitIdx]!;
      let serialFailed = false;
      for (const flow of unit) {
        if (serialFailed) {
          const skipped: TestResult = {
            name: flow.name,
            platform: workerEngineConfig.platform,
            status: "skipped",
            skipReason: "Skipped because an earlier flow in this serial suite failed",
            durationMs: 0,
            ...(flow.config.tags ? { tags: flow.config.tags } : {}),
            ...(flow.config.annotations ? { annotations: flow.config.annotations } : {}),
          };
          results.push(skipped);
          onFlowComplete?.(skipped, worker.name);
          continue;
        }
        if (bail !== undefined && failureCount >= bail) break;
        const res = await runOne(flow);
        if (res.status === "failed" && unit.length > 1) {
          serialFailed = true;
        }
      }
    }

    return { workerId: worker.id, stats };
  });

  const workerResults = await Promise.all(workerPromises);

  // Mark remaining un-processed flows as skipped if bailed out (local queue only)
  if (!claimNextFlow && bail !== undefined && failureCount >= bail) {
    bailedOut = true;
    while (nextUnitIndex < workUnits.length) {
      const unit = workUnits[nextUnitIndex++]!;
      for (const flow of unit) {
        results.push(
          getFlowSkip(flow, workers[0]!.engineConfig.platform) ?? {
            name: flow.name,
            platform: workers[0]!.engineConfig.platform,
            status: "skipped",
            durationMs: 0,
            attempts: 0,
            ...(flow.config.tags ? { tags: flow.config.tags } : {}),
          },
        );
      }
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
