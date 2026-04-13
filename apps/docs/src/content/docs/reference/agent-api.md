---
title: Agent API
description: Programmatic API for connecting to local web, Android, and iOS targets from your own scripts.
---

The `spana-test/agent` export gives you a persistent automation session outside the flow runner. It is useful for custom scripts, AI agents, internal tooling, and live debugging.

## Installation

The agent API ships with `spana-test`.

```ts
import { connect, validateFlows } from "spana-test/agent";
```

## Connecting

```ts
import { connect } from "spana-test/agent";

const session = await connect({
  platform: "web",
  baseUrl: "http://localhost:3000",
  headless: false,
});

await session.tap({ testID: "login-button" });
await session.disconnect();
```

## `ConnectOptions`

```ts
interface ConnectOptions {
  platform: "web" | "android" | "ios";
  device?: string;
  baseUrl?: string;
  browser?: "chromium" | "firefox" | "webkit";
  headless?: boolean;
  storageState?: string;
  verboseLogging?: boolean;
  storybook?: {
    url?: string;
    iframePath?: string;
  };
  packageName?: string;
  bundleId?: string;
}
```

| Option           | Platform     | Description                                        |
| ---------------- | ------------ | -------------------------------------------------- |
| `platform`       | all          | Target platform                                    |
| `device`         | android, ios | Explicit device ID from `spana devices`            |
| `baseUrl`        | web          | Base URL to open when the browser session starts   |
| `browser`        | web          | Browser engine: `chromium`, `firefox`, or `webkit` |
| `headless`       | web          | Run the browser headless, default `true`           |
| `storageState`   | web          | Preload Playwright cookies and storage state       |
| `verboseLogging` | web          | Print verbose Playwright runtime logs              |
| `storybook`      | web          | Storybook URL and iframe config for `openStory()`  |
| `packageName`    | android      | Android application ID                             |
| `bundleId`       | ios          | iOS bundle identifier                              |

## Session methods

### Touch and input

| Method            | Signature                            | Description                                        |
| ----------------- | ------------------------------------ | -------------------------------------------------- |
| `tap`             | `(selector) => Promise<void>`        | Tap an element                                     |
| `tapXY`           | `(x, y) => Promise<void>`            | Tap at absolute coordinates                        |
| `doubleTap`       | `(selector, opts?) => Promise<void>` | Double-tap an element                              |
| `longPress`       | `(selector, opts?) => Promise<void>` | Long-press an element                              |
| `longPressXY`     | `(x, y, opts?) => Promise<void>`     | Long-press at coordinates                          |
| `inputText`       | `(text) => Promise<void>`            | Type into the focused control                      |
| `pressKey`        | `(key) => Promise<void>`             | Send a named key                                   |
| `hideKeyboard`    | `() => Promise<void>`                | Dismiss the software keyboard                      |
| `dismissKeyboard` | `(opts?) => Promise<void>`           | Use the platform-aware keyboard dismissal strategy |

### Navigation and gestures

| Method               | Signature                                             | Description                               |
| -------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `swipe`              | `(direction, opts?) => Promise<void>`                 | Swipe up, down, left, or right            |
| `scroll`             | `(direction) => Promise<void>`                        | Scroll in one direction                   |
| `scrollUntilVisible` | `(selector, opts?) => Promise<void>`                  | Scroll until a target appears             |
| `backUntilVisible`   | `(selector, opts?) => Promise<void>`                  | Repeatedly go back until a target appears |
| `pinch`              | `(selector, { scale?, duration? }?) => Promise<void>` | Pinch on a mobile element                 |
| `zoom`               | `(selector, { scale?, duration? }?) => Promise<void>` | Zoom on a mobile element                  |
| `multiTouch`         | `(sequences) => Promise<void>`                        | Run multiple touch sequences at once      |

### App lifecycle

| Method       | Signature                              | Description                                   |
| ------------ | -------------------------------------- | --------------------------------------------- |
| `launch`     | `(opts?) => Promise<void>`             | Launch the app or page                        |
| `stop`       | `() => Promise<void>`                  | Stop the app                                  |
| `kill`       | `() => Promise<void>`                  | Force-kill the app                            |
| `clearState` | `() => Promise<void>`                  | Clear app/browser state                       |
| `openLink`   | `(url) => Promise<void>`               | Open a URL or deep link                       |
| `openStory`  | `(storyId, options?) => Promise<void>` | Open a Storybook story in the browser runtime |
| `back`       | `() => Promise<void>`                  | Trigger browser back or Android back          |

`openStory()` is web-only and uses the `storybook` connection settings when provided.

### Queries and inspection

