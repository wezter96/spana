---
title: API Reference
description: Quick reference for all app methods, expect methods, and config options.
---

## app methods

All methods return `Promise<void>` unless noted.

### Interaction

| Method               | Signature                  | Description                                                                                                        |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tap`                | `(selector, opts?)`        | Tap an element matching the selector                                                                               |
| `tapXY`              | `(x, y)`                   | Tap at absolute screen coordinates                                                                                 |
| `doubleTap`          | `(selector, opts?)`        | Double-tap an element                                                                                              |
| `longPress`          | `(selector, opts?)`        | Long-press an element                                                                                              |
| `longPressXY`        | `(x, y, opts?)`            | Long-press at coordinates                                                                                          |
| `inputText`          | `(text)`                   | Type text into the focused element                                                                                 |
| `fill`               | `(selector, value, opts?)` | Focus, clear, and fill an input in one round trip on a DOM channel; falls back to `tap` + `inputText` on native UI |
| `pressKey`           | `(key)`                    | Press a named key                                                                                                  |
| `hideKeyboard`       | `()`                       | Dismiss the software keyboard                                                                                      |
| `dismissKeyboard`    | `(opts?)`                  | Platform-aware keyboard dismissal                                                                                  |
| `swipe`              | `(direction, opts?)`       | Swipe in a direction                                                                                               |
| `scroll`             | `(direction)`              | Scroll in a direction                                                                                              |
| `scrollUntilVisible` | `(selector, opts?)`        | Scroll until the element is visible                                                                                |
| `backUntilVisible`   | `(selector, opts?)`        | Go back until the element is visible                                                                               |

Direction: `"up" | "down" | "left" | "right"`

### App lifecycle

| Method       | Signature          | Description                       |
| ------------ | ------------------ | --------------------------------- |
| `launch`     | `(opts?)`          | Launch the app                    |
| `stop`       | `()`               | Stop the app                      |
| `kill`       | `()`               | Force-kill the app                |
| `clearState` | `()`               | Clear app data/state              |
| `openLink`   | `(url)`            | Open a URL or deep link           |
| `openStory`  | `(storyId, opts?)` | Open a Storybook story (web only) |
| `back`       | `()`               | Browser back or Android back      |

### Utilities

| Method           | Signature                   | Description                                               |
| ---------------- | --------------------------- | --------------------------------------------------------- |
| `takeScreenshot` | `(name?)`                   | `Promise<Uint8Array>` — capture the current screen        |
| `getText`        | `(selector, opts?)`         | `Promise<string>` — read an element's text                |
| `getAttribute`   | `(selector, name, opts?)`   | `Promise<string \| null>` — read an attribute             |
| `isVisible`      | `(selector, { timeout? }?)` | `Promise<boolean>` — check visibility without throwing    |
| `isEnabled`      | `(selector, opts?)`         | `Promise<boolean>` — check enabled state without throwing |
| `evaluate`       | `(fn \| string, ...args)`   | Run JavaScript in the page                                |

### Web-first bridge and browser-only helpers

| Method                                                                             | Signature            | Description                                                                       |
| ---------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `waitForIdle`                                                                      | `(opts?)`            | Wait for network, animations, and renders to settle (needs `spana-bridge`)        |
| `setStorage`                                                                       | `(entries)`          | Inject storage / auth state through the DOM bridge                                |
| `clearStorage`                                                                     | `(opts?)`            | Clear localStorage, sessionStorage, cookies, IndexedDB, and Capacitor Preferences |
| `resetFast`                                                                        | `()`                 | Clear storage through the bridge and reload                                       |
| `getPage`                                                                          | `()`                 | Return the underlying page object (web)                                           |
| `enableVirtualAuthenticator`                                                       | `(opts?)`            | `Promise<string>` — add a WebAuthn virtual authenticator                          |
| `getVirtualCredentials` / `clearVirtualCredentials` / `removeVirtualAuthenticator` | `(authenticatorId?)` | Manage virtual WebAuthn credentials                                               |

Browser, network, tab, WebView-context, and gesture helpers (`mockNetwork`, `newTab`, `switchToWebView`, `pinch`, and more) use the same signatures as the [Agent API](/reference/agent-api/) session methods.

## expect methods

```ts
expect(selector: Selector): PromiseExpectation
```

| Method                                                  | Signature                                            | Description                               |
| ------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `toBeVisible`                                           | `(opts?)`                                            | Assert element is present and visible     |
| `toBeHidden`                                            | `(opts?)`                                            | Assert element is absent or not visible   |
| `toHaveText`                                            | `(expected, opts?)`                                  | Assert element text equals `expected`     |
| `toContainText`                                         | `(expected, opts?)`                                  | Assert element text contains `expected`   |
| `toMatchText`                                           | `(pattern, opts?)`                                   | Assert element text matches a `RegExp`    |
| `toHaveValue`                                           | `(expected, opts?)`                                  | Assert an input value                     |
| `toHaveAttribute`                                       | `(name, value?, opts?)`                              | Assert an attribute exists or has a value |
| `toBeEnabled` / `toBeDisabled`                          | `(opts?)`                                            | Assert enabled state                      |
| `toMatchScreenshot`                                     | `(name, { threshold?, maxDiffPixelRatio?, mask? }?)` | Visual regression against a baseline      |
| `toPassAccessibilityAudit`                              | `({ severity?, rules?, exclude? }?)`                 | Run an accessibility audit                |
| `toHaveAccessibilityLabel`                              | `(expected?)`                                        | Assert an accessibility label             |
| `toBeFocusable` / `toHaveRole` / `toHaveMinTouchTarget` | `()` / `(role)` / `(size?)`                          | Accessibility checks                      |

## Selectors

| Type                 | Example                           | Notes                                                     |
| -------------------- | --------------------------------- | --------------------------------------------------------- |
| `string`             | `"Sign In"`                       | Shorthand text match (case-insensitive, partial)          |
| `testID`             | `{ testID: "login-btn" }`         | `data-testid` / `accessibilityIdentifier` / `resource-id` |
| `text`               | `{ text: "Sign In" }`             | Visible label, case-insensitive partial match             |
| `accessibilityLabel` | `{ accessibilityLabel: "Close" }` | OS accessibility label                                    |
| `point`              | `{ point: { x: 100, y: 200 } }`   | Absolute coordinates, last resort                         |

Add `systemUI: true` (or use the `systemUI(...)` helper) on `text` / `accessibilityLabel` selectors to target OS UI such as OAuth sheets and permission dialogs. Relative selectors (`{ selector, below?, above?, leftOf?, rightOf?, childOf? }`) are also accepted.

## WaitOptions

Accepted by all selector-based `app` methods and all `expect` methods.

```ts
interface WaitOptions {
  timeout?: number; // ms, default 5000
  pollInterval?: number; // ms, default 200
  settleTimeout?: number; // ms, default 0
  initialPollInterval?: number; // ms, default 50 (adaptive polling)
  tapMode?: "native" | "dom";
}
```

## FlowConfig

```ts
interface FlowConfig {
  tags?: string[];
  platforms?: Array<"web" | "android" | "ios" | "electron" | "electrobun">;
  timeout?: number;
  autoLaunch?: boolean; // default true
  launchOptions?: LaunchOptions;
  artifacts?: ArtifactConfig; // same shape as config `artifacts`
  defaults?: {
    /* per-flow timing overrides */
  };
  when?: WhenCondition;
}

