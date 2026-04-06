# Phase 6: Parallel Execution & Runner UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `--parallel` into `spana test` so it auto-discovers devices, builds one runtime per device, runs platforms concurrently, and distributes flows via work-stealing queue with device-aware console output.

**Architecture:** The `--parallel` flag triggers multi-device discovery per platform. Each mobile device gets its own runtime. The orchestrator delegates multi-worker platforms to `runParallel()`. The console reporter prefixes output with device names and prints worker stats at the end.

**Tech Stack:** TypeScript, Bun test runner, Effect library for driver operations.

---

## File Map

| File                            | Action | Responsibility                                                  |
| ------------------------------- | ------ | --------------------------------------------------------------- |
| `src/core/parallel.ts`          | Modify | Add retries, retryDelay, bail, onFlowStart, flaky detection     |
| `src/core/parallel.test.ts`     | Modify | Tests for new parallel runner features                          |
| `src/core/orchestrator.ts`      | Modify | Accept multi-worker platform configs, delegate to runParallel   |
| `src/core/orchestrator.test.ts` | Modify | Tests for multi-worker delegation                               |
| `src/report/types.ts`           | Modify | Add workerName to Reporter callbacks, workerStats to RunSummary |
| `src/report/console.ts`         | Modify | Device-prefixed output, worker stats table, single-device hint  |
| `src/report/console.test.ts`    | Modify | Tests for new console output formatting                         |
| `src/cli/index.ts`              | Modify | Parse `--parallel` flag                                         |
| `src/cli/test-command.ts`       | Modify | Multi-device runtime setup, pass parallel config through        |
| `src/cli/test-command.test.ts`  | Modify | Tests for --parallel flag handling                              |

---

### Task 1: Upgrade parallel runner with retries, bail, and onFlowStart

**Files:**

- Modify: `packages/spana/src/core/parallel.ts`
- Test: `packages/spana/src/core/parallel.test.ts`

- [ ] **Step 1: Write failing tests for retries and flaky detection**

Add to `packages/spana/src/core/parallel.test.ts`:

```typescript
test("retries failed flows on the same worker and marks flaky", async () => {
  const callCounts = new Map<string, number>();

  const flakyFlow: FlowDefinition = {
    name: "flaky",
    config: {},
    fn: async () => {
      const count = (callCounts.get("flaky") ?? 0) + 1;
      callCounts.set("flaky", count);
      if (count <= 1) throw new Error("first attempt fails");
    },
  };

  const result = await runParallel({
    workers: [
      {
        id: "worker-a",
        name: "Pixel 8",
        driver: createDriver("worker-a"),
        engineConfig: {
          appId: "com.example",
          platform: "android",
          autoLaunch: false,
          coordinatorConfig: {
            parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
          },
        },
      },
    ],
    flows: [flakyFlow],
    retries: 2,
  });

  expect(result.results).toHaveLength(1);
  expect(result.results[0]!.status).toBe("passed");
  expect(result.results[0]!.flaky).toBe(true);
  expect(result.results[0]!.attempts).toBe(2);
  expect(result.flaky).toBe(1);
});

test("bail stops workers from picking up new flows", async () => {
  const result = await runParallel({
    workers: [
      {
        id: "worker-a",
        name: "Pixel 8",
        driver: createDriver("worker-a"),
        engineConfig: {
          appId: "com.example",
          platform: "android",
          autoLaunch: false,
          coordinatorConfig: {
            parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
          },
        },
      },
    ],
    flows: [createFlow("fail-1", true), createFlow("fail-2", true), createFlow("should-skip")],
    bail: 1,
  });

  expect(result.bailedOut).toBe(true);
  expect(result.failed).toBe(1);
  // Remaining flows skipped after bail
  expect(result.results.filter((r) => r.status === "skipped").length).toBeGreaterThanOrEqual(1);
});

test("onFlowStart is called before each flow", async () => {
  const starts: Array<{ name: string; workerName: string }> = [];

  await runParallel({
    workers: [
      {
        id: "worker-a",
        name: "Pixel 8",
        driver: createDriver("worker-a"),
        engineConfig: {
          appId: "com.example",
          platform: "android",
          autoLaunch: false,
          coordinatorConfig: {
            parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
          },
        },
      },
    ],
    flows: [createFlow("alpha"), createFlow("beta")],
    onFlowStart: (name, workerName) => {
      starts.push({ name, workerName });
    },
  });

  expect(starts).toHaveLength(2);
  expect(starts[0]!.name).toBe("alpha");
  expect(starts[0]!.workerName).toBe("Pixel 8");
});

test("retryDelay adds delay between retry attempts", async () => {
  let callCount = 0;
  const timestamps: number[] = [];

  const flakyFlow: FlowDefinition = {
    name: "delayed-retry",
    config: {},
    fn: async () => {
      timestamps.push(Date.now());
      callCount++;
      if (callCount <= 1) throw new Error("fails first");
    },
  };

  await runParallel({
    workers: [
      {
        id: "worker-a",
        name: "Pixel 8",
        driver: createDriver("worker-a"),
        engineConfig: {
          appId: "com.example",
          platform: "android",
          autoLaunch: false,
          coordinatorConfig: {
            parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
          },
        },
      },
    ],
    flows: [flakyFlow],
    retries: 1,
    retryDelay: 50,
  });

  expect(timestamps).toHaveLength(2);
  expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(40);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/spana/src/core/parallel.test.ts`
