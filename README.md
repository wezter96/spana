# prov

TypeScript-native E2E testing for React Native + Web

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
bun add prov
```

Create `prov.config.ts`:

```ts
import { defineConfig } from "prov";

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
import { flow } from "prov";

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
prov test
```

---

## Writing Flows

### Basic API

```ts
import { flow } from "prov";

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
  }
);
```

### FlowConfig options

| Option | Type | Default | Description |
|---|---|---|---|
| `tags` | `string[]` | — | Tag for filtering with `--tag` |
| `platforms` | `Platform[]` | all | Restrict to specific platforms |
| `timeout` | `number` | config default | Timeout in ms for this flow |
| `autoLaunch` | `boolean` | `true` | Launch app before flow starts |

---

## CLI Commands

| Command | Description |
|---|---|
| `prov test [path]` | Run test flows (default: `./flows`) |
| `prov hierarchy` | Dump full element hierarchy as JSON |
| `prov selectors` | List actionable elements with suggested selectors |
| `prov validate [path]` | Validate flow files without a device connection |
| `prov devices` | List connected devices across all platforms |
| `prov version` | Show version |

### test options

```bash
prov test flows/login.ts              # run a single file
prov test --platform android,ios      # target platforms (default: web)
prov test --tag smoke                 # filter by tag
prov test --grep "log in"             # filter by name pattern
prov test --reporter json             # reporter format
prov test --config ./prov.config.ts   # explicit config path
```

### hierarchy / selectors options

```bash
prov hierarchy --platform android --pretty
prov selectors --platform ios
```

---

## Configuration

```ts
import { defineConfig } from "prov";

export default defineConfig({
  apps: {
    web:     { url: "http://localhost:3000" },
    android: { packageName: "com.example.app" },
    ios:     { bundleId: "com.example.app" },
  },
  platforms: ["web", "android", "ios"],
  flowDir: "./flows",
  reporters: ["console", "json"],
  defaults: {
    waitTimeout:   5000,  // ms to wait for element
    pollInterval:  200,   // ms between polls
    settleTimeout: 300,   // ms of stability before match
    retries:       2,     // retries on action failure
  },
  artifacts: {
    outputDir:        ".prov/artifacts",
    captureOnFailure: true,   // screenshot + hierarchy on failure
    captureOnSuccess: false,
    screenshot:       true,
    uiHierarchy:      true,
  },
  hooks: {
    beforeAll:  async ({ app }) => { /* setup */ },
    beforeEach: async ({ app }) => { /* reset state */ },
    afterEach:  async ({ app, result }) => { /* teardown */ },
    afterAll:   async ({ app, summary }) => { /* cleanup */ },
  },
});
```

---

## Selectors

| Selector | Example | Notes |
|---|---|---|
| `testID` | `{ testID: "login-btn" }` | Preferred — maps to `accessibilityIdentifier` (iOS), `resource-id` (Android), `data-testid` (web) |
| `text` | `{ text: "Sign In" }` | Visible label text, partial match supported |
| `accessibilityLabel` | `{ accessibilityLabel: "Close" }` | OS accessibility label |
| `point` | `{ point: { x: 100, y: 200 } }` | Absolute coordinate tap, use as last resort |

Selectors can be combined. When multiple fields are set, all must match.

---

## Agent Integration

`prov` is designed for AI agent workflows:

- `prov selectors --platform android` returns JSON with element details and suggested selectors — feed this to an agent to identify what to interact with
- `prov hierarchy --platform web --pretty` dumps the full accessibility tree as structured JSON
- `prov validate` exits non-zero on invalid flows — use in CI preflight
- `--reporter json` emits structured JSON events to stdout — pipe to an agent for result analysis

Example agent loop:

```bash
# 1. discover what's on screen
prov selectors --platform web | jq '.[] | select(.testID != null)'

# 2. run a specific flow with JSON output
prov test flows/login.ts --reporter json 2>&1 | jq '.results'
```

---

## Architecture

prov uses a layered architecture: CLI -> TestRunner -> PlatformOrchestrator -> SmartLayer -> RawDriver.

Raw drivers are thin HTTP clients. All selector matching, auto-wait, retry, and element resolution lives in the TypeScript SmartLayer — no logic in companion binaries.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

---

## Platforms

| Platform | Driver | Companion binary |
|---|---|---|
| Web / RN Web | Playwright (CDP) | None — Playwright is a dev dependency |
| Android | UiAutomator2 HTTP client | Appium UiAutomator2 server APK (bundled, ~2-3 MB) |
| iOS Simulator | WebDriverAgent HTTP client | WDA XCTest bundle (bundled unsigned, ~5 MB) |
| iOS Device | Same WDA bundle | Re-signed with user certificate via `codesign`; requires `iproxy` |

---

## License

MIT
