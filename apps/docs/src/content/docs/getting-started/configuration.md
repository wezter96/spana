---
title: Configuration
description: Full reference for defineConfig() and all spana configuration options.
---

Configuration lives in `spana.config.ts` at the project root. Pass the config object to `defineConfig` for type safety.

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  // ...
});
```

Use `--config ./path/to/spana.config.ts` to specify a different location.

Run `spana validate-config` to validate the file without starting drivers or discovering flows.

## Full example

```ts
import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: { packageName: "com.example.app", appPath: "./builds/app.apk" },
    ios: {
      bundleId: "com.example.app",
      appPath: "./builds/App.app",
      signing: { teamId: "ABCDE12345" },
    },
  },
  platforms: ["web", "android", "ios"],
  parallelPlatforms: true,
  flowDir: "./flows",
  reporters: ["console", "json", "html"],
  defaults: {
    waitTimeout: 5000,
    pollInterval: 200,
    settleTimeout: 250,
    initialPollInterval: 50,
    waitForIdleTimeout: 150,
    typingDelay: 20,
    retries: 2,
    retryDelay: 250,
    workers: 2,
  },
  artifacts: {
    outputDir: "./spana-output",
    captureOnFailure: true,
    captureOnSuccess: false,
    captureSteps: false,
    screenshot: true,
    uiHierarchy: true,
    consoleLogs: true,
    jsErrors: true,
    har: true,
  },
  execution: {
    web: {
      browser: "chromium",
      engine: "playwright", // default; or "auto" | "cdp" | "lightpanda"
      cdpUrl: undefined, // e.g. "http://127.0.0.1:9222" for Lightpanda or an existing CDP browser
      wsEndpoint: undefined, // e.g. BrowserStack Automate Web Playwright wsEndpoint
      headless: true,
      warmBrowser: true, // keep warm headless Chromium daemon alive across runs
      instantAnimations: true, // collapse CSS transitions/animations to 0.001ms
      blockResources: ["image", "font", "media"], // optional heavy asset abort
      waitUntil: "load", // "domcontentloaded" | "load" | "networkidle" | "commit"
      verboseLogging: false,
      storybook: { url: "http://localhost:6006" },
    },
    appium: {
      serverUrl: "https://hub.browserstack.com/wd/hub",
      reportToProvider: true,
    },
  },
  visualRegression: {
    threshold: 0.2,
    maxDiffPixelRatio: 0.01,
    baselinesDir: "./visual-baselines",
  },
  hooks: {
    beforeAll: async ({ platform }) => {
      /* global setup — no app instance yet */
    },
    beforeEach: async ({ app }) => {
      /* reset state */
    },
    afterEach: async ({ app, result }) => {
      /* teardown */
    },
    afterAll: async ({ platform, summary }) => {
      /* cleanup */
    },
  },
});
```

## `apps`

Defines the app targets for each platform.

```ts
apps: {
  web?:        { url?: string; bridge?: BridgeConfig };
  android?:    { packageName?: string; appPath?: string; cdpPort?: number; bridge?: BridgeConfig };
  ios?:        {
    bundleId?: string;
    appPath?: string;
    signing?: IOSSigningConfig;
    webkitInspectorUrl?: string;
    webkitInspectorPort?: number;
    bridge?: BridgeConfig;
  };
  electron?:   ElectronAppConfig;
  electrobun?: ElectrobunAppConfig;
}
```

| Field                     | Platform    | Description                                                   |
| ------------------------- | ----------- | ------------------------------------------------------------- |
| `web.url`                 | Web         | Base URL the browser navigates to on launch                   |
| `android.packageName`     | Android     | Android application ID (e.g. `com.example.app`)               |
| `ios.bundleId`            | iOS         | iOS bundle identifier (e.g. `com.example.app`)                |
| `appPath`                 | Android/iOS | Path to `.app`, `.ipa`, or `.apk` for auto-install            |
| `signing.teamId`          | iOS         | Apple Development Team ID (required for physical devices)     |
| `signing.signingIdentity` | iOS         | Code signing identity (default: `"Apple Development"`)        |
| `cdpPort`                 | Android     | Explicit CDP port for Android WebView DOM access              |
| `webkitInspectorUrl/Port` | iOS         | Explicit WebKit Inspector target for WKWebView DOM access     |
| `bridge`                  | All         | Per-app `spana-bridge` override (replaces `execution.bridge`) |

`apps.electron` launches an Electron app (`entry` or `executablePath`, plus `args`, `cwd`, `env`, `url`) or attaches to a running one with `cdpUrl` / `cdpPort`. `apps.electrobun` takes `executablePath` or `appDir`, `args`, `cwd`, `env`, `renderer` (`"native"` or `"cef"`), `cdpUrl` / `cdpPort`, `webkitInspectorPort`, and `url`. Both accept `bridge`.

## `platforms`

```ts
platforms?: Array<"web" | "android" | "ios" | "electron" | "electrobun">
```

Which platforms to run tests on by default. Can be overridden per-flow with `FlowConfig.platforms` and at the CLI with `--platform`.

Default: `["web"]`

## `parallelPlatforms`

```ts
parallelPlatforms?: boolean
```

Run platform groups concurrently instead of serially.

Default: `false`

This is most useful when your web, Android, and iOS runs use independent resources. CLI parallel controls such as `--parallel`, `--workers`, and `--devices` can still force concurrent execution for the selected run.

## `flowDir`

```ts
flowDir?: string
```

Directory to discover flow files from. spana searches it recursively for `*.flow.ts`, `*.test.ts`, and `*.feature` files. A single file path also works.

Default: `"./flows"`

Relative paths are resolved from the directory that contains the config file, not from the current shell directory.

## `reporters`

```ts
reporters?: string[]
```

One or more reporter names or custom reporter module paths. Available reporters:

| Name      | Output                                                                   |
| --------- | ------------------------------------------------------------------------ |
| `console` | Human-readable terminal output (default)                                 |
| `json`    | Structured JSON events to stdout                                         |
| `junit`   | JUnit XML — compatible with CI artifact ingestion                        |
| `html`    | Self-contained HTML report with embedded screenshots                     |
| `allure`  | Allure-compatible result files                                           |
| `github`  | Markdown summary (`github-pr-summary.md`) and GitHub Actions job summary |

Default: `["console"]`

A custom reporter is a relative path (e.g. `"./reporters/slack.ts"`) whose default export is a `Reporter` object or a `(options: { outputDir: string }) => Reporter` factory. See [Custom Reporters](/reference/custom-reporters/).

## `execution`

Execution mode and remote Appium settings.

```ts
execution?: {
  mode?: "local" | "appium";
  web?: {
    browser?: "chromium" | "firefox" | "webkit";
    engine?: "playwright" | "auto" | "cdp" | "lightpanda";
    cdpUrl?: string;
    wsEndpoint?: string;
    executablePath?: string;
    channel?: string;
    headless?: boolean;
    waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
    instantAnimations?: boolean;
    blockResources?: Array<"image" | "font" | "media" | "stylesheet">;
    warmBrowser?: boolean;
    warmBrowserScope?: string;
    freshContextPerFlow?: boolean;
    contextIsolation?: "hot-cache" | "fresh";
    maxContextsPerBrowser?: number;
    virtualAuthenticator?: boolean | VirtualAuthenticatorOptions;
    storageState?: string;
    verboseLogging?: boolean;
    storybook?: {
      url?: string;
      iframePath?: string;
    };
  };
  bridge?: {
    enabled?: boolean;
    port?: number;           // default 9333
    host?: string;           // default "127.0.0.1"
    url?: string;
    connectTimeout?: number; // ms, default 5000
  };
  warmDaemons?: {
    enabled?: boolean;
    reuseSession?: boolean;
    stateFile?: string;
  };
  appium?: {
    serverUrl?: string;
    capabilities?: Record<string, unknown>;
    platformCapabilities?: {
      android?: Record<string, unknown>;
      ios?: Record<string, unknown>;
    };
    capabilitiesFile?: string;
    autoStart?: boolean;
    autoStartBinary?: string;
    autoStartArgs?: string[];
    reportToProvider?: boolean;
    cloudProvider?: string;
    browserstack?: {
      app?: { id?: string; path?: string; name?: string; customId?: string };
      local?: { enabled?: boolean; binary?: string; identifier?: string; args?: string[] };
      options?: Record<string, unknown>;
    };
    saucelabs?: {
      app?: { id?: string; path?: string; name?: string };
      connect?: { enabled?: boolean; binary?: string; tunnelName?: string; args?: string[] };
      options?: Record<string, unknown>;
    };
  };
}
```

Use `execution.web` to configure the local browser runtime for web flows.

| Field                   | Description                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser`               | Browser for local web runs: `chromium` (default), `firefox`, or `webkit`                                                                                                        |
| `engine`                | `"playwright"` (default), `"cdp"` (direct CDP to Chromium, no Playwright pipe), `"lightpanda"` (connects to `cdpUrl`, default `http://127.0.0.1:9222`), or `"auto"` (see below) |
| `cdpUrl`                | Connect to an existing CDP browser or Lightpanda endpoint instead of launching one                                                                                              |
| `wsEndpoint`            | Connect to a remote Playwright server (e.g. BrowserStack Automate)                                                                                                              |
| `executablePath`        | Explicit browser binary                                                                                                                                                         |
| `channel`               | Playwright browser channel such as `"chrome"` or `"msedge"`                                                                                                                     |
| `headless`              | Run without a visible browser window (default `true`)                                                                                                                           |
| `waitUntil`             | Navigation readiness event for launch / `openLink` (default `"load"`)                                                                                                           |
| `instantAnimations`     | Collapse CSS transitions and animations for faster, deterministic runs                                                                                                          |
| `blockResources`        | Abort `image`, `font`, `media`, or `stylesheet` requests                                                                                                                        |
| `warmBrowser`           | Reuse a persistent warm Chromium process across runs (Chromium only; falls back to `warmDaemons.enabled`)                                                                       |
| `warmBrowserScope`      | Key that isolates warm browsers between concurrent repos or runs                                                                                                                |
| `freshContextPerFlow`   | Isolate browser state between flows; defaults to `"hot-cache"` on Direct CDP (wipes cookies/storage/OPFS/IDB while keeping HTTP/V8 caches warm)                                 |
| `contextIsolation`      | Direct CDP isolation strategy when `freshContextPerFlow` is enabled: `"hot-cache"` (default, ~4 ms reset) or `"fresh"` (brand-new `Target.createBrowserContext` per flow)       |
| `maxContextsPerBrowser` | Max worker contexts sharing one browser process under `--parallel` (default `4` for `cdp` with multiplexed WebSocket, `2` otherwise)                                            |
| `virtualAuthenticator`  | Attach a WebAuthn virtual authenticator (passkeys) to each new context; `true` or an options object                                                                             |
| `storageState`          | Preload Playwright cookies and storage state from a JSON file                                                                                                                   |
| `verboseLogging`        | Print verbose Playwright browser/page diagnostics to stdout                                                                                                                     |
| `storybook.url`         | Dedicated Storybook origin for `app.openStory()` / `Session.openStory()`                                                                                                        |
| `storybook.iframePath`  | Override Storybook's preview iframe path, default `/iframe.html`                                                                                                                |

