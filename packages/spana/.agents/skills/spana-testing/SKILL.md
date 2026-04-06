# Writing spana Tests

## When to use

Use this skill when writing, debugging, or iterating on spana E2E test flows. spana is a TypeScript-native E2E testing framework for React Native + Web that uses `flow()` files instead of traditional test suites.

## Quick reference

### Discover elements on screen

```bash
spana selectors --platform web       # JSON array of interactable elements with suggested selectors
spana selectors --platform android   # same for Android
spana selectors --platform ios       # same for iOS
spana hierarchy --platform web       # full accessibility tree (includes non-interactable elements)
```

Filter with `jq`:

```bash
spana selectors --platform web | jq '.[] | select(.testID != null)'
spana selectors --platform ios | jq '[.[].suggestedSelector]'
```

### Write a flow

```ts
import { flow } from "spana-test";

// Simple form
export default flow("descriptive name", async ({ app, expect, platform }) => {
  // test body
});

// With config
export default flow(
  "descriptive name",
  { tags: ["smoke"], platforms: ["web", "android"], timeout: 30000 },
  async ({ app, expect, platform }) => {
    // test body
  },
);
```

**File naming:** `<name>.flow.ts` in the configured `flowDir` (default `./flows`).

**FlowConfig options:**

| Option       | Type                          | Default | Description                         |
| ------------ | ----------------------------- | ------- | ----------------------------------- |
| `tags`       | `string[]`                    | --      | Filter with `--tag`                 |
| `platforms`  | `("web"\|"android"\|"ios")[]` | all     | Restrict to specific platforms      |
| `timeout`    | `number`                      | config  | Timeout in ms                       |
| `autoLaunch` | `boolean`                     | `true`  | Launch app before flow starts       |
| `artifacts`  | `ArtifactConfig`              | --      | Per-flow artifact capture overrides |
| `when`       | `{ platform?, env? }`         | --      | Conditional execution               |

### app methods (FlowContext.app)

| Method                           | Description                       |
| -------------------------------- | --------------------------------- |
| `app.tap(selector, opts?)`       | Tap element (auto-waits)          |
| `app.tapXY(x, y)`                | Tap absolute coordinates          |
| `app.doubleTap(selector, opts?)` | Double-tap element                |
| `app.longPress(selector, opts?)` | Long press (default 1s)           |
| `app.inputText(text)`            | Type text into focused element    |
| `app.pressKey(key)`              | Press a keyboard key              |
| `app.hideKeyboard()`             | Dismiss keyboard                  |
| `app.swipe(direction, opts?)`    | Swipe: "up"/"down"/"left"/"right" |
| `app.scroll(direction)`          | Scroll (slower swipe)             |
| `app.launch(opts?)`              | Launch/relaunch app               |
| `app.stop()` / `app.kill()`      | Stop or force-kill app            |
| `app.clearState()`               | Clear app data                    |
| `app.openLink(url)`              | Open deep link or URL             |
| `app.back()`                     | Navigate back                     |
| `app.takeScreenshot(name?)`      | Capture screenshot                |
| `app.evaluate(fn, ...args)`      | Run JS in web context             |

`opts` on tap/doubleTap/longPress accepts `{ timeout?: number }` to override wait timeout.

### expect methods (FlowContext.expect)

```ts
await expect({ testID: "header" }).toBeVisible();
await expect({ testID: "header" }).toBeVisible({ timeout: 10_000 });
await expect({ testID: "spinner" }).toBeHidden();
await expect({ testID: "title" }).toHaveText("Welcome");
```

| Method                        | Description                           |
| ----------------------------- | ------------------------------------- |
| `toBeVisible(opts?)`          | Assert element is visible on screen   |
| `toBeHidden(opts?)`           | Assert element is not visible         |
| `toHaveText(expected, opts?)` | Assert element's text matches exactly |

All expect methods auto-wait with polling. Pass `{ timeout: ms }` to override.

### Selector types

```ts
{ testID: "login-btn" }           // maps to data-testid (web), resource-id (Android), accessibilityIdentifier (iOS)
{ text: "Sign In" }               // visible label text
{ accessibilityLabel: "Close" }   // OS accessibility label
{ point: { x: 100, y: 200 } }    // absolute coordinate (last resort)
"Sign In"                         // shorthand for { text: "Sign In" }
```

**Selector priority:** `testID` > `accessibilityLabel` > `text` > `point`

**Relative selectors** (for ambiguous elements):

```ts
await app.tap({ selector: { text: "Edit" }, below: { testID: "user-row-1" } });
await app.tap({ selector: { text: "Delete" }, rightOf: { text: "Item 3" } });
```

Relative modifiers: `below`, `above`, `leftOf`, `rightOf`, `childOf`.

### Validate without a device

```bash
spana validate             # validates all flows in flowDir
spana validate flows/      # validate specific directory
```

Checks: valid exports, no duplicate names, valid platform values, directory exists.

### Run and read results

