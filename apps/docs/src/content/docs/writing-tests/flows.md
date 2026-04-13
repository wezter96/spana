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
    launchOptions: {
      deepLink: "myapp://checkout",
    },
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
  launchOptions?: LaunchOptions;
  artifacts?: ArtifactConfig;
  defaults?: FlowDefaults;
  when?: WhenCondition;
}

interface WhenCondition {
  platform?: Platform | Platform[];
  env?: string;
}
```

| Option          | Type             | Default        | Description                                                      |
| --------------- | ---------------- | -------------- | ---------------------------------------------------------------- |
| `tags`          | `string[]`       | —              | Tag strings for `--tag` filtering at the CLI                     |
| `platforms`     | `Platform[]`     | all configured | Restrict this flow to specific platforms only                    |
| `timeout`       | `number`         | config default | Flow-level timeout in milliseconds                               |
| `autoLaunch`    | `boolean`        | `true`         | Automatically launch the app before the flow starts              |
| `launchOptions` | `LaunchOptions`  | config default | Override launch defaults for this flow and for manual app.launch |
| `artifacts`     | `ArtifactConfig` | config default | Override capture behavior for this single flow                   |
| `defaults`      | `FlowDefaults`   | config default | Override wait / typing / stability defaults per flow             |
| `when`          | `WhenCondition`  | —              | Runtime conditions that control whether the flow runs            |

### Per-flow launch overrides

`FlowConfig.launchOptions` is merged on top of the project `launchOptions`, and explicit `app.launch(opts)` calls are merged last.

```ts
export default flow(
  "launch in French",
  {
    autoLaunch: true,
    launchOptions: {
      deepLink: "myapp://checkout",
      deviceState: {
        language: "fr",
        locale: "fr_CA",
      },
    },
  },
  async ({ expect }) => {
    await expect({ testID: "checkout-screen" }).toBeVisible();
  },
);
```

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

### Core interaction

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

Direction values are `"up" | "down" | "left" | "right"`.

`dismissKeyboard()` defaults to an auto strategy that uses the driver-specific keyboard dismissal path and falls back to Android system back when needed. `scrollUntilVisible()` and `backUntilVisible()` are useful for replacing ad hoc retry loops in mobile-heavy flows.

### Advanced gestures

| Method       | Signature                                             | Description                           |
| ------------ | ----------------------------------------------------- | ------------------------------------- |
| `pinch`      | `(selector, { scale?, duration? }?) => Promise<void>` | Perform a pinch gesture on an element |
| `zoom`       | `(selector, { scale?, duration? }?) => Promise<void>` | Perform a zoom gesture on an element  |
| `multiTouch` | `(sequences) => Promise<void>`                        | Run multiple touch sequences together |

These gestures are only available on mobile runtimes. Use them for map canvases, image viewers, and multi-finger interactions that are awkward to model with repeated taps.

### App lifecycle and navigation

| Method       | Signature                              | Description                                           |
| ------------ | -------------------------------------- | ----------------------------------------------------- |
| `launch`     | `(opts?) => Promise<void>`             | Launch the app, optionally with a deep link           |
| `stop`       | `() => Promise<void>`                  | Stop the app                                          |
| `kill`       | `() => Promise<void>`                  | Force-kill the app                                    |
| `clearState` | `() => Promise<void>`                  | Clear app data/state                                  |
| `openLink`   | `(url) => Promise<void>`               | Open a URL or deep link                               |
| `openStory`  | `(storyId, options?) => Promise<void>` | Open a Storybook story inside the web runtime         |
| `back`       | `() => Promise<void>`                  | Press the Android back button or browser history back |

`openStory()` is web-only. It uses `execution.web.storybook` when configured and falls back to `apps.web.url` plus Storybook's `iframe.html`.

### Element queries and utilities

| Method           | Signature                                            | Description                                      |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `takeScreenshot` | `() => Promise<Uint8Array>`                          | Capture a screenshot and return the bytes        |
| `getText`        | `(selector, opts?) => Promise<string>`               | Read the current element text                    |
| `getAttribute`   | `(selector, name, opts?) => Promise<string \| null>` | Read an element attribute                        |
| `isVisible`      | `(selector, opts?) => Promise<boolean>`              | Check visibility without failing the flow        |
| `isEnabled`      | `(selector, opts?) => Promise<boolean>`              | Check whether an element is enabled              |
| `evaluate`       | `<T>(fn \| string, ...args) => Promise<T>`           | Run JavaScript in the browser context (web only) |

`getText()`, `getAttribute()`, `isVisible()`, and `isEnabled()` are useful when you need branching logic instead of a hard assertion.

### Browser runtime helpers

| Method                 | Signature                                                                                     | Description                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `mockNetwork`          | `(matcher, response) => Promise<void>`                                                        | Fulfill matching requests with a mocked response   |
| `blockNetwork`         | `(matcher) => Promise<void>`                                                                  | Abort matching requests                            |
| `clearNetworkMocks`    | `() => Promise<void>`                                                                         | Remove active route mocks or blocks                |
| `setNetworkConditions` | `(conditions) => Promise<void>` | Simulate network conditions — profiles, custom throttling, or offline mode |
| `saveCookies`          | `(path) => Promise<void>`                                                                     | Save Playwright cookies to a JSON file             |
| `loadCookies`          | `(path) => Promise<void>`                                                                     | Load cookies from a JSON file                      |
| `saveAuthState`        | `(path) => Promise<void>`                                                                     | Save Playwright storage state to disk              |
| `loadAuthState`        | `(path) => Promise<void>`                                                                     | Replace the browser context with saved auth state  |
| `downloadFile`         | `(path) => Promise<void>`                                                                     | Save the next browser download to disk             |
| `uploadFile`           | `(selector, path) => Promise<void>`                                                           | Upload a local file through a file input           |
| `newTab`               | `(url?) => Promise<void>`                                                                     | Open a new browser tab                             |
| `switchToTab`          | `(index) => Promise<void>`                                                                    | Switch to a tab by index                           |
| `closeTab`             | `() => Promise<void>`                                                                         | Close the current tab                              |
| `getTabIds`            | `() => Promise<string[]>`                                                                     | List known browser tab IDs                         |
| `getConsoleLogs`       | `() => Promise<Array<{ type, text, location? }>>`                                             | Read captured browser console messages             |
| `getJSErrors`          | `() => Promise<Array<{ name?, message, stack? }>>`                                            | Read captured uncaught JavaScript errors           |
| `getHAR`               | `() => Promise<Record<string, unknown>>`                                                      | Read the recorded HTTP Archive for the current run |

These helpers are available on local Playwright web runs. When artifact capture is enabled, failures can also write console logs, JavaScript errors, and HAR files into `spana-output/`.

#### `setNetworkConditions()`

Simulate degraded or offline network conditions across all platforms. You can use a named profile or supply custom values.

**Available profiles:** `wifi`, `4g`, `3g`, `2g`, `edge`, `offline`

```ts
// Simulate 3G network
await app.setNetworkConditions({ profile: "3g" });

