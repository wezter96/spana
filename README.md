# spana

TypeScript-native E2E testing for React Native + Web.

[Documentation](https://wezter96.github.io/spana/) | [GitHub](https://github.com/wezter96/spana) | [npm](https://www.npmjs.com/package/spana-test) | [E2E Test Report](https://htmlpreview.github.io/?https://github.com/wezter96/spana/blob/main/docs/e2e-report.html)

---

## Features

- Pure TypeScript flows, plus optional Gherkin / BDD `.feature` support
- Cross-platform execution across web, Android, and iOS from the same suite
- Local web via Playwright, local Android via UiAutomator2, local iOS via WebDriverAgent, plus Appium cloud mode
- Smart waits, retries, relative selectors, and per-flow stability defaults
- Reporters: console, JSON, JUnit XML, HTML, and Allure
- Artifacts on failure or success: screenshots, UI hierarchy dumps, and per-step capture
- App auto-install with `appPath`, iOS device signing, and BrowserStack / Sauce helper services
- CLI tooling for teams and agents: `validate`, `validate-config`, `init`, `studio`, `selectors`, `hierarchy`, and `devices`
- Execution controls for targeted and CI runs: `--device`, `--shard`, `--bail`, `--debug-on-failure`
- Browser helpers for network/auth state plus WebView / hybrid context APIs where the driver supports them

---

## Quick Start

```bash
npm install spana-test
# or
bun add spana-test
```

Create `spana.config.ts`:

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: {
      packageName: "com.example.app",
      appPath: "./builds/app.apk",
    },
    ios: {
      bundleId: "com.example.app",
      appPath: "./builds/MyApp.app",
    },
  },
  platforms: ["web", "android"],
  reporters: ["console", "html"],
  artifacts: {
    outputDir: ".spana/artifacts",
    captureOnFailure: true,
  },
});
```

Create `flows/login.flow.ts`:

```ts
import { flow } from "spana-test";

export default flow("user can log in", async ({ app, expect }) => {
  await app.tap({ testID: "email-input" });
  await app.inputText("user@example.com");
  await app.dismissKeyboard();
  await app.tap({ testID: "password-input" });
  await app.inputText("secret");
  await app.dismissKeyboard();
  await app.tap({ testID: "login-button" });
  await expect({ testID: "home-screen" }).toBeVisible();
});
```

Run:

```bash
spana validate-config
spana validate ./flows
spana test
```

---

## Capability Matrix

| Capability                                           | Web | Local Android / iOS              | Appium cloud                               |
| ---------------------------------------------------- | --- | -------------------------------- | ------------------------------------------ |
| TypeScript `.flow.ts` suites                         | Yes | Yes                              | Yes                                        |
| Gherkin `.feature` suites                            | Yes | Yes                              | Yes                                        |
| Smart waits, retries, relative selectors             | Yes | Yes                              | Yes                                        |
| HTML / JUnit / Allure reports and artifacts          | Yes | Yes                              | Yes                                        |
| App install / app reference handling                 | n/a | Yes, via `appPath`               | Yes, via capabilities and provider helpers |
| Browser helpers (`mockNetwork`, cookies, auth state) | Yes | No                               | No                                         |
| WebView context APIs                                 | n/a | Android yes, iOS via Appium mode | Yes                                        |

---

## Writing Flows

### Basic API

```ts
import { flow } from "spana-test";

export default flow(
  "checkout flow",
  {
    tags: ["smoke", "payments"],
    platforms: ["android", "ios"],
    timeout: 60_000,
    defaults: {
      waitForIdleTimeout: 250,
      typingDelay: 20,
    },
  },
  async ({ app, expect }) => {
    await app.tap({ text: "Sign In" });
    await app.inputText("hello@example.com");
    await app.dismissKeyboard();

    await app.scrollUntilVisible({ testID: "order-summary" });
    await app.doubleTap({ testID: "promo-card" });
    await app.longPress({ testID: "options-trigger" });
    await app.scroll("down");

    await expect({ testID: "welcome" }).toBeVisible();
    await expect({ text: "Welcome" }).toBeVisible();
  },
);
```

Use `scrollUntilVisible()` for off-screen targets instead of hand-written scroll loops. Use `dismissKeyboard()` for a platform-aware keyboard close path, and `backUntilVisible()` when you want system back navigation to stop on a known screen. Tap-like actions also prefer the nearest actionable container for nested label-inside-button layouts.

### FlowConfig options

| Option       | Type             | Default        | Description                                  |
| ------------ | ---------------- | -------------- | -------------------------------------------- |
| `tags`       | `string[]`       | -              | Tags for `--tag` filtering                   |
| `platforms`  | `Platform[]`     | all            | Restrict a flow to specific platforms        |
| `timeout`    | `number`         | config default | Flow timeout in ms                           |
| `autoLaunch` | `boolean`        | `true`         | Launch app before the flow starts            |
| `when`       | `WhenCondition`  | -              | Conditionally run by platform or env         |
| `artifacts`  | `ArtifactConfig` | config default | Per-flow artifact overrides                  |
| `defaults`   | `FlowDefaults`   | config default | Per-flow wait / typing / stability overrides |

### BDD parity

Spana can compile `.feature` files into the same runtime as `.flow.ts` files. Keep Gherkin scenarios for high-value readable coverage, and use step definitions for reuse:

```gherkin
Feature: Login
  Scenario: Signed-out user logs in
    Given I am on the login screen
    When I type valid credentials
    Then I should see the home screen