```bash
spana test --platform web --reporter json
spana test flows/login.flow.ts --reporter json
spana test --tag smoke --platform android --reporter json
spana test --grep "login" --reporter json

# Parse failures
spana test --reporter json 2>&1 | jq '.results[] | select(.status == "failed")'
```

## Agent workflow loop

```
1. spana selectors --platform <target>     -> discover elements
2. Write a .flow.ts file using selectors   -> create the test
3. spana validate flows/                   -> check structure (no device needed)
4. spana test <file> --reporter json       -> execute on device
5. If failed: read error, fix, goto 3
```

Do not skip step 3. Validation catches export errors, duplicate names, and invalid platforms before spending device time.

## Flow patterns

### Navigation with deep links

```ts
export default flow(
  "home screen loads",
  { autoLaunch: false },
  async ({ app, expect, platform }) => {
    const url = platform === "web" ? "http://localhost:3000/" : "myapp://home";
    await app.openLink(url);
    await expect({ testID: "home-screen" }).toBeVisible();
  },
);
```

### Form fill

```ts
await app.tap({ testID: "email-input" });
await app.inputText("user@example.com");
await app.tap({ testID: "password-input" });
await app.inputText("secret123");
await app.hideKeyboard();
await app.tap({ testID: "submit-btn" });
await expect({ testID: "dashboard" }).toBeVisible();
```

### Scrolling to find content

```ts
await app.scroll("down");
await expect({ testID: "footer-section" }).toBeVisible({ timeout: 10_000 });
```

### Platform branching

```ts
async ({ app, expect, platform }) => {
  await app.tap({ testID: "menu-btn" });
  if (platform === "android") {
    await app.back(); // close drawer via back button
  }
  if (platform === "web") {
    await app.evaluate(() => window.scrollTo(0, 0));
  }
};
```

### Artifact capture per flow

```ts
export default flow(
  "checkout flow",
  { artifacts: { captureOnSuccess: true, captureSteps: true } },
  async ({ app, expect }) => {
    /* ... */
  },
);
```

## Platform-specific notes

### Web

- Uses Playwright (CDP). No companion binary needed.
- `testID` maps to `data-testid` attribute.
- `app.evaluate()` runs JS in the browser context.
- Default `baseUrl`: `http://localhost:3000`.

### Android

- Uses UiAutomator2 HTTP server (APK auto-installed on device).
- `testID` maps to `resource-id`.
- `app.back()` triggers the system back button.
- Emulators and physical devices supported.

### iOS

- Uses WebDriverAgent (XCTest bundle).
- `testID` maps to `accessibilityIdentifier`.
- Simulators: works out of the box.
- Physical devices: requires code signing config in `spana.config.ts`.
- `app.back()` may not work the same as Android; prefer tap on back button element.

## Error handling

| Error                         | Cause                                        | Fix                                                                     |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `Element not found: {...}`    | Selector does not match any visible element  | Run `spana selectors` to verify element exists and get correct selector |
| `Timeout waiting for element` | Element didn't appear within wait timeout    | Increase `timeout` in opts, or check if prior navigation succeeded      |
| `Duplicate flow name`         | Two flow files export the same `name` string | Rename one of the flows                                                 |
| `Invalid platform`            | Platform string is not web/android/ios       | Fix the `platforms` array in FlowConfig                                 |
| `No Android device connected` | No emulator/device available                 | Start emulator or connect device, verify with `spana devices`           |
| `No iOS simulator available`  | No booted simulator found                    | Boot a simulator: `xcrun simctl boot <udid>`                            |

When a flow fails at runtime, the JSON reporter includes the error message and the step that failed. Read the `results[].error` field to diagnose.

## Config reference

`spana.config.ts` at project root:

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: { packageName: "com.example.app" },
    ios: { bundleId: "com.example.app", appPath: "./MyApp.app" },
  },
  platforms: ["web", "android", "ios"],
  flowDir: "./flows",
  reporters: ["console", "json", "html"],
  defaults: {
    waitTimeout: 5000, // ms to wait for element visibility
    pollInterval: 200, // ms between hierarchy polls
    settleTimeout: 300, // ms of stability before match
    retries: 2, // retries on action failure
  },
  artifacts: {
    outputDir: ".spana/artifacts",
    captureOnFailure: true,
    captureOnSuccess: false,
    screenshot: true,
    uiHierarchy: true,
  },
  hooks: {
    beforeAll: async ({ app }) => {
      /* global setup */
    },
    beforeEach: async ({ app }) => {
      /* per-flow setup, e.g. clear state */
    },
    afterEach: async ({ app, result }) => {
      /* per-flow teardown */
    },
    afterAll: async ({ app, summary }) => {
      /* global cleanup */
    },
  },
});
```

Key config options for agents:

- `flowDir`: where to put flow files (default `./flows`)
- `defaults.waitTimeout`: how long auto-wait polls before failing
- `artifacts.captureOnFailure`: auto-capture screenshots on failure (useful for debugging)
- `reporters`: use `["json"]` for machine-readable output
