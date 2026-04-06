import type { AppConfig, AppiumExecutionConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import { BrowserStackProvider } from "./browserstack.js";
import { hasConfig } from "./common.js";
import { SauceLabsProvider } from "./saucelabs.js";

export interface ProviderRunResult {
  passed: boolean;
  name?: string;
  reason?: string;
}

export interface CloudProviderHelper {
  prepareCapabilities(
    platform: Platform,
    caps: Record<string, unknown>,
    appConfig?: AppConfig,
  ): Promise<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

export interface CloudProvider {
  name(): string;
  createHelper(appiumUrl: string, config: AppiumExecutionConfig): CloudProviderHelper;
  extractMeta(sessionId: string, caps: Record<string, unknown>, meta: Record<string, string>): void;
  reportResult(
    appiumUrl: string,
    meta: Record<string, string>,
    result: ProviderRunResult,
  ): Promise<void>;
}

export function detectProvider(appiumUrl: string): CloudProvider | null {
  let hostname: string;
  try {
    hostname = new URL(appiumUrl).hostname;
  } catch {
    return null;
  }

  if (hostname.includes("browserstack.com")) {
    return new BrowserStackProvider();
  }

  if (hostname.includes("saucelabs.com")) {
    return new SauceLabsProvider();
  }

  return null;
}

const noopHelper: CloudProviderHelper = {
  prepareCapabilities: async (_platform, caps) => caps,
  cleanup: async () => {},
};

export function createCloudProviderHelper(
  appiumUrl: string,
  config: AppiumExecutionConfig,
): CloudProviderHelper {
  const provider = detectProvider(appiumUrl);
  const hasBrowserStackConfig = hasConfig(config.browserstack);
  const hasSauceLabsConfig = hasConfig(config.saucelabs);

  if (!provider) {
    if (hasBrowserStackConfig || hasSauceLabsConfig) {
      throw new Error("Provider helper config requires a BrowserStack or Sauce Labs Appium URL.");
    }
    return noopHelper;
  }

  if (provider.name() === "BrowserStack" && hasSauceLabsConfig) {
    throw new Error("Sauce Labs helper config requires a Sauce Labs Appium URL.");
  }

  if (provider.name() === "Sauce Labs" && hasBrowserStackConfig) {
    throw new Error("BrowserStack helper config requires a BrowserStack Appium URL.");
  }

  return provider.createHelper(appiumUrl, config);
}