```

---

## CLI Commands

| Command                        | Description                                       |
| ------------------------------ | ------------------------------------------------- |
| `spana test [path]`            | Run test flows (default: `./flows`)               |
| `spana hierarchy`              | Dump full element hierarchy as JSON               |
| `spana selectors`              | List actionable elements with suggested selectors |
| `spana validate [path]`        | Validate flow files without a device connection   |
| `spana validate-config [path]` | Validate `spana.config.ts` without running flows  |
| `spana doctor`                 | Check environment readiness before a run          |
| `spana studio`                 | Launch Spana Studio                               |
| `spana init`                   | Scaffold a new Spana project                      |
| `spana init-flow <name>`       | Generate a starter `.flow.ts` file                |
| `spana devices`                | List connected devices across all platforms       |
| `spana version`                | Show version                                      |

### test options

```bash
spana test flows/login.flow.ts                   # run a single file
spana test --platform android,ios               # target platforms
spana test --device emulator-5554               # target a specific local device
spana test --tag smoke --grep "log in"          # filter flows
spana test --reporter html,allure               # choose reporters
spana test --retries 2 --shard 1/3 --bail 5     # CI-friendly execution
spana test --last-failed                        # rerun only previous failures
spana test --watch                              # rerun automatically on changes
spana test --parallel --workers 2               # parallelize across devices
spana test --update-baselines                   # refresh screenshot baselines
spana test --debug-on-failure                   # open REPL on the first failure
spana test --driver appium --appium-url $BROWSERSTACK_URL --caps ./caps/android.json --platform android
spana test --config ./spana.config.ts           # explicit config path
```

### inspection and debugging

```bash
spana hierarchy --platform android --pretty
spana selectors --platform ios
spana validate-config
spana doctor --platform android,ios
spana init-flow "checkout smoke" --preset smoke --platform web,android
spana studio --no-open
```

---

## Configuration

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: {
      packageName: "com.example.app",
      appPath: "./builds/app.apk",
    },
    ios: {
      bundleId: "com.example.app",
      appPath: "./builds/MyApp.app",
      signing: { teamId: "ABCDE12345" },
    },
  },
  execution: {
    web: {
      browser: "chromium",
      headless: true,
      storageState: "./auth/web-user.json",
      storybook: {
        url: "http://localhost:6006",
      },
    },
    appium: {
      serverUrl: process.env.BROWSERSTACK_URL,
      capabilitiesFile: "./caps/browserstack-android.json",
      reportToProvider: true,
      browserstack: {
        local: { enabled: true },
      },
    },
  },
  platforms: ["web", "android", "ios"],
  flowDir: "./flows",
  reporters: ["console", "json", "html", "allure"],
  defaults: {
    waitTimeout: 5000,
    pollInterval: 200,
    settleTimeout: 300,
    retries: 2,
    waitForIdleTimeout: 250,
    typingDelay: 20,
    initialPollInterval: 50,
    hierarchyCacheTtl: 100,
    retryDelay: 0,
  },
  launchOptions: {
    clearState: false,
  },
  artifacts: {
    outputDir: ".spana/artifacts",
    captureOnFailure: true,
    captureOnSuccess: false,
    captureSteps: false,
    screenshot: true,
    uiHierarchy: true,
  },
  hooks: {
    beforeAll: async ({ app }) => {
      /* setup */
    },
    beforeEach: async ({ app }) => {
      /* reset state */
    },
    afterEach: async ({ app, result }) => {
      /* teardown */
    },
    afterAll: async ({ app, summary }) => {
      /* cleanup */
    },
  },
});
```

