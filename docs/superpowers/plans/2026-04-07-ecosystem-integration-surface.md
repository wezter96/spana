# Phase 9 — Ecosystem & Integration Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add custom reporter support via config-path loading, per-platform progress in console + Studio, result filtering in Studio UI, and improved agent-facing docs/JSDoc.

**Architecture:** The reporter loading pipeline in `test-command.ts` gains dynamic import for non-built-in names. The console reporter tracks per-platform counters. The Studio backend enriches its status response with per-platform progress. The Studio frontend adds filter controls and progress bars.

**Tech Stack:** TypeScript, Bun, React, TanStack Query, Tailwind CSS, Zod

---

### Task 1: Relax reporter config schema to accept module paths

**Files:**

- Modify: `packages/spana/src/schemas/config.ts:151` (reporterSchema)
- Modify: `packages/spana/src/schemas/config.ts:302` (provConfigSchema reporters field)
- Modify: `packages/spana/src/cli/test-command.ts:421-429` (reporter validation)

Currently `reporterSchema` is `z.enum(["console", "json", "junit", "html", "allure"])` which rejects custom paths. The CLI also validates against a hardcoded `validReporters` Set.

- [ ] **Step 1: Update the Zod schema to accept any string for reporters**

In `packages/spana/src/schemas/config.ts`, change the reporter schema and the provConfigSchema reporters field:

```typescript
// Line 151 — replace the enum with a union that accepts built-in names or any path-like string
const reporterSchema = z.string().min(1);
```

```typescript
// Line 302 — the reporters field in provConfigSchema already uses z.array(reporterSchema)
// so it will now accept any string. No change needed here.
```

- [ ] **Step 2: Remove hardcoded reporter validation in CLI**

In `packages/spana/src/cli/test-command.ts`, remove the `validReporters` Set check (lines 421-429). Replace with nothing — validation now happens at import time in `setupReporters`.

Replace this block:

```typescript
const reporterList = reporterNames.split(",").map((name) => name.trim());
const validReporters = new Set(["console", "json", "junit", "html", "allure"]);
for (const reporterName of reporterList) {
  if (!validReporters.has(reporterName)) {
    console.log(
      `Unknown reporter "${reporterName}". Use one of: ${Array.from(validReporters).join(", ")}.`,
    );
    return false;
  }
}
```

With:

```typescript
// Reporter names are validated during setup — built-in names are matched,
// other strings are treated as module paths and dynamically imported.
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `cd packages/spana && bun test src/cli/test-command.test.ts`
Expected: All existing tests pass (the tests don't test reporter validation directly).

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/schemas/config.ts packages/spana/src/cli/test-command.ts
git commit -m "feat: relax reporter schema to accept custom module paths"
```

---

### Task 2: Add dynamic reporter loading in setupReporters

**Files:**

- Modify: `packages/spana/src/cli/test-command.ts:277-311` (setupReporters function)

- [ ] **Step 1: Write the test for custom reporter loading**

Create `packages/spana/src/cli/custom-reporter-loading.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

// We test the loadCustomReporter function directly
import { loadCustomReporter } from "./test-command.js";

const tmpDir = resolve(import.meta.dir, "__test-reporters__");

describe("custom reporter loading", () => {
  test("loads a reporter object from a module path", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const reporterPath = resolve(tmpDir, "object-reporter.ts");
    writeFileSync(reporterPath, `export default { onRunComplete(summary) { /* noop */ } };`);

    const reporter = await loadCustomReporter(reporterPath, tmpDir);
    expect(reporter).toBeDefined();
    expect(typeof reporter.onRunComplete).toBe("function");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads a reporter factory function from a module path", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const reporterPath = resolve(tmpDir, "factory-reporter.ts");
    writeFileSync(
      reporterPath,
      `export default function(opts) { return { onRunComplete(summary) {} }; };`,
    );

    const reporter = await loadCustomReporter(reporterPath, tmpDir);
    expect(reporter).toBeDefined();
    expect(typeof reporter.onRunComplete).toBe("function");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("throws on missing module", async () => {
    expect(loadCustomReporter("./nonexistent-reporter.ts", "/tmp")).rejects.toThrow();
  });

  test("throws on module with no default export", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const reporterPath = resolve(tmpDir, "bad-reporter.ts");
    writeFileSync(reporterPath, `export const foo = 42;`);

    expect(loadCustomReporter(reporterPath, tmpDir)).rejects.toThrow(/default export/);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/spana && bun test src/cli/custom-reporter-loading.test.ts`