interface LaunchOptions {
  clearState?: boolean;
  clearKeychain?: boolean;
  deepLink?: string;
  launchArguments?: Record<string, unknown>;
  deviceState?: {
    language?: string;
    locale?: string;
    timeZone?: string;
  };
}
```

## defineConfig options

```ts
interface SpanaConfig {
  apps?: {
    web?: { url: string };
    android?: { packageName: string };
    ios?: { bundleId: string };
    electron?: { entry?: string; executablePath?: string /* ... */ };
    electrobun?: { executablePath?: string; renderer?: "native" | "cef" /* ... */ };
  };
  platforms?: Array<"web" | "android" | "ios" | "electron" | "electrobun">;
  parallelPlatforms?: boolean;
  flowDir?: string;
  launchOptions?: LaunchOptions;
  reporters?: string[];
  defaults?: {
    waitTimeout?: number;
    pollInterval?: number;
    settleTimeout?: number;
    retries?: number;
    workers?: number;
    maxWorkersPerProcess?: number; // default 8
    tapMode?: "native" | "dom";
    // ...more timing options
  };
  artifacts?: {
    outputDir?: string;
    captureOnFailure?: boolean;
    captureOnSuccess?: boolean;
    captureSteps?: boolean;
    screenshot?: boolean;
    uiHierarchy?: boolean;
    consoleLogs?: boolean;
    jsErrors?: boolean;
    har?: boolean;
    video?: "off" | "on" | "retain-on-failure";
    playback?: boolean;
  };
  hooks?: {
    beforeAll?: (ctx: HookContext) => Promise<void>;
    beforeEach?: (ctx: HookContext) => Promise<void>;
    afterEach?: (ctx: HookContext) => Promise<void>;
    afterAll?: (ctx: HookContext) => Promise<void>;
  };
  execution?: ExecutionConfig; // local/appium mode, web browser & engine, bridge, warm daemons
  visualRegression?: {
    threshold?: number;
    maxDiffPixelRatio?: number;
    baselinesDir?: string;
    mode?: "pixel" | "layout-tolerant";
  };
  filters?: Array<{ name: string; filter: (flows, context) => unknown }>; // used by --changed-since
  replayCache?: { mode?: "read-write" | "strict" | "off"; dir?: string }; // accepted, not used by `spana test` yet
}
```

## CLI flags

| Command                 | Key flags                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `spana test [path]`     | `--platform`, `--tag`, `--grep`, `--reporter`, `--config`, `--parallel`, `--workers`, `--retries`, `--shard`, `--changed-since` |
| `spana hierarchy`       | `--platform`, `--config`, `--json`, `--pretty`                                                                                  |
| `spana selectors`       | `--platform`, `--config`, `--json`, `--pretty`                                                                                  |
| `spana validate [path]` | `--json`                                                                                                                        |
| `spana devices`         | `--json`                                                                                                                        |
| `spana mcp`             | —                                                                                                                               |
| `spana version`         | —                                                                                                                               |

See [CLI Commands](/cli/commands/) for every command and flag.
