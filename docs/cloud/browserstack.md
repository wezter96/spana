# BrowserStack Cloud Testing

Spana runs tests against BrowserStack using **Appium cloud mode** -- it connects to BrowserStack's Appium hub as a standard W3C WebDriver client. This is not the BrowserStack Maestro upload API; Spana executes its own TypeScript flows against BrowserStack's remote devices.

## Prerequisites

- A BrowserStack App Automate account
- Your app artifact available locally or already uploaded to BrowserStack
- BrowserStack Local installed if you want Spana to manage the local tunnel

## 1. Choose an app reference

Spana can upload the app for you from config, or you can upload it yourself and reuse the `bs://...` reference.

Manual upload example:

```bash
curl -u "USERNAME:ACCESS_KEY" \
  -X POST "https://api-cloud.browserstack.com/app-automate/upload" \
  -F "file=@app.apk"
```

Response:

```json
{ "app_url": "bs://YOUR_APP_ID" }
```

If you upload manually, use `bs://YOUR_APP_ID` in capabilities or `execution.appium.browserstack.app.id`.

## 2. Create capabilities

### Android

Save as `caps/browserstack-android.json`:

```json
{
  "platformName": "Android",
  "appium:app": "bs://YOUR_APP_ID",
  "appium:deviceName": "Google Pixel 7",
  "appium:platformVersion": "13.0",
  "bstack:options": {
    "projectName": "My App",
    "buildName": "spana-run-1"
  }
}
```

### iOS

Save as `caps/browserstack-ios.json`:

```json
{
  "platformName": "iOS",
  "appium:app": "bs://YOUR_APP_ID",
  "appium:deviceName": "iPhone 15",
  "appium:platformVersion": "17",
  "bstack:options": {
    "projectName": "My App",
    "buildName": "spana-run-1"
  }
}
```

## 3. Configure Spana

Create or update `spana.config.ts`:

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
      serverUrl: process.env.BROWSERSTACK_URL,
      browserstack: {
        app: {
          customId: "spana-android",
        },
        local: {
          enabled: true,
          identifier: "spana-local",
        },
        options: {
          projectName: "My App",
          buildName: process.env.CI_BUILD_ID ?? "spana-local",
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

If `browserstack.app.path` is omitted, Spana falls back to `apps.<platform>.appPath` when present. If you already set `appium:app` or `bstack:options` in raw capabilities, those explicit values win.

Set the hub URL as an environment variable:

```bash
export BROWSERSTACK_URL="https://USERNAME:ACCESS_KEY@hub-cloud.browserstack.com/wd/hub"
```

## 4. Run tests

```bash
# Using config
spana test --platform android

# Using CLI flags (no config needed)
spana test \
  --driver appium \
  --appium-url $BROWSERSTACK_URL \
  --caps ./caps/browserstack-android.json \
  --platform android
```

To skip reporting results back to BrowserStack:

```bash
spana test --platform android --no-provider-reporting
```

## BrowserStack Local

When `execution.appium.browserstack.local.enabled` is true, Spana starts BrowserStack Local before the run and stops it during cleanup. The helper also fills `bstack:options.local` and `bstack:options.localIdentifier` when needed.

```ts
browserstack: {
  local: {
    enabled: true,
    identifier: "spana-local",
    binary: "/opt/browserstack/BrowserStackLocal",
  },
}
```

If you prefer to manage the tunnel yourself, leave the helper disabled and run BrowserStack Local manually:

```bash
BrowserStackLocal --key ACCESS_KEY
```

Then add the tunnel flags to your capabilities:

```json
{
  "bstack:options": {
    "local": true
  }
}
```

Both approaches work; the helper is just the convenient default now.

## Device selection

Browse available devices at [BrowserStack App Automate](https://www.browserstack.com/list-of-browsers-and-platforms/app_automate). Use the device name and platform version in your capabilities file.
