---
title: CI/CD Integration
description: Run spana tests in continuous integration pipelines with structured reporting and artifacts.
---

spana is designed for CI from the ground up. It ships as a single npm package (`spana-test`), produces machine-readable output via JSON and JUnit reporters, and uses standard exit codes so your pipeline can react to results without parsing logs.

## Exit codes

| Code | Meaning                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | No flow failed. This includes runs where no flows matched, `--changed-since` filtered out every flow, or a platform was skipped because no device was found. |
| `1`  | At least one flow failed, or the command could not start (invalid options, a config that fails to load, missing Appium URL).                                 |

## Reporters for CI

Use the `--reporter` flag to control output format. Multiple reporters can be combined with commas.

```bash
# Machine-readable results for CI dashboards
spana test --reporter json,junit

# Human-readable HTML report for review
spana test --reporter html

# Combined: console output + JUnit + HTML
spana test --reporter console,junit,html
```

- **`junit`** — writes a JUnit XML file to `spana-output/junit-report.xml`, understood by most CI systems.
- **`json`** — prints one JSON event per line to stdout (`flowPass`, `flowFail`, `flowSkip`, `runComplete`), useful for piping to other tools.
- **`html`** — writes an HTML report to `spana-output/report.html` with screenshots and step details.
- **`allure`** — writes Allure result files for an Allure report.
- **`github`** — writes a PR-ready Markdown summary (`spana-output/github-pr-summary.md`) and appends directly to `$GITHUB_STEP_SUMMARY` in GitHub Actions.

The output directory is `artifacts.outputDir` (default `./spana-output`). Per-flow artifacts (screenshots, `hierarchy.json`, `failure-bundle.json`) go in `spana-output/<flow>-<platform>/`.

## PR-Aware CI Filtering (`--changed-since`)

Run only the flows affected by a pull request while staying **fail-open**. `--changed-since <ref>` diffs against `git merge-base <ref> HEAD` and runs the `filters` from `spana.config.ts` in order.

`--changed-since` does nothing without a `filters` list in config: spana prints a warning and runs all flows. If git fails (for example, the base ref is missing in a shallow clone), spana also fails open and runs all flows. If one filter throws, that filter is skipped and keeps every flow it received (flows an earlier filter excluded stay excluded). If the filters exclude every flow, the run exits `0`.

Built-in filters (all exported from `spana-test`):

- **`pathRuleFilter`** — deterministic, no LLM. Maps flow tags or file prefixes to watched source paths. Flows that no rule owns always run.
- **`deterministicImpactFilter`** — deterministic, no LLM. Uses path mappings and the import graph; by default, unmapped changes run everything.
- **`decisionFilter`** — asks a model judge (`createLogprobDecisionJudge` or `createOllamaDecisionJudge`) how likely each flow is affected, and skips flows below `threshold` (default `0.20`).

All three always keep changed flow files and flows with `alwaysRunTags`, and run everything when `spana.config.*` or a lockfile changes or a `runAllOnPaths` prefix matches. `decisionFilter` also runs everything when the diff exceeds `maxDiffBytes` (default 60 kB) and keeps a flow when the judge errors.

```ts
// spana.config.ts
import {
  defineConfig,
  decisionFilter,
  createLogprobDecisionJudge,
  pathRuleFilter,
} from "spana-test";

export default defineConfig({
  filters: [
    pathRuleFilter({
      rules: [{ matchFlow: { tag: "billing" }, watchPaths: ["src/billing/"] }],
    }),
    decisionFilter({
      alwaysRunTags: ["smoke"],
      judge: createLogprobDecisionJudge({
        provider: "openai", // works with vLLM, SGLang, llama-server, Typesafe AI, OpenRouter, or "ollama"
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "typesafe-ai/jev",
      }),
    }),
  ],
});
```

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # required for merge-base diffing

- name: Run affected E2E flows
  run: >-
    npx spana test
    --parallel --workers 4
    --reporter console,junit,github
    ${{ github.event_name == 'pull_request' && format('--changed-since origin/{0}', github.base_ref) || '' }}
```

`createLogprobDecisionJudge` places the shared git diff prefix **first** in every prompt so vLLM, SGLang, and llama.cpp can reuse the KV cache across every flow in the PR. It requests a single token (`YES` / `NO`) with `logprobs` and turns the top logprobs into a probability.

Spana also persists per-flow durations in `spana-output/.spana/last-run.json`. On later runs, multi-worker runs (`--parallel` / `--workers` / `--devices`) schedule the slowest flows first (`orderFlowsLongestFirst`), and `--shard` uses the durations to balance shards. Cache this file between CI runs to keep the benefit.

## GitHub Actions

### Using the reusable action

The spana repository contains a composite GitHub Action (`.github/actions/spana-test`) that handles installation, test execution, and artifact upload. The examples below reference it as a local action, so copy it into your repository first:

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run dev &
      - run: npx wait-on http://localhost:3000

      - name: Run E2E tests
        uses: ./.github/actions/spana-test
        with:
          platform: web
          reporters: console,junit,html

  e2e-android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci

      - name: Set up Android emulator
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 33
          script: echo "Emulator ready"

      - name: Run E2E tests
        uses: ./.github/actions/spana-test
        with:
          platform: android
          retries: 1

  e2e-ios:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci

      - name: Boot iOS Simulator
        run: |
          xcrun simctl boot "iPhone 15"
          xcrun simctl bootstatus "iPhone 15" -b

      - name: Run E2E tests
        uses: ./.github/actions/spana-test
        with:
          platform: ios
```

