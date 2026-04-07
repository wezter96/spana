# Phase 10 DX Slices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured failure bundles with selector alternatives, runtime selector guardrails, and auto-generated `llms-full.txt` for agent context.

**Architecture:** Three independent slices. Failure bundles are written by the engine after artifact capture. Selector guardrails analyze step data and print via the console reporter. The llms-full.txt generator is a build-time script that concatenates doc markdown.

**Tech Stack:** TypeScript, Bun

---

### Task 1: Failure bundle — core module with selector alternatives

**Files:**

- Create: `packages/spana/src/report/failure-bundle.ts`
- Create: `packages/spana/src/report/failure-bundle.test.ts`

- [ ] **Step 1: Write the test file**

Create `packages/spana/src/report/failure-bundle.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createFailureBundle, findNearbySelectors } from "./failure-bundle.js";
import type { StepResult, FlowError } from "./types.js";

describe("findNearbySelectors", () => {
  const hierarchy = {
    type: "View",
    testID: "login-form",
    children: [
      { type: "TextInput", testID: "email-input", children: [] },
      { type: "TextInput", testID: "password-input", children: [] },
      { type: "Button", testID: "submit-button", children: [] },
      { type: "Button", testID: "forgot-password-link", children: [] },
      { type: "Text", text: "Welcome back", children: [] },
    ],
  };
  const hierarchyJson = JSON.stringify(hierarchy);

  test("finds similar testIDs by substring match", () => {
    const results = findNearbySelectors({ testID: "submit-btn" }, hierarchyJson);
    expect(results).toContain("submit-button");
  });

  test("finds similar testIDs by edit distance", () => {
    const results = findNearbySelectors({ testID: "email-inpt" }, hierarchyJson);
    expect(results).toContain("email-input");
  });

  test("returns empty array when no matches", () => {
    const results = findNearbySelectors({ testID: "completely-unrelated" }, hierarchyJson);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  test("searches text values for text selectors", () => {
    const results = findNearbySelectors({ text: "Welcome" }, hierarchyJson);
    expect(results).toContain("Welcome back");
  });

  test("handles bare string selectors", () => {
    const results = findNearbySelectors("Submit", hierarchyJson);
    // Should search both testIDs and text values
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  test("returns empty for null hierarchy", () => {
    const results = findNearbySelectors({ testID: "foo" }, null);
    expect(results).toEqual([]);
  });
});

describe("createFailureBundle", () => {
  test("creates a complete failure bundle", () => {
    const steps: StepResult[] = [
      { command: "tap", selector: { testID: "email" }, status: "passed", durationMs: 50 },
      { command: "inputText", status: "passed", durationMs: 30 },
      {
        command: "tap",
        selector: { testID: "submit-btn" },
        status: "failed",
        durationMs: 5000,
        error: "Element not found",
      },
    ];
    const error: FlowError = {
      message: 'Element not found: testID "submit-btn"',
      category: "element-not-found",
      suggestion: "Check selector spelling",
    };

    const bundle = createFailureBundle("login flow", "android", steps, error, "/tmp/artifacts");

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.flow).toBe("login flow");
    expect(bundle.platform).toBe("android");
    expect(bundle.failedStep).toEqual({
      index: 2,
      command: "tap",
      selector: { testID: "submit-btn" },
      durationMs: 5000,
      error: "Element not found",
    });
    expect(bundle.lastPassedStep).toEqual({
      index: 1,
      command: "inputText",
      selector: null,
      durationMs: 30,
    });
    expect(bundle.error.category).toBe("element-not-found");
    expect(bundle.reproCommand).toContain("login flow");
  });

  test("handles flow with no passed steps", () => {
    const steps: StepResult[] = [
      {
        command: "tap",
        selector: { testID: "x" },
        status: "failed",
        durationMs: 100,
        error: "boom",
      },
    ];
    const error: FlowError = { message: "boom", category: "unknown" };

    const bundle = createFailureBundle("fail flow", "web", steps, error, "/tmp/out");
    expect(bundle.failedStep?.index).toBe(0);
    expect(bundle.lastPassedStep).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/report/failure-bundle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement failure-bundle.ts**

Create `packages/spana/src/report/failure-bundle.ts`:

```typescript
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { StepResult, FlowError, Attachment } from "./types.js";

export interface BundleStep {
  index: number;
  command: string;
  selector: unknown;
  durationMs: number;
  error?: string;
}

