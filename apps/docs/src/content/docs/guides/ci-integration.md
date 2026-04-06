---
title: CI/CD Integration
description: Run spana tests in continuous integration pipelines with structured reporting and artifacts.
---

spana is designed for CI from the ground up. It ships as a single npm package (`spana-test`), produces machine-readable output via JSON and JUnit reporters, and uses standard exit codes so your pipeline can react to results without parsing logs.

## Exit codes

| Code | Meaning                      |
| ---- | ---------------------------- |
| `0`  | All flows passed             |
| `1`  | One or more flows failed     |
| `2`  | Configuration or setup error |

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

- **`junit`** — writes a JUnit XML file to `spana-output/junit.xml`, understood by most CI systems.
- **`json`** — writes structured JSON to stdout, useful for piping to other tools.
- **`html`** — writes an HTML report to `spana-output/report.html` with screenshots and step details.

## GitHub Actions

### Using the reusable action

Spana provides a composite GitHub Action that handles installation, test execution, and artifact upload:

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
          node-version: 20
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
          node-version: 20
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
          node-version: 20
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

| Input              | Default              | Description                             |
| ------------------ | -------------------- | --------------------------------------- |
| `platform`         | `web`                | Platform to test (web, android, ios)    |
| `reporters`        | `console,junit,html` | Comma-separated reporter names          |
| `config`           | —                    | Path to spana.config.ts                 |
| `flow-path`        | —                    | Path to flow files or directory         |
| `device`           | —                    | Target a specific device by ID          |
| `retries`          | —                    | Number of retries for failed flows      |
| `tags`             | —                    | Filter by tags                          |
| `grep`             | —                    | Filter by name pattern                  |
| `upload-artifacts` | `true`               | Upload spana-output/ as build artifacts |

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
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Install spana
        run: npm install -g spana-test

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
          path: spana-output/junit.xml

      - name: Upload HTML report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: html-report
          path: spana-output/report.html

      - name: Upload screenshots
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: screenshots
          path: spana-output/screenshots/
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
        node-version: 20

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
        node-version: 20

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
      junit: spana-output/junit.xml
```

GitLab natively parses JUnit XML when declared under `artifacts.reports.junit`, so test results appear directly in merge request widgets.

## Tips

- **Combine reporters.** Use `--reporter console,junit,html` to get terminal output for logs, JUnit for CI dashboards, and HTML for manual review — all in one run.
- **Upload `spana-output/` as artifacts.** This directory contains JUnit XML, HTML reports, and screenshots from failed steps. Always upload with `if: always()` (GitHub Actions) or `when: always` (GitLab) so artifacts are available even when tests fail.
- **Headless web works out of the box.** Playwright runs headless by default. No `xvfb` or display server setup needed.
- **Use tags to split pipelines.** Run `spana test --tag smoke` on every push and `spana test --tag regression` on a nightly schedule to balance speed and coverage.
- **Pin spana version.** Use `npm install -g spana-test@0.1.0` in CI to avoid unexpected breakage from new releases.
