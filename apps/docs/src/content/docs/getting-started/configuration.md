---
title: Configuration
description: Full reference for defineConfig() and all spana configuration options.
---

Configuration lives in `spana.config.ts` at the project root. Pass the config object to `defineConfig` for type safety.

```ts
import { defineConfig } from "spana";

export default defineConfig({
  // ...
});
```

Use `--config ./path/to/spana.config.ts` to specify a different location.

## Full example

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
  reporters: ["console", "json", "html"],
  defaults: {
    waitTimeout: 5000,
    pollInterval: 200,
    settleTimeout: 300,
    retries: 2,
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

## `apps`

Defines the app targets for each platform.

```ts
apps: {
  web?:     { url: string };
  android?: { packageName: string };
  ios?:     { bundleId: string };
}
```

| Field                 | Platform | Description                                     |
| --------------------- | -------- | ----------------------------------------------- |
| `web.url`             | Web      | Base URL Playwright navigates to on launch      |
| `android.packageName` | Android  | Android application ID (e.g. `com.example.app`) |
| `ios.bundleId`        | iOS      | iOS bundle identifier (e.g. `com.example.app`)  |

## `platforms`

```ts
platforms?: Array<"web" | "android" | "ios">
```

Which platforms to run tests on by default. Can be overridden per-flow with `FlowConfig.platforms` and at the CLI with `--platform`.

Default: `["web"]`

## `flowDir`

```ts
flowDir?: string
```

Directory to discover flow files from. Accepts a glob or directory path.

Default: `"./flows"`

## `reporters`

```ts
reporters?: string[]
```

One or more reporter names. Available reporters:

| Name      | Output                                               |
| --------- | ---------------------------------------------------- |
| `console` | Human-readable terminal output (default)             |
| `json`    | Structured JSON events to stdout                     |
| `junit`   | JUnit XML — compatible with CI artifact ingestion    |
| `html`    | Self-contained HTML report with embedded screenshots |

Default: `["console"]`

## `defaults`

Timing and retry defaults applied to all auto-wait operations. Individual operations can override these with `WaitOptions`.

```ts
defaults?: {
  waitTimeout?:   number;  // ms
  pollInterval?:  number;  // ms
  settleTimeout?: number;  // ms
  retries?:       number;
}
```

| Option          | Default | Description                                                     |
| --------------- | ------- | --------------------------------------------------------------- |
| `waitTimeout`   | `5000`  | Maximum ms to wait for an element to appear                     |
| `pollInterval`  | `200`   | ms between hierarchy polls                                      |
| `settleTimeout` | `300`   | ms the element must remain stable before matching               |
| `retries`       | `2`     | Number of retries on action failure (e.g. tap on stale element) |

## `artifacts`

Controls screenshot and hierarchy capture on test completion.

```ts
artifacts?: {
  outputDir?:        string;
  captureOnFailure?: boolean;
  captureOnSuccess?: boolean;
  screenshot?:       boolean;
  uiHierarchy?:      boolean;
}
```

| Option             | Default              | Description                           |
| ------------------ | -------------------- | ------------------------------------- |
| `outputDir`        | `".spana/artifacts"` | Directory to write captured artifacts |
| `captureOnFailure` | `true`               | Capture on failed flows               |
| `captureOnSuccess` | `false`              | Capture on passed flows               |
| `screenshot`       | `true`               | Include screenshot in capture         |
| `uiHierarchy`      | `true`               | Include UI hierarchy dump in capture  |

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

`HookContext` provides `app`, `expect`, `platform`, `result` (in `afterEach`), and `summary` (in `afterAll`).
