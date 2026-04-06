---
title: Remote Execution
description: Run tests against remote Appium servers and cloud device farms.
---

By default, spana runs tests locally using built-in drivers (Playwright for web, UiAutomator2 for Android, WebDriverAgent for iOS). Switch to **Appium mode** to run against a remote Appium server — useful for cloud device farms, shared test infrastructure, or devices on another machine.

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

The `--appium-url` flag automatically enables Appium mode.

## How it works

In Appium mode, spana:

1. Connects to the Appium server at the given URL
2. Creates a session with the resolved [capabilities](#capabilities)
3. Runs your flows using the Appium WebDriver protocol instead of local drivers
4. Deletes the session when the run completes
5. Reports results to the [cloud provider](/spana/guides/cloud-providers) if detected

The same flow files work in both local and Appium mode -- no changes needed.

## Cloud helper config

For BrowserStack and Sauce Labs, Spana can also manage provider-specific helper behavior on top of raw capabilities:

- upload a local app artifact and inject `appium:app`
- start and stop BrowserStack Local / Sauce Connect
- fill missing `bstack:options` / `sauce:options` values from config

Raw capabilities still win. Helper config fills missing provider fields and lifecycle, but it does not override explicit `appium:app`, `bstack:options`, or `sauce:options` values you already provided through config, `--caps`, or `--caps-json`.

## Capabilities

Appium sessions are configured through W3C capabilities. Spana merges capabilities from three sources (later overrides earlier):

| Source      | How to set                                      | Example                              |
| ----------- | ----------------------------------------------- | ------------------------------------ |
| Config file | `execution.appium.capabilities`                 | `{ "appium:app": "/path/to/app" }`   |
| JSON file   | `--caps <path>` or `capabilitiesFile` in config | `caps.json`                          |
| Inline CLI  | `--caps-json '<json>'`                          | `'{"appium:deviceName": "Pixel 7"}'` |

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

Spana automatically sets `platformName: "Android"`.

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

Spana automatically sets `platformName: "iOS"` and `appium:automationName: "XCUITest"`.

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

      // Inline capabilities (lowest priority)
      capabilities: {
        "appium:app": "/path/to/app.apk",
      },

      // Path to a JSON capabilities file (medium priority)
      capabilitiesFile: "./caps.json",

      // Report results to cloud provider (default: true)
      reportToProvider: true,

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

| Flag                      | Description                             |
| ------------------------- | --------------------------------------- |
| `--appium-url <url>`      | Appium server URL (enables appium mode) |
| `--caps <path>`           | Path to capabilities JSON file          |
| `--caps-json <json>`      | Inline capabilities JSON string         |
| `--no-provider-reporting` | Disable cloud provider result reporting |

## Cloud providers

When the Appium URL points to BrowserStack or Sauce Labs, spana auto-detects the provider and reports test results. See the [Cloud Providers](/spana/guides/cloud-providers) guide for setup details.
