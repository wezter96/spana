# Writing spana Tests

## When to use

Use this skill when setting up, writing, debugging, or iterating on **spana (`spana-test`)** E2E tests across **Web, Android (Capacitor/WebView & React Native), iOS (WKWebView & React Native), Electron, and Electrobun**. Spana uses pure TypeScript `flow()` files (plus optional Gherkin `.feature` files) with a dual-channel web-first engine — zero Appium required locally.

Full online docs & LLM reference: `https://spana.antonwester.se/llms-full.txt`

---

## Preferred Agent Workflow: `spana mcp` (Model-Free Stdio MCP Server)

When connected to `spana mcp` (`npx spana mcp` / `bunx spana mcp`), drive live sessions directly at sub-5 ms tool latency instead of shelling out repeatedly:

| MCP Tool                                             | Purpose                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `spana_session_start`                                | Start a live session (`web`, `android`, `ios`, `electron`, `electrobun`)  |
| `spana_observe`                                      | Compact interactive element tree (~273 tokens avg) with `testID` & bounds |
| `spana_tap` / `spana_input_text` / `spana_press_key` | Execute verified pointer/keyboard actions (2–4 ms on web)                 |
| `spana_assert_visible` / `spana_assert_text`         | Run real auto-waiting assertions (~1 ms on web)                           |
| `spana_diagnostics`                                  | Fetch browser console logs & uncaught JS errors (~0.8 ms)                 |
| `spana_screenshot`                                   | Capture PNG screenshot when visual inspection is needed                   |
| `spana_export_flow`                                  | Export the verified action trace as a deterministic `.flow.ts` file       |
| `spana_run_flow` / `spana_session_stop`              | Execute existing `.flow.ts` files and cleanly tear down                   |

---

## CLI Discovery & Execution Loop

```bash
# 1. Check environment readiness (web, Android/iOS WebView, WDA/UA2, Electron, Electrobun)
spana doctor --json

# 2. Discover interactable elements with suggested selectors
spana selectors --platform web
spana selectors --platform android
spana selectors --platform ios
spana hierarchy --platform web --pretty

# 3. Validate flows without a device/browser
spana validate-config
spana validate flows/

# 4. Run tests (fast parallel + structured output)
spana test flows/login.flow.ts --reporter json
spana test --platform web --parallel --workers 4
spana test --changed-since origin/main --reporter console,github
spana test --last-failed
spana test --strict-cache   # 0-LLM verified replay cache in CI

# 5. Manage persistent warm daemons (Chromium / WDA / UiAutomator2)
spana daemon status
spana daemon stop
```

---

## Writing Flows

### Standard `.flow.ts`

```ts
import { flow, systemUI } from "spana-test";

export default flow(
  "SSO sign-in across WebView and native sheet",
  { tags: ["smoke", "auth"], platforms: ["web", "android", "ios"], timeout: 30_000 },
  async ({ app, expect, platform }) => {
    await app.tap({ testID: "sign-in" }); // ~1 ms DOM lookup -> real native touch
    if (platform !== "web") {
      await app.tap(systemUI({ text: "Continue" })); // SFSafariViewController / Chrome Custom Tabs
    }
    await expect({ testID: "profile-id" }).toBeVisible();
  },
);
```

### Composable Lazy Fixtures & Named Setups

```ts
import { createFlowWithFixtures, defineSetup } from "spana-test";

const adminSetup = defineSetup("admin", {
  storage: { localStorage: { auth_token: "test-admin-jwt" } },
});

const testFlow = createFlowWithFixtures({
  setups: { admin: adminSetup },
  fixtures: {
    seededOrder: async ({ app }, use) => {
      const orderId = "ord_123";
      await use(orderId);
    },
  },
});

export default testFlow(
  "admin inspects order",
  { setup: "admin" },
  async ({ app, expect, seededOrder }) => {
    await app.openLink(`/orders/${seededOrder}`);
    await expect({ testID: "order-status" }).toContainText("Paid");
  },
);
```

