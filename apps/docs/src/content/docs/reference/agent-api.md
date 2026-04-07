---
title: Agent API
description: Programmatic API for connecting to devices and controlling apps from your own scripts.
---

The `spana-test/agent` subpath export provides a programmatic API for connecting to devices and controlling apps outside of the flow runner. Use it to build custom automation scripts, AI agents, or integrations.

## Installation

The agent API is included in the `spana-test` package — no extra install needed.

```ts
import { connect } from "spana-test/agent";
```

## Connecting to a device

```ts
import { connect } from "spana-test/agent";

const session = await connect({
  platform: "web",
  baseUrl: "http://localhost:3000",
});

// Interact with the app
await session.tap({ testID: "login-button" });
await session.inputText("user@example.com");

// Read the UI hierarchy
const root = await session.hierarchy();

// Get suggested selectors for visible elements
const selectors = await session.selectors();

// Disconnect when done
await session.disconnect();
```

## `ConnectOptions`

```ts
interface ConnectOptions {
  platform: "web" | "android" | "ios";
  device?: string; // device ID (from `spana devices`)
  baseUrl?: string; // web: URL to navigate to
  packageName?: string; // android: app package name
  bundleId?: string; // ios: app bundle identifier
  headless?: boolean; // web: run headless (default: true)
}
```

| Option        | Platform | Description                                    |
| ------------- | -------- | ---------------------------------------------- |
| `platform`    | all      | Target platform (required)                     |
| `device`      | all      | Target a specific device by ID                 |
| `baseUrl`     | web      | URL to navigate to on launch                   |
| `packageName` | android  | Android package name (e.g. `com.example.app`)  |
| `bundleId`    | ios      | iOS bundle identifier (e.g. `com.example.app`) |
| `headless`    | web      | Run browser in headless mode (default: `true`) |

## Session methods

### Touch actions

| Method        | Signature                                              | Description          |
| ------------- | ------------------------------------------------------ | -------------------- |
| `tap`         | `(selector: ExtendedSelector) => Promise<void>`        | Tap an element       |
| `tapXY`       | `(x: number, y: number) => Promise<void>`              | Tap at coordinates   |
| `doubleTap`   | `(selector: ExtendedSelector) => Promise<void>`        | Double-tap           |
| `longPress`   | `(selector: ExtendedSelector, opts?) => Promise<void>` | Long-press           |
| `longPressXY` | `(x, y, opts?) => Promise<void>`                       | Long-press at coords |

### Text input

| Method            | Signature                         | Description                                      |
| ----------------- | --------------------------------- | ------------------------------------------------ |
| `inputText`       | `(text: string) => Promise<void>` | Type text                                        |
| `pressKey`        | `(key: string) => Promise<void>`  | Press a key                                      |
| `hideKeyboard`    | `() => Promise<void>`             | Dismiss keyboard                                 |
| `dismissKeyboard` | `(opts?) => Promise<void>`        | Use a platform-aware keyboard dismissal strategy |

### Gestures

| Method               | Signature                             | Description                                    |
| -------------------- | ------------------------------------- | ---------------------------------------------- |
| `swipe`              | `(direction, opts?) => Promise<void>` | Swipe gesture                                  |
| `scroll`             | `(direction) => Promise<void>`        | Scroll gesture                                 |
| `scrollUntilVisible` | `(selector, opts?) => Promise<void>`  | Scroll until a target becomes visible          |
| `backUntilVisible`   | `(selector, opts?) => Promise<void>`  | Use system back until a target becomes visible |

### App lifecycle

| Method       | Signature                                 | Description        |
| ------------ | ----------------------------------------- | ------------------ |
| `launch`     | `(opts?: LaunchOptions) => Promise<void>` | Launch the app     |
| `stop`       | `() => Promise<void>`                     | Stop the app       |
| `kill`       | `() => Promise<void>`                     | Force-kill the app |
| `clearState` | `() => Promise<void>`                     | Clear app data     |
| `openLink`   | `(url: string) => Promise<void>`          | Open a URL         |
| `back`       | `() => Promise<void>`                     | Press back         |

### Queries

| Method       | Signature                            | Description                                      |
| ------------ | ------------------------------------ | ------------------------------------------------ |
| `hierarchy`  | `() => Promise<Element>`             | Get the full UI element tree                     |
| `selectors`  | `() => Promise<SuggestedSelector[]>` | Get suggested selectors for all visible elements |
| `screenshot` | `() => Promise<Uint8Array>`          | Capture a screenshot                             |
| `evaluate`   | `<T>(fn, ...args) => Promise<T>`     | Run JS in browser context (web only)             |

### Browser helpers (web)

| Method                 | Signature                                              | Description                                 |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `mockNetwork`          | `(matcher, response) => Promise<void>`                 | Fulfill matching requests with mocked data  |
| `blockNetwork`         | `(matcher) => Promise<void>`                           | Abort matching requests                     |
| `clearNetworkMocks`    | `() => Promise<void>`                                  | Remove active route mocks/blocks            |
| `setNetworkConditions` | `(conditions) => Promise<void>`                        | Toggle offline mode / Chromium throttling   |
| `saveCookies`          | `(path) => Promise<void>`                              | Save cookies to a JSON file                 |
| `loadCookies`          | `(path) => Promise<void>`                              | Load cookies from a JSON file               |
| `saveAuthState`        | `(path) => Promise<void>`                              | Save Playwright storage state               |
| `loadAuthState`        | `(path) => Promise<void>`                              | Replace the browser context with auth state |
| `getConsoleLogs`       | `() => Promise<Array<{ type, text, location? }>>`      | Read captured browser console logs          |
| `getJSErrors`          | `() => Promise<Array<{ name?, message, stack? }>>`     | Read uncaught JavaScript errors             |

These helpers are only available on local Playwright web sessions.

### Lifecycle

| Method       | Signature             | Description                           |
| ------------ | --------------------- | ------------------------------------- |
| `disconnect` | `() => Promise<void>` | Clean up driver and release resources |

## Flow validation

The agent export also includes `validateFlows` for programmatic flow validation:

```ts
import { validateFlows } from "spana-test/agent";

const errors = await validateFlows("./flows");
if (errors.length > 0) {
  console.error("Invalid flows:", errors);
}
```

## Platform examples

### Web

```ts
const session = await connect({
  platform: "web",
  baseUrl: "http://localhost:3000",
  headless: false, // show the browser
});
```

### Android

```ts
const session = await connect({
  platform: "android",
  packageName: "com.example.app",
  device: "emulator-5554", // optional: target specific device
});
```

### iOS

```ts
const session = await connect({
  platform: "ios",
  bundleId: "com.example.app",
});
```
