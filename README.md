# spana

TypeScript-native E2E testing for React Native + Web

[Documentation](https://wezter96.github.io/spana/) | [GitHub](https://github.com/wezter96/spana) | [npm](https://www.npmjs.com/package/spana-test) | [E2E Test Report](https://htmlpreview.github.io/?https://github.com/wezter96/spana/blob/main/docs/e2e-report.html)

---

## Features

- Pure TypeScript — no YAML, no JVM, no app modification required
- Cross-platform — Web, Android, iOS from a single test file
- Web via Playwright (CDP), Android via UiAutomator2, iOS via WebDriverAgent
- Agent-first design — JSON reporter, hierarchy dump, and selector discovery for AI agents
- Auto-wait with configurable poll interval, settle timeout, and retries
- Multiple reporters: console, JSON, JUnit XML, HTML
- Artifact capture (screenshots + UI hierarchy) on failure

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
    android: { packageName: "com.example.app" },
    ios: { bundleId: "com.example.app" },
  },
  platforms: ["web", "android"],
});
```

Create `flows/login.ts`:

```ts
import { flow } from "spana-test";

export default flow("user can log in", async ({ app, expect }) => {
  await app.tap({ testID: "email-input" });
  await app.typeText("user@example.com");
  await app.tap({ testID: "password-input" });
  await app.typeText("secret");
  await app.tap({ testID: "login-button" });
  await expect({ testID: "home-screen" }).toBeVisible();
});
```

Run:

```bash
spana test
```

---

## Writing Flows

### Basic API

```ts
import { flow } from "spana-test";

export default flow("flow name", async ({ app, expect, platform }) => {
  // tap, type, scroll
  await app.tap({ text: "Sign In" });
  await app.typeText("hello");
  await app.scroll({ direction: "down" });

  // assertions
  await expect({ testID: "welcome" }).toBeVisible();
  await expect({ text: "Welcome" }).toBeVisible();

  // platform branching
  if (platform === "web") {
    await app.tap({ testID: "web-only-button" });
  }
});
```

### With config

```ts
export default flow(
  "checkout flow",
  { tags: ["smoke", "payments"], platforms: ["android", "ios"], timeout: 60000 },
  async ({ app, expect }) => {
    // ...
  },
);
```

### FlowConfig options

| Option       | Type         | Default        | Description                    |
| ------------ | ------------ | -------------- | ------------------------------ |
| `tags`       | `string[]`   | —              | Tag for filtering with `--tag` |
| `platforms`  | `Platform[]` | all            | Restrict to specific platforms |
| `timeout`    | `number`     | config default | Timeout in ms for this flow    |
| `autoLaunch` | `boolean`    | `true`         | Launch app before flow starts  |

---

## CLI Commands

| Command                 | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `spana test [path]`     | Run test flows (default: `./flows`)               |
| `spana hierarchy`       | Dump full element hierarchy as JSON               |
| `spana selectors`       | List actionable elements with suggested selectors |
| `spana validate [path]` | Validate flow files without a device connection   |
| `spana devices`         | List connected devices across all platforms       |
| `spana version`         | Show version                                      |

### test options

```bash
spana test flows/login.ts              # run a single file
spana test --platform android,ios      # target platforms (default: web)
spana test --tag smoke                 # filter by tag
spana test --grep "log in"             # filter by name pattern
spana test --reporter json             # reporter format
spana test --reporter html             # self-contained HTML report
spana test --config ./spana.config.ts   # explicit config path
```

### hierarchy / selectors options

```bash
spana hierarchy --platform android --pretty
spana selectors --platform ios
```

---

## Configuration

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: { packageName: "com.example.app" },
    ios: { bundleId: "com.example.app" },
  },
  execution: {
    web: {
      browser: "chromium",
      headless: true,
      storageState: "./auth/web-user.json",
    },
  },
  platforms: ["web", "android", "ios"],
  flowDir: "./flows",
  reporters: ["console", "json", "html"],
  defaults: {
    waitTimeout: 5000, // ms to wait for element
    pollInterval: 200, // ms between polls
    settleTimeout: 300, // ms of stability before match
    retries: 2, // retries on action failure
  },
  artifacts: {
    outputDir: ".spana/artifacts",
    captureOnFailure: true, // screenshot + hierarchy on failure
    captureOnSuccess: false,
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

`execution.web` controls the local Playwright runtime for web flows. Use it to switch browser engines, run headed for debugging, or preload a saved storage state file.

### Browser runtime helpers (web)

```ts
export default flow("web dashboard", async ({ app, platform }) => {
  if (platform !== "web") return;

  await app.loadAuthState("./auth/web-user.json");
  await app.mockNetwork("**/api/dashboard", {
    json: { widgets: ["revenue", "alerts"] },
  });
  await app.blockNetwork("**/analytics/**");
  await app.setNetworkConditions({ offline: false, latencyMs: 120 });
  await app.saveCookies("./tmp/cookies.json");
});
```

`mockNetwork`, `blockNetwork`, `clearNetworkMocks`, `setNetworkConditions`, `saveCookies`, `loadCookies`, `saveAuthState`, and `loadAuthState` are web-only helpers backed by Playwright. Latency and throughput throttling require the Chromium browser runtime.

---

## Selectors

| Selector             | Example                           | Notes                                                                                             |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `testID`             | `{ testID: "login-btn" }`         | Preferred — maps to `accessibilityIdentifier` (iOS), `resource-id` (Android), `data-testid` (web) |
| `text`               | `{ text: "Sign In" }`             | Visible label text, partial match supported                                                       |
| `accessibilityLabel` | `{ accessibilityLabel: "Close" }` | OS accessibility label                                                                            |
| `point`              | `{ point: { x: 100, y: 200 } }`   | Absolute coordinate tap, use as last resort                                                       |

Selectors can be combined. When multiple fields are set, all must match.

---

## Agent Integration

`spana` is designed for AI agent workflows:

- `spana selectors --platform android` returns JSON with element details and suggested selectors — feed this to an agent to identify what to interact with
- `spana hierarchy --platform web --pretty` dumps the full accessibility tree as structured JSON
- `spana validate` exits non-zero on invalid flows — use in CI preflight
- `--reporter json` emits structured JSON events to stdout — pipe to an agent for result analysis

Example agent loop:

```bash
# 1. discover what's on screen
spana selectors --platform web | jq '.[] | select(.testID != null)'

