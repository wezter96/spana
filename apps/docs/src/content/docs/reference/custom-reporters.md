---
title: Custom Reporters
description: Extend Spana's output pipeline with your own reporter modules.
---

Custom reporters let you push results into Slack, internal dashboards, CSV files, metrics systems, or any other destination.

## Reporter shape

Import reporter types from `spana`:

```ts
import type { Reporter, FlowResult, RunSummary } from "spana";

const reporter: Reporter = {
  onFlowStart(name, platform, workerName) {
    console.log(`START ${platform}:${workerName ?? "default"} ${name}`);
  },

  onFlowFail(result: FlowResult) {
    console.log(`FAIL ${result.name}: ${result.error?.message}`);
  },

  onRunComplete(summary: RunSummary) {
    console.log(`${summary.passed}/${summary.total} passed`);
  },
};

export default reporter;
```

All hooks except `onRunComplete` are optional. `onFlowPass` and `onFlowFail` fire for passed and failed flows; skipped flows fire neither and appear only in `summary.results`. Results are redacted before they reach any reporter.

## Registering a reporter

```ts
import { defineConfig } from "spana";

export default defineConfig({
  reporters: ["console", "./reporters/slack.ts"],
});
```

Paths that start with `.` are resolved relative to the directory of `spana.config.ts`. Other values are imported as package names. You can also pass a module path on the CLI, for example `spana test --reporter console,./reporters/slack.ts`.

## Factory reporters

If your reporter needs options, export a factory function:

```ts
import type { Reporter } from "spana";

export default function createCsvReporter(options: { outputDir: string }): Reporter {
  return {
    onRunComplete(summary) {
      console.log(`Write results into ${options.outputDir}`);
    },
  };
}
```

Spana calls factory reporters with `{ outputDir }`. The value is the directory of `spana.config.ts`, not `artifacts.outputDir`.

## Exported types

### `Reporter`

```ts
interface Reporter {
  onFlowStart?(name: string, platform: Platform, workerName?: string): void;
  onFlowPass?(result: FlowResult): void;
  onFlowFail?(result: FlowResult): void;
  onRunComplete(summary: RunSummary): void;
  flowCount?: number;
  platformFlowCounts?: Partial<Record<Platform, number>>;
}
```

`flowCount` and `platformFlowCounts` are populated by Spana so console-style reporters can render progress.

### `FlowResult`

| Field           | Description                                                 |
| --------------- | ----------------------------------------------------------- |
| `name`          | Flow name                                                   |
| `platform`      | `web`, `android`, `ios`, `electron`, or `electrobun`        |
| `status`        | `passed`, `failed`, or `skipped`                            |
| `flaky`         | `true` when the flow failed first and later passed on retry |
| `attempts`      | Number of attempts made                                     |
| `durationMs`    | Total runtime in milliseconds                               |
| `error`         | Structured `FlowError` for failed flows                     |
| `attachments`   | Captured artifacts such as screenshots, HAR, or logs        |
| `steps`         | Low-level driver steps recorded for the flow                |
| `scenarioSteps` | Gherkin step results for scenario-style flows               |
| `workerName`    | Worker or device name when parallel mode is enabled         |

### `RunSummary`

| Field                           | Description                                        |
| ------------------------------- | -------------------------------------------------- |
| `total`                         | Total flow executions across all platforms         |
| `passed` / `failed` / `skipped` | Final result counts                                |
| `flaky`                         | Number of flaky flows                              |
| `durationMs`                    | Total run duration                                 |
| `results`                       | All `FlowResult` entries                           |
| `platforms`                     | Platforms included in the run                      |
| `bailedOut`                     | `true` when `--bail` stopped the run early         |
| `bailLimit`                     | Bail threshold that triggered the stop             |
| `workerStats`                   | Per-worker timing and flow counts in parallel mode |

### `StepResult` and `ScenarioStepResult`

`StepResult` represents low-level driver actions such as taps, assertions, typing, or network setup.

`ScenarioStepResult` represents higher-level Gherkin steps such as `Given`, `When`, `Then`, `And`, `But`, `Before`, and `After`. Each scenario step can include nested `steps` for the underlying driver actions.

### `Attachment`

```ts
interface Attachment {
  name: string;
  contentType: string;
  path: string;
}
```

Attachments point at files on disk, for example screenshots, hierarchy dumps, console logs, JavaScript errors, or HAR captures.

### `FlowError` and `FailureCategory`

```ts
interface FlowError {
  message: string;
  stack?: string;
  category: FailureCategory;
  suggestion?: string;
  errorCode?: string;
}
```

`FailureCategory` values include:

- `element-not-found`
- `element-not-visible`
- `element-off-screen`
- `element-not-interactive`
- `text-mismatch`
- `timeout`
- `device-disconnected`
- `app-crashed`
- `app-not-installed`
- `driver-error`
- `config-error`
- `unknown`

## Example: failure webhook

Spana does not await reporter hooks, and the process exits soon after `onRunComplete`. An async hook like this one can be cut off before the request finishes, so keep the work small or write to disk synchronously.

```ts
import type { Reporter } from "spana";

const reporter: Reporter = {
  async onFlowFail(result) {
    await fetch("https://hooks.example.com/test-failures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: result.name,
        platform: result.platform,
        category: result.error?.category,
        message: result.error?.message,
        worker: result.workerName,
        attachments: result.attachments?.map((attachment) => attachment.name),
      }),
    });
  },

  onRunComplete(summary) {
    console.log(`${summary.failed} failed flow(s)`);
  },
};

export default reporter;
```
