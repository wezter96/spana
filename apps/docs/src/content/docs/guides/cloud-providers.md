---
title: Cloud Providers
description: Run tests on BrowserStack and Sauce Labs device clouds.
---

Spana can run mobile (Android and iOS) tests on cloud device farms through Appium. It auto-detects BrowserStack and Sauce Labs from the server URL hostname, reports the run result back to the provider dashboard, and can manage provider-specific upload/tunnel helpers from config. Keep the credentials in the URL (`https://USER:KEY@...`): managed uploads, tunnels, and result reporting read them from there.

## Supported providers

| Provider                          | Auto-detected | Result reporting | Managed helpers           |
| --------------------------------- | ------------- | ---------------- | ------------------------- |
| BrowserStack                      | Yes           | Yes              | Yes                       |
| Sauce Labs                        | Yes           | Yes              | Yes                       |
| Custom provider (`cloudProvider`) | --            | No (see below)   | Yes (your `createHelper`) |
| Other Appium grid                 | --            | No               | No                        |

## BrowserStack

### 1. Set your credentials

Embed credentials in the Appium server URL:

```ts title="spana.config.ts"
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: "https://USER:KEY@hub-cloud.browserstack.com/wd/hub",
    },
  },
});
```

Or pass them on the CLI:

```bash
spana test --appium-url "https://USER:KEY@hub-cloud.browserstack.com/wd/hub"
```

### 2. Set capabilities or helper config

Create a `caps.json` file with BrowserStack-specific options:

```json title="caps.json"
{
  "bstack:options": {
    "projectName": "my-app",
    "buildName": "ci-42",
    "deviceName": "Samsung Galaxy S23",
    "os_version": "13.0"
  },
  "appium:app": "bs://app-id-from-upload"
}
```

Then reference it:

```bash
spana test --caps caps.json
```

Or let Spana manage app upload, BrowserStack Local, and default `bstack:options` values from config:

```ts title="spana.config.ts"
export default defineConfig({
  apps: {
    android: {
      packageName: "com.example.myapp",
      appPath: "./builds/app.apk",
    },
  },
  execution: {
    mode: "appium",
    appium: {
      serverUrl: "https://USER:KEY@hub-cloud.browserstack.com/wd/hub",
      browserstack: {
        app: {
          customId: "spana-android",
        },
        local: {
          enabled: true,
          identifier: "spana-local",
        },
        options: {
          projectName: "my-app",
          buildName: process.env.CI_BUILD_ID ?? "local",
        },
      },
      capabilities: {
        "appium:deviceName": "Samsung Galaxy S23",
        "appium:platformVersion": "13.0",
      },
    },
  },
});
```

When an `execution.appium.browserstack` block is present, Spana uploads `browserstack.app.path`, or `apps.<platform>.appPath` when that is not set, and injects the returned `bs://...` URL as `appium:app`. Use `browserstack.app.id` when you already have a `bs://...` reference. If `appium:app` or `bstack:options` are already set in raw capabilities, those explicit values win and helper config only fills what is missing.

### 3. Result reporting

Spana reports pass/fail status to BrowserStack once, after the whole run completes. This updates each Appium session in the BrowserStack dashboard with the name `spana <platforms>` and `passed` (no flow failed) or `failed`. No per-flow status or failure reason is sent.

Disable reporting with `--no-provider-reporting` or in config:

```ts
appium: {
  reportToProvider: false,
}
```

When `browserstack.local.enabled` is true, Spana starts and stops BrowserStack Local for the run. Set `browserstack.local.binary` if the `BrowserStackLocal` binary is not on `PATH`, or keep managing the tunnel yourself and pass `bstack:options.local` manually.

## Sauce Labs

### 1. Set your credentials

```ts title="spana.config.ts"
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: "https://USER:KEY@ondemand.us-west-1.saucelabs.com/wd/hub",
    },
  },
});
```

For EU data center:

```bash
spana test --appium-url "https://USER:KEY@ondemand.eu-central-1.saucelabs.com/wd/hub"
```

### 2. Set capabilities or helper config

```json title="caps.json"
{
  "sauce:options": {
    "name": "login-flow",
    "build": "ci-42",
    "appiumVersion": "2.0"
  },
  "appium:deviceName": "Google Pixel 7",
  "appium:platformVersion": "13",
  "appium:app": "storage:filename=app.apk"
}
```

Or let Spana manage Sauce storage uploads, Sauce Connect, and default `sauce:options` values from config:

