# Phase 9 — Ecosystem & Integration Surface (v1.5.0)

Design spec for extending spana's public API, reporting ecosystem, CI story, and Studio UX.

## Decisions

- **Reporter extension model**: Config-path resolution (option A). Users specify module paths in `reporters` array. No plugin registry or npm convention yet — can be added later.
- **No full plugin system**: Existing hooks (`beforeAll`, `afterAll`, `beforeEach`, `afterEach`) cover service-like use cases. A formal plugin/service model is deferred until real demand appears.
- **Cloud providers**: LambdaTest and TestingBot are dropped — no demand. BrowserStack and Sauce Labs remain the supported providers.
- **CI examples**: GitHub Actions only.
- **Agent-facing docs**: Improve JSDoc and skill docs. No structured capability manifest.
- **Reporter interface**: Keep the current 4-hook shape (`onFlowStart`, `onFlowPass`, `onFlowFail`, `onRunComplete`). Step-level hooks deferred.

## 1. Custom Reporter API

### Public interface

The `Reporter` interface is already well-shaped. Stabilize it as public API:

```typescript
export interface Reporter {
  onFlowStart?(name: string, platform: Platform): void;
  onFlowPass?(result: FlowResult): void;
  onFlowFail?(result: FlowResult): void;
  onRunComplete?(summary: RunSummary): void;
}
```

All supporting types (`FlowResult`, `RunSummary`, `StepResult`, `FlowError`, `FailureCategory`, `Attachment`) are already exported from `packages/spana/src/report/types.ts` and re-exported from the main package entry. Verify they are all reachable via `import { ... } from "spana"`.

### Config-based loading

Update the `reporters` config field to accept module paths alongside built-in names:

```typescript
// spana.config.ts
export default defineConfig({
  reporters: ["console", "junit", "./reporters/slack-notifier.ts", "../shared/custom-reporter.ts"],
});
```

**Resolution logic** in `setupReporters()` (`test-command.ts`):

1. If the name matches a built-in (`console`, `json`, `junit`, `html`, `allure`), use the existing factory.
2. Otherwise, treat it as a module path relative to the config file location.
3. Dynamic `import()` the module. Expect a default export that is either:
   - A `Reporter` object, or
   - A factory function `(options: { outputDir: string }) => Reporter`
4. If the import fails or the export doesn't conform, throw a clear error with the path and expected shape.

**Schema change** in `config.ts`: The `reporters` Zod field is already `z.array(z.string())` — no schema change needed. Add a JSDoc comment clarifying that module paths are accepted.

### Documentation

Add `apps/docs/src/content/docs/reference/custom-reporters.md`:

- Explain the `Reporter` interface
- Minimal example (a reporter that posts to a webhook on failure)
- How to reference it from config
- Available types to import from `spana`

## 2. Progress & Result Filtering

### Console reporter per-platform progress

Currently the console reporter shows `[5/12] flow-name...` with a single global counter.

Change to per-platform progress lines:

```
web [3/5 60%] · android [1/8 13%] · ios [0/4 0%]
```

**Implementation:**

- The console reporter already receives `platform` in `onFlowStart` and `onFlowPass`/`onFlowFail`
- Track a `Map<Platform, { done: number; total: number }>` instead of a single counter
- Total per platform = number of selected flows for that platform (passed in via a new `flowCounts` option: `Record<Platform, number>`)
- Update the progress line on each flow completion

### Studio backend progress enrichment

In `tests.ts`, the `status` handler currently returns `{ status, results }`.

Enrich with per-platform progress:

```typescript
{
  status: "running" | "complete",
  results: FlowResult[],
  progress: {
    web?: { done: number; total: number };
    android?: { done: number; total: number };
    ios?: { done: number; total: number };
  },
  summary?: RunSummary, // present when status === "complete"
}
```

**How totals are known:** The `run` procedure already receives `platforms` and `flows` — compute `total = flows.length` per platform and store in `activeRuns`.