#### Action inputs

| Input               | Default              | Description                                               |
| ------------------- | -------------------- | --------------------------------------------------------- |
| `platform`          | `web`                | Platform to test (web, android, ios)                      |
| `reporters`         | `console,junit,html` | Comma-separated reporter names                            |
| `config`            | —                    | Path to spana.config.ts                                   |
| `flow-path`         | —                    | Path to flow files or directory                           |
| `device`            | —                    | Target a specific device by ID                            |
| `retries`           | —                    | Number of retries for failed flows                        |
| `tags`              | —                    | Filter by tags                                            |
| `grep`              | —                    | Filter by name pattern                                    |
| `working-directory` | `.`                  | Directory to run spana in                                 |
| `version`           | `latest`             | `spana-test` version to install                           |
| `upload-artifacts`  | `true`               | Upload `spana-output/` and `allure-results/` as artifacts |

The action also sets a `result` output (`pass` or `fail`).

### Manual workflow setup

If you prefer full control over the workflow steps:

```yaml
name: E2E Tests (Web)

on: [push, pull_request]

jobs:
  e2e-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Install dependencies
        run: npm ci

      - name: Install spana
        run: npm install -g spana-test

      - name: Install Chromium
        run: npx playwright install chromium

      - name: Start app
        run: npm run dev &

      - name: Wait for app
        run: npx wait-on http://localhost:3000

      - name: Run tests
        run: spana test --platform web --reporter console,junit,html

      - name: Upload JUnit results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: junit-results
          path: spana-output/junit-report.xml

      - name: Upload HTML report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: html-report
          path: spana-output/report.html

      - name: Upload per-flow artifacts (screenshots, hierarchy, failure bundles)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: spana-output
          path: spana-output/
```

### Android tests

Android tests need the Android SDK. GitHub's `ubuntu-latest` runners include the SDK, but you need to boot an emulator.

```yaml
e2e-android:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: 24

    - name: Install spana
      run: npm install -g spana-test

    - name: Set up Android emulator
      uses: reactivecircus/android-emulator-runner@v2
      with:
        api-level: 33
        script: |
          adb wait-for-device
          spana test --platform android --reporter console,junit,html

    - name: Upload test artifacts
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: android-results
        path: spana-output/
```

### iOS tests

iOS tests require a macOS runner with Xcode installed.

```yaml
e2e-ios:
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: 24

    - name: Install spana
      run: npm install -g spana-test

    - name: Boot iOS Simulator
      run: |
        xcrun simctl boot "iPhone 15"
        xcrun simctl bootstatus "iPhone 15" -b

    - name: Install app and run tests
      run: spana test --platform ios --reporter console,junit,html

    - name: Upload test artifacts
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: ios-results
        path: spana-output/
```

## GitLab CI

```yaml
e2e-web:
  image: node:20
  stage: test
  script:
    - npm ci
    - npm install -g spana-test
    - npm run dev &
    - npx wait-on http://localhost:3000
    - spana test --platform web --reporter console,junit,html
  artifacts:
    when: always
    paths:
      - spana-output/
    reports:
      junit: spana-output/junit-report.xml
```

GitLab natively parses JUnit XML when declared under `artifacts.reports.junit`, so test results appear directly in merge request widgets.

## Tips

- **Combine reporters.** Use `--reporter console,junit,html` to get terminal output for logs, JUnit for CI dashboards, and HTML for manual review — all in one run.
- **Upload `spana-output/` as artifacts.** This directory contains JUnit XML, HTML reports, and per-flow screenshots, hierarchies, and failure bundles. Always upload with `if: always()` (GitHub Actions) or `when: always` (GitLab) so artifacts are available even when tests fail.
- **Headless web & Ubuntu 23.10+ CI runners work out of the box.** Web runs are headless by default (`execution.web.headless`), and Direct CDP defaults to `execution.web.chromiumSandbox: false` (`--no-sandbox`, matching Playwright) so Ubuntu 23.10+ / GitHub Actions runners with AppArmor `unprivileged_userns` restrictions launch cleanly without extra flags. Set `chromiumSandbox: true` only if your host enables unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=0`). Install a browser on the runner first (`npx playwright install chromium`).
- **Pick a web engine.** `execution.web.engine` accepts `"playwright"` (default), `"cdp"`, `"lightpanda"`, or `"auto"`. `"auto"` uses the direct CDP engine for Chromium unless `wsEndpoint`, `channel`, or `artifacts.har` needs Playwright. Note that Direct CDP browser-context mode defaults to `waitUntil: "domcontentloaded"` while Playwright defaults to `waitUntil: "load"`.
- **Scale web workers.** `--workers <n>` runs `n` isolated browser contexts, spread over browser processes by `execution.web.maxContextsPerBrowser`.
- **Split across jobs (duration-balanced).** `--shard <current>/<total>` distributes flows using Longest-Processing-Time-First (LPT) bin packing when historical timings exist. Pass `--timings <path>` (or set `defaults.timingsFile` to a committed/cached `spana-timings.json` or a directory of per-shard JSON files) and `--write-timings <path>` so every CI runner finishes at roughly the same wall time.
- **Use tags to split pipelines.** Run `spana test --tag smoke` on every push and `spana test --tag regression` on a nightly schedule to balance speed and coverage.
- **Pin spana version.** Use `npm install -g spana-test@<version>` (for example `spana-test@0.7.0`) in CI to avoid unexpected breakage from new releases.
