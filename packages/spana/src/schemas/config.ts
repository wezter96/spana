import type { Platform } from "./selector.js";
import type { LaunchOptions } from "../drivers/raw-driver.js";

export type { LaunchOptions };

export interface IOSSigningConfig {
  /** Apple Development Team ID (from developer.apple.com or Xcode) */
  teamId: string;
  /** Code signing identity (default: "Apple Development") */
  signingIdentity?: string;
}

export interface AppConfig {
  url?: string;
  packageName?: string;
  bundleId?: string;
  /** Path to .app or .ipa for auto-install on device/simulator */
  appPath?: string;
  /** iOS code signing config for physical devices */
  signing?: IOSSigningConfig;
}

export interface ArtifactConfig {
  outputDir?: string;
  captureOnFailure?: boolean;
  captureOnSuccess?: boolean;
  captureSteps?: boolean;
  screenshot?: boolean;
  uiHierarchy?: boolean;
}

export interface HookContext {
  app: unknown; // Will be typed properly when App is defined
  expect?: unknown;
  platform?: Platform;
  result?: unknown;
  summary?: unknown;
}

export interface ProvConfig {
  apps?: {
    web?: AppConfig;
    android?: AppConfig;
    ios?: AppConfig;
  };
  defaults?: {
    waitTimeout?: number;
    pollInterval?: number;
    settleTimeout?: number;
    retries?: number;
  };
  platforms?: Platform[];
  flowDir?: string;
  launchOptions?: LaunchOptions;
  reporters?: string[];
  hooks?: {
    beforeAll?: (ctx: HookContext) => Promise<void>;
    beforeEach?: (ctx: HookContext) => Promise<void>;
    afterEach?: (ctx: HookContext) => Promise<void>;
    afterAll?: (ctx: HookContext) => Promise<void>;
  };
  artifacts?: ArtifactConfig;
}

export function defineConfig(config: ProvConfig): ProvConfig {
  return config;
}