Expected: FAIL — `retries`, `bail`, `onFlowStart`, `retryDelay` not recognized by `runParallel`.

- [ ] **Step 3: Implement parallel runner upgrades**

Replace `packages/spana/src/core/parallel.ts` with:

```typescript
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
  onFlowStart?: (name: string, workerName: string) => void;
  onFlowComplete?: (result: TestResult, workerName: string) => void;
}

export interface ParallelResult {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  workerStats: Map<string, { flowCount: number; totalMs: number }>;
  bailedOut?: boolean;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runParallel(config: ParallelRunnerConfig): Promise<ParallelResult> {
  const { workers, flows, onFlowStart, onFlowComplete } = config;
  const retries = config.retries ?? 0;
  const retryDelay = config.retryDelay ?? 0;
  const bail = config.bail;
  const start = Date.now();
  const results: TestResult[] = [];
  let nextFlowIndex = 0;
  let failureCount = 0;
  let bailedOut = false;

  const shouldBail = () => {
    if (bail !== undefined && failureCount >= bail) {
      bailedOut = true;
      return true;
    }
    return false;
  };

  const workerPromises = workers.map(async (worker) => {
    const stats = { flowCount: 0, totalMs: 0 };

    while (true) {
      if (shouldBail()) break;

      const flowIdx = nextFlowIndex++;
      if (flowIdx >= flows.length) break;

      const flow = flows[flowIdx]!;
      onFlowStart?.(flow.name, worker.name);

      let result = await executeFlow(flow, worker.driver, worker.engineConfig);
      let attempts = 1;

      if (result.status === "failed" && retries > 0) {
        for (let retry = 0; retry < retries; retry++) {
          if (shouldBail()) break;
          await sleep(retryDelay);
          const retryResult = await executeFlow(flow, worker.driver, worker.engineConfig);
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
      stats.flowCount++;
      stats.totalMs += result.durationMs;

      if (result.status === "failed") {
        failureCount++;
      }

      onFlowComplete?.(result, worker.name);
    }

    return { workerId: worker.id, stats };
  });

  const workerResults = await Promise.all(workerPromises);

  // If bailed out, mark remaining unexecuted flows as skipped
  if (bailedOut) {
    const executedNames = new Set(results.map((r) => r.name));
    for (const flow of flows) {
      if (!executedNames.has(flow.name)) {
        results.push({
          name: flow.name,
          platform: workers[0]!.engineConfig.platform,
          status: "skipped",
          durationMs: 0,
        });
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
    flaky: results.filter((r) => r.flaky).length,
    workerStats,
    bailedOut,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/spana/src/core/parallel.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/core/parallel.ts packages/spana/src/core/parallel.test.ts
git commit -m "feat(parallel): add retries, bail, retryDelay, onFlowStart, and flaky detection"
```

---

### Task 2: Update reporter types for worker-aware callbacks

**Files:**

- Modify: `packages/spana/src/report/types.ts`