// Go offline
await app.setNetworkConditions({ profile: "offline" });

// Back to normal
await app.setNetworkConditions({ profile: "wifi" });
```

Custom values still work when you need fine-grained control:

```ts
await app.setNetworkConditions({
  latencyMs: 150,
  downloadThroughputKbps: 1000,
  uploadThroughputKbps: 500,
});
```

**Platform support:**

| Platform | Offline | Profiles | Custom Values |
|---|---|---|---|
| Web (Chromium) | Yes | Yes | Yes |
| Web (Firefox/WebKit) | Yes | No | No |
| Android emulator | Yes | Yes | Yes |
| Android device | Yes | No | No |
| iOS simulator | Yes | Yes (sudo) | Yes (sudo) |
| Appium cloud | Yes | Yes | varies |

```ts
flow("web app can run with mocked APIs", async ({ app, platform }) => {
  if (platform !== "web") return;

  await app.loadAuthState("./auth/user.json");
  await app.mockNetwork("**/api/profile", {
    json: { id: "demo", name: "Demo User" },
  });
  await app.blockNetwork("**/analytics/**");
  await app.setNetworkConditions({ profile: "3g" });
  await app.evaluate(() => console.info("profile hydrated"));

  const logs = await app.getConsoleLogs();
  const jsErrors = await app.getJSErrors();
  const har = await app.getHAR();

  if (!logs.some((entry) => entry.text.includes("profile hydrated"))) {
    throw new Error("Expected the profile hydration log to be captured.");
  }

  if (jsErrors.length > 0) {
    throw new Error(`Unexpected JS errors: ${jsErrors.map((entry) => entry.message).join(", ")}`);
  }

  if (!Array.isArray((har as { log?: { entries?: unknown[] } }).log?.entries)) {
    throw new Error("Expected HAR output to contain request entries.");
  }

  await app.saveCookies("./tmp/cookies.json");
});
```

### Storybook-backed component flows

Storybook is a good isolated surface for Spana's web runtime when you want component-level checks without giving up real-browser automation.

```ts
flow("primary button story passes smoke checks", async ({ app, expect, platform }) => {
  if (platform !== "web") return;

  await app.openStory("components-button--primary", {
    args: { label: "Save", disabled: false },
    globals: { theme: "dark" },
  });

  await expect({ role: "button", text: "Save" }).toBeVisible();
  await expect({ role: "button", text: "Save" }).toMatchScreenshot("storybook-button");
});
```

Set `execution.web.storybook.url` when Storybook runs on a different origin from your main app. `args` and `globals` support scalar values (`string`, `number`, `boolean`, `null`).

### Hybrid / WebView helpers

| Method              | Signature                      | Description                                |
| ------------------- | ------------------------------ | ------------------------------------------ |
| `getContexts`       | `() => Promise<string[]>`      | List available native and WebView contexts |
| `getCurrentContext` | `() => Promise<string>`        | Read the currently active context          |
| `switchToContext`   | `(contextId) => Promise<void>` | Switch to a specific context ID            |
| `switchToWebView`   | `() => Promise<void>`          | Switch to the first available WebView      |
| `switchToNativeApp` | `() => Promise<void>`          | Switch back to the native app context      |

These helpers are useful for hybrid apps where you need to move between native chrome and embedded web content.

### JavaScript execution

`app.evaluate()` runs JavaScript inside the browser page context. Use it to read DOM state, manipulate local storage, or access browser-only globals.

```ts
flow("read page state", async ({ app, platform }) => {
  if (platform !== "web") return;

  const title = await app.evaluate(() => document.title);
  const count = await app.evaluate(
    (selector: string) => document.querySelectorAll(selector).length,
    "button",
  );

  await app.evaluate(() => {
    localStorage.setItem("feature-flag", "true");
  });

  if (!title || count === 0) {
    throw new Error("Expected page state to be readable from evaluate().");
  }
});
```

`evaluate()` is only supported on the web platform. Native apps do not expose a JavaScript execution context.

## Per-flow artifact overrides

Use `artifacts` in `FlowConfig` when one flow needs different capture behavior from the global defaults.

```ts
export default flow(
  "checkout keeps extra diagnostics on success",
  {
    artifacts: {
      captureSteps: true,
      captureOnSuccess: true,
      consoleLogs: true,
      jsErrors: true,
      har: true,
    },
  },
  async ({ app, expect, platform }) => {
    if (platform === "web") {
      await app.openLink("/checkout");
    }

    await expect({ text: "Checkout" }).toBeVisible();
  },
);
```

Use the global config in [Configuration](/spana/getting-started/configuration/) for your default policy, then tighten or loosen capture per flow only where it helps debugging.

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
