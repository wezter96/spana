---
title: Cloud Providers
description: Run tests on BrowserStack and Sauce Labs device clouds.
---

Spana can run mobile tests on cloud device farms through Appium. It auto-detects BrowserStack and Sauce Labs from the server URL and reports test results back to the provider dashboard.

## Supported providers

| Provider     | Auto-detected | Result reporting |
| ------------ | ------------- | ---------------- |
| BrowserStack | Yes           | Yes              |
| Sauce Labs   | Yes           | Yes              |
| Custom grid  | --            | No               |

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

### 2. Set capabilities

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

Or inline in config:

```ts title="spana.config.ts"
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: "https://USER:KEY@hub-cloud.browserstack.com/wd/hub",
      capabilities: {
        "bstack:options": {
          projectName: "my-app",
          buildName: process.env.CI_BUILD_ID ?? "local",
        },
        "appium:app": "bs://your-app-id",
      },
    },
  },
});
```

### 3. Result reporting

Spana automatically reports pass/fail status to BrowserStack when a test run completes. This updates the session in the BrowserStack dashboard with the test name, status, and failure reason.

Disable reporting with `--no-provider-reporting` or in config:

```ts
appium: {
  reportToProvider: false,
}
```

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

### 2. Set capabilities

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

### 3. Result reporting

Sauce Labs sessions are automatically updated with pass/fail status after each test. Region (US/EU) is detected from the server URL.

## Capability resolution

Capabilities merge from three sources, with later sources overriding earlier ones:

1. **Config file** -- `execution.appium.capabilities` in `spana.config.ts`
2. **Capabilities file** -- `--caps <path>` flag or `execution.appium.capabilitiesFile` in config
3. **Inline CLI JSON** -- `--caps-json '{"key": "value"}'`

This lets you keep shared capabilities in config, environment-specific ones in a file, and override individual values from the CLI.

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
