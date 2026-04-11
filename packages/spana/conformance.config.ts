/**
 * Driver conformance config.
 *
 * This config drives the flows in `flows/conformance/` against any
 * `RawDriverService` implementation. Run it with `--driver local` (direct
 * WDA / UiAutomator2) and `--driver appium` (via local or remote Appium
 * server) — both runs must pass identically. That's what "driver conformance"
 * means in spana: same flows, same app, different driver paths, same result.
 *
 * See `flows/conformance/README.md` for the full coverage matrix and
 * invocation examples, and `docs/internals/appium-local-dev.md` for how to
 * point it at a local Appium server.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "./src/schemas/config.js";

const androidReleaseApk = fileURLToPath(
  new URL(
    "../../apps/native/android/app/build/outputs/apk/release/app-release.apk",
    import.meta.url,
  ),
);
const androidDebugApk = fileURLToPath(
  new URL("../../apps/native/android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url),
);
const iosIpa = fileURLToPath(
  new URL("../../apps/native/ios/build/export/spana.ipa", import.meta.url),
);

const androidAppPath = existsSync(androidReleaseApk)
  ? androidReleaseApk
  : existsSync(androidDebugApk)
    ? androidDebugApk
    : undefined;
const iosAppPath = existsSync(iosIpa) ? iosIpa : undefined;

const appiumServerUrl = process.env.SPANA_APPIUM_URL;

export default defineConfig({
  apps: {
    web: { url: "http://127.0.0.1:8081" },
    android: {
      packageName: "com.wezter96.spana.testapp",
      ...(androidAppPath ? { appPath: androidAppPath } : {}),
    },
    ios: {
      bundleId: "com.wezter96.spana.testapp",
      ...(iosAppPath ? { appPath: iosAppPath } : {}),
    },
  },
  defaults: {
    waitTimeout: 5_000,
    pollInterval: 200,
  },
  artifacts: {
    outputDir: "./spana-conformance-output",
    captureOnFailure: true,
    captureOnSuccess: false,
    screenshot: true,
    uiHierarchy: true,
  },
  platforms: ["android", "ios"],
  flowDir: "./flows/conformance",
  reporters: ["console", "junit"],
  // Only set execution when SPANA_APPIUM_URL is present; otherwise leave it
  // undefined so the default local-direct-driver path is used. Passing
  // --driver local on the CLI also overrides this.
  ...(appiumServerUrl
    ? {
        execution: {
          mode: "appium" as const,
          appium: {
            serverUrl: appiumServerUrl,
            reportToProvider: false,
            platformCapabilities: {
              android: {
                "appium:deviceName": process.env.SPANA_ANDROID_DEVICE ?? "emulator-5554",
                "appium:platformVersion": process.env.SPANA_ANDROID_VERSION ?? "13.0",
                ...(androidAppPath ? { "appium:app": androidAppPath } : {}),
              },
              ios: {
                "appium:deviceName": process.env.SPANA_IOS_DEVICE ?? "iPhone 15",
                "appium:platformVersion": process.env.SPANA_IOS_VERSION ?? "17.0",
                ...(iosAppPath ? { "appium:app": iosAppPath } : {}),
              },
            },
          },
        },
      }
    : {}),
});
