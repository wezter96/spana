import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { TestResult } from "./engine.js";

export const DEFAULT_MAX_WORKERS_PER_PROCESS = 8;

export interface ProcessPartitionPlan {
  totalWorkers: number;
  maxWorkersPerProcess: number;
  processCount: number;
  workersPerProcess: number[];
}

/**
 * Plan how to split `totalWorkers` across OS processes.
 * - Up to `maxWorkersPerProcess` (default 8): 1 single in-process Bun event loop (zero IPC overhead).
 * - Above `maxWorkersPerProcess` (e.g. 16 or 32 workers on large CI boxes): evenly divides
 *   workers across `Math.ceil(totalWorkers / maxWorkersPerProcess)` OS processes so each
 *   process gets its own JS heap, GC, and event loop.
 */
export function planProcessPool(
  totalWorkers: number,
  maxWorkersPerProcess: number = DEFAULT_MAX_WORKERS_PER_PROCESS,
): ProcessPartitionPlan {
  const safeTotal = Math.max(1, Math.floor(totalWorkers));
  const safeMax = Math.max(1, Math.floor(maxWorkersPerProcess));
  if (safeTotal <= safeMax) {
    return {
      totalWorkers: safeTotal,
      maxWorkersPerProcess: safeMax,
      processCount: 1,
      workersPerProcess: [safeTotal],
    };
  }

  const processCount = Math.ceil(safeTotal / safeMax);
  const base = Math.floor(safeTotal / processCount);
  const remainder = safeTotal % processCount;
  const workersPerProcess = Array.from(
    { length: processCount },
    (_v, i) => base + (i < remainder ? 1 : 0),
  );

  return {
    totalWorkers: safeTotal,
    maxWorkersPerProcess: safeMax,
    processCount,
    workersPerProcess,
  };
}

/**
 * Partition flows across `processCount` buckets using Longest-Processing-Time-First (LPT)
 * bin packing when `durationHintsMs` are available so every child process finishes together.
 */
export function partitionFlowsAcrossProcesses<T>(
  items: T[],
  processCount: number,
  options?: {
    durationHintsMs?: Record<string, number>;
    getName?: (item: T) => string;
  },
): T[][] {
  const count = Math.max(1, Math.min(Math.floor(processCount), Math.max(1, items.length)));
  if (count === 1 || items.length === 0) {
    return items.length === 0 ? [] : [items];
  }

  const hints = options?.durationHintsMs;
  const getName = options?.getName;
  const known = hints ? Object.values(hints).filter((v) => typeof v === "number" && v > 0) : [];
  const defaultWeight = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1000;

  const indexed = items.map((item, idx) => ({
    item,
    idx,
    weight: hints && getName ? (hints[getName(item)] ?? defaultWeight) : 1000,
  }));

  const ordered =
    hints && getName && Object.keys(hints).length > 0
      ? indexed.toSorted((a, b) => b.weight - a.weight || a.idx - b.idx)
      : indexed;

  const loads = Array.from({ length: count }, () => 0);
  const buckets: Array<Array<{ item: T; idx: number }>> = Array.from({ length: count }, () => []);

  for (const entry of ordered) {
    let best = 0;
    for (let i = 1; i < count; i++) {
      if (loads[i]! < loads[best]!) best = i;
    }
    loads[best] = loads[best]! + entry.weight;
    buckets[best]!.push({ item: entry.item, idx: entry.idx });
  }

  return buckets
    .map((bucket) => bucket.toSorted((a, b) => a.idx - b.idx).map((e) => e.item))
    .filter((b) => b.length > 0);
}

export interface ProcessShardCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  reportJsonPath: string;
}

export interface ProcessShardOutcome {
  shardIndex: number;
  workerCount: number;
  exitCode: number | null;
  durationMs: number;
  results: TestResult[];
  error?: string;
}

export interface MultiProcessPoolOptions {
  totalWorkers: number;
  maxWorkersPerProcess?: number;
  buildShardCommand: (
    shardIndex: number,
    shardTotal: number,
    workerCount: number,
  ) => ProcessShardCommand;
  spawnFn?: typeof spawn;
  readReportFn?: (reportJsonPath: string) => TestResult[];
  cleanupReportFiles?: boolean;
}

export interface MultiProcessPoolResult {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  processCount: number;
  processResults: ProcessShardOutcome[];
}

function defaultReadJsonReport(reportJsonPath: string): TestResult[] {
  if (!existsSync(reportJsonPath)) return [];
  const raw = JSON.parse(readFileSync(reportJsonPath, "utf8")) as {
    results?: TestResult[];
  };
  return Array.isArray(raw.results) ? raw.results : [];
}

/**
 * Execute a high-concurrency suite (16–32+ workers) across multiple OS worker processes,
 * each running up to `maxWorkersPerProcess` in-process workers with its own JS heap & event loop.
 */
export async function runMultiProcessPool(
  options: MultiProcessPoolOptions,
): Promise<MultiProcessPoolResult> {
  const plan = planProcessPool(options.totalWorkers, options.maxWorkersPerProcess);
  const spawnFn = options.spawnFn ?? spawn;
  const readReport = options.readReportFn ?? defaultReadJsonReport;
  const shouldCleanup = options.cleanupReportFiles !== false;
  const startedAt = Date.now();

  const processResults = await Promise.all(
    plan.workersPerProcess.map(async (workerCount, shardIdx): Promise<ProcessShardOutcome> => {
      const shardStart = Date.now();
      const spec = options.buildShardCommand(shardIdx + 1, plan.processCount, workerCount);

      let exitCode: number | null = null;
      let spawnError: string | undefined;

      try {
        exitCode = await new Promise<number | null>((resolve, reject) => {
          const child = spawnFn(spec.command, spec.args, {
            env: { ...process.env, ...spec.env },
            stdio: "inherit",
          });
          child.on("error", reject);
          child.on("close", (code) => resolve(code));
        });
      } catch (err) {
        spawnError = err instanceof Error ? err.message : String(err);
      }

      let shardResults: TestResult[] = [];
      try {
        shardResults = readReport(spec.reportJsonPath);
      } catch (err) {
        if (!spawnError) {
          spawnError = `Failed to parse shard ${shardIdx + 1} report: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (shouldCleanup) {
        try {
          if (existsSync(spec.reportJsonPath)) unlinkSync(spec.reportJsonPath);
        } catch {
          // ignore cleanup failure
        }
      }

      if (exitCode !== 0 && shardResults.length === 0) {
        shardResults.push({
          name: `worker-process-${shardIdx + 1}`,
          platform: "web",
          status: "failed",
          durationMs: Date.now() - shardStart,
          error: {
            category: "driver-error",
            message:
              spawnError ??
              `Worker process ${shardIdx + 1} exited with code ${exitCode ?? "unknown"}`,
          },
        });
      }

      return {
        shardIndex: shardIdx + 1,
        workerCount,
        exitCode,
        durationMs: Date.now() - shardStart,
        results: shardResults,
        ...(spawnError ? { error: spawnError } : {}),
      };
    }),
  );

  const results = processResults.flatMap((p) => p.results);
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const flaky = results.filter((r) => r.flaky).length;

  return {
    results,
    totalDurationMs: Date.now() - startedAt,
    passed,
    failed,
    skipped,
    flaky,
    processCount: plan.processCount,
    processResults,
  };
}