# 2. run a specific flow with JSON output
spana test flows/login.ts --reporter json 2>&1 | jq '.results'
```

---

## Cloud Testing

Spana supports running tests on cloud device farms via Appium cloud mode. Instead of controlling local devices, Spana connects to a remote Appium hub (BrowserStack, Sauce Labs, or any W3C-compatible grid) and runs your TypeScript flows there.

```bash
# BrowserStack
spana test --driver appium --appium-url $BROWSERSTACK_URL --caps ./caps/browserstack-android.json --platform android

# Sauce Labs
spana test --driver appium --appium-url $SAUCE_URL --caps ./caps/saucelabs-android.json --platform android
```

Or configure in `spana.config.ts`:

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: process.env.BROWSERSTACK_URL,
      capabilitiesFile: "./caps/browserstack-android.json",
      reportToProvider: true,
    },
  },
  apps: {
    android: { packageName: "com.example.myapp" },
  },
});
```

Guides:

- [BrowserStack setup](./docs/cloud/browserstack.md)
- [Sauce Labs setup](./docs/cloud/saucelabs.md)
- [Example capabilities](./examples/caps/)

### Smoke validation checklist

Before relying on cloud mode in CI, verify these work end-to-end:

1. Self-hosted Appium -- Android session against a local Appium server
2. BrowserStack -- Android real-device session
3. Sauce Labs -- iOS simulator or real-device session

---

## Architecture

spana uses a layered architecture: CLI -> TestRunner -> PlatformOrchestrator -> SmartLayer -> RawDriver.

Raw drivers are thin HTTP clients. All selector matching, auto-wait, retry, and element resolution lives in the TypeScript SmartLayer — no logic in companion binaries.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

---

## Platforms

| Platform      | Driver                     | Companion binary                                                  |
| ------------- | -------------------------- | ----------------------------------------------------------------- |
| Web / RN Web  | Playwright (CDP)           | None — Playwright is a dev dependency                             |
| Android       | UiAutomator2 HTTP client   | Appium UiAutomator2 server APK (bundled, ~2-3 MB)                 |
| iOS Simulator | WebDriverAgent HTTP client | WDA XCTest bundle (bundled unsigned, ~5 MB)                       |
| iOS Device    | Same WDA bundle            | Re-signed with user certificate via `codesign`; requires `iproxy` |

---

## License

Apache-2.0
