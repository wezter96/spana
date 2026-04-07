# Phase 10 Slices — Failure Bundles, Selector Guardrails, Agent Context

Design spec for three independent Phase 10 deliverables.

## Decisions

- **Failure bundle format**: Single JSON file per failure referencing existing artifact files by relative path
- **Selector guardrails**: Runtime-only analysis after flow completion, advisory warnings, no blocking
- **Agent context**: Single auto-generated `llms-full.txt` inlining all doc content, built at docs build time

---

## 1. Richer Failure Bundles

### What

When a flow fails, write a `failure-bundle.json` alongside existing artifacts containing structured failure context: the failed step, last successful step, selector with nearby alternatives, all artifact paths, error classification, and a repro command.

### Output location

`{outputDir}/{flowName}-{platform}/failure-bundle.json`

### Schema

```json
{
  "schemaVersion": 1,
  "flow": "login flow",
  "platform": "android",
  "timestamp": "2026-04-08T10:00:00.000Z",
  "failedStep": {
    "index": 5,
    "command": "tap",
    "selector": { "testID": "submit-btn" },
    "durationMs": 5012,
    "error": "Element not found: testID \"submit-btn\""
  },
  "lastPassedStep": {
    "index": 4,
    "command": "inputText",
    "selector": null,
    "durationMs": 120
  },
  "error": {
    "message": "Timed out waiting for element",
    "category": "element-not-found",
    "suggestion": "Check selector spelling or add testID to element",
    "errorCode": "E001"
  },
  "selectorContext": {
    "attempted": { "testID": "submit-btn" },
    "nearbyAlternatives": ["submit-button", "login-submit", "btn-submit"]
  },
  "artifacts": {
    "screenshot": "screenshot.png",
    "hierarchy": "hierarchy.json",
    "consoleLogs": "console-logs.json",
    "jsErrors": "js-errors.json",
    "har": "network.har",
    "driverLogs": "driver-logs.txt"
  },
  "reproCommand": "spana test flows/login.flow.ts --platform android --grep 'login flow'",
  "durationMs": 8432
}
```

All paths in `artifacts` are relative to the bundle file's directory. Missing artifacts are omitted from the object.

### Nearby selector alternatives

When the failure category is `element-not-found`, load the hierarchy JSON from the captured artifact, extract all `testID` and `accessibilityLabel` values, and find the closest matches to the attempted selector using simple substring containment and Levenshtein distance (top 5, max distance 5). If the attempted selector is a text selector, search visible text values instead.

### Implementation

New file: `packages/spana/src/report/failure-bundle.ts`

```typescript
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
}

interface BundleStep {
  index: number;
  command: string;
  selector: unknown;
  durationMs: number;
  error?: string;
}

export function createFailureBundle(
  flowName: string,
  platform: string,
  steps: StepResult[],
  error: FlowError,
  artifactDir: string,
  flowPath?: string,
): FailureBundle;
```

Called from the engine (`packages/spana/src/core/engine.ts`) after `captureArtifacts` completes on a failed flow. The engine already has access to steps, error, and artifact directory.

### What changes

| File                                               | Change                                                       |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `packages/spana/src/report/failure-bundle.ts`      | New — bundle creation + selector alternatives                |
| `packages/spana/src/core/engine.ts`                | Call `createFailureBundle` after artifact capture on failure |
| `packages/spana/src/report/failure-bundle.test.ts` | New — tests for bundle creation and selector matching        |

---

## 2. Selector Guardrails (Runtime Warnings)

### What

After a flow run completes, analyze recorded steps and emit advisory warnings about brittle selector patterns. Warnings are printed via the console reporter and included in failure bundles.

### Warning rules

