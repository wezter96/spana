# Phase 6 — Parallel Execution & Runner UX

## Overview

Wire the existing `parallel.ts` work-stealing queue into `spana test` via a `--parallel` flag that auto-discovers all available devices per platform, builds one runtime per device, and distributes flows across workers. Platforms run concurrently. Console output is device-aware.

## Architecture

```
spana test --parallel
  |
  +- Discover devices (Android: 2 emulators, iOS: 1 sim, Web: 1 browser)
  |
  +- Build runtimes: Android x2, iOS x1, Web x1
  |
  +- Run concurrently:
       +- Web: serial (1 worker, all flows)
       +- Android: parallel (2 workers, work-stealing queue)
       +- iOS: serial (1 worker, all flows)
```

When `--parallel` is off (default), behavior is unchanged: first device per platform, serial execution.

## Components

### 1. CLI layer (`cli/index.ts` + `test-command.ts`)

- Add `--parallel` boolean flag.
- When enabled:
  - Auto-discover all available devices per platform via `discoverDevices()`.
  - Set `parallelPlatforms: true` on orchestrator options.
  - Build one runtime per discovered device per mobile platform.
  - Web always gets exactly 1 runtime (no multi-context parallelism).
- Error if combined with `--device` (conflicting intent).
- Compatible with `--bail`, `--retries`, `--retryDelay`, `--shard`.

### 2. Multi-device runtime setup (`test-command.ts`)

New flow when `--parallel` is enabled:

```
for each platform in requested platforms:
  devices = discoverDevices(platform)
  if platform == web:
    runtimes = [buildWebRuntime()]  // always 1
  else:
    runtimes = devices.map(device => buildRuntime(platform, device))

  if runtimes.length == 1 and platform != web:
    print hint: "Only 1 {platform} device found - connect more for parallel execution."
```

When `--parallel` is off, existing behavior: `firstDeviceForPlatform()` or `--device`.

### 3. Orchestrator integration (`orchestrator.ts`)

Extend `PlatformConfig` to support multiple workers:

```typescript
interface PlatformConfig {
  platform: Platform;
  driver: RawDriverService;
  engineConfig: EngineConfig;
  /** Additional workers for parallel execution within this platform. */
  additionalWorkers?: DeviceWorkerConfig[];
}
```

Inside `runPlatform()`:

- If `additionalWorkers` is present and non-empty, delegate to `runParallel()` with all workers (primary + additional).
- If no additional workers, use existing serial `executeFlow` loop.
- `beforeAll` hook runs once before parallel dispatch. `afterAll` runs once after.

### 4. Parallel runner updates (`parallel.ts`)

Add missing features to align with orchestrator capabilities:

- `retries?: number` — retry failed flows on the same worker before picking up next flow.
- `retryDelay?: number` — delay between retry attempts.
- `bail?: number` — shared counter; once hit, workers stop picking up new flows.
- `onFlowStart?: (name: string, workerName: string) => void` — callback before flow execution.

Updated interface:

```typescript
interface ParallelRunnerConfig {
  workers: DeviceWorkerConfig[];
  flows: FlowDefinition[];
  retries?: number;
  retryDelay?: number;
  bail?: number;
  onFlowStart?: (name: string, workerName: string) => void;
  onFlowComplete?: (result: TestResult, workerName: string) => void;
}

interface ParallelResult {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  workerStats: Map<string, { flowCount: number; totalMs: number }>;
  bailedOut?: boolean;
}
```

### 5. Console reporter (`console.ts`)

**During execution (parallel mode):**

- Prefix output lines with device name: `[Pixel 7] [3/20] Login flow...`
- Single-device platforms omit the prefix (no noise).
- Detect parallel mode from presence of worker name in callbacks.

**Summary:**

- Grouped by platform, then by device within each platform.
- Worker stats table at the end:

```
Worker Stats:
  [Pixel 7]    12 flows  38.2s
  [Pixel 8]    8 flows   36.1s
```

- Hint when platform has only 1 device:
  `i Only 1 Android device found -- connect more devices for parallel execution.`

### 6. Reporter interface updates (`report/types.ts`)

Extend reporter callbacks to carry worker info:

```typescript
interface ReporterCallbacks {
  onFlowStart?(name: string, platform: Platform, workerName?: string): void;
  onFlowPass?(result: TestResult, workerName?: string): void;
  onFlowFail?(result: TestResult, workerName?: string): void;
  onFlowSkip?(result: TestResult, workerName?: string): void;
  onRunComplete?(summary: RunSummary): void;
}

interface RunSummary {
  results: TestResult[];
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  workerStats?: Map<string, { flowCount: number; totalMs: number }>;
}
```

## Flag interactions

| Combination                | Behavior                                                 |
| -------------------------- | -------------------------------------------------------- |
| `--parallel` alone         | Auto-discover all devices, run concurrently              |
| `--parallel --device <id>` | Error: conflicting flags                                 |
| `--parallel --bail <n>`    | Shared bail counter across all workers                   |
| `--parallel --retries <n>` | Retry on same worker before picking up next flow         |
| `--parallel --shard 1/3`   | Shard filters flow list first, then parallel distributes |
| No `--parallel`            | Existing serial behavior, unchanged                      |

## Error handling

- Runtime build failure for one device: skip that worker, warn, continue with remaining.
- All runtimes for a platform fail: mark all platform flows as failed (existing behavior).
- Bail is global: any worker failure increments shared counter.

## Testing strategy

**Unit tests:**

- `parallel.ts`: retries, retryDelay, bail, onFlowStart callback, flaky detection, worker stats
- `orchestrator.ts`: multi-worker platform config delegation to runParallel
- `console.ts`: device-prefix formatting, worker stats table, single-device hint

**Integration tests:**

- Mock multi-device discovery, verify flows distributed across workers
- Verify bail stops all workers from picking up new flows
- Verify retry happens on same worker
- Verify beforeAll/afterAll hooks run once per platform even with multiple workers

## Out of scope

Tracked in roadmap as a future phase:

- `--workers <n>` cap on workers per platform
- `--devices <id1>,<id2>` explicit multi-device selection
- Web multi-context parallelism (multiple browser contexts as workers)
- Per-platform worker count configuration in `spana.config.ts`
