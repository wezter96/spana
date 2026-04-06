# Sauce Labs Cloud Testing

Spana runs tests against Sauce Labs using **Appium cloud mode** -- it connects to Sauce Labs' Appium hub as a standard W3C WebDriver client. Spana executes its own TypeScript flows against Sauce Labs' remote devices.

## Prerequisites

- A Sauce Labs account with Real Devices or Virtual Devices access
- Your app artifact available locally or already uploaded to Sauce Labs storage
- Sauce Connect installed if you want Spana to manage the tunnel

## 1. Choose an app reference

Spana can upload the app for you from config, or you can upload it yourself and reuse the storage reference.

Manual upload example:

```bash
curl -u "USERNAME:ACCESS_KEY" \
  -X POST "https://api.us-west-1.saucelabs.com/v1/storage/upload" \
  -F "payload=@app.apk" \
  -F "name=app.apk"
```

When you upload manually, use a Sauce storage reference such as `storage:YOUR_APP_ID` in capabilities or `execution.appium.saucelabs.app.id`.

## 2. Create capabilities

### Android

Save as `caps/saucelabs-android.json`:

```json
{
  "platformName": "Android",
  "appium:app": "storage:YOUR_APP_ID",
  "appium:deviceName": "Google Pixel 7",
  "appium:platformVersion": "13.0",
  "sauce:options": {
    "name": "spana-run-1",
    "build": "my-app-build-1"
  }
}
```

### iOS

Save as `caps/saucelabs-ios.json`:

```json
{
  "platformName": "iOS",
  "appium:app": "storage:YOUR_APP_ID",
  "appium:deviceName": "iPhone 15",
  "appium:platformVersion": "17",
  "sauce:options": {
    "name": "spana-run-1",
    "build": "my-app-build-1"
  }
}
```

## 3. Configure Spana

```ts
import { defineConfig } from "spana-test";

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
      serverUrl: process.env.SAUCE_URL,
      saucelabs: {
        app: {
          name: "app.apk",
        },
        connect: {
          enabled: true,
          tunnelName: "spana-ci",
        },
        options: {
          build: process.env.CI_BUILD_ID ?? "spana-local",
          name: "spana-run-1",
        },
      },
      capabilities: {
        "appium:deviceName": "Google Pixel 7",
        "appium:platformVersion": "13.0",
      },
      reportToProvider: true,
    },
  },
});
```

If `saucelabs.app.path` is omitted, Spana falls back to `apps.<platform>.appPath` when present. If you already set `appium:app` or `sauce:options` in raw capabilities, those explicit values win.

Set the hub URL:

```bash
# US West data center
export SAUCE_URL="https://USERNAME:ACCESS_KEY@ondemand.us-west-1.saucelabs.com/wd/hub"

# EU data center
export SAUCE_URL="https://USERNAME:ACCESS_KEY@ondemand.eu-central-1.saucelabs.com/wd/hub"
```

## 4. Run tests

```bash
# Using config
spana test --platform android

# Using CLI flags
spana test \
  --driver appium \
  --appium-url $SAUCE_URL \
  --caps ./caps/saucelabs-android.json \
  --platform android

# Inline capabilities (no file needed)
spana test \
  --driver appium \
  --appium-url $SAUCE_URL \
  --caps-json '{"platformName":"Android","appium:app":"storage:YOUR_APP_ID","appium:deviceName":"Google Pixel 7","appium:platformVersion":"13.0"}' \
  --platform android
```

To skip reporting results back to Sauce Labs:

```bash
spana test --platform android --no-provider-reporting
```

## Sauce Connect

When `execution.appium.saucelabs.connect.enabled` is true, Spana starts Sauce Connect before the run and stops it during cleanup. The helper detects the Sauce region from your Appium URL and fills `sauce:options.tunnelName` when needed.

```ts
saucelabs: {
  connect: {
    enabled: true,
    tunnelName: "spana-ci",
    binary: "/opt/sauce/sc",
  },
}
```

If you prefer to manage the tunnel yourself, leave the helper disabled and run Sauce Connect manually:

```bash
sc run --username USERNAME --access-key ACCESS_KEY --tunnel-name my-tunnel
```

Then add the tunnel name to your capabilities:

```json
{
  "sauce:options": {
    "tunnelName": "my-tunnel"
  }
}
```

Both approaches work; the helper is just the convenient default now.