`engine: "auto"` uses the direct CDP engine when `browser` is `chromium` and you have not set `wsEndpoint`, `channel`, or `artifacts.har`; otherwise it uses Playwright. The direct CDP engine does not support `app.getHAR()`.

`storageState` is resolved relative to `spana.config.ts`. Storybook uses URLs instead of filesystem paths, so it stays portable by pointing at the right origin for each environment.

`execution.bridge` configures the optional in-app `spana-bridge` WebSocket server shared by WebView targets. It is enabled when `enabled: true`, or when you set `port` or `url`. `execution.warmDaemons.enabled` keeps WDA / UiAutomator2 daemons alive between runs (default `false`); `reuseSession` (default `true` when enabled) reuses the active session; `stateFile` overrides where daemon metadata is stored. Use `spana daemon status` / `spana daemon stop` to inspect or stop them.

Use `mode: "appium"` when running against BrowserStack, Sauce Labs, or another Appium-compatible grid.

| Field                               | Description                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `serverUrl`                         | Remote Appium server URL                                                          |
| `capabilities` / `capabilitiesFile` | Raw desired capabilities, with file paths resolved relative to the config file    |
| `platformCapabilities`              | Extra capabilities merged on top of `capabilities` for `android` or `ios`         |
| `autoStart`                         | Spawn a local `appium` process for the run (default `false`; ignores `serverUrl`) |
| `autoStartBinary` / `autoStartArgs` | Override the `appium` binary name and pass extra CLI args to it                   |
| `reportToProvider`                  | Mark the remote session passed/failed when the provider supports it               |
| `cloudProvider`                     | Path to a custom cloud provider module that default-exports a `CloudProvider`     |
| `browserstack`                      | BrowserStack upload, local tunnel, and capability helper settings                 |
| `saucelabs`                         | Sauce Labs upload, Sauce Connect, and capability helper settings                  |

