---
title: Remote Execution
description: Run tests against remote Appium servers and cloud device farms.
---

By default, spana runs tests locally using built-in drivers (Playwright or direct CDP for web, UiAutomator2 for Android, WebDriverAgent for iOS). Switch to **Appium mode** to run Android and iOS against a remote Appium server — useful for cloud device farms, shared test infrastructure, or devices on another machine. Web, Electron, and Electrobun still run locally in Appium mode.

## Enabling Appium mode

### Config file

```ts title="spana.config.ts"
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: "http://localhost:4723",
    },
  },
});
```

### CLI flags

```bash
spana test --appium-url http://localhost:4723
```

The `--appium-url` flag automatically enables Appium mode. You can also select the mode explicitly with `--driver appium` (or `--driver local` to override a config that sets `mode: "appium"`).

The server URL is resolved in this order: `--appium-url`, the `SPANA_APPIUM_URL` environment variable, then `execution.appium.serverUrl`. `SPANA_APPIUM_URL` only supplies the URL; it does not switch on Appium mode by itself.

### Auto-starting a local Appium server

With `--appium-auto-start` (or `execution.appium.autoStart: true`), spana spawns `appium` from `PATH` for the duration of the run and ignores any configured URL. Appium mode must still be on (`mode: "appium"` or `--driver appium`). Use `autoStartBinary` and `autoStartArgs` to change the binary or pass extra arguments.

## How it works

In Appium mode, spana:

1. Connects to the Appium server at the given URL
2. Creates one session per platform with the resolved [capabilities](#capabilities)
3. Runs your flows using the Appium WebDriver protocol instead of local drivers
4. Deletes the session when the run completes
5. Reports results to the [cloud provider](/guides/cloud-providers) if detected

The same flow files work in both local and Appium mode -- no changes needed.

Appium mode runs one session per platform. `--parallel`, `--workers`, and `--devices` use the local device-discovery path and do not create Appium sessions.

## Cloud helper config

For BrowserStack and Sauce Labs, Spana can also manage provider-specific helper behavior on top of raw capabilities:

- upload a local app artifact and inject `appium:app`
- start and stop BrowserStack Local / Sauce Connect
- fill missing `bstack:options` / `sauce:options` values from config

Raw capabilities still win. Helper config fills missing provider fields and lifecycle, but it does not override explicit `appium:app`, `bstack:options`, or `sauce:options` values you already provided through config, `--caps`, or `--caps-json`.

## Capabilities

Appium sessions are configured through W3C capabilities. Spana merges capabilities from five sources (later overrides earlier):

| Source              | How to set                                               | Example                                |
| ------------------- | -------------------------------------------------------- | -------------------------------------- |
| Launch device state | `launchOptions.deviceState`                              | `{ language: "sv", locale: "sv_SE" }`  |
| Config file         | `execution.appium.capabilities`                          | `{ "appium:app": "/path/to/app" }`     |
| Platform config     | `execution.appium.platformCapabilities.android` / `.ios` | `{ "appium:deviceName": "iPhone 15" }` |
| JSON file           | `--caps <path>` or `capabilitiesFile` in config          | `caps.json`                            |
| Inline CLI          | `--caps-json '<json>'`                                   | `'{"appium:deviceName": "Pixel 7"}'`   |

### Android capabilities

```json title="caps-android.json"
{
  "appium:automationName": "UiAutomator2",
  "appium:deviceName": "emulator-5554",
  "appium:app": "/path/to/app.apk",
  "appium:appPackage": "com.example.myapp",
  "appium:appActivity": "com.example.myapp.MainActivity"
}
```

Spana sets `platformName: "Android"` by default. Your capabilities can override it.

### iOS capabilities

```json title="caps-ios.json"
{
  "appium:automationName": "XCUITest",
  "appium:deviceName": "iPhone 15",
  "appium:platformVersion": "18.0",
  "appium:app": "/path/to/app.ipa",
  "appium:bundleId": "com.example.myapp"
}
```

Spana sets `platformName: "iOS"` and `appium:automationName: "XCUITest"` by default. Your capabilities can override them.

## Local Appium server

To test against a local Appium server:

```bash
# Install Appium
npm install -g appium

# Install drivers
appium driver install uiautomator2
appium driver install xcuitest

# Start the server
appium

# Run tests against it
spana test --appium-url http://localhost:4723
```

## Config reference

```ts title="spana.config.ts"
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      // Appium server URL (required in appium mode)
      serverUrl: "http://localhost:4723",

      // Inline capabilities (applied after launchOptions.deviceState)
      capabilities: {
        "appium:app": "/path/to/app.apk",
      },

      // Per-platform capabilities (override `capabilities`)
      platformCapabilities: {
        android: { "appium:deviceName": "Pixel 7" },
        ios: { "appium:deviceName": "iPhone 15" },
      },

      // Path to a JSON capabilities file, resolved relative to spana.config.ts
      // (overrides config capabilities; --caps-json overrides this)
      capabilitiesFile: "./caps.json",

      // Report results to cloud provider (default: true)
      reportToProvider: true,

      // Spawn a local `appium` for the run (default: false)
      autoStart: false,
      autoStartBinary: "appium",
      autoStartArgs: [],

      // Custom cloud provider module (see Cloud Providers guide)
      // cloudProvider: "./providers/acme-grid.ts",

      // BrowserStack helper config
      browserstack: {
        app: { path: "./builds/app.apk", customId: "spana-android" },
        local: { enabled: true, identifier: "spana-local" },
        options: {
          projectName: "my-app",
          buildName: "ci-42",
        },
      },

      // Sauce Labs helper config
      saucelabs: {
        app: { path: "./builds/app.apk", name: "app.apk" },
        connect: { enabled: true, tunnelName: "spana-ci" },
        options: {
          build: "ci-42",
          name: "login-flow",
        },
      },
    },
  },
});
```

## CLI flags

| Flag                       | Description                             |
| -------------------------- | --------------------------------------- |
| `--appium-url <url>`       | Appium server URL (enables appium mode) |
| `--driver <local\|appium>` | Select the execution mode explicitly    |
| `--appium-auto-start`      | Spawn a local `appium` for the run      |
| `--caps <path>`            | Path to capabilities JSON file          |
| `--caps-json <json>`       | Inline capabilities JSON string         |
| `--no-provider-reporting`  | Disable cloud provider result reporting |

## Cloud providers

When the Appium URL points to BrowserStack or Sauce Labs, spana auto-detects the provider and reports test results. See the [Cloud Providers](/guides/cloud-providers) guide for setup details.