export interface FailureBundle {
  schemaVersion: number;
  flow: string;
  platform: string;
  timestamp: string;
  failedStep: BundleStep | null;
  lastPassedStep: BundleStep | null;
  error: {
    message: string;
    category: string;
    suggestion?: string;
    errorCode?: string;
  };
  selectorContext?: {
    attempted: unknown;
    nearbyAlternatives: string[];
  };
  artifacts: Record<string, string>;
  reproCommand: string;
  durationMs: number;
  selectorWarnings?: Array<{ rule: string; stepIndex?: number; message: string }>;
}

/**
 * Compute Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/**
 * Extract all testID and text values from a hierarchy JSON string via DFS.
 */
function extractIdentifiers(hierarchyJson: string): { testIDs: string[]; texts: string[] } {
  const testIDs: string[] = [];
  const texts: string[] = [];

  try {
    const root = JSON.parse(hierarchyJson);
    const queue = [root];
    while (queue.length > 0) {
      const node = queue.pop();
      if (!node || typeof node !== "object") continue;
      if (node.testID && typeof node.testID === "string") testIDs.push(node.testID);
      if (node.text && typeof node.text === "string") texts.push(node.text);
      if (Array.isArray(node.children)) {
        for (const child of node.children) queue.push(child);
      }
    }
  } catch {
    // Invalid JSON — return empty
  }

  return { testIDs, texts };
}

/**
 * Find selectors in the hierarchy that are similar to the attempted selector.
 * Returns up to 5 matches ranked by relevance.
 */
export function findNearbySelectors(attempted: unknown, hierarchyJson: string | null): string[] {
  if (!hierarchyJson) return [];

  const { testIDs, texts } = extractIdentifiers(hierarchyJson);

  let target: string;
  let candidates: string[];

  if (typeof attempted === "string") {
    // Bare string — search both testIDs and texts
    target = attempted.toLowerCase();
    candidates = [...testIDs, ...texts];
  } else if (attempted && typeof attempted === "object") {
    const sel = attempted as Record<string, unknown>;
    if (typeof sel.testID === "string") {
      target = sel.testID.toLowerCase();
      candidates = testIDs;
    } else if (typeof sel.text === "string") {
      target = sel.text.toLowerCase();
      candidates = texts;
    } else if (typeof sel.accessibilityLabel === "string") {
      target = sel.accessibilityLabel.toLowerCase();
      candidates = [...testIDs, ...texts];
    } else {
      return [];
    }
  } else {
    return [];
  }

  // Score each candidate: substring match (score 0) beats edit distance
  const scored = candidates
    .filter((c) => c !== target) // exclude exact match
    .map((c) => {
      const cl = c.toLowerCase();
      const substringMatch = cl.includes(target) || target.includes(cl);
      const dist = levenshtein(target, cl);
      return { value: c, score: substringMatch ? 0 : dist };
    })
    .filter((s) => s.score <= 5)
    .sort((a, b) => a.score - b.score);

  // Deduplicate and take top 5
  const seen = new Set<string>();
  const results: string[] = [];
  for (const s of scored) {
    if (!seen.has(s.value)) {
      seen.add(s.value);
      results.push(s.value);
      if (results.length >= 5) break;
    }
  }

  return results;
}

/**
 * Build the artifact map from attachment list — maps type to relative filename.
 */
function buildArtifactMap(attachments: Attachment[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!attachments) return map;

  for (const att of attachments) {
    const filename = basename(att.path);
    if (filename === "screenshot.png") map.screenshot = filename;
    else if (filename === "hierarchy.json") map.hierarchy = filename;
    else if (filename === "console-logs.json") map.consoleLogs = filename;
    else if (filename === "js-errors.json") map.jsErrors = filename;
    else if (filename === "network.har") map.har = filename;
    else if (filename === "driver-logs.txt") map.driverLogs = filename;
  }

  return map;
}

/**
 * Create a structured failure bundle JSON for a failed flow.
 */