| Rule             | Trigger                                                              | Message                                                                                      |
| ---------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `coordinate-tap` | Step uses `tapXY()` or `{ point: ... }` selector                     | "Step N used coordinate tap — prefer testID or text selectors for stability"                 |
| `text-heavy`     | >50% of steps in a flow use bare string or `{ text: ... }` selectors | "Flow uses text selectors for N/M steps — consider adding testID attributes for reliability" |
| `bare-string`    | A selector is a plain string that could be ambiguous                 | "Step N uses bare string selector 'X' — prefer { testID: '...' } for unambiguous targeting"  |

### Output

```
  Selector warnings:
    ! Step 3 used coordinate tap — prefer testID or text selectors for stability
    ! Flow uses text selectors for 8/12 steps — consider adding testID attributes
```

Printed after each flow's result in the console reporter (after pass/fail line, before next flow). Only shown when warnings exist. Suppressed in quiet mode.

### Implementation

New file: `packages/spana/src/report/selector-guardrails.ts`

```typescript
export interface SelectorWarning {
  rule: "coordinate-tap" | "text-heavy" | "bare-string";
  stepIndex?: number;
  message: string;
}

export function analyzeStepQuality(steps: StepResult[]): SelectorWarning[];
```

The function inspects `step.selector` on each `StepResult`. The selector is already stored as `unknown` — the function checks for `point` property (coordinate tap), string type (bare string), or `text` property (text selector).

### What changes

| File                                                    | Change                                     |
| ------------------------------------------------------- | ------------------------------------------ |
| `packages/spana/src/report/selector-guardrails.ts`      | New — step analysis and warning generation |
| `packages/spana/src/report/selector-guardrails.test.ts` | New — tests for each warning rule          |
| `packages/spana/src/report/console.ts`                  | Print warnings after each flow result      |

---

## 3. Agent Context Packaging

### What

Auto-generate `llms-full.txt` at docs build time by inlining all documentation markdown into a single file. Update existing `llms.txt` to reference it.

### Generation script

New file: `apps/docs/scripts/generate-llms-full.ts`

Reads all `.md` files from `apps/docs/src/content/docs/` in a defined order, strips YAML frontmatter, prepends a section header derived from the file's `title` frontmatter, and concatenates into `apps/docs/public/llms-full.txt`.

### Output structure

```
# spana — TypeScript-native E2E testing for React Native + Web

> Full documentation for AI/LLM consumption.
> For links-only version, see llms.txt

---

## Introduction

[content of introduction.md without frontmatter]

## Quick Start

[content of quick-start.md without frontmatter]

...
```

### Section ordering

```
getting-started/introduction.md
getting-started/quick-start.md
getting-started/configuration.md
writing-tests/flows.md
writing-tests/selectors.md
writing-tests/assertions.md
writing-tests/platform-specific.md
writing-tests/gherkin.md
cli/commands.md
cli/agent-commands.md
cli/init.md
cli/studio.md
reference/reporters.md
reference/custom-reporters.md
reference/agent-api.md
architecture/overview.md
architecture/drivers.md
guides/device-setup.md
guides/remote-execution.md
guides/cloud-providers.md
guides/ci-integration.md
guides/debugging.md
```

### Build integration

Add to the docs build script in `apps/docs/package.json` — run the generation script before the Astro build.

### What changes

| File                                      | Change                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `apps/docs/scripts/generate-llms-full.ts` | New — generation script                                           |
| `apps/docs/public/llms-full.txt`          | New — generated output (gitignored or committed, user preference) |
| `apps/docs/public/llms.txt`               | Add link to llms-full.txt at top                                  |
| `apps/docs/package.json`                  | Add generate step to build script                                 |

---

## Dropped / Out of scope

| Item                                      | Reason                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| Static `spana lint` CLI command           | Selectors are runtime-dynamic; static analysis misses most patterns    |
| Structured per-topic context files        | Single `llms-full.txt` covers the use case; split files add complexity |
| Failure bundle as directory with manifest | Single JSON file is simpler and equally useful                         |
| Blocking selector warnings                | Advisory-only avoids breaking existing flows                           |