Expected: FAIL — `loadCustomReporter` is not exported from test-command.

- [ ] **Step 3: Implement loadCustomReporter and update setupReporters**

In `packages/spana/src/cli/test-command.ts`, add the `loadCustomReporter` export and update `setupReporters`:

Add before the `setupReporters` function (around line 277):

```typescript
import type { Reporter } from "../report/types.js";

const BUILTIN_REPORTERS = new Set(["console", "json", "junit", "html", "allure"]);

/**
 * Load a custom reporter from a module path.
 * The module must have a default export that is either a Reporter object
 * or a factory function (options: { outputDir: string }) => Reporter.
 */
export async function loadCustomReporter(modulePath: string, configDir: string): Promise<Reporter> {
  const resolvedPath = modulePath.startsWith(".")
    ? resolve(configDir, modulePath)
    : resolve(modulePath);

  let mod: Record<string, unknown>;
  try {
    mod = await import(resolvedPath);
  } catch (err) {
    throw new Error(
      `Failed to load custom reporter from "${modulePath}" (resolved: ${resolvedPath}): ${err instanceof Error ? err.message : err}`,
    );
  }

  const exported = mod.default;
  if (!exported) {
    throw new Error(
      `Custom reporter "${modulePath}" has no default export. Export a Reporter object or a (options) => Reporter factory function.`,
    );
  }

  if (typeof exported === "function") {
    return exported({ outputDir: configDir }) as Reporter;
  }

  if (typeof exported === "object") {
    return exported as Reporter;
  }

  throw new Error(
    `Custom reporter "${modulePath}" default export must be a Reporter object or factory function, got ${typeof exported}.`,
  );
}
```

Then update the `setupReporters` function to handle custom reporters. Replace the `reporters` mapping block (line 295-308):

```typescript
const resolvedOutputDir = config.artifacts?.outputDir ?? resolveFromConfig("./spana-output");
const reporters: Reporter[] = [];

for (const name of reporterNames.split(",")) {
  const trimmed = name.trim();
  if (!trimmed) continue;

  if (BUILTIN_REPORTERS.has(trimmed)) {
    switch (trimmed) {
      case "json":
        reporters.push(createJsonReporter());
        break;
      case "junit":
        reporters.push(createJUnitReporter(resolvedOutputDir));
        break;
      case "html":
        reporters.push(createHtmlReporter(resolvedOutputDir));
        break;
      case "allure":
        reporters.push(createAllureReporter());
        break;
      default:
        reporters.push(createConsoleReporter({ quiet: opts.quiet }));
        break;
    }
  } else {
    // Custom reporter — resolve relative to config directory
    const configDir = resolve(resolveFromConfig("."));
    try {
      const custom = await loadCustomReporter(trimmed, configDir);
      reporters.push(custom);
    } catch (err) {
      console.log(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
```

Also add the `Reporter` import at the top of the file if not already present. The type is already available via the report module.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/spana && bun test src/cli/custom-reporter-loading.test.ts`
Expected: All 4 tests pass.

- [ ] **Step 5: Run all existing tests to verify no regressions**

Run: `cd packages/spana && bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/spana/src/cli/test-command.ts packages/spana/src/cli/custom-reporter-loading.test.ts
git commit -m "feat: add dynamic custom reporter loading via module paths"
```

---

### Task 3: Export Reporter types from main package entry

**Files:**

- Modify: `packages/spana/src/index.ts`

Verify and add exports so custom reporter authors can `import { Reporter, FlowResult, ... } from "spana"`.

- [ ] **Step 1: Add reporter type exports to the main entry**

In `packages/spana/src/index.ts`, add the reporter types:

```typescript
// Reporter API — for custom reporter authors
export {
  type Reporter,
  type FlowResult,
  type RunSummary,
  type StepResult,
  type ScenarioStepResult,
  type Attachment,
  type FlowError,
  type FailureCategory,
} from "./report/types.js";
```

- [ ] **Step 2: Verify the exports compile**

Run: `cd packages/spana && bun build src/index.ts --no-bundle --outdir /dev/null 2>&1 || echo "Build check done"`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/index.ts
git commit -m "feat: export Reporter types from main package entry"
```

