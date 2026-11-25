import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_MAX_WORKERS_PER_PROCESS,
  partitionFlowsAcrossProcesses,
  planProcessPool,
  runMultiProcessPool,
} from "./worker-pool.js";
import type { TestResult } from "./engine.js";

describe("worker-pool (hybrid multi-process × in-process)", () => {
  it("keeps <= maxWorkersPerProcess in 1 single Bun process and shards > maxWorkersPerProcess evenly", () => {
    expect(DEFAULT_MAX_WORKERS_PER_PROCESS).toBe(8);

    expect(planProcessPool(1)).toEqual({
      totalWorkers: 1,
      maxWorkersPerProcess: 8,
      processCount: 1,
      workersPerProcess: [1],
    });
    expect(planProcessPool(4)).toEqual({
      totalWorkers: 4,
      maxWorkersPerProcess: 8,
      processCount: 1,
      workersPerProcess: [4],
    });
    expect(planProcessPool(8)).toEqual({
      totalWorkers: 8,
      maxWorkersPerProcess: 8,
      processCount: 1,
      workersPerProcess: [8],
    });
    expect(planProcessPool(16)).toEqual({
      totalWorkers: 16,
      maxWorkersPerProcess: 8,
      processCount: 2,
      workersPerProcess: [8, 8],
    });
    expect(planProcessPool(18)).toEqual({
      totalWorkers: 18,
      maxWorkersPerProcess: 8,
      processCount: 3,
      workersPerProcess: [6, 6, 6],
    });
    expect(planProcessPool(32)).toEqual({
      totalWorkers: 32,
      maxWorkersPerProcess: 8,
      processCount: 4,
      workersPerProcess: [8, 8, 8, 8],
    });
    expect(planProcessPool(10, 4)).toEqual({
      totalWorkers: 10,
      maxWorkersPerProcess: 4,
      processCount: 3,
      workersPerProcess: [4, 3, 3],
    });
  });

  it("partitions flows across processes with LPT duration balancing", () => {
    const flows = [
      { name: "slow-1" }, // 10s
      { name: "slow-2" }, // 9s
      { name: "med-1" }, // 5s
      { name: "med-2" }, // 4s
      { name: "fast-1" }, // 2s
      { name: "fast-2" }, // 1s
    ];
    const hints: Record<string, number> = {
      "slow-1": 10_000,
      "slow-2": 9_000,
      "med-1": 5_000,
      "med-2": 4_000,
      "fast-1": 2_000,
      "fast-2": 1_000,
    };

    const buckets = partitionFlowsAcrossProcesses(flows, 2, {
      durationHintsMs: hints,
      getName: (f) => f.name,
    });
    expect(buckets).toHaveLength(2);

    const loads = buckets.map((b) => b.reduce((sum, f) => sum + (hints[f.name] ?? 0), 0));
    // Optimal 2-way LPT split: [10+4+2 = 16s] vs [9+5+1 = 15s]
    expect(Math.abs(loads[0]! - loads[1]!)).toBeLessThanOrEqual(2000);
    expect(buckets.flat()).toHaveLength(flows.length);
  });

  it("spawns child worker processes, merges JSON reports, and records synthetic failure on crash", async () => {
    const reportsByPath = new Map<string, TestResult[]>([
      [
        "/tmp/shard-1.json",
        [
          { name: "flow-a", platform: "web", status: "passed", durationMs: 120 },
          { name: "flow-b", platform: "web", status: "passed", durationMs: 150 },
        ],
      ],
      [
        "/tmp/shard-2.json",
        [
          {
            name: "flow-c",
            platform: "web",
            status: "failed",
            durationMs: 200,
            error: { category: "driver-error", message: "boom" },
          },
        ],
      ],
      [
        "/tmp/shard-3.json",
        [{ name: "flow-d", platform: "web", status: "passed", durationMs: 90, flaky: true }],
      ],
      // shard-4 crashes with non-zero exit code and no report
    ]);

    const spawned: Array<{ cmd: string; args: string[] }> = [];

    const outcome = await runMultiProcessPool({
      totalWorkers: 32,
      maxWorkersPerProcess: 8,
      cleanupReportFiles: false,
      buildShardCommand: (shardIndex, shardTotal, workerCount) => ({
        command: "bun",
        args: [
          "spana",
          "test",
          "--shard",
          `${shardIndex}/${shardTotal}`,
          "--workers",
          String(workerCount),
        ],
        reportJsonPath: `/tmp/shard-${shardIndex}.json`,
      }),
      spawnFn: ((cmd: string, args: string[]) => {
        spawned.push({ cmd, args });
        const ee = new EventEmitter() as ChildProcess;
        const isShard4 = args.includes("4/4");
        setImmediate(() => ee.emit("close", isShard4 ? 1 : 0));
        return ee;
      }) as any,
      readReportFn: (path) => reportsByPath.get(path) ?? [],
    });

    expect(outcome.processCount).toBe(4);
    expect(spawned).toHaveLength(4);
    expect(outcome.passed).toBe(3);
    expect(outcome.failed).toBe(2); // flow-c + synthetic crash failure for shard-4
    expect(outcome.flaky).toBe(1);
    expect(
      outcome.results.some((r) => r.name === "worker-process-4" && r.status === "failed"),
    ).toBe(true);
  });
});