Raw capabilities from `execution.appium.capabilities`, `capabilitiesFile`, and `--caps-json` remain the strongest override surface. Provider helper sections fill in missing provider-specific fields and can manage BrowserStack Local / Sauce Connect lifecycle when enabled. For a custom provider implementation, see [Cloud Providers](/guides/cloud-providers/).

## CLI precedence

For `spana test`, CLI flags win over config values.

| CLI flag                                       | Config field                                         |
| ---------------------------------------------- | ---------------------------------------------------- |
| `--platform`                                   | `platforms`                                          |
| `--reporter`                                   | `reporters`                                          |
| `--retries`                                    | `defaults.retries`                                   |
| `--workers`                                    | `defaults.workers`                                   |
| `--driver`                                     | `execution.mode`                                     |
| `--appium-url`                                 | `execution.appium.serverUrl`                         |
| `--appium-auto-start`                          | `execution.appium.autoStart`                         |
| `--caps` / `--caps-json`                       | `execution.appium.capabilitiesFile` / `capabilities` |
| `--changed-since <ref>`                        | Runs the configured `filters`                        |
| `--tag` / `--grep`                             | CLI-only flow selection                              |
| `--validate-config`                            | Validates config and exits                           |
| `--device` / `--devices`                       | CLI-only device selection                            |
| `--parallel`                                   | Enables concurrent execution                         |
| `--watch` / `--changed` / `--last-failed`      | CLI-only iteration controls                          |
| `--update-baselines`                           | CLI-only screenshot and ARIA baseline control        |
| `--js-coverage`                                | `artifacts.jsCoverage`                               |
| `--shard` / `--bail`                           | CLI-only execution controls                          |
| `--debug-on-failure` / `--verbose` / `--quiet` | CLI-only output and debugging controls               |