- [ ] **Step 1: Add workerName and workerStats to reporter types**

In `packages/spana/src/report/types.ts`, update:

```typescript
// Add workerName to FlowResult (after scenarioSteps field, line 57)
export interface FlowResult {
  name: string;
  platform: Platform;
  status: "passed" | "failed" | "skipped";
  flaky?: boolean;
  attempts?: number;
  durationMs: number;
  error?: FlowError;
  attachments?: Attachment[];
  steps?: StepResult[];
  scenarioSteps?: ScenarioStepResult[];
  /** Device/worker name when running in parallel mode. */
  workerName?: string;
}

// Add workerStats to RunSummary (after bailLimit field, line 70)
export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  results: FlowResult[];
  platforms: Platform[];
  bailedOut?: boolean;
  bailLimit?: number;
  /** Per-worker execution stats (parallel mode only). */
  workerStats?: Map<string, { flowCount: number; totalMs: number }>;
}

// Add workerName to Reporter callbacks
export interface Reporter {
  onFlowStart?(name: string, platform: Platform, workerName?: string): void;
  onFlowPass?(result: FlowResult): void;
  onFlowFail?(result: FlowResult): void;
  onRunComplete(summary: RunSummary): void;
  /** Total number of flows to run (for progress display). */
  flowCount?: number;
}
```

- [ ] **Step 2: Run full test suite to check for type errors**

Run: `bun test packages/spana/src/`
Expected: All tests PASS (new fields are optional, no breaking changes).

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/report/types.ts
git commit -m "feat(types): add workerName and workerStats to reporter interfaces"
```

---

### Task 3: Upgrade console reporter for device-aware output

**Files:**

- Modify: `packages/spana/src/report/console.ts`
- Test: `packages/spana/src/report/console.test.ts`

- [ ] **Step 1: Write failing tests for device-prefixed output**

Add to `packages/spana/src/report/console.test.ts`:

```typescript
test("prefixes output with worker name in parallel mode", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));

  const reporter = createConsoleReporter();
  reporter.flowCount = 2;

  reporter.onFlowStart?.("Login", "android", "Pixel 8");
  reporter.onFlowPass?.({
    name: "Login",
    platform: "android",
    status: "passed",
    durationMs: 1234,
    workerName: "Pixel 8",
  });

  console.log = originalLog;

  const passLine = lines.find((l) => l.includes("Login") && l.includes("✓"));
  expect(passLine).toBeDefined();
  expect(passLine).toContain("[Pixel 8]");
});

test("omits worker prefix when workerName is absent", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));

  const reporter = createConsoleReporter();
  reporter.flowCount = 1;

  reporter.onFlowStart?.("Login", "android");
  reporter.onFlowPass?.({
    name: "Login",
    platform: "android",
    status: "passed",
    durationMs: 1234,
  });

  console.log = originalLog;

  const passLine = lines.find((l) => l.includes("Login") && l.includes("✓"));
  expect(passLine).toBeDefined();
  expect(passLine).not.toContain("[Pixel");
});

test("prints worker stats in summary when workerStats present", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));

  const reporter = createConsoleReporter();
  reporter.onRunComplete({
    total: 4,
    passed: 4,
    failed: 0,
    skipped: 0,
    flaky: 0,
    durationMs: 5000,
    results: [
      { name: "a", platform: "android", status: "passed", durationMs: 1000, workerName: "Pixel 7" },
      { name: "b", platform: "android", status: "passed", durationMs: 2000, workerName: "Pixel 7" },
      { name: "c", platform: "android", status: "passed", durationMs: 1500, workerName: "Pixel 8" },
      { name: "d", platform: "android", status: "passed", durationMs: 500, workerName: "Pixel 8" },
    ],
    platforms: ["android"],
    workerStats: new Map([
      ["pixel-7", { flowCount: 2, totalMs: 3000 }],
      ["pixel-8", { flowCount: 2, totalMs: 2000 }],
    ]),
  });

  console.log = originalLog;

  const statsHeader = lines.find((l) => l.includes("Worker Stats"));
  expect(statsHeader).toBeDefined();
  const pixel7Line = lines.find((l) => l.includes("pixel-7"));
  expect(pixel7Line).toContain("2 flows");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/spana/src/report/console.test.ts`
Expected: FAIL — `onFlowStart` doesn't accept 3 args, no worker prefix logic, no worker stats.

- [ ] **Step 3: Implement device-aware console reporter**

Replace `packages/spana/src/report/console.ts` with:

```typescript
import type { Platform } from "../schemas/selector.js";
import type { FlowResult, Reporter, RunSummary, ScenarioStepResult } from "./types.js";

