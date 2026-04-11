import { Effect } from "effect";
import type { ProvConfig } from "../schemas/config.js";
import type { RuntimeResult } from "./types.js";
import { AppiumClient } from "../drivers/appium/client.js";
import { createAppiumAndroidDriver } from "../drivers/appium/android.js";
import { createAppiumIOSDriver } from "../drivers/appium/ios.js";
import { parseAndroidHierarchy } from "../drivers/uiautomator2/pagesource.js";
import { parseIOSHierarchy } from "../drivers/wda/pagesource.js";
import { detectProvider } from "../cloud/provider.js";

export async function buildAppiumAndroidRuntime(
  config: ProvConfig,
  appiumUrl: string,
  caps: Record<string, unknown>,
): Promise<RuntimeResult> {
  const appId =
    (caps["appium:appPackage"] as string | undefined) ?? config.apps?.android?.packageName ?? "";
  const client = new AppiumClient(appiumUrl);
  await client.createSession({
    platformName: "Android",
    ...caps,
  });

  const driver = await Effect.runPromise(createAppiumAndroidDriver(client, appId || undefined));
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  const sessionId = client.getSessionId() ?? undefined;
  const sessionCaps = client.getSessionCaps();

  // Detect cloud provider
  const detectedProvider = detectProvider(appiumUrl);
  const providerName = detectedProvider?.name();

  return {
    runtime: {
      driver,
      cleanup: async () => {
        try {
          await client.deleteSession();
        } catch {
          /* swallow cleanup errors */
        }
      },
      metadata: {
        platform: "android",
        mode: "appium",
        sessionId,
        sessionCaps,
        provider: providerName,
      },
    },
    engineConfig: {
      appId,
      platform: "android",
      coordinatorConfig: {
        parse: parseAndroidHierarchy,
        defaults: {
          timeout: config.defaults?.waitTimeout,
          pollInterval: config.defaults?.pollInterval,
          settleTimeout: config.defaults?.settleTimeout,
          initialPollInterval: config.defaults?.initialPollInterval,
        },
        waitForIdleTimeout: config.defaults?.waitForIdleTimeout,
        typingDelay: config.defaults?.typingDelay,
        hierarchyCacheTtl: config.defaults?.hierarchyCacheTtl,
        screenWidth: deviceInfo.screenWidth,
        screenHeight: deviceInfo.screenHeight,
      },
      autoLaunch: false, // Appium manages app lifecycle
      flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
      artifactConfig: config.artifacts,
      launchOptions: config.launchOptions,
      hooks: config.hooks,
      visualRegression: config.visualRegression,
    },
  };
}

export async function buildAppiumIOSRuntime(
  config: ProvConfig,
  appiumUrl: string,
  caps: Record<string, unknown>,
): Promise<RuntimeResult> {
  const appId = (caps["appium:bundleId"] as string | undefined) ?? config.apps?.ios?.bundleId ?? "";
  const client = new AppiumClient(appiumUrl);
  await client.createSession({
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    ...caps,
  });

  // Raise XCTest snapshotMaxDepth above the stock limit of 60 so deeply
  // nested React Native hierarchies remain reachable by accessibilityIdentifier.
  // See https://github.com/appium/appium/issues/14825.
  const snapshotMaxDepth = config.defaults?.snapshotMaxDepth ?? 100;
  try {
    await client.request("POST", client.sessionPath("/appium/settings"), {
      settings: { snapshotMaxDepth },
    });
  } catch (e) {
    console.warn(`Failed to set snapshotMaxDepth (continuing): ${e}`);
  }

  const driver = await Effect.runPromise(createAppiumIOSDriver(client));
  const deviceInfo = await Effect.runPromise(driver.getDeviceInfo());

  const sessionId = client.getSessionId() ?? undefined;
  const sessionCaps = client.getSessionCaps();

  // Detect cloud provider
  const detectedProvider = detectProvider(appiumUrl);
  const providerName = detectedProvider?.name();

  return {
    runtime: {
      driver,
      cleanup: async () => {
        try {
          await client.deleteSession();
        } catch {
          /* swallow cleanup errors */
        }
      },
      metadata: {
        platform: "ios",
        mode: "appium",
        sessionId,
        sessionCaps,
        provider: providerName,
      },
    },
    engineConfig: {
      appId,
      platform: "ios",
      coordinatorConfig: {
        parse: parseIOSHierarchy,
        defaults: {
          timeout: config.defaults?.waitTimeout,
          pollInterval: config.defaults?.pollInterval,
          settleTimeout: config.defaults?.settleTimeout,
          initialPollInterval: config.defaults?.initialPollInterval,
        },
        waitForIdleTimeout: config.defaults?.waitForIdleTimeout,
        typingDelay: config.defaults?.typingDelay,
        hierarchyCacheTtl: config.defaults?.hierarchyCacheTtl,
        screenWidth: deviceInfo.screenWidth,
        screenHeight: deviceInfo.screenHeight,
      },
      autoLaunch: false, // Appium manages app lifecycle
      flowTimeout: config.defaults?.waitTimeout ? config.defaults.waitTimeout * 10 : 60_000,
      artifactConfig: config.artifacts,
      launchOptions: config.launchOptions,
      hooks: config.hooks,
      visualRegression: config.visualRegression,
    },
  };
}