Sharding happens after tag/name/platform filtering so each shard gets a deterministic slice of the already-selected flows.

## `defaults`

Timing and retry defaults applied to all auto-wait operations. Individual operations can override these with `WaitOptions`.

```ts
defaults?: {
  waitTimeout?:   number;  // ms
  pollInterval?:  number;  // ms
  settleTimeout?: number;  // ms
  retries?:       number;
  waitForIdleTimeout?: number;
  typingDelay?: number;
  initialPollInterval?: number;
  hierarchyCacheTtl?: number;
  retryDelay?: number;
  workers?: number;
  snapshotMaxDepth?: number;
  tapMode?: "native" | "dom";
  failFastWhenIdle?: boolean;
}
```

| Option                | Default    | Description                                                                                                        |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `waitTimeout`         | `5000`     | Maximum ms to wait for an assertion or element lookup                                                              |
| `pollInterval`        | `200`      | Maximum ms between assertion polls                                                                                 |
| `settleTimeout`       | `0`        | Stable time required before an assertion passes                                                                    |
| `retries`             | `0`        | Retry count for failed flow executions                                                                             |
| `waitForIdleTimeout`  | `0`        | Pause after mutating actions such as tap or scroll                                                                 |
| `typingDelay`         | `0`        | Delay between typed characters                                                                                     |
| `initialPollInterval` | `50`       | First poll interval before adaptive backoff ramps up                                                               |
| `hierarchyCacheTtl`   | `100`      | Hierarchy cache freshness window in ms; set `0` to disable                                                         |
| `retryDelay`          | `0`        | Delay between failed flow retry attempts                                                                           |
| `workers`             | —          | Default max workers per platform when `--parallel` is enabled                                                      |
| `snapshotMaxDepth`    | `100`      | Max depth of iOS UI hierarchy snapshots                                                                            |
| `tapMode`             | `"native"` | When a DOM channel finds the element: `"native"` real touch, or `"dom"` fast synthetic click                       |
| `failFastWhenIdle`    | `false`    | On web, fail element waits early when the page is idle and fully loaded, instead of waiting the full `waitTimeout` |