---

### Task 4: Per-platform progress in console reporter

**Files:**

- Modify: `packages/spana/src/report/console.ts:42-50` (reporter state and progress)
- Modify: `packages/spana/src/report/types.ts:78-85` (Reporter interface)
- Modify: `packages/spana/src/cli/test-command.ts:567-573` (flowCount assignment)
- Test: `packages/spana/src/report/console.test.ts`

- [ ] **Step 1: Write the test for per-platform progress**

Add to `packages/spana/src/report/console.test.ts`:

```typescript
test("shows per-platform progress when platformFlowCounts is set", () => {
  const reporter = createConsoleReporter();
  reporter.platformFlowCounts = { web: 2, android: 3 };

  // Simulate completions
  reporter.onFlowPass?.({
    name: "Flow A",
    platform: "web",
    status: "passed",
    durationMs: 100,
  });

  reporter.onFlowPass?.({
    name: "Flow B",
    platform: "android",
    status: "passed",
    durationMs: 200,
  });

  // Check that the progress line includes per-platform counts
  // The progress prefix should show something like "web [1/2 50%] · android [1/3 33%]"
  const progressLines = logs.filter((line) => line.includes("✓"));
  expect(progressLines.length).toBe(2);
  // First pass is web — should show web progress
  expect(progressLines[0]).toContain("[1/2");
  // Second pass is android — should show android progress
  expect(progressLines[1]).toContain("[1/3");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/spana && bun test src/report/console.test.ts`
Expected: FAIL — `platformFlowCounts` property doesn't exist.

- [ ] **Step 3: Add platformFlowCounts to Reporter interface**

In `packages/spana/src/report/types.ts`, add to the `Reporter` interface:

```typescript
export interface Reporter {
  onFlowStart?(name: string, platform: Platform, workerName?: string): void;
  onFlowPass?(result: FlowResult): void;
  onFlowFail?(result: FlowResult): void;
  onRunComplete(summary: RunSummary): void;
  /** Total number of flows to run (for progress display). */
  flowCount?: number;
  /** Per-platform flow counts for detailed progress display. */
  platformFlowCounts?: Partial<Record<Platform, number>>;
}
```

- [ ] **Step 4: Implement per-platform progress tracking in console reporter**

In `packages/spana/src/report/console.ts`, replace the progress tracking logic.

Replace the state variables (lines 44-46):

```typescript
let completed = 0;
let total = 0;
let currentPlatform: Platform | undefined;
```

With:

```typescript
let completed = 0;
let total = 0;
let currentPlatform: Platform | undefined;
const platformDone = new Map<Platform, number>();
let platformTotals: Partial<Record<Platform, number>> | undefined;
```

Replace the `progressPrefix` function (lines 48-50):

```typescript
function progressPrefix(platform?: Platform): string {
  if (platformTotals && platform) {
    const done = platformDone.get(platform) ?? 0;
    const ptotal = platformTotals[platform] ?? 0;
    if (ptotal > 0) {
      const pct = Math.round((done / ptotal) * 100);
      return `${platform} [${done}/${ptotal} ${pct}%]`;
    }
  }
  return total > 0 ? `[${completed}/${total}]` : "";
}
```

In `onFlowPass`, after `completed++` (line 68), add platform tracking:

```typescript
platformDone.set(result.platform, (platformDone.get(result.platform) ?? 0) + 1);
```

Update the pass log line (line 78-80) to pass platform:

```typescript
console.log(
  `  ✓ ${workerPrefix(result.workerName)}${progressPrefix(result.platform)} ${result.name} ${duration}${flakyTag}`,
);
```