```ts title="spana.config.ts"
export default defineConfig({
  apps: {
    android: {
      packageName: "com.example.myapp",
      appPath: "./builds/app.apk",
    },
  },
  execution: {
    mode: "appium",
    appium: {
      serverUrl: "https://USER:KEY@ondemand.us-west-1.saucelabs.com/wd/hub",
      saucelabs: {
        app: {
          name: "app.apk",
        },
        connect: {
          enabled: true,
          tunnelName: "spana-ci",
        },
        options: {
          build: process.env.CI_BUILD_ID ?? "local",
          name: "login-flow",
        },
      },
      capabilities: {
        "appium:deviceName": "Google Pixel 7",
        "appium:platformVersion": "13",
      },
    },
  },
});
```

When an `execution.appium.saucelabs` block is present, Spana uploads `saucelabs.app.path`, or `apps.<platform>.appPath` when that is not set, to Sauce storage and injects `storage:<id>` as `appium:app`. Use `saucelabs.app.id` when you already have a Sauce storage reference such as `storage:YOUR_APP_ID`. Explicit `appium:app` and `sauce:options` capability values still override helper-derived defaults.

### 3. Result reporting

Sauce Labs sessions are updated with pass/fail status once, after the whole run completes (same rules as BrowserStack). Region is detected from the server URL hostname: uploads and Sauce Connect use `eu-central`, `us-east`, or `us-west` (default); result reporting uses `eu-central-1` when the hostname contains `eu-central`, otherwise `us-west-1`.

When `saucelabs.connect.enabled` is true, Spana starts and stops Sauce Connect for the run. Set `saucelabs.connect.binary` if the `sc` binary is not on `PATH`, or keep managing the tunnel yourself and pass `sauce:options.tunnelName` manually.

## Capability resolution

Capabilities merge from five sources, with later sources overriding earlier ones (`src/runtime/capabilities.ts`):

1. **Launch device state** -- `launchOptions.deviceState` (`language` / `locale` / `timeZone`) mapped to Appium capabilities
2. **Config file** -- `execution.appium.capabilities` in `spana.config.ts`
3. **Platform-specific config** -- `execution.appium.platformCapabilities.android` or `.ios`, for the platform being run
4. **Capabilities file** -- `--caps <path>` flag or `execution.appium.capabilitiesFile` in config
5. **Inline CLI JSON** -- `--caps-json '{"key": "value"}'`

This lets you keep shared capabilities in config, platform or environment-specific ones in `platformCapabilities` or a file, and override individual values from the CLI. Cloud helper config is applied after this merge and only fills fields that are still missing.

## Custom cloud providers

If you use an Appium grid other than BrowserStack or Sauce Labs, point `execution.appium.cloudProvider` at a module that default-exports a `CloudProvider`.

```ts title="spana.config.ts"
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: "https://grid.example.com/wd/hub",
      cloudProvider: "./providers/acme-grid.ts",
    },
  },
});
```

The module path is resolved relative to `spana.config.ts`.

:::caution
Today the CLI only calls `createHelper()` (and the helper's `prepareCapabilities()` / `cleanup()`) on a custom provider. End-of-run result reporting is only wired for the built-in BrowserStack and Sauce Labs providers, so a custom `extractMeta()` / `reportResult()` is not called by `spana test`.
:::

### `CloudProvider`

```ts
import type { CloudProvider, CloudProviderHelper } from "spana-test";

const provider: CloudProvider = {
  name() {
    return "Acme Grid";
  },

  createHelper(appiumUrl, config): CloudProviderHelper {
    return {
      async prepareCapabilities(platform, caps, appConfig) {
        return {
          ...caps,
          "acme:options": {
            platform,
            appIdentifier: appConfig?.packageName ?? appConfig?.bundleId,
          },
        };
      },

      async cleanup() {
        // stop tunnels, delete temporary uploads, etc.
      },
    };
  },

  extractMeta(sessionId, caps, meta) {
    meta.sessionId = sessionId;
    meta.build = String(caps["build"] ?? "");
  },

  async reportResult(appiumUrl, meta, result) {
    await fetch(`${appiumUrl}/custom-results/${meta.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });
  },
};

export default provider;
```

### Interface responsibilities

| API                     | Responsibility                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `name()`                | Human-readable provider name                                                                  |
| `createHelper()`        | Build a helper for capability mutation and lifecycle cleanup                                  |
| `prepareCapabilities()` | Add provider-specific desired capabilities before session creation                            |
| `cleanup()`             | Tear down uploads, tunnels, or temporary state after the run                                  |
| `extractMeta()`         | Pull provider metadata from the created session for reporting (built-in providers only today) |
| `reportResult()`        | Mark the remote session passed or failed (built-in providers only today)                      |

## CI example

```yaml title=".github/workflows/test.yml"
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: |
          spana test \
            --platform android \
            --appium-url "https://${{ secrets.BS_USER }}:${{ secrets.BS_KEY }}@hub-cloud.browserstack.com/wd/hub" \
            --caps caps.json \
            --caps-json '{"bstack:options": {"buildName": "${{ github.run_id }}"}}'
```