## `artifacts`

Controls screenshot and hierarchy capture on test completion.

```ts
artifacts?: {
  outputDir?:        string;
  captureOnFailure?: boolean;
  captureOnSuccess?: boolean;
  captureSteps?:     boolean;
  screenshot?:       boolean;
  uiHierarchy?:      boolean;
  consoleLogs?:      boolean;
  jsErrors?:         boolean;
  har?:              boolean;
  jsCoverage?:       boolean;
  video?:            "off" | "on" | "retain-on-failure";
  playback?:         boolean;
}
```

| Option             | Default            | Description                                                                                     |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------------------- |
| `outputDir`        | `"./spana-output"` | Directory to write captured artifacts                                                           |
| `captureOnFailure` | `true`             | Capture artifacts for failed flows                                                              |
| `captureOnSuccess` | `false`            | Capture final artifacts for passed flows                                                        |
| `captureSteps`     | `false`            | Capture screenshots after each recorded step                                                    |
| `screenshot`       | `true`             | Include screenshots in captures                                                                 |
| `uiHierarchy`      | `true`             | Include UI hierarchy dumps                                                                      |
| `consoleLogs`      | `true`             | Include captured browser console logs on web                                                    |
| `jsErrors`         | `true`             | Include uncaught browser JavaScript errors on web                                               |
| `har`              | `true`             | Include HAR network traces on web                                                               |
| `jsCoverage`       | `false`            | Write `js-coverage.json` as a flow attachment for Chromium web tests (Playwright or direct CDP) |
| `video`            | `"off"`            | Record a video of each flow: `"on"`, or `"retain-on-failure"` to keep it only for failed flows  |
| `playback`         | `false`            | Keep a step-by-step visual playback timeline for the HTML report                                |

JavaScript coverage is collected for the primary page from before app launch through the end of the flow, whether the flow passes or fails. Secondary tabs and contexts are not included. Each flow gets a raw V8 coverage file; Spana does not merge coverage or generate a source-mapped report. Use `spana test --js-coverage` for a single run, or set `artifacts: { jsCoverage: true }` in the project or flow configuration.

## `hooks`

Lifecycle hooks that run around flow execution. Each hook receives a `HookContext`.