In `onFlowFail`, after `completed++` (line 86), add platform tracking:

```typescript
platformDone.set(result.platform, (platformDone.get(result.platform) ?? 0) + 1);
```

Update the fail log line (line 95-97) to pass platform:

```typescript
console.log(
  `  ✗ ${workerPrefix(result.workerName)}${progressPrefix(result.platform)} [${result.platform}] ${result.name} ${duration}`,
);
```

Add the `platformFlowCounts` setter alongside the existing `flowCount` setter (line 178):

```typescript
    set platformFlowCounts(counts: Partial<Record<Platform, number>>) {
      platformTotals = counts;
    },
```

- [ ] **Step 5: Set platformFlowCounts in test-command.ts**

In `packages/spana/src/cli/test-command.ts`, after the `flowCount` assignment block (around line 567-573), add:

```typescript
// Set per-platform flow counts for detailed progress
const platformCounts: Partial<Record<Platform, number>> = {};
for (const p of platforms) {
  platformCounts[p] = selectedFlows.length;
}
for (const reporter of reporters) {
  if ("platformFlowCounts" in reporter) {
    reporter.platformFlowCounts = platformCounts;
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/spana && bun test src/report/console.test.ts`
Expected: All tests pass including the new one.

- [ ] **Step 7: Commit**

```bash
git add packages/spana/src/report/types.ts packages/spana/src/report/console.ts packages/spana/src/report/console.test.ts packages/spana/src/cli/test-command.ts
git commit -m "feat: per-platform progress display in console reporter"
```

---

### Task 5: Per-platform progress in Studio backend

**Files:**

- Modify: `packages/spana/src/studio/routers/tests.ts:50-55` (ActiveRun interface)
- Modify: `packages/spana/src/studio/routers/tests.ts:184-186` (run handler)
- Modify: `packages/spana/src/studio/routers/tests.ts:343-353` (status handler)

- [ ] **Step 1: Add progress tracking to ActiveRun and status response**

In `packages/spana/src/studio/routers/tests.ts`, update the `ActiveRun` interface (line 50-55):

```typescript
interface ActiveRun {
  id: string;
  status: "running" | "completed";
  results: FlowResult[];
  summary?: RunSummary;
  /** Total flows per platform for progress calculation */
  platformTotals?: Partial<Record<Platform, number>>;
}
```

In the `run` handler, after `const run: ActiveRun = ...` (line 186), compute and store platform totals. Add after the `void (async () => {` line and the platforms declaration:

```typescript
// Compute per-platform totals for progress tracking
// We won't know exact flow counts until the run starts, but we can estimate
// by counting results as they arrive. Set totals once we see runComplete.
```

Actually, since the Studio spawns a subprocess and gets results via JSON streaming, we don't know the total upfront without parsing a "runStart" event. The simpler approach: compute progress from results as they arrive, and provide totals from the `runComplete` event. But for live progress we need totals earlier.

Better approach: emit the total in the run response and track it. Update the `run` handler to also discover flow count before spawning:

In the `run` handler, after creating the run object (line 186), before the subprocess spawn, add flow count tracking. Update the run creation:

```typescript
const runId = nextRunId();
const run: ActiveRun = { id: runId, status: "running", results: [] };

// Count expected flows for progress tracking
try {
  const flows = await discoverAndLoad(flowDir);
  const filtered = filterFlows(flows, {
    tags: input.tags,
    grep: input.grep,
    platforms: input.platforms as Platform[] | undefined,
  });
  const totals: Partial<Record<Platform, number>> = {};
  for (const p of platforms) {
    totals[p] = filtered.length;
  }
  run.platformTotals = totals;
} catch {
  // If discovery fails, progress just won't show percentages
}

activeRuns.set(runId, run);
```

Update the `status` handler (line 343-353) to include progress:

```typescript
  status: publicProcedure.input(z.object({ runId: z.string() })).handler(({ input }) => {
    const run = activeRuns.get(input.runId);
    if (!run) {
      return { status: "not_found" as const, results: [], progress: {} };
    }

    // Compute per-platform progress from results
    const progress: Record<string, { done: number; total: number }> = {};
    if (run.platformTotals) {
      for (const [platform, total] of Object.entries(run.platformTotals)) {
        const done = run.results.filter((r) => r.platform === platform).length;
        progress[platform] = { done, total: total as number };
      }
    }

    return {
      status: run.status,
      results: run.results,
      summary: run.summary,
      progress,
    };
  }),
```

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `cd packages/spana && bun test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/studio/routers/tests.ts
git commit -m "feat: per-platform progress in Studio status endpoint"
```

---

### Task 6: Studio UI — progress bars and result filtering

**Files:**

- Modify: `apps/studio/src/components/run-progress.tsx`
- Modify: `apps/studio/src/pages/runner.tsx`

- [ ] **Step 1: Add platform filter state and progress props to RunProgress**

In `apps/studio/src/components/run-progress.tsx`, update the interface and component:

Update `RunProgressProps` (line 36-43):

```typescript
interface RunProgressProps {
  results: FlowResult[];
  isRunning: boolean;
  onSelectResult?: (result: FlowResult) => void;
  onRemoveResult?: (index: number) => void;
  onClearResults?: () => void;
  selectedResult?: FlowResult;
  progress?: Record<string, { done: number; total: number }>;
}
```

Add the `Filter` import alongside existing lucide imports (line 1-12):

```typescript
import { Filter } from "lucide-react";
```

- [ ] **Step 2: Add ProgressBar component and filter controls**

Add these components before the `RunProgress` function in `run-progress.tsx`:

```typescript
type Platform = "web" | "android" | "ios";
type StatusFilter = "passed" | "failed" | "skipped";

function ProgressBar({
  platform,
  done,
  total,
}: {
  platform: string;
  done: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-zinc-400 w-16">{platform}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-zinc-500 tabular-nums w-20 text-right">
        {done}/{total} ({pct}%)
      </span>
    </div>
  );
}

function FilterToggle({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-xs transition-colors border ${
        active
          ? `${color} border-current`
          : "text-zinc-600 border-zinc-800 hover:text-zinc-400"
      }`}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 3: Add filter state and progress rendering to RunProgress component**

In the `RunProgress` function, add filter state after the `expanded` state (line 182):

```typescript
const [platformFilter, setPlatformFilter] = useState<Set<Platform>>(new Set());
const [statusFilter, setStatusFilter] = useState<Set<StatusFilter>>(new Set());
```

Add the filter toggle helpers:

```typescript
const togglePlatformFilter = (p: Platform) => {
  setPlatformFilter((prev) => {
    const next = new Set(prev);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });
};

const toggleStatusFilter = (s: StatusFilter) => {
  setStatusFilter((prev) => {
    const next = new Set(prev);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    return next;
  });
};
```

Add filtered results computation:

```typescript
const filteredResults = results.filter((r) => {
  if (platformFilter.size > 0 && !platformFilter.has(r.platform as Platform)) return false;
  if (statusFilter.size > 0 && !statusFilter.has(r.status as StatusFilter)) return false;
  return true;
});
```

Extract the unique platforms from results:

```typescript
const resultPlatforms = [...new Set(results.map((r) => r.platform))] as Platform[];
```

Update the counts to use all results (not filtered) for the header:

```typescript
const passed = results.filter((r) => r.status === "passed").length;
const failed = results.filter((r) => r.status === "failed").length;
const skipped = results.filter((r) => r.status === "skipped").length;
```

- [ ] **Step 4: Render progress bars and filter controls in JSX**

In the `RunProgress` return JSX, add progress bars after the header `<div>` and before the results list. Insert between the header border-b div and the `<div className="flex-1 overflow-y-auto">`:

```tsx
{
  /* Per-platform progress bars */
}
{
  progress && Object.keys(progress).length > 0 && isRunning && (
    <div className="px-4 py-2 space-y-1.5 border-b border-zinc-800">
      {Object.entries(progress).map(([platform, { done, total }]) => (
        <ProgressBar key={platform} platform={platform} done={done} total={total} />
      ))}
    </div>
  );
}

{
  /* Filter controls */
}
{
  results.length > 0 && (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-zinc-800">
      <Filter className="w-3 h-3 text-zinc-500" />
      {resultPlatforms.map((p) => (
        <FilterToggle
          key={p}
          label={p}
          active={platformFilter.has(p)}
          onClick={() => togglePlatformFilter(p)}
          color="text-blue-400"
        />
      ))}
      {resultPlatforms.length > 0 && <span className="text-zinc-800">|</span>}
      {passed > 0 && (
        <FilterToggle
          label="passed"
          active={statusFilter.has("passed")}
          onClick={() => toggleStatusFilter("passed")}
          color="text-emerald-400"
        />
      )}
      {failed > 0 && (
        <FilterToggle
          label="failed"
          active={statusFilter.has("failed")}
          onClick={() => toggleStatusFilter("failed")}
          color="text-red-400"
        />
      )}
      {skipped > 0 && (
        <FilterToggle
          label="skipped"
          active={statusFilter.has("skipped")}
          onClick={() => toggleStatusFilter("skipped")}
          color="text-zinc-400"
        />
      )}
      {(platformFilter.size > 0 || statusFilter.size > 0) && (
        <button
          onClick={() => {
            setPlatformFilter(new Set());
            setStatusFilter(new Set());
          }}
          className="text-xs text-zinc-600 hover:text-zinc-400 ml-1"
        >
          clear
        </button>
      )}
    </div>
  );
}
```

Replace the results rendering to use `filteredResults` instead of `results`. In the `<div className="divide-y divide-zinc-800/50">` section, change `results.map` to `filteredResults.map`. Also update the `onRemoveResult` index to reference the original array:

```tsx
<div className="divide-y divide-zinc-800/50">
  {filteredResults.map((result) => {
    const originalIndex = results.indexOf(result);
    const key = `${result.name}-${result.platform}-${originalIndex}`;
    const isExpanded = expanded.has(key);
    const isSelected =
      selectedResult?.name === result.name && selectedResult?.platform === result.platform;
    return (
      <div key={key}>
        {/* ... same content but use originalIndex for onRemoveResult ... */}
        <div
          className={`group flex items-center gap-0.5 transition-colors ${
            isSelected ? "bg-zinc-800" : "hover:bg-zinc-800/50"
          }`}
        >
          <button
            onClick={() => {
              onSelectResult?.(result);
              toggleExpand(key);
            }}
            className="flex-1 flex items-center gap-2.5 px-2 py-2 text-left min-w-0"
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />
            )}
            <StatusIcon status={result.status} />
            <span className="text-sm text-zinc-200 truncate flex-1">{result.name}</span>
            <span className="text-xs text-zinc-500">{result.platform}</span>
            <span className="text-xs text-zinc-500 tabular-nums">
              {formatDuration(result.durationMs)}
            </span>
          </button>
          {onRemoveResult && !isRunning && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemoveResult(originalIndex);
              }}
              className="opacity-0 group-hover:opacity-100 p-2 mr-1 text-zinc-600 hover:text-zinc-300 transition-all shrink-0"
              title="Remove result"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <div
          className={`overflow-hidden transition-all duration-300 ease-in-out ${
            isExpanded ? "max-h-[1000px] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <ResultDetails result={result} />
        </div>
      </div>
    );
  })}
</div>
```

- [ ] **Step 5: Pass progress data from RunnerPage to RunProgress**

In `apps/studio/src/pages/runner.tsx`, extract progress from the status response and pass it:

After `const runCompleted = statusData?.status === "completed";` (line 84), add:

```typescript
const progress = (statusData as any)?.progress as
  Record<string, { done: number; total: number }> | undefined;
```

Update the `<RunProgress>` component usage (line 289-295) to pass `progress`:

```tsx
<RunProgress
  results={results}
  isRunning={isRunning || isStarting}
  onSelectResult={setSelectedResult}
  onRemoveResult={handleRemoveResult}
  onClearResults={handleClearResults}
  selectedResult={selectedResult}
  progress={progress}