`appPath` lets Spana install the app automatically for local Android and iOS runs. `execution.appium.browserstack` and `execution.appium.saucelabs` can also manage uploaded app references plus BrowserStack Local / Sauce Connect lifecycles for cloud runs.

### Browser runtime helpers (web)

```ts
import { flow } from "spana-test";

export default flow("web dashboard", async ({ app, platform }) => {
  if (platform !== "web") return;

  await app.loadAuthState("./auth/web-user.json");
  await app.mockNetwork("**/api/dashboard", {
    json: { widgets: ["revenue", "alerts"] },
  });
  await app.blockNetwork("**/analytics/**");
  await app.setNetworkConditions({ offline: false, latencyMs: 120 });
  await app.evaluate(() => console.info("dashboard hydrated"));
  console.log(await app.getConsoleLogs());
  console.log(await app.getJSErrors());
  await app.saveCookies("./tmp/cookies.json");
});
```

`mockNetwork`, `blockNetwork`, `clearNetworkMocks`, `setNetworkConditions`, `saveCookies`, `loadCookies`, `saveAuthState`, `loadAuthState`, `getConsoleLogs`, and `getJSErrors` are web-only helpers backed by local Playwright runs. Latency and throughput throttling require Chromium. When artifact capture is enabled, web failures also include captured console logs and JavaScript errors in `spana-output/` and the HTML report.

### Storybook component flows (web)

```ts
import { defineConfig, flow } from "spana-test";

// spana.config.ts
export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
  },
  execution: {
    web: {
      storybook: { url: "http://localhost:6006" },
    },
  },
});

// flows/button.flow.ts
export default flow("primary button story", async ({ app, expect, platform }) => {
  if (platform !== "web") return;

  await app.openStory("components-button--primary", {
    args: { disabled: false, size: "lg" },
    globals: { theme: "dark" },
  });

  await expect({ text: "Continue" }).toBeVisible();
});
```

`app.openStory()` opens Storybook's isolated `iframe.html` entry inside Spana's existing browser runtime. That makes Storybook a good component surface for Spana web flows, screenshots, and accessibility checks. `execution.web.storybook.url` is optional; when omitted, `openStory()` falls back to `apps.web.url`. `args` and `globals` support simple scalar values (`string`, `number`, `boolean`, `null`).

### Hybrid / WebView helpers

```ts
import { flow } from "spana-test";

export default flow("hybrid checkout", async ({ app, platform }) => {
  if (platform === "web") return;

  const contexts = await app.getContexts();
  await app.switchToWebView();
  await app.switchToNativeApp();

  console.log(contexts);
});
```

Context APIs depend on driver support. Appium mode is the best path for iOS WebView automation.

---

## Selectors

| Selector             | Example                           | Notes                                                                                                 |
| -------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `testID`             | `{ testID: "login-btn" }`         | Preferred - maps to `accessibilityIdentifier` (iOS), `resource-id` (Android), and `data-testid` (web) |
| `text`               | `{ text: "Sign In" }`             | Visible label text, partial match supported                                                           |
| `accessibilityLabel` | `{ accessibilityLabel: "Close" }` | OS accessibility label                                                                                |
| `point`              | `{ point: { x: 100, y: 200 } }`   | Absolute coordinate tap, use as a last resort                                                         |

Selectors can be combined. When multiple fields are set, all must match.

### Relative selectors

For actions that accept an extended selector, you can locate an element relative to another one:

```ts
await app.tap({
  selector: { testID: "confirm-button" },
  below: { text: "Delete account" },
});
```

Supported relations: `below`, `above`, `leftOf`, `rightOf`, and `childOf`.

---

## Tooling and Debugging

Spana ships a few built-in workflows that are easy to miss from the minimal quick start:

- `spana validate-config` catches config issues before a suite starts
- `spana init` scaffolds a starter project
- `spana devices` lists local execution targets
- `spana studio` launches a browser UI for inspection and test runs
- `--debug-on-failure` drops into an interactive REPL with bound `app` and driver context
- `--device`, `--shard`, and `--bail` help with targeted local runs and CI fan-out

---

## Agent Integration

`spana` is designed for AI agent workflows:

- `spana selectors --platform android` returns JSON with element details and suggested selectors
- `spana hierarchy --platform web --pretty` dumps the accessibility tree as structured JSON
- `spana validate` exits non-zero on invalid flows, which works well as a preflight step
- `--reporter json` emits structured JSON events to stdout for downstream analysis

Example agent loop:

```bash
# 1. discover what's on screen
spana selectors --platform web | jq '.[] | select(.testID != null)'

# 2. run a specific flow with JSON output
spana test flows/login.flow.ts --reporter json 2>&1 | jq '.results'
```

---

## Cloud Testing

Spana supports running the same TypeScript flows on cloud device farms via Appium mode.

```bash
# BrowserStack
spana test --driver appium --appium-url $BROWSERSTACK_URL --caps ./caps/browserstack-android.json --platform android

# Sauce Labs
spana test --driver appium --appium-url $SAUCE_URL --caps ./caps/saucelabs-android.json --platform android
```

Or configure it in `spana.config.ts`:

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: process.env.BROWSERSTACK_URL,
      capabilitiesFile: "./caps/browserstack-android.json",
      reportToProvider: true,
      browserstack: {
        local: { enabled: true },
      },
    },
  },
  apps: {
    android: {
      packageName: "com.example.myapp",
      appPath: "./builds/app.apk",
    },
  },
});
```

Spana ships first-class helper services for **BrowserStack** and **Sauce Labs**:

- managed app upload and app reference resolution
- BrowserStack Local lifecycle management
- Sauce Connect lifecycle management
- provider result reporting

Generic Appium hubs still work even without provider-specific helpers.

Guides:

- [BrowserStack setup](https://github.com/wezter96/spana/blob/main/docs/cloud/browserstack.md)
- [Sauce Labs setup](https://github.com/wezter96/spana/blob/main/docs/cloud/saucelabs.md)
- [Example capabilities](https://github.com/wezter96/spana/tree/main/examples/caps)

---

## Example Reports

Real reports generated from the framework-app test suite are checked into
[`docs/examples/reports/`](./docs/examples/reports). They're regenerated from
an actual `spana test` run against the demo app and kept up to date with each
release. Use them as reference for wiring spana into CI or integrating with
existing reporting pipelines.

| File                                                                                                               | Reporter                | What it shows                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`framework-app-single-flow.json`](./docs/examples/reports/framework-app-single-flow.json)                         | `json` (pretty-printed) | A single flow's full structured output — steps, selectors, timings, and attachments. Start here if you want to understand the JSON schema.                                         |
| [`framework-app-web.ndjson`](./docs/examples/reports/framework-app-web.ndjson)                                     | `json` (streaming)      | Full suite in newline-delimited JSON — one event per line. This is what `--reporter json` emits to stdout, suitable for piping into CI dashboards.                                 |
| [`framework-app.junit.xml`](./docs/examples/reports/framework-app.junit.xml)                                       | `junit`                 | Standard JUnit XML. Drop straight into GitHub Actions, GitLab CI, Jenkins, or anything else that speaks JUnit.                                                                     |
| [E2E HTML report](https://htmlpreview.github.io/?https://github.com/wezter96/spana/blob/main/docs/e2e-report.html) | `html`                  | Full self-contained HTML report with embedded screenshots, hierarchy dumps, and step-by-step timelines. Hosted via htmlpreview.github.io so you can click through without cloning. |

Generate your own by passing `--reporter` to `spana test`:

```bash
# Streaming JSON events to stdout
spana test --platform web --reporter json > run.ndjson

# JUnit XML (writes spana-output/junit-report.xml)
spana test --platform android --reporter junit

# HTML (writes spana-output/report.html)
spana test --reporter html

# Multiple reporters at once
spana test --reporter console,junit,html
```

Reporters can also be pinned in `spana.config.ts` via the `reporters` array.

---

## Architecture

spana uses a layered architecture: CLI -> TestRunner -> PlatformOrchestrator -> SmartLayer -> RawDriver.

Raw drivers are thin HTTP clients. All selector matching, auto-wait, retry, and element resolution lives in the TypeScript smart layer instead of companion binaries.

See [ARCHITECTURE.md](https://github.com/wezter96/spana/blob/main/ARCHITECTURE.md) for details.

---

## Platforms

| Platform      | Driver                      | Companion binary                                         |
| ------------- | --------------------------- | -------------------------------------------------------- |
| Web / RN Web  | Playwright (CDP)            | None - Playwright is a dev dependency                    |
| Android       | UiAutomator2 HTTP client    | Appium UiAutomator2 server APK (bundled)                 |
| iOS Simulator | WebDriverAgent HTTP client  | WDA XCTest bundle (bundled unsigned)                     |
| iOS Device    | Same WDA bundle             | Re-signed with `codesign`; requires `iproxy`             |
| Appium cloud  | Appium 2 / 3 compatible hub | BrowserStack, Sauce Labs, or another W3C-compatible grid |

---

## License

Apache-2.0