```ts
hooks?: {
  beforeAll?:  (ctx: HookContext) => Promise<void>;
  beforeEach?: (ctx: HookContext) => Promise<void>;
  afterEach?:  (ctx: HookContext) => Promise<void>;
  afterAll?:   (ctx: HookContext) => Promise<void>;
}
```

| Hook         | When it runs                                              |
| ------------ | --------------------------------------------------------- |
| `beforeAll`  | Once before all flows on a platform                       |
| `beforeEach` | Before each individual flow                               |
| `afterEach`  | After each individual flow (always runs, even on failure) |
| `afterAll`   | Once after all flows on a platform                        |

`beforeEach` and `afterEach` receive `app` and `platform`, plus `result` in `afterEach`. `beforeAll` and `afterAll` run outside any flow, so they receive `platform` (and `summary` in `afterAll`) but no `app`. `beforeEach` runs before the flow's automatic launch.

### Error handling

| Hook         | On failure                                                  |
| ------------ | ----------------------------------------------------------- |
| `beforeAll`  | All flows on that platform are skipped and marked as failed |
| `beforeEach` | That flow is skipped and marked as failed                   |
| `afterEach`  | Warning logged, test result is not affected                 |
| `afterAll`   | Warning logged, test results are not affected               |

### Example

```ts
export default defineConfig({
  hooks: {
    beforeEach: async ({ app }) => {
      await app.launch({ clearState: true });
    },
    afterEach: async ({ app, result }) => {
      if (result?.status === "failed") {
        console.log(`Flow failed: ${result.name}`);
      }
    },
  },
});
```

## Per-flow configuration

The `flow()` function accepts an optional config object as its second argument, letting you override global settings for a single flow.

```ts
import { flow } from "spana-test";

flow(
  "checkout",
  {
    timeout: 30000,
    tags: ["smoke"],
    artifacts: { captureSteps: true },
    launchOptions: { deepLink: "myapp://checkout" },
  },
  async ({ app }) => {
    // ...
  },
);
```

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
```

| Option          | Default                                 | Description                                                         |
| --------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `tags`          | `[]`                                    | Tags for CLI filtering with `--tag`                                 |
| `platforms`     | —                                       | Restrict a flow to specific platforms                               |
| `timeout`       | `defaults.waitTimeout × 10`, or `60000` | Overall flow timeout in ms                                          |
| `autoLaunch`    | `true`                                  | Automatically launch the app before the flow starts                 |
| `launchOptions` | —                                       | Per-flow launch defaults merged on top of project `launchOptions`   |
| `artifacts`     | —                                       | Per-flow artifact overrides                                         |
| `defaults`      | —                                       | Per-flow wait, typing, cache, and idle timing overrides             |
| `when`          | —                                       | Runtime conditions such as `platform` or environment-variable gates |

The per-flow `artifacts` object is merged with the global `artifacts` config, so you only need to specify the fields you want to override. For example, enabling `captureSteps` on a single flow:

```ts
flow(
  "visual regression",
  { artifacts: { captureSteps: true, captureOnSuccess: true } },
  async ({ app }) => {
    // Every step is captured, and the final state is saved even on success
  },
);
```

## `launchOptions`

Default launch options applied to each flow launch. `FlowConfig.launchOptions` overrides these defaults for one flow, and explicit `app.launch(opts)` calls are merged on top of both.

```ts
launchOptions?: LaunchOptions
```

```ts
export default defineConfig({
  launchOptions: {
    clearState: true, // fresh state every run
  },
});
```

### `LaunchOptions` reference

```ts
interface LaunchOptions {
  clearState?: boolean;
  clearKeychain?: boolean;
  deepLink?: string;
  launchArguments?: Record<string, unknown>;
  deviceState?: DeviceStateConfig;
}