/>
```

- [ ] **Step 6: Verify the Studio builds**

Run: `cd apps/studio && bun run build 2>&1 | tail -5`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/components/run-progress.tsx apps/studio/src/pages/runner.tsx
git commit -m "feat: progress bars and platform/status filters in Studio runner"
```

---

### Task 7: Custom reporters documentation page

**Files:**

- Create: `apps/docs/src/content/docs/reference/custom-reporters.md`
- Modify: `apps/docs/src/content/docs/reference/reporters.md` (add link)

- [ ] **Step 1: Create the custom reporters doc page**

Create `apps/docs/src/content/docs/reference/custom-reporters.md`:

```markdown
---
title: Custom Reporters
description: Write your own reporter to extend spana's output pipeline.
---

spana's reporter API lets you hook into the test lifecycle and process results however you need — post to Slack, push metrics to Datadog, write custom file formats, or integrate with internal dashboards.

## The Reporter interface

A reporter is an object with optional lifecycle hooks:

\`\`\`ts
import type { Reporter, FlowResult, RunSummary } from "spana";

const myReporter: Reporter = {
onFlowStart(name, platform, workerName) {
// Called when a flow begins execution
},

onFlowPass(result: FlowResult) {
// Called when a flow passes
},

onFlowFail(result: FlowResult) {
// Called when a flow fails (after all retries)
},

onRunComplete(summary: RunSummary) {
// Called once after all flows finish
},
};

export default myReporter;
\`\`\`

All hooks except `onRunComplete` are optional.

## Registering a custom reporter

Add the module path to your `reporters` array in `spana.config.ts`:

\`\`\`ts
import { defineConfig } from "spana";

export default defineConfig({
reporters: [
"console", // built-in
"./reporters/slack.ts", // your custom reporter
],
});
\`\`\`

Paths are resolved relative to your config file. Absolute paths also work.

## Factory pattern

If your reporter needs configuration, export a factory function instead of a plain object:

\`\`\`ts
import type { Reporter } from "spana";

export default function createSlackReporter(options: {
outputDir: string;
}): Reporter {
return {
onFlowFail(result) {
// Post to Slack webhook
},
onRunComplete(summary) {
console.log(`Results saved to ${options.outputDir}`);
},
};
}
\`\`\`

spana calls factory functions with `{ outputDir }` automatically.

## Available types

Import these from `"spana"` for full type safety:

| Type              | Description                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- |
| `Reporter`        | The reporter interface                                                                |
| `FlowResult`      | Result of a single flow (name, platform, status, duration, error, steps, attachments) |
| `RunSummary`      | Aggregate summary (total, passed, failed, skipped, flaky, duration, all results)      |
| `StepResult`      | Individual step within a flow (command, selector, status, duration)                   |
| `FlowError`       | Error details with category and suggestion                                            |
| `FailureCategory` | Error classification (element-not-found, timeout, etc.)                               |
| `Attachment`      | Screenshot or artifact reference (name, contentType, path)                            |
| `Platform`        | `"web" \| "android" \| "ios"`                                                         |

## Example: Webhook reporter

A minimal reporter that posts failures to an HTTP webhook:

\`\`\`ts
import type { Reporter, FlowResult } from "spana";

const webhookReporter: Reporter = {
async onFlowFail(result: FlowResult) {
await fetch("https://hooks.example.com/test-failures", {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
name: result.name,
platform: result.platform,
error: result.error?.message,
duration: result.durationMs,
}),
});
},

onRunComplete(summary) {
// Optional: post summary
},
};

export default webhookReporter;
\`\`\`

## Example: CSV reporter

\`\`\`ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter } from "spana";

export default function createCsvReporter(options: {
outputDir: string;
}): Reporter {
return {
onRunComplete(summary) {
const header = "name,platform,status,durationMs,error\n";
const rows = summary.results
.map(
(r) =>
`${r.name},${r.platform},${r.status},${r.durationMs},${r.error?.message ?? ""}`,
)
.join("\n");
writeFileSync(join(options.outputDir, "results.csv"), header + rows);
},
};
}
\`\`\`
```

- [ ] **Step 2: Add a link from the existing reporters page**

At the end of `apps/docs/src/content/docs/reference/reporters.md`, add:

