---
title: Flows
description: The flow() API — defining, configuring, and exporting test flows.
---

A flow is the basic unit of a spana test. Each flow file exports a single `FlowDefinition` as its default export.

## Defining a flow

`flow()` has two overloads:

```ts
// Without config
flow(name: string, fn: FlowFn): FlowDefinition

// With config
flow(name: string, config: FlowConfig, fn: FlowFn): FlowDefinition
```

### Basic flow

```ts
import { flow } from "spana-test";

export default flow("user can log in", async ({ app, expect }) => {
  await app.tap({ testID: "email-input" });
  await app.inputText("user@example.com");
  await app.tap({ testID: "login-button" });
  await expect({ testID: "home-screen" }).toBeVisible();
});
```

### Flow with config

```ts
export default flow(
  "checkout flow",
  {
    tags: ["smoke", "payments"],
    platforms: ["android", "ios"],
    timeout: 60000,
    autoLaunch: true,
  },
  async ({ app, expect, platform }) => {
    // ...
  },
);
```

## FlowContext

The function receives a `FlowContext` object:

```ts
interface FlowContext {
  app: PromiseApp;
  expect: (selector: Selector) => PromiseExpectation;
  platform: Platform;
}
```

| Property   | Type                               | Description                                               |
| ---------- | ---------------------------------- | --------------------------------------------------------- |
| `app`      | `PromiseApp`                       | App interaction API — tap, type, scroll, launch, etc.     |
| `expect`   | `(selector) => PromiseExpectation` | Assertion API — `toBeVisible`, `toBeHidden`, `toHaveText` |
| `platform` | `"web" \| "android" \| "ios"`      | The platform this run is executing on                     |

## FlowConfig

```ts
interface FlowConfig {
  tags?: string[];
  platforms?: Platform[];
  timeout?: number;
  autoLaunch?: boolean;
  when?: WhenCondition;
}

interface WhenCondition {
  platform?: Platform | Platform[];
  env?: string;
}
```

| Option       | Type            | Default        | Description                                           |
| ------------ | --------------- | -------------- | ----------------------------------------------------- |
| `tags`       | `string[]`      | —              | Tag strings for `--tag` filtering at the CLI          |
| `platforms`  | `Platform[]`    | all configured | Restrict this flow to specific platforms only         |
| `timeout`    | `number`        | config default | Flow-level timeout in milliseconds                    |
| `autoLaunch` | `boolean`       | `true`         | Automatically launch the app before the flow starts   |
| `when`       | `WhenCondition` | —              | Runtime conditions that control whether the flow runs |

### Conditional execution with `when`

The `when` field lets you skip flows based on runtime conditions.

#### Platform condition

`when.platform` works like `platforms` but within the `when` block, keeping conditional logic grouped:

```ts
export default flow("iOS-specific test", { when: { platform: "ios" } }, async ({ app, expect }) => {
  // only runs on iOS
});
```

You can also pass an array:

```ts
export default flow(
  "mobile-only test",
  { when: { platform: ["ios", "android"] } },
  async ({ app, expect }) => {
    // runs on iOS and Android, skipped on web
  },
);
```

#### Environment variable condition

`when.env` skips the flow unless the specified environment variable is set:

```ts
export default flow(
  "CI smoke test",
  {
    when: { env: "CI" },
    tags: ["smoke"],
  },
  async ({ app, expect }) => {
    // only runs when CI=1 (or any truthy value)
  },
);
```

## The `app` API

All methods return `Promise<void>` unless noted.

### Interaction

| Method               | Signature                             | Description                                      |
| -------------------- | ------------------------------------- | ------------------------------------------------ |
| `tap`                | `(selector, opts?) => Promise<void>`  | Tap an element                                   |
| `tapXY`              | `(x, y) => Promise<void>`             | Tap at absolute coordinates                      |
| `doubleTap`          | `(selector, opts?) => Promise<void>`  | Double-tap an element                            |
| `longPress`          | `(selector, opts?) => Promise<void>`  | Long-press an element                            |
| `longPressXY`        | `(x, y, opts?) => Promise<void>`      | Long-press at coordinates                        |
| `inputText`          | `(text) => Promise<void>`             | Type text into the focused element               |
| `pressKey`           | `(key) => Promise<void>`              | Press a named key                                |
| `hideKeyboard`       | `() => Promise<void>`                 | Dismiss the software keyboard                    |
| `dismissKeyboard`    | `(opts?) => Promise<void>`            | Use a platform-aware keyboard dismissal strategy |
| `swipe`              | `(direction, opts?) => Promise<void>` | Swipe in a direction                             |
| `scroll`             | `(direction) => Promise<void>`        | Scroll in a direction                            |
| `scrollUntilVisible` | `(selector, opts?) => Promise<void>`  | Scroll until a target becomes visible            |
| `backUntilVisible`   | `(selector, opts?) => Promise<void>`  | Use system back until a target becomes visible   |

Direction values: `"up" | "down" | "left" | "right"`