interface DeviceStateConfig {
  language?: string;
  locale?: string;
  timeZone?: string;
}
```

| Option            | Default | Description                                                                          |
| ----------------- | ------- | ------------------------------------------------------------------------------------ |
| `clearState`      | `false` | Clear app data/storage before launch                                                 |
| `clearKeychain`   | `false` | Clear the iOS keychain before launch (simulator only)                                |
| `deepLink`        | —       | Open the app via a deep link URL                                                     |
| `launchArguments` | —       | Key-value pairs passed as launch arguments to the app                                |
| `deviceState`     | —       | Launch-time language / locale / time-zone overrides where the runtime can honor them |

#### Platform behavior

| Option            | Web                          | Android                                                    | iOS                                                                           |
| ----------------- | ---------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `clearState`      | Clears cookies, localStorage | `adb shell pm clear`                                       | Resets app permissions                                                        |
| `clearKeychain`   | No-op                        | No-op (warns)                                              | `xcrun simctl keychain reset`                                                 |
| `launchArguments` | No-op                        | Passed as `--es` extras via `am start`                     | Appium iOS: process args via `mobile: launchApp`; local WDA: warns + ignores  |
| `deviceState`     | Warns + ignores              | Appium: session-start caps; local Android: warns + ignores | Appium: session caps + launch-time process config; local WDA: warns + ignores |
| `deepLink`        | Navigates to URL             | `adb shell am start -d <url>`                              | `xcrun simctl openurl` / WDA                                                  |

Android `launchArguments` are string extras. For example:

```ts
await app.launch({
  launchArguments: {
    featureFlag: "on",
    buildVariant: "staging",
  },
});
```

`deviceState` is for launch-time localization and time-zone setup. It does **not** mutate the device clock mid-run. In Appium mode, suite-level `launchOptions.deviceState` is also mapped into session capabilities so defaults apply even when Appium keeps `autoLaunch` off. Common locale forms such as `fr_CA` / `fr-CA` are normalized for Appium, but Android still needs both language and region information available.

#### Per-flow usage

Use `FlowConfig.launchOptions` when one flow needs a different launch profile than the project defaults:

```ts
flow(
  "checkout in French",
  {
    autoLaunch: true,
    launchOptions: {
      clearState: true,
      deepLink: "myapp://checkout",
      deviceState: {
        language: "fr",
        locale: "fr_CA",
        timeZone: "America/Toronto",
      },
    },
  },
  async ({ app }) => {
    // ...
  },
);
```

When `autoLaunch` is `false`, you can still call `app.launch()` manually. The project and per-flow defaults are merged first, then the manual call wins:

```ts
flow("onboarding", { autoLaunch: false }, async ({ app }) => {
  await app.launch({ deepLink: "myapp://welcome" });
  // ...
});
```

## `visualRegression`

Project-level defaults for screenshot assertions.

```ts
visualRegression?: {
  threshold?: number;
  maxDiffPixelRatio?: number;
  baselinesDir?: string;
}
```

| Option              | Default                                | Description                                         |
| ------------------- | -------------------------------------- | --------------------------------------------------- |
| `threshold`         | `0.2`                                  | Pixel comparison sensitivity                        |
| `maxDiffPixelRatio` | `0.01`                                 | Maximum differing pixels before the assertion fails |
| `baselinesDir`      | `__baselines__` next to each flow file | Centralize baseline screenshots in one directory    |

These values become defaults for `expect(selector).toMatchScreenshot(name, options?)`. Per-assertion options still win, and baseline rewrites are still controlled by `spana test --update-baselines`.

## `filters`

```ts
filters?: TestFilter[]
```

CI test filters that run only when you pass `spana test --changed-since <ref>`. Each filter gets the selected flows and the git changes since `<ref>`, and returns the flows to skip. `spana-test` exports `pathRuleFilter`, `deterministicImpactFilter`, and `decisionFilter`. Without `filters`, `--changed-since` warns and runs all flows. See [CI Integration](/guides/ci-integration/).