export interface ConsoleReporterOptions {
  /** Only show failures and the final summary. */
  quiet?: boolean;
}

function printResultAttachments(result: FlowResult): void {
  for (const attachment of result.attachments ?? []) {
    console.log(`    ↳ ${attachment.name}: ${attachment.path}`);
  }

  for (const [index, step] of (result.steps ?? []).entries()) {
    for (const attachment of step.attachments ?? []) {
      console.log(`    ↳ step ${index + 1} ${step.command}: ${attachment.path}`);
    }
  }
}

function printScenarioSteps(steps: ScenarioStepResult[]): void {
  for (const step of steps) {
    const icon = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : "○";
    const duration = step.durationMs > 0 ? ` (${step.durationMs}ms)` : "";
    console.log(`      ${icon} ${step.keyword} ${step.text}${duration}`);
    if (step.error) {
      console.log(`        ${step.error}`);
    }
  }
}

const driverNames: Record<Platform, string> = {
  web: "Playwright",
  android: "UiAutomator2",
  ios: "WebDriverAgent",
};

export function createConsoleReporter(options?: ConsoleReporterOptions): Reporter {
  const quiet = options?.quiet ?? false;
  let completed = 0;
  let total = 0;
  let currentPlatform: Platform | undefined;

  function progressPrefix(): string {
    return total > 0 ? `[${completed}/${total}]` : "";
  }

  function workerPrefix(workerName?: string): string {
    return workerName ? `[${workerName}] ` : "";
  }

  return {
    onFlowStart(name, platform, workerName?) {
      if (quiet) return;

      if (platform !== currentPlatform) {
        currentPlatform = platform;
        console.log(`\n  ${platform} (${driverNames[platform]})`);
      }

      if (process.stderr.isTTY) {
        process.stderr.write(`  ▸ ${workerPrefix(workerName)}${progressPrefix()} ${name}...\r`);
      }
    },

    onFlowPass(result) {
      completed++;
      if (quiet) return;

      if (process.stderr.isTTY) {
        process.stderr.write("\x1b[2K");
      }

      const duration = `(${result.durationMs}ms)`;
      const flakyTag = result.flaky ? ` [flaky, passed on attempt ${result.attempts}]` : "";
      const wp = workerPrefix(result.workerName);
      console.log(`  ✓ ${wp}${progressPrefix()} ${result.name} ${duration}${flakyTag}`);
      if (result.scenarioSteps) printScenarioSteps(result.scenarioSteps);
      printResultAttachments(result);
    },

    onFlowFail(result) {
      completed++;

      if (process.stderr.isTTY) {
        process.stderr.write("\x1b[2K");
      }

      const duration = `(${result.durationMs}ms)`;
      const wp = workerPrefix(result.workerName);
      console.log(`  ✗ ${wp}${progressPrefix()} [${result.platform}] ${result.name} ${duration}`);
      if (result.scenarioSteps) printScenarioSteps(result.scenarioSteps);
      printResultAttachments(result);
    },

    onRunComplete(summary: RunSummary) {
      console.log("");

      // Group results by platform
      const byPlatform = new Map<Platform, FlowResult[]>();
      for (const r of summary.results) {
        const list = byPlatform.get(r.platform) ?? [];
        list.push(r);
        byPlatform.set(r.platform, list);
      }

      for (const [platform, results] of byPlatform) {
        const passed = results.filter((r) => r.status === "passed").length;
        const totalCount = results.length;
        const symbols = results
          .map((r) => (r.flaky ? "~" : r.status === "passed" ? "✓" : "✗"))
          .join("");
        const label = `${platform} (${driverNames[platform]})`;
        const duration = Math.max(...results.map((r) => r.durationMs));
        console.log(
          `${label.padEnd(25)} ${symbols}  ${passed}/${totalCount} passed (${(duration / 1000).toFixed(1)}s)`,
        );
      }

      // Failures detail with suggestions
      const failures = summary.results.filter((r) => r.status === "failed");
      if (failures.length > 0) {
        console.log("\n--- Failures ---");
        for (const f of failures) {
          const wp = f.workerName ? ` on ${f.workerName}` : "";
          console.log(`✗ [${f.platform}${wp}] ${f.name}`);
          if (f.error) {
            console.log(`  ${f.error.message}`);
            if (f.error.suggestion) {
              for (const line of f.error.suggestion.split("\n")) {
                console.log(`  💡 ${line}`);
              }
            }
          }
        }
      }

      // Flaky detail
      const flakyResults = summary.results.filter((r) => r.flaky);
      if (flakyResults.length > 0) {
        console.log("\n--- Flaky ---");
        for (const f of flakyResults) {
          console.log(`~ [${f.platform}] ${f.name} (passed on attempt ${f.attempts})`);
        }
      }

      // Worker stats (parallel mode)
      if (summary.workerStats && summary.workerStats.size > 0) {
        console.log("\nWorker Stats:");
        for (const [id, stats] of summary.workerStats) {
          console.log(`  [${id}]  ${stats.flowCount} flows  ${(stats.totalMs / 1000).toFixed(1)}s`);
        }
      }

      if (summary.bailedOut) {
        console.log(
          `\nBailed out after ${summary.failed} failure(s)${
            summary.bailLimit ? ` (limit: ${summary.bailLimit})` : ""
          }.`,
        );
      }

      // Final summary
      const flakyStr = summary.flaky > 0 ? `, ${summary.flaky} flaky` : "";
      console.log(
        `\n${summary.passed}/${summary.total} passed, ${summary.failed} failed${flakyStr} (${(summary.durationMs / 1000).toFixed(1)}s)`,
      );
    },

    set flowCount(n: number) {
      total = n;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/spana/src/report/console.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/report/console.ts packages/spana/src/report/console.test.ts
git commit -m "feat(console): device-prefixed output and worker stats in summary"
```

---

### Task 4: Wire multi-worker into orchestrator

**Files:**

- Modify: `packages/spana/src/core/orchestrator.ts`
- Test: `packages/spana/src/core/orchestrator.test.ts`

- [ ] **Step 1: Write failing test for multi-worker delegation**

Add to `packages/spana/src/core/orchestrator.test.ts`:

```typescript
test("delegates to runParallel when additionalWorkers provided", async () => {
  const workerFlows: string[] = [];

  const flow: FlowDefinition = {
    name: "parallel-worker-test",
    config: {},
    fn: async ({ app }) => {
      workerFlows.push("executed");
      await app.inputText("test");
    },
  };

  const result = await orchestrate(
    [flow, createFlow("second"), createFlow("third")],
    [
      {
        platform: "android",
        driver: createDriver("android"),
        engineConfig: {
          appId: "com.example",
          platform: "android",
          autoLaunch: false,
          coordinatorConfig: {
            parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
          },
        },
        additionalWorkers: [
          {
            id: "worker-b",
            name: "Pixel 8",
            driver: createDriver("android"),
            engineConfig: {
              appId: "com.example",
              platform: "android",
              autoLaunch: false,
              coordinatorConfig: {
                parse: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, children: [] }),
              },
            },
          },
        ],
      },
    ],
  );

  expect(result.results).toHaveLength(3);
  expect(result.passed).toBe(3);
  // workerStats should be present from parallel execution
  expect(result.workerStats).toBeDefined();
  expect(result.workerStats!.size).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/spana/src/core/orchestrator.test.ts`
Expected: FAIL — `additionalWorkers` and `workerStats` not recognized.

- [ ] **Step 3: Update orchestrator to support multi-worker platforms**

In `packages/spana/src/core/orchestrator.ts`:

Add import at top:

```typescript
import { runParallel, type DeviceWorkerConfig } from "./parallel.js";
```

Update `PlatformConfig` interface:

```typescript
export interface PlatformConfig {
  platform: Platform;
  driver: RawDriverService;
  engineConfig: EngineConfig;
  /** Additional workers for parallel execution within this platform. */
  additionalWorkers?: DeviceWorkerConfig[];
}
```

Update `OrchestratorResult` to include workerStats:

```typescript
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
```

In `runPlatform()`, add multi-worker branch at the start of the flow execution loop (after beforeAll hook, replacing the existing for-loop):

```typescript
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

  results.push(...parallelResult.results);
  return { results, workerStats: parallelResult.workerStats };
}
```

Update the return type of `runPlatform` to return workerStats optionally, and merge them in the main `orchestrate` function.

Update `onFlowStart` signature in `OrchestrateOptions`:

```typescript
onFlowStart?: (name: string, platform: Platform, workerName?: string) => void;
```

Update the serial path's onFlowStart call:

```typescript
options?.onFlowStart?.(flow.name, platform);
```

In the main `orchestrate` function, collect workerStats from all platforms:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/spana/src/core/orchestrator.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/core/orchestrator.ts packages/spana/src/core/orchestrator.test.ts
git commit -m "feat(orchestrator): delegate multi-worker platforms to runParallel"
```

---

### Task 5: Add --parallel flag to CLI and wire into test command

**Files:**

- Modify: `packages/spana/src/cli/index.ts`
- Modify: `packages/spana/src/cli/test-command.ts`

- [ ] **Step 1: Add --parallel flag parsing in cli/index.ts**

In `packages/spana/src/cli/index.ts`, add after line 24 (`let quiet = false;`):

```typescript
let parallel = false;
```

Add parsing in the for loop (after the `--quiet` handler around line 80):

```typescript
} else if (arg === "--parallel") {
  parallel = true;
```

Add to the `runTestCommand` call around line 106:

```typescript
parallel,
```

Add to the help text after the `--device` line around line 235:

```typescript
console.log("  --parallel                 Auto-discover devices and run in parallel");
```

- [ ] **Step 2: Add parallel option to TestCommandOptions**

In `packages/spana/src/cli/test-command.ts`, add to `TestCommandOptions` interface (after `quiet`):

```typescript
parallel?: boolean;
```

- [ ] **Step 3: Add --parallel + --device conflict check**

In `packages/spana/src/cli/test-command.ts`, add after the bail validation (around line 69):

```typescript
if (opts.parallel && opts.device) {
  console.log("Cannot use --parallel with --device. Remove --device to auto-discover all devices.");
  return false;
}
```

- [ ] **Step 4: Add multi-device runtime setup when --parallel is enabled**

In `packages/spana/src/cli/test-command.ts`, replace the runtime setup loop (lines 282-325) with:

```typescript
if (opts.parallel) {
  // Parallel mode: discover all devices per platform, build one runtime per device
  const { discoverDevices } = await import("../device/discover.js");
  const allDevices = discoverDevices(platforms);

  for (const platform of platforms) {
    const platformDevices = allDevices.filter((d) => d.platform === platform);

    if (platform === "web") {
      // Web always gets exactly 1 runtime
      const result = await buildWebRuntime(config);
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    } else if (platformDevices.length === 0) {
      console.log(`No ${platform} devices found. Skipping ${platform} platform.`);
    } else {
      if (platformDevices.length === 1) {
        console.log(
          `ℹ Only 1 ${platform} device found — connect more devices for parallel execution.`,
        );
      }

      // Build runtime for first device (primary)
      const builder = platform === "android" ? buildLocalAndroidRuntime : buildLocalIOSRuntime;
      const primaryResult = await builder(config, platformDevices[0]!, resolveFromConfig);
      if (!primaryResult) continue;
      runtimes.push(primaryResult.runtime);

      // Build runtimes for additional devices
      const additionalWorkers: import("../core/parallel.js").DeviceWorkerConfig[] = [];
      for (const device of platformDevices.slice(1)) {
        try {
          const result = await builder(config, device, resolveFromConfig);
          if (result) {
            runtimes.push(result.runtime);
            additionalWorkers.push({
              id: device.id,
              name: device.name,
              driver: result.runtime.driver,
              engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
            });
          }
        } catch (err) {
          console.log(
            `Warning: Failed to set up ${platform} device ${device.name}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      platformConfigs.push({
        platform,
        driver: primaryResult.runtime.driver,
        engineConfig: { ...primaryResult.engineConfig, debugOnFailure: opts.debugOnFailure },
        additionalWorkers: additionalWorkers.length > 0 ? additionalWorkers : undefined,
      });
    }
  }
} else {
  // Existing serial runtime setup (unchanged)
  for (const platform of platforms) {
    if (executionMode === "appium" && (platform === "android" || platform === "ios")) {
      const builder = platform === "android" ? buildAppiumAndroidRuntime : buildAppiumIOSRuntime;
      const preparedCaps = await cloudHelper!.prepareCapabilities(
        platform,
        { ...baseAppiumCaps },
        platform === "android" ? config.apps?.android : config.apps?.ios,
      );
      const result = await builder(config, appiumUrl!, preparedCaps);
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    } else if (platform === "web") {
      const result = await buildWebRuntime(config);
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    } else if (platform === "android") {
      const result = await buildLocalAndroidRuntime(config, targetDevice, resolveFromConfig);
      if (!result) continue;
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    } else if (platform === "ios") {
      const result = await buildLocalIOSRuntime(config, targetDevice, resolveFromConfig);
      if (!result) continue;
      runtimes.push(result.runtime);
      platformConfigs.push({
        platform,
        driver: result.runtime.driver,
        engineConfig: { ...result.engineConfig, debugOnFailure: opts.debugOnFailure },
      });
    }
  }
}
```

- [ ] **Step 5: Pass parallelPlatforms and workerName through orchestrate call**

Update the `orchestrate` call (around line 381) to pass `parallelPlatforms` and pass `workerName` through reporter callbacks:

```typescript
const retries = opts.retries ?? config.defaults?.retries ?? 0;
const retryDelay = config.defaults?.retryDelay ?? 0;
const result = await orchestrate(selectedFlows, platformConfigs, {
  retries,
  retryDelay,
  bail: opts.bail,
  parallelPlatforms: opts.parallel,
  onFlowStart(name, platform, workerName) {
    for (const reporter of reporters) {
      reporter.onFlowStart?.(name, platform, workerName);
    }
  },
  onResult(r) {
    const redacted = redactResult(r);
    for (const reporter of reporters) {
      if (redacted.status === "passed") {
        reporter.onFlowPass?.(redacted);
      } else if (redacted.status === "failed") {
        reporter.onFlowFail?.(redacted);
      }
    }
  },
});
```

Update the final summary to pass workerStats:

```typescript
for (const reporter of reporters) {
  reporter.onRunComplete({
    total: result.results.length,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    flaky: result.flaky,
    durationMs: result.totalDurationMs,
    results: redactedResults,
    platforms,
    bailedOut: result.bailedOut,
    bailLimit: result.bailLimit,
    workerStats: result.workerStats,
  });
}
```

- [ ] **Step 6: Run full test suite**

Run: `bun test packages/spana/src/`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/spana/src/cli/index.ts packages/spana/src/cli/test-command.ts
git commit -m "feat(cli): add --parallel flag with multi-device runtime setup"
```

---

### Task 6: Add test-command unit tests for parallel flag

**Files:**

- Modify: `packages/spana/src/cli/test-command.test.ts`

- [ ] **Step 1: Write tests for --parallel flag behavior**

Add to `packages/spana/src/cli/test-command.test.ts` a test for the conflict:

```typescript
test("--parallel + --device returns error", async () => {
  const result = await runTestCommand({
    platforms: ["android"],
    parallel: true,
    device: "emulator-5554",
  });

  expect(result).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test packages/spana/src/cli/test-command.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/cli/test-command.test.ts
git commit -m "test(cli): add test for --parallel + --device conflict"
```

---

### Task 7: Full integration test and type check

- [ ] **Step 1: Run full test suite**

Run: `bun test packages/spana/src/`
Expected: All tests PASS (0 failures).

- [ ] **Step 2: Run TypeScript type check**

Run: `cd packages/spana && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Run build**

Run: `npx turbo build --filter=spana-test`
Expected: Build succeeds.

- [ ] **Step 4: Commit and push**

```bash
git push
```

Expected: All pre-push hooks pass (lint, check-types, tests).