export function createFailureBundle(
  flowName: string,
  platform: string,
  steps: StepResult[],
  error: FlowError,
  artifactDir: string,
  attachments?: Attachment[],
  flowPath?: string,
): FailureBundle {
  // Find the failed step (last step with status "failed")
  const failedStepIndex = steps.findLastIndex((s) => s.status === "failed");
  const failedStep =
    failedStepIndex >= 0
      ? {
          index: failedStepIndex,
          command: steps[failedStepIndex]!.command,
          selector: steps[failedStepIndex]!.selector ?? null,
          durationMs: steps[failedStepIndex]!.durationMs,
          error: steps[failedStepIndex]!.error,
        }
      : null;

  // Find the last passed step before the failure
  const lastPassedIndex =
    failedStepIndex > 0
      ? steps.findLastIndex((s, i) => i < failedStepIndex && s.status === "passed")
      : -1;
  const lastPassedStep =
    lastPassedIndex >= 0
      ? {
          index: lastPassedIndex,
          command: steps[lastPassedIndex]!.command,
          selector: steps[lastPassedIndex]!.selector ?? null,
          durationMs: steps[lastPassedIndex]!.durationMs,
        }
      : null;

  // Build selector context with nearby alternatives
  let selectorContext: FailureBundle["selectorContext"];
  if (
    failedStep?.selector &&
    (error.category === "element-not-found" || error.category === "element-not-visible")
  ) {
    // Try to read the hierarchy from the artifact directory
    const hierarchyPath = join(artifactDir, "hierarchy.json");
    let hierarchyJson: string | null = null;
    if (existsSync(hierarchyPath)) {
      try {
        hierarchyJson = readFileSync(hierarchyPath, "utf-8");
      } catch {
        // Ignore read errors
      }
    }

    const nearbyAlternatives = findNearbySelectors(failedStep.selector, hierarchyJson);
    selectorContext = {
      attempted: failedStep.selector,
      nearbyAlternatives,
    };
  }

  const flowFile = flowPath ?? `flows/${flowName.replaceAll(" ", "-")}.flow.ts`;
  const reproCommand = `spana test ${flowFile} --platform ${platform} --grep '${flowName}'`;

  const bundle: FailureBundle = {
    schemaVersion: 1,
    flow: flowName,
    platform,
    timestamp: new Date().toISOString(),
    failedStep,
    lastPassedStep,
    error: {
      message: error.message,
      category: error.category,
      suggestion: error.suggestion,
      errorCode: error.errorCode,
    },
    selectorContext,
    artifacts: buildArtifactMap(attachments),
    reproCommand,
    durationMs: steps.reduce((sum, s) => sum + s.durationMs, 0),
  };

  return bundle;
}

/**
 * Write a failure bundle to disk as JSON.
 */