`dismissKeyboard()` defaults to an auto strategy that uses the driver-specific keyboard dismissal path and falls back to Android system back when needed. `scrollUntilVisible()` and `backUntilVisible()` are useful for replacing ad hoc retry loops in mobile-heavy flows.

### App lifecycle

| Method       | Signature                  | Description                                  |
| ------------ | -------------------------- | -------------------------------------------- |
| `launch`     | `(opts?) => Promise<void>` | Launch the app (optionally with a deep link) |
| `stop`       | `() => Promise<void>`      | Stop the app                                 |
| `kill`       | `() => Promise<void>`      | Force-kill the app                           |
| `clearState` | `() => Promise<void>`      | Clear app data/state                         |
| `openLink`   | `(url) => Promise<void>`   | Open a URL or deep link                      |
| `back`       | `() => Promise<void>`      | Press the back button (Android)              |

### Utilities

| Method           | Signature                                  | Description                                      |
| ---------------- | ------------------------------------------ | ------------------------------------------------ |
| `takeScreenshot` | `() => Promise<Uint8Array>`                | Capture a screenshot and return the bytes        |
| `evaluate`       | `<T>(fn \| string, ...args) => Promise<T>` | Run JavaScript in the browser context (web only) |

### Browser runtime helpers (web platform)

| Method                 | Signature                                                                                     | Description                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `mockNetwork`          | `(matcher, response) => Promise<void>`                                                        | Fulfill matching requests with a mocked response    |
| `blockNetwork`         | `(matcher) => Promise<void>`                                                                  | Abort matching requests                             |
| `clearNetworkMocks`    | `() => Promise<void>`                                                                         | Remove active route mocks/blocks                    |
| `setNetworkConditions` | `({ offline?, latencyMs?, downloadThroughputKbps?, uploadThroughputKbps? }) => Promise<void>` | Toggle offline mode and Chromium network throttling |
| `saveCookies`          | `(path) => Promise<void>`                                                                     | Save Playwright cookies to a JSON file              |
| `loadCookies`          | `(path) => Promise<void>`                                                                     | Load cookies from a JSON file                       |
| `saveAuthState`        | `(path) => Promise<void>`                                                                     | Save Playwright storage state to disk               |
| `loadAuthState`        | `(path) => Promise<void>`                                                                     | Replace the browser context with saved auth state   |
| `getConsoleLogs`       | `() => Promise<Array<{ type, text, location? }>>`                                             | Read captured browser console messages              |
| `getJSErrors`          | `() => Promise<Array<{ name?, message, stack? }>>`                                            | Read captured uncaught JavaScript errors            |

These helpers are only available on local Playwright web runs. `setNetworkConditions()` supports offline mode on every browser, but latency/throughput throttling requires the Chromium browser runtime. When artifact capture is enabled, web failures also include console logs and JavaScript errors in `spana-output/` and the HTML report.

```ts
flow("web app can run with mocked APIs", async ({ app, platform }) => {
  if (platform !== "web") return;

  await app.loadAuthState("./auth/user.json");
  await app.mockNetwork("**/api/profile", {
    json: { id: "demo", name: "Demo User" },
  });
  await app.blockNetwork("**/analytics/**");
  await app.setNetworkConditions({ offline: false, latencyMs: 120 });
  await app.evaluate(() => console.info("profile hydrated"));
  const logs = await app.getConsoleLogs();
  const jsErrors = await app.getJSErrors();

  if (!logs.some((entry) => entry.text.includes("profile hydrated"))) {
    throw new Error("Expected the profile hydration log to be captured.");
  }

  if (jsErrors.length > 0) {
    throw new Error(`Unexpected JS errors: ${jsErrors.map((entry) => entry.message).join(", ")}`);
  }

  await app.saveCookies("./tmp/cookies.json");
});
```

### JavaScript execution (web platform)

`app.evaluate()` runs JavaScript inside the browser page context. This is useful for reading DOM state, manipulating localStorage, or interacting with the app's JavaScript runtime.

```ts
flow("read page state", async ({ app, platform }) => {
  if (platform !== "web") return;

  // Read a value from the page
  const title = await app.evaluate(() => document.title);

  // Pass arguments
  const count = await app.evaluate(
    (selector: string) => document.querySelectorAll(selector).length,
    "button",
  );

  // Manipulate state
  await app.evaluate(() => {
    localStorage.setItem("feature-flag", "true");
  });
});
```

`evaluate()` is only supported on the web platform (Playwright). On Android and iOS, it throws an error — native apps don't expose a JavaScript engine. Since flows are TypeScript, you have full access to Node.js/Bun APIs for any test logic that doesn't need to run inside the browser.

## Settings export

You can export named `settings` from a flow file to apply shared config to all flows in that file:

```ts
export const settings = {
  tags: ["smoke"],
  timeout: 30000,
};

export default flow("my flow", async ({ app }) => {
  // ...
});
```

Per-flow `FlowConfig` values take precedence over `settings`.
