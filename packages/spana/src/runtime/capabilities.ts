import { readFile } from "node:fs/promises";
import type { AppiumExecutionConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import type { LaunchOptions } from "../drivers/raw-driver.js";
import { deviceStateToAppiumCapabilities } from "../drivers/launch-options.js";

export interface ResolveCapabilitiesOptions {
  capsPath?: string;
  capsJson?: string;
  platform?: Platform;
  launchOptions?: LaunchOptions;
}

/**
 * Merge capabilities from five sources (later sources override earlier):
 * 1. Typed launchOptions.deviceState (mapped to Appium capabilities)
 * 2. Config file capabilities (execution.appium.capabilities)
 * 3. Platform-specific capabilities (execution.appium.platformCapabilities.{android|ios})
 * 4. Capabilities JSON file (--caps or execution.appium.capabilitiesFile)
 * 5. Inline CLI JSON (--caps-json)
 */
export async function resolveCapabilities(
  config: AppiumExecutionConfig,
  opts: ResolveCapabilitiesOptions,
): Promise<Record<string, unknown>> {
  const configCaps = config.capabilities ?? {};
  const launchDeviceCaps =
    opts.platform === "android" || opts.platform === "ios"
      ? deviceStateToAppiumCapabilities(opts.platform, opts.launchOptions?.deviceState)
      : {};

  // Platform-specific capabilities (only applied for android/ios)
  let platformCaps: Record<string, unknown> = {};
  if (opts.platform === "android" && config.platformCapabilities?.android) {
    platformCaps = config.platformCapabilities.android;
  } else if (opts.platform === "ios" && config.platformCapabilities?.ios) {
    platformCaps = config.platformCapabilities.ios;
  }

  // Load file caps from --caps flag or config capabilitiesFile
  let fileCaps: Record<string, unknown> = {};
  const capsFilePath = opts.capsPath ?? config.capabilitiesFile;
  if (capsFilePath) {
    const raw = await readFile(capsFilePath, "utf-8");
    fileCaps = JSON.parse(raw) as Record<string, unknown>;
  }

  // Parse inline JSON caps
  let cliCaps: Record<string, unknown> = {};
  if (opts.capsJson) {
    cliCaps = JSON.parse(opts.capsJson) as Record<string, unknown>;
  }

  return { ...launchDeviceCaps, ...configCaps, ...platformCaps, ...fileCaps, ...cliCaps };
}