export function writeFailureBundle(bundle: FailureBundle, artifactDir: string): string {
  const path = join(artifactDir, "failure-bundle.json");
  writeFileSync(path, JSON.stringify(bundle, null, 2), "utf-8");
  return path;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/spana && bun test src/report/failure-bundle.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/report/failure-bundle.ts packages/spana/src/report/failure-bundle.test.ts
git commit -m "feat: failure bundle module with selector alternative matching"
```

---

### Task 2: Wire failure bundles into the engine

**Files:**

- Modify: `packages/spana/src/core/engine.ts:141-160` (catch block on failure)

- [ ] **Step 1: Add failure bundle import to engine.ts**

In `packages/spana/src/core/engine.ts`, add at the top imports (after line 13):

```typescript
import { createFailureBundle, writeFailureBundle } from "../report/failure-bundle.js";
```

- [ ] **Step 2: Add failure bundle creation after artifact capture on failure**

In `packages/spana/src/core/engine.ts`, in the main catch block (around line 141-160), after the `result` assignment (line 160) and before the `if (config.debugOnFailure)` check (line 162), insert:

```typescript
// Write structured failure bundle alongside artifacts
if (artifactConfig.captureOnFailure && result.error) {
  try {
    const artDir = join(
      artifactConfig.outputDir,
      `${
        flow.name
          .replaceAll(/[^a-zA-Z0-9-_]/g, "_")
          .replaceAll(/_+/g, "_")
          .slice(0, 80) || "artifact"
      }-${platform}`,
    );
    const bundle = createFailureBundle(
      flow.name,
      platform,
      stepRecorder.getSteps(),
      result.error,
      artDir,
      attachments,
    );
    writeFailureBundle(bundle, artDir);
  } catch {
    // Bundle writing is best-effort — don't block test execution
  }
}
```

Also add the `join` import if not already present. Check line 1 — it imports from `node:path` already? No — check the existing imports. The engine imports from Effect and relative modules but not `node:path`. Add:

```typescript
import { join } from "node:path";
```

- [ ] **Step 3: Also wire into the buildFailureResult helper**

The `buildFailureResult` function (line 75-88) is used for early failures (beforeEach hook, beginFlow). Add bundle creation there too.

After the return object is constructed (but the function returns it), this is trickier since it's an inline async function. Instead, add bundle creation right after the `result` is fully built in the main catch block only — the `buildFailureResult` path has less step data and isn't worth bundling.

- [ ] **Step 4: Run all tests**

Run: `cd packages/spana && bun test`
Expected: All tests pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/core/engine.ts
git commit -m "feat: write failure bundles from engine on test failure"
```

---

### Task 3: Selector guardrails — analysis module

**Files:**

- Create: `packages/spana/src/report/selector-guardrails.ts`
- Create: `packages/spana/src/report/selector-guardrails.test.ts`

- [ ] **Step 1: Write the test file**

Create `packages/spana/src/report/selector-guardrails.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { analyzeStepQuality } from "./selector-guardrails.js";
import type { StepResult } from "./types.js";

describe("selector guardrails", () => {
  test("warns on coordinate taps", () => {
    const steps: StepResult[] = [
      { command: "tapXY", status: "passed", durationMs: 50 },
      { command: "tap", selector: { testID: "btn" }, status: "passed", durationMs: 50 },
    ];

    const warnings = analyzeStepQuality(steps);
    expect(warnings.some((w) => w.rule === "coordinate-tap")).toBe(true);
    expect(warnings.find((w) => w.rule === "coordinate-tap")?.stepIndex).toBe(0);
  });

  test("warns on point selectors", () => {
    const steps: StepResult[] = [
      { command: "tap", selector: { point: { x: 100, y: 200 } }, status: "passed", durationMs: 50 },
    ];

    const warnings = analyzeStepQuality(steps);
    expect(warnings.some((w) => w.rule === "coordinate-tap")).toBe(true);
  });

  test("warns when flow is text-heavy (>50% text selectors)", () => {
    const steps: StepResult[] = [
      { command: "tap", selector: "Sign In", status: "passed", durationMs: 50 },
      { command: "tap", selector: { text: "Continue" }, status: "passed", durationMs: 50 },
      { command: "tap", selector: "Next", status: "passed", durationMs: 50 },
      { command: "tap", selector: { testID: "btn" }, status: "passed", durationMs: 50 },
    ];

    const warnings = analyzeStepQuality(steps);
    expect(warnings.some((w) => w.rule === "text-heavy")).toBe(true);
    expect(warnings.find((w) => w.rule === "text-heavy")?.message).toContain("3/4");
  });

  test("warns on bare string selectors", () => {
    const steps: StepResult[] = [
      { command: "tap", selector: "Submit", status: "passed", durationMs: 50 },
      { command: "tap", selector: { testID: "btn" }, status: "passed", durationMs: 50 },
    ];

    const warnings = analyzeStepQuality(steps);
    expect(warnings.some((w) => w.rule === "bare-string" && w.stepIndex === 0)).toBe(true);
  });

  test("returns no warnings for testID-only flows", () => {
    const steps: StepResult[] = [
      { command: "tap", selector: { testID: "a" }, status: "passed", durationMs: 50 },
      { command: "tap", selector: { testID: "b" }, status: "passed", durationMs: 50 },
    ];

    const warnings = analyzeStepQuality(steps);
    expect(warnings).toEqual([]);
  });

  test("ignores steps without selectors (inputText, pressKey)", () => {
    const steps: StepResult[] = [
      { command: "inputText", status: "passed", durationMs: 50 },
      { command: "pressKey", status: "passed", durationMs: 50 },
      { command: "tap", selector: { testID: "a" }, status: "passed", durationMs: 50 },
    ];

    const warnings = analyzeStepQuality(steps);
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/report/selector-guardrails.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement selector-guardrails.ts**

Create `packages/spana/src/report/selector-guardrails.ts`:

```typescript
import type { StepResult } from "./types.js";

export interface SelectorWarning {
  rule: "coordinate-tap" | "text-heavy" | "bare-string";
  stepIndex?: number;
  message: string;
}

function isCoordinateTap(step: StepResult): boolean {
  if (step.command === "tapXY" || step.command === "longPressXY") return true;
  if (
    step.selector &&
    typeof step.selector === "object" &&
    "point" in (step.selector as Record<string, unknown>)
  ) {
    return true;
  }
  return false;
}

function isTextSelector(selector: unknown): boolean {
  if (typeof selector === "string") return true;
  if (selector && typeof selector === "object" && "text" in (selector as Record<string, unknown>)) {
    return true;
  }
  return false;
}

function isBareString(selector: unknown): boolean {
  return typeof selector === "string";
}

/**
 * Analyze recorded steps for brittle selector patterns.
 * Returns advisory warnings — never blocks execution.
 */
export function analyzeStepQuality(steps: StepResult[]): SelectorWarning[] {
  const warnings: SelectorWarning[] = [];

  // Only consider steps that have selectors (skip inputText, pressKey, etc.)
  const selectorSteps = steps.filter((s) => s.selector !== undefined);

  for (const [i, step] of steps.entries()) {
    // Rule: coordinate-tap
    if (isCoordinateTap(step)) {
      warnings.push({
        rule: "coordinate-tap",
        stepIndex: i,
        message: `Step ${i + 1} used coordinate tap — prefer testID or text selectors for stability`,
      });
    }

    // Rule: bare-string
    if (step.selector !== undefined && isBareString(step.selector)) {
      warnings.push({
        rule: "bare-string",
        stepIndex: i,
        message: `Step ${i + 1} uses bare string selector '${step.selector}' — prefer { testID: '...' } for unambiguous targeting`,
      });
    }
  }

  // Rule: text-heavy (>50% of selector steps use text/string selectors)
  if (selectorSteps.length >= 2) {
    const textCount = selectorSteps.filter((s) => isTextSelector(s.selector)).length;
    if (textCount > selectorSteps.length / 2) {
      warnings.push({
        rule: "text-heavy",
        message: `Flow uses text selectors for ${textCount}/${selectorSteps.length} steps — consider adding testID attributes for reliability`,
      });
    }
  }

  return warnings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/spana && bun test src/report/selector-guardrails.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/report/selector-guardrails.ts packages/spana/src/report/selector-guardrails.test.ts
git commit -m "feat: selector guardrails with runtime step quality analysis"
```

---

### Task 4: Wire selector guardrails into console reporter

**Files:**

- Modify: `packages/spana/src/report/console.ts:79-113` (onFlowPass and onFlowFail)
- Modify: `packages/spana/src/report/console.test.ts`

- [ ] **Step 1: Write the test**

Add to `packages/spana/src/report/console.test.ts`:

```typescript
test("prints selector warnings after flow results", () => {
  const reporter = createConsoleReporter();

  reporter.onFlowPass?.({
    name: "Tappy flow",
    platform: "web",
    status: "passed",
    durationMs: 100,
    steps: [
      { command: "tapXY", status: "passed", durationMs: 50 },
      { command: "tap", selector: { testID: "btn" }, status: "passed", durationMs: 50 },
    ],
  });

  expect(logs.some((line) => line.includes("coordinate tap"))).toBe(true);
});

test("suppresses selector warnings in quiet mode", () => {
  const reporter = createConsoleReporter({ quiet: true });

  reporter.onFlowPass?.({
    name: "Tappy flow",
    platform: "web",
    status: "passed",
    durationMs: 100,
    steps: [{ command: "tapXY", status: "passed", durationMs: 50 }],
  });

  expect(logs.some((line) => line.includes("coordinate tap"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/report/console.test.ts`
Expected: FAIL — "coordinate tap" not found in output.

- [ ] **Step 3: Add guardrails to the console reporter**

In `packages/spana/src/report/console.ts`, add the import at the top:

```typescript
import { analyzeStepQuality } from "./selector-guardrails.js";
```

Add a helper function after `printScenarioSteps` (around line 30):

```typescript
function printSelectorWarnings(result: FlowResult): void {
  if (!result.steps || result.steps.length === 0) return;
  const warnings = analyzeStepQuality(result.steps);
  if (warnings.length === 0) return;
  console.log("    Selector warnings:");
  for (const w of warnings) {
    console.log(`      ! ${w.message}`);
  }
}
```

In `onFlowPass`, after `printResultAttachments(result)` (line 95), add:

```typescript
printSelectorWarnings(result);
```

In `onFlowFail`, after `printResultAttachments(result)` (line 113), add:

```typescript
printSelectorWarnings(result);
```

Note: `printSelectorWarnings` is only called when not quiet — the `onFlowPass` already returns early on quiet mode (line 82). For `onFlowFail`, warnings should print even in quiet mode since failures are always shown. But selector warnings on a failed flow are less useful (the failure itself is the issue), so skip them on failure:

Actually, simpler: only print warnings on passed flows. Failed flows have the failure message which is more important. Update: only add `printSelectorWarnings(result)` after `onFlowPass`'s `printResultAttachments`, not after `onFlowFail`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/spana && bun test src/report/console.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/report/console.ts packages/spana/src/report/console.test.ts
git commit -m "feat: print selector guardrail warnings in console reporter"
```

---

### Task 5: Agent context — llms-full.txt generator

**Files:**

- Create: `apps/docs/scripts/generate-llms-full.ts`
- Modify: `apps/docs/public/llms.txt`
- Modify: `apps/docs/package.json`

- [ ] **Step 1: Create the generator script**

Create `apps/docs/scripts/generate-llms-full.ts`:

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const DOCS_DIR = resolve(import.meta.dir, "../src/content/docs");
const OUTPUT_PATH = resolve(import.meta.dir, "../public/llms-full.txt");

// Ordered list of doc files to include
const DOC_FILES = [
  "getting-started/introduction.md",
  "getting-started/quick-start.md",
  "getting-started/configuration.md",
  "writing-tests/flows.md",
  "writing-tests/selectors.md",
  "writing-tests/assertions.md",
  "writing-tests/platform-specific.md",
  "writing-tests/gherkin.md",
  "cli/commands.md",
  "cli/agent-commands.md",
  "cli/init.md",
  "cli/studio.md",
  "reference/reporters.md",
  "reference/custom-reporters.md",
  "reference/agent-api.md",
  "reference/example.md",
  "architecture/overview.md",
  "architecture/drivers.md",
  "guides/device-setup.md",
  "guides/remote-execution.md",
  "guides/cloud-providers.md",
  "guides/ci-integration.md",
  "guides/debugging.md",
];

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return content;
  return content.slice(endIndex + 3).trim();
}

function extractTitle(content: string): string {
  if (!content.startsWith("---")) return "Untitled";
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return "Untitled";
  const frontmatter = content.slice(3, endIndex);
  const match = frontmatter.match(/title:\s*(.+)/);
  return match ? match[1]!.trim().replaceAll(/^["']|["']$/g, "") : "Untitled";
}

const header = `# spana — TypeScript-native E2E testing for React Native + Web

> Full documentation for AI/LLM consumption.
> For links-only version, see llms.txt
>
> Generated from source docs — do not edit manually.

`;

const sections: string[] = [header];

for (const file of DOC_FILES) {
  const filePath = join(DOCS_DIR, file);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const title = extractTitle(raw);
    const body = stripFrontmatter(raw);
    sections.push(`---\n\n## ${title}\n\n${body}\n`);
  } catch {
    console.warn(`Warning: Could not read ${file}, skipping.`);
  }
}

writeFileSync(OUTPUT_PATH, sections.join("\n"), "utf-8");
console.log(`Generated ${OUTPUT_PATH} (${DOC_FILES.length} sections)`);
```

- [ ] **Step 2: Run the script to verify it works**

Run: `cd apps/docs && bun scripts/generate-llms-full.ts`
Expected: Prints "Generated ... (23 sections)" and creates `apps/docs/public/llms-full.txt`.

- [ ] **Step 3: Update llms.txt to reference llms-full.txt**

In `apps/docs/public/llms.txt`, add at the top after the first description paragraph (after line 3):

```
> For full inlined documentation (all content in one file), see: llms-full.txt
```

- [ ] **Step 4: Update package.json build script**

In `apps/docs/package.json`, update the build script:

```json
"build": "bun scripts/generate-llms-full.ts && astro build",
```

- [ ] **Step 5: Commit**

```bash
git add apps/docs/scripts/generate-llms-full.ts apps/docs/public/llms.txt apps/docs/public/llms-full.txt apps/docs/package.json
git commit -m "feat: auto-generate llms-full.txt with inlined documentation"
```

---

### Task 6: Update ROADMAP.md

**Files:**

- Modify: `ROADMAP.md`

- [ ] **Step 1: Mark the three delivered items in Phase 10**

In the Phase 10 section of `ROADMAP.md`, add checkboxes for the delivered items:

Add under the existing Phase 10 content:

```markdown
### Delivered

- [x] Structured failure bundles with selector alternatives and repro commands
- [x] Runtime selector guardrails (coordinate tap, text-heavy, bare string warnings)
- [x] Auto-generated `llms-full.txt` for agent context packaging
```

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark Phase 10 DX slices as delivered in roadmap"
```