| Method         | Signature                                            | Description                                  |
| -------------- | ---------------------------------------------------- | -------------------------------------------- |
| `hierarchy`    | `() => Promise<Element>`                             | Read the full current hierarchy              |
| `selectors`    | `() => Promise<SuggestedSelector[]>`                 | Get suggested selectors for visible elements |
| `screenshot`   | `() => Promise<Uint8Array>`                          | Capture a screenshot                         |
| `getText`      | `(selector, opts?) => Promise<string>`               | Read an element's text                       |
| `getAttribute` | `(selector, name, opts?) => Promise<string \| null>` | Read an attribute                            |
| `isVisible`    | `(selector, opts?) => Promise<boolean>`              | Check visibility without throwing            |
| `isEnabled`    | `(selector, opts?) => Promise<boolean>`              | Check enabled state without throwing         |
| `evaluate`     | `<T>(fn \| string, ...args) => Promise<T>`           | Run JavaScript in the web page               |

### Browser helpers

| Method                 | Signature                                          | Description                                       |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `mockNetwork`          | `(matcher, response) => Promise<void>`             | Fulfill matching requests with mocked data        |
| `blockNetwork`         | `(matcher) => Promise<void>`                       | Abort matching requests                           |
| `clearNetworkMocks`    | `() => Promise<void>`                              | Remove active network mocks                       |
| `setNetworkConditions` | `(conditions) => Promise<void>`                    | Simulate network conditions — profiles, custom throttling, or offline mode |
| `saveCookies`          | `(path) => Promise<void>`                          | Persist cookies to disk                           |
| `loadCookies`          | `(path) => Promise<void>`                          | Load cookies from disk                            |
| `saveAuthState`        | `(path) => Promise<void>`                          | Save Playwright storage state                     |
| `loadAuthState`        | `(path) => Promise<void>`                          | Replace the browser context with saved auth state |
| `downloadFile`         | `(path) => Promise<void>`                          | Save the next browser download                    |
| `uploadFile`           | `(selector, path) => Promise<void>`                | Upload a local file through a file input          |
| `newTab`               | `(url?) => Promise<void>`                          | Open a new browser tab                            |
| `switchToTab`          | `(index) => Promise<void>`                         | Switch to a tab by index                          |
| `closeTab`             | `() => Promise<void>`                              | Close the current tab                             |
| `getTabIds`            | `() => Promise<string[]>`                          | List known tab IDs                                |
| `getConsoleLogs`       | `() => Promise<Array<{ type, text, location? }>>`  | Read captured console messages                    |
| `getJSErrors`          | `() => Promise<Array<{ name?, message, stack? }>>` | Read uncaught JavaScript errors                   |
| `getHAR`               | `() => Promise<Record<string, unknown>>`           | Read the current HAR network capture              |

These helpers are available on local Playwright web sessions.

#### `setNetworkConditions()`

Simulate degraded or offline network conditions across all platforms. You can use a named profile or supply custom values.

**Available profiles:** `wifi`, `4g`, `3g`, `2g`, `edge`, `offline`

```ts
// Simulate 3G network
await session.setNetworkConditions({ profile: "3g" });

// Go offline
await session.setNetworkConditions({ profile: "offline" });

// Back to normal
await session.setNetworkConditions({ profile: "wifi" });

// Custom values
await session.setNetworkConditions({
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

### Hybrid / WebView helpers

| Method              | Signature                      | Description                           |
| ------------------- | ------------------------------ | ------------------------------------- |
| `getContexts`       | `() => Promise<string[]>`      | List native and WebView contexts      |
| `getCurrentContext` | `() => Promise<string>`        | Read the active context ID            |
| `switchToContext`   | `(contextId) => Promise<void>` | Switch to a specific context          |
| `switchToWebView`   | `() => Promise<void>`          | Switch to the first available WebView |
| `switchToNativeApp` | `() => Promise<void>`          | Switch back to the native context     |

### Cleanup

| Method       | Signature             | Description                                        |
| ------------ | --------------------- | -------------------------------------------------- |
| `disconnect` | `() => Promise<void>` | Release the session and clean up runtime resources |

## `validateFlows(path)`

The same package also exports programmatic validation:

```ts
import { validateFlows } from "spana-test/agent";

const issues = await validateFlows("./flows");
if (issues.length > 0) {
  console.error(issues);
}
```

## Examples

### Web + Storybook

```ts
const session = await connect({
  platform: "web",
  baseUrl: "http://localhost:3000",
  storybook: { url: "http://localhost:6006" },
  storageState: "./auth/admin.json",
});

await session.openStory("components-button--primary", {
  globals: { theme: "dark" },
});
await session.getConsoleLogs();
await session.disconnect();
```

### Android

```ts
const session = await connect({
  platform: "android",
  packageName: "com.example.app",
  device: "emulator-5554",
});

await session.tap({ testID: "login-button" });
await session.disconnect();
```

### iOS

```ts
const session = await connect({
  platform: "ios",
  bundleId: "com.example.app",
  device: "00008110-001C195E0E12801E",
});

await session.switchToWebView();
await session.disconnect();
```