---

## Selector Priority & Dual-Channel Rules

1. **`{ testID: "..." }`** (preferred) — maps to `data-testid` / `testID` (Web, Shadow DOM, same-origin `<iframe>`, Capacitor WebView, Electron, Electrobun), `resource-id` (Android), and `accessibilityIdentifier` (iOS).
2. **`systemUI({ text: "..." })` / `systemUI({ accessibilityLabel: "..." })`** — routes straight to native OS UI (permission sheets, OAuth `SFSafariViewController`, Chrome Custom Tabs) and skips DOM channels.
3. **`{ accessibilityLabel: "..." }`** — OS accessibility label / `aria-label`.
4. **`{ text: "..." }`** — visible text match.
5. **Relative selectors:** `{ selector: { text: "Edit" }, below: { testID: "user-row-1" } }` (`below`, `above`, `leftOf`, `rightOf`, `childOf`).
6. **`{ point: { x, y } }`** — last resort only.

### Common `app` & `expect` APIs

- **Actions:** `app.tap()`, `app.doubleTap()`, `app.longPress()`, `app.inputText()`, `app.pressKey()`, `app.dismissKeyboard()`, `app.scrollUntilVisible()`, `app.backUntilVisible()`, `app.openLink()`, `app.takeScreenshot()`, `app.evaluate()`
- **Web helpers:** `app.mockNetwork()`, `app.blockNetwork()`, `app.setNetworkConditions()`, `app.saveAuthState()`, `app.loadAuthState()`, `app.getConsoleLogs()`, `app.getJSErrors()`, `app.openStory()`
- **Assertions (auto-waiting with MutationObserver reactive waits on web):** `toBeVisible()`, `toBeHidden()`, `toHaveText()`, `toContainText()`, `toMatchText()`, `toHaveValue()`, `toBeEnabled()`, `toBeDisabled()`, `toHaveAttribute()`, `toMatchScreenshot({ mode: "layout-tolerant" })`, `toPassAccessibilityAudit()`

---

## Fast Configuration & CI Filters (`spana.config.ts`)

```ts
import {
  defineConfig,
  decisionFilter,
  createLogprobDecisionJudge,
  pathRuleFilter,
} from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: { packageName: "com.example.app", appPath: "./builds/app.apk" },
    ios: { bundleId: "com.example.app", appPath: "./builds/MyApp.app" },
  },
  execution: {
    web: {
      browser: "chromium", // or engine: "cdp" | "lightpanda" with cdpUrl, or wsEndpoint for BrowserStack Automate Web
      headless: true,
      warmBrowser: true,
      instantAnimations: true,
      blockResources: ["image", "font", "media"],
    },
  },
  defaults: {
    waitTimeout: 5000,
    failFastWhenIdle: false, // set true on web to fail missing selectors once page is idle
  },
  filters: [
    pathRuleFilter({
      rules: [{ matchFlow: { tag: "billing" }, watchPaths: ["src/billing/"] }],
    }),
    decisionFilter({
      alwaysRunTags: ["smoke"],
      judge: createLogprobDecisionJudge({
        provider: "openai",
        baseUrl: "http://127.0.0.1:8000/v1",
        model: "typesafe-ai/jev",
      }),
    }),
  ],
  reporters: ["console", "html"],
});
```

---

## Failure Investigation Checklist

When a flow fails, inspect `.spana/artifacts/` (or `spana-output/`):

1. Read `failure-bundle.json` — contains the failed step, attempted selector, nearby selector alternatives, inline `consoleLogs` & `jsErrors`, screenshot path, and exact repro command.
2. Prefer fixing selectors to `{ testID }` over adding sleeps (Spana already uses `MutationObserver` reactive waits + adaptive polling).
3. Always run `spana validate` before `spana test` after editing flows.