### Studio UI result filtering

In `run-progress.tsx`:

1. **Progress bars per platform** — horizontal bar showing percentage, rendered above the results table. Only show bars for platforms included in the current run.

2. **Filter controls on results table:**
   - Platform filter: toggle buttons for each platform in the run (web / android / ios)
   - Status filter: toggle buttons for passed / failed / skipped
   - Default: all shown, filters are AND-combined
   - Client-side filtering only — all results are already in memory from polling

3. **Group-by-platform view** (optional toggle):
   - Collapsible sections per platform, each with its own pass/fail/skip count
   - Default view remains flat list; grouping is opt-in

## 3. CI Examples

Create `examples/ci/github-actions/` with reusable workflow files:

### `web-tests.yml`

```yaml
name: Spana Web Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx spana test --platform web --reporter console,junit,html
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: spana-output/
      - uses: dorny/test-reporter@v1
        if: always()
        with:
          name: Spana Results
          path: spana-output/spana-junit.xml
          reporter: java-junit
```

### `android-tests.yml`

```yaml
name: Spana Android Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          arch: x86_64
          script: bunx spana test --platform android --reporter console,junit,html
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: android-results
          path: spana-output/
```

### `multi-platform.yml`

Combined workflow showing web + android in parallel jobs with a summary step that merges JUnit results.

Each file includes comments explaining what to customize (config path, platform flags, artifact retention).

## 4. Agent-Facing Docs

### JSDoc improvements

Add or improve JSDoc on all public exports from `packages/spana/src/index.ts`:

- Every `app.*` method: parameter descriptions, return types, platform support notes
- `flow()` function: full usage example in JSDoc
- `defineConfig()`: document all config options inline
- `Reporter` interface: document each hook's purpose and when it fires
- Selector types: examples of each selector format

### Skill doc update

Update `.agents/skills/spana-testing/SKILL.md` to include:

- Complete `app.*` method reference (current list is incomplete)
- All assertion methods (`toHaveText`, `toBeVisible`, `toHaveValue`, `toBeEnabled`, etc.)
- All gesture methods (`swipe`, `pinch`, `zoom`, `multiTouch`)
- Config option reference
- Custom reporter authoring guide
- Common patterns section (login flows, scroll-to-find, conditional platform logic)

## 5. Dropped / Deferred

| Item                                  | Reason                                                   |
| ------------------------------------- | -------------------------------------------------------- |
| LambdaTest / TestingBot helpers       | No demand                                                |
| Full plugin/service system            | Hooks cover use cases; revisit when demand appears       |
| npm package convention for reporters  | Can layer on top of config-path resolution later         |
| Structured capability manifest (JSON) | JSDoc sufficient for AI tooling today                    |
| Step-level reporter hooks             | Current 4-hook interface is sufficient; add if requested |
| WebSocket streaming in Studio         | Polling at 1s is adequate for current scale              |

## File changes summary

| File                                                       | Change                                        |
| ---------------------------------------------------------- | --------------------------------------------- |
| `packages/spana/src/report/types.ts`                       | Verify all types exported, add JSDoc          |
| `packages/spana/src/cli/test-command.ts`                   | Dynamic reporter import in `setupReporters()` |
| `packages/spana/src/schemas/config.ts`                     | JSDoc on reporters field                      |
| `packages/spana/src/report/console.ts`                     | Per-platform progress display                 |
| `packages/spana/src/studio/routers/tests.ts`               | Per-platform progress in status response      |
| `apps/studio/src/components/run-progress.tsx`              | Progress bars, filter controls, group-by      |
| `packages/spana/src/index.ts`                              | Verify/add JSDoc on all exports               |
| `apps/docs/src/content/docs/reference/custom-reporters.md` | New doc page                                  |
| `.agents/skills/spana-testing/SKILL.md`                    | Comprehensive update                          |
| `examples/ci/github-actions/*.yml`                         | New CI workflow examples                      |