```markdown
---

## Custom reporters

Need a reporter that isn't built in? See [Custom Reporters](/reference/custom-reporters/) to learn how to write your own using spana's `Reporter` interface.
```

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs/reference/custom-reporters.md apps/docs/src/content/docs/reference/reporters.md
git commit -m "docs: add custom reporters guide"
```

---

### Task 8: JSDoc on public API exports

**Files:**

- Modify: `packages/spana/src/report/types.ts`
- Modify: `packages/spana/src/api/flow.ts` (JSDoc on flow function)
- Modify: `packages/spana/src/schemas/config.ts` (JSDoc on reporters field, defineConfig)

- [ ] **Step 1: Add JSDoc to Reporter types**

In `packages/spana/src/report/types.ts`, add JSDoc comments to all exported types:

```typescript
/** Result of a single test step (tap, assertVisible, etc.) within a flow. */
export interface StepResult {
  /** The command name (e.g., "tap", "assertVisible", "typeText"). */
  command: string;
  /** The selector used for this step, if any. */
  selector?: unknown;
  /** Whether this step passed or failed. */
  status: "passed" | "failed";
  /** Wall-clock duration of this step in milliseconds. */
  durationMs: number;
  /** Error message if this step failed. */
  error?: string;
  /** Screenshots or artifacts captured during this step. */
  attachments?: Attachment[];
}

/** A screenshot, hierarchy dump, or other artifact captured during a test. */
export interface Attachment {
  /** Display name for this attachment (e.g., "failure-screenshot"). */
  name: string;
  /** MIME type: "image/png", "application/json", or "text/plain". */
  contentType: string;
  /** Absolute file path to the attachment on disk. */
  path: string;
}
```

Continue for all other interfaces — `FlowError`, `FlowResult`, `RunSummary`. Add a one-line JSDoc above each interface and each field that isn't self-evident.

- [ ] **Step 2: Add JSDoc to the reporters config field**

In `packages/spana/src/schemas/config.ts`, add JSDoc to the `reporters` field on `ProvConfig` (line 139):

```typescript
  /**
   * Reporter names or module paths. Built-in: "console", "json", "junit", "html", "allure".
   * Custom reporters: provide a relative path (e.g., "./reporters/slack.ts") that default-exports
   * a Reporter object or a (options: { outputDir: string }) => Reporter factory function.
   */
  reporters?: string[];
```

- [ ] **Step 3: Verify build**

Run: `cd packages/spana && bun build src/index.ts --no-bundle --outdir /dev/null 2>&1 || echo "Check done"`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/report/types.ts packages/spana/src/schemas/config.ts
git commit -m "docs: add JSDoc to Reporter types and config schema"
```

---

### Task 9: Update ROADMAP.md

**Files:**

- Modify: `ROADMAP.md`

- [ ] **Step 1: Mark Phase 9 items as complete and add checkboxes**

Update the Phase 9 section in `ROADMAP.md` to reflect what was delivered and what was intentionally dropped. Mark the phase as `[complete]`:

```markdown
## Phase 9 — Ecosystem & Integration Surface (v1.5.0) [complete]

spana now supports custom reporters via config-path loading, per-platform progress in both CLI and Studio, result filtering in Studio UI, and improved JSDoc coverage for AI tooling.

- [x] Stabilize and document a public custom reporter API
- [x] Custom reporters loadable via module path in `spana.config.ts`
- [x] Export all Reporter types from the main `spana` package
- [x] Per-platform progress display in console reporter and Studio UI
- [x] Platform and status filtering in Studio runner results
- [x] JSDoc on all public API exports for AI-driven automation
- [x] Custom reporters documentation with examples
- [ ] ~~Full plugin/service extension model~~ — deferred (hooks cover current use cases)
- [ ] ~~LambdaTest / TestingBot cloud helpers~~ — dropped (no demand)

### Success criteria

- Teams can write and load custom reporters without patching spana internals
- Console and Studio show per-platform progress during test runs
- Studio results are filterable by platform and status
- AI tools get rich inline documentation from JSDoc
```

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark Phase 9 complete in roadmap"
```
