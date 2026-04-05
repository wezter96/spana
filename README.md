# spana

TypeScript-native E2E testing for React Native + Web

[Documentation](https://wezter96.github.io/spana/) | [GitHub](https://github.com/wezter96/spana) | [npm](https://www.npmjs.com/package/spana) | [E2E Test Report](https://htmlpreview.github.io/?https://github.com/wezter96/spana/blob/main/docs/e2e-report.html)

---

## Features

- Pure TypeScript — no YAML, no JVM, no app modification required
- Cross-platform — Web, Android, iOS from a single test file
- Web via Playwright (CDP), Android via UiAutomator2, iOS via WebDriverAgent
- Agent-first design — JSON reporter, hierarchy dump, and selector discovery for AI agents
- Auto-wait with configurable poll interval, settle timeout, and retries
- Multiple reporters: console, JSON, JUnit XML, HTML, Allure
- Artifact capture (screenshots + UI hierarchy) on failure

---

## Quick Start

```bash
bun add spana
```

Create `spana.config.ts`:

```ts
import { defineConfig } from "spana";

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
import { flow } from "spana";

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
import { flow } from "spana";

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
import { defineConfig } from "spana";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: { packageName: "com.example.app" },
    ios: { bundleId: "com.example.app" },
  },
  platforms: ["web", "android", "ios"],
  flowDir: "./flows",
  reporters: ["console", "json"],
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
