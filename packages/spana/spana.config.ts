import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "./src/schemas/config.js";

const defaultBrowserstackAndroidReleaseAppPath = fileURLToPath(
  new URL(
    "../../apps/native/android/app/build/outputs/apk/release/app-release.apk",
    import.meta.url,
  ),
);

const defaultBrowserstackAndroidDebugAppPath = fileURLToPath(
  new URL("../../apps/native/android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url),
);

const defaultBrowserstackIosAppPath = fileURLToPath(
  new URL("../../apps/native/ios/build/export/spana.ipa", import.meta.url),
);

const browserstackServerUrl =
  process.env.BROWSERSTACK_USERNAME && process.env.BROWSERSTACK_ACCESS_KEY
    ? `https://${process.env.BROWSERSTACK_USERNAME}:${process.env.BROWSERSTACK_ACCESS_KEY}@hub-cloud.browserstack.com/wd/hub`
    : undefined;

const browserstackAndroidAppPath =
  process.env.BROWSERSTACK_ANDROID_APP_PATH ??
  (existsSync(defaultBrowserstackAndroidReleaseAppPath)
    ? defaultBrowserstackAndroidReleaseAppPath
    : existsSync(defaultBrowserstackAndroidDebugAppPath)
      ? defaultBrowserstackAndroidDebugAppPath
      : undefined);

const browserstackIosAppPath =
  process.env.BROWSERSTACK_IOS_APP_PATH ??
  (existsSync(defaultBrowserstackIosAppPath) ? defaultBrowserstackIosAppPath : undefined);
const browserstackLocalEnabled = process.env.BROWSERSTACK_LOCAL_ENABLED === "true";
const browserstackLocalBinary = process.env.BROWSERSTACK_LOCAL_BINARY;
const browserstackLocalIdentifier = process.env.BROWSERSTACK_LOCAL_IDENTIFIER;

// Optional BrowserStack cloud setup for the framework demo. When *_APP_PATH env vars are set,
// Spana uploads those local builds automatically via the BrowserStack helper.
const browserstackAndroidDevice = process.env.BROWSERSTACK_ANDROID_DEVICE ?? "Google Pixel 7";
const browserstackAndroidVersion = process.env.BROWSERSTACK_ANDROID_VERSION ?? "13.0";
const browserstackIosDevice = process.env.BROWSERSTACK_IOS_DEVICE ?? "iPhone 15";
const browserstackIosVersion = process.env.BROWSERSTACK_IOS_VERSION ?? "17";

const browserstackExecution = browserstackServerUrl
  ? {
      mode: "appium" as const,
      appium: {
        serverUrl: browserstackServerUrl,
        reportToProvider: true,
        platformCapabilities: {
          android: {
            "appium:deviceName": browserstackAndroidDevice,
            "appium:platformVersion": browserstackAndroidVersion,
          },
          ios: {
            "appium:deviceName": browserstackIosDevice,
            "appium:platformVersion": browserstackIosVersion,
          },
        },
        browserstack: {
          options: {
            projectName: process.env.BROWSERSTACK_PROJECT_NAME ?? "spana-framework-app",
            buildName:
              process.env.BROWSERSTACK_BUILD_NAME ?? process.env.CI_BUILD_ID ?? "spana-local",
          },
          ...(browserstackLocalEnabled || browserstackLocalBinary || browserstackLocalIdentifier
            ? {
                local: {
                  enabled: browserstackLocalEnabled,
                  ...(browserstackLocalBinary ? { binary: browserstackLocalBinary } : {}),
                  ...(browserstackLocalIdentifier
                    ? { identifier: browserstackLocalIdentifier }
                    : {}),
                },
              }
            : {}),
        },
      },
    }
  : undefined;

export default defineConfig({
  apps: {
    web: { url: "http://127.0.0.1:8081" },
    android: {
      packageName: "com.wezter96.spana.testapp",
      ...(browserstackAndroidAppPath ? { appPath: browserstackAndroidAppPath } : {}),
    },
    ios: {
      bundleId: "com.wezter96.spana.testapp",
      ...(browserstackIosAppPath ? { appPath: browserstackIosAppPath } : {}),
    },
  },
  defaults: {
    waitTimeout: 5_000,
    pollInterval: 200,
    // 40ms between characters avoids dropped keys in XCUITest's typeText on
    // iOS (especially multi-grapheme input like emoji + combining accents),
    // and is small enough to stay under a second of total input in tests.
    typingDelay: 40,
  },
  artifacts: {
    outputDir: "./spana-output",
    captureOnFailure: true,
    captureOnSuccess: false,
    captureSteps: false,
    screenshot: true,
    uiHierarchy: true,
  },
  platforms: ["web", "android", "ios"],
  flowDir: "./flows/framework-app",
  reporters: ["console", "junit", "html"],
  execution: browserstackExecution,
});
