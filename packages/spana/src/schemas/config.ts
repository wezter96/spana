import type { Platform } from "./selector.js";
import type { LaunchOptions } from "../drivers/raw-driver.js";
import { z, type ZodError } from "zod";

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

export type BrowserName = "chromium" | "firefox" | "webkit";

export interface WebExecutionConfig {
  browser?: BrowserName;
  headless?: boolean;
  /** Optional Playwright storage state JSON file to preload for web runs */
  storageState?: string;
}

export interface CloudAppReferenceConfig {
  /** Existing remote app reference, e.g. bs://... or storage:... */
  id?: string;
  /** Local file path to upload when the provider supports managed upload */
  path?: string;
  /** Override the uploaded file name when the provider supports it */
  name?: string;
}

export interface BrowserStackAppConfig extends CloudAppReferenceConfig {
  /** Stable BrowserStack app alias */
  customId?: string;
}

export interface BrowserStackLocalConfig {
  enabled?: boolean;
  binary?: string;
  identifier?: string;
  args?: string[];
}

export interface BrowserStackHelperConfig {
  app?: BrowserStackAppConfig;
  local?: BrowserStackLocalConfig;
  options?: Record<string, unknown>;
}

export interface SauceConnectConfig {
  enabled?: boolean;
  binary?: string;
  tunnelName?: string;
  args?: string[];
}

export interface SauceLabsHelperConfig {
  app?: CloudAppReferenceConfig;
  connect?: SauceConnectConfig;
  options?: Record<string, unknown>;
}

export interface AppiumExecutionConfig {
  serverUrl?: string;
  capabilities?: Record<string, unknown>;
  capabilitiesFile?: string;
  reportToProvider?: boolean;
  browserstack?: BrowserStackHelperConfig;
  saucelabs?: SauceLabsHelperConfig;
}

export interface ExecutionConfig {
  mode?: "local" | "appium";
  web?: WebExecutionConfig;
  appium?: AppiumExecutionConfig;
}

export interface ArtifactConfig {
  outputDir?: string;
  captureOnFailure?: boolean;
  captureOnSuccess?: boolean;
  captureSteps?: boolean;
  screenshot?: boolean;
  uiHierarchy?: boolean;
  consoleLogs?: boolean;
  jsErrors?: boolean;
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
    /** Pause after each action (tap, scroll) to let the UI settle. Default: 0 (disabled). */
    waitForIdleTimeout?: number;
    /** Delay between each character when typing. Default: 0 (instant). */
    typingDelay?: number;
    /** Starting poll interval for adaptive backoff. Default: 50ms. Set equal to pollInterval to disable adaptive backoff. */
    initialPollInterval?: number;
    /** Max age in ms before cached hierarchy is stale. Default: 100. Set to 0 to disable. */
    hierarchyCacheTtl?: number;
    /** Delay in ms between retry attempts of a failed flow. Default: 0 (immediate). */
    retryDelay?: number;
    /** Max workers per platform when using --parallel. */
    workers?: number;
  };
  platforms?: Platform[];
  /** Run platforms concurrently when they use independent resources. Default: false (serial). */
  parallelPlatforms?: boolean;
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
  execution?: ExecutionConfig;
}

const platformSchema = z.enum(["web", "android", "ios"]);
const reporterSchema = z.enum(["console", "json", "junit", "html", "allure"]);
const hookSchema = z.custom<(...args: unknown[]) => Promise<void>>(
  (value) => typeof value === "function",
  { message: "Expected function" },
);

const iosSigningConfigSchema = z
  .object({
    teamId: z.string().min(1, "teamId is required"),
    signingIdentity: z.string().min(1).optional(),
  })
  .strict();

const appConfigSchema = z
  .object({
    url: z.string().url().optional(),
    packageName: z.string().min(1).optional(),
    bundleId: z.string().min(1).optional(),
    appPath: z.string().min(1).optional(),
    signing: iosSigningConfigSchema.optional(),
  })
  .strict();

const cloudAppReferenceSchema = z
  .object({
    id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  })
  .strict();

const browserStackAppSchema = cloudAppReferenceSchema
  .extend({
    customId: z.string().min(1).optional(),
  })
  .strict();

const browserStackLocalSchema = z
  .object({
    enabled: z.boolean().optional(),
    binary: z.string().min(1).optional(),
    identifier: z.string().min(1).optional(),
    args: z.array(z.string().min(1)).optional(),
  })
  .strict();

const browserStackHelperSchema = z
  .object({
    app: browserStackAppSchema.optional(),
    local: browserStackLocalSchema.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const sauceConnectSchema = z
  .object({
    enabled: z.boolean().optional(),
    binary: z.string().min(1).optional(),
    tunnelName: z.string().min(1).optional(),
    args: z.array(z.string().min(1)).optional(),
  })
  .strict();

const sauceLabsHelperSchema = z
  .object({
    app: cloudAppReferenceSchema.optional(),
    connect: sauceConnectSchema.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const appiumExecutionConfigSchema = z
  .object({
    serverUrl: z.string().url().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    capabilitiesFile: z.string().min(1).optional(),
    reportToProvider: z.boolean().optional(),
    browserstack: browserStackHelperSchema.optional(),
    saucelabs: sauceLabsHelperSchema.optional(),
  })
  .strict();

const webExecutionConfigSchema = z
  .object({
    browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
    headless: z.boolean().optional(),
    storageState: z.string().min(1).optional(),
  })
  .strict();

const executionConfigSchema = z
  .object({
    mode: z.enum(["local", "appium"]).optional(),
    web: webExecutionConfigSchema.optional(),
    appium: appiumExecutionConfigSchema.optional(),
  })
  .strict();

const artifactConfigSchema = z
  .object({
    outputDir: z.string().min(1).optional(),
    captureOnFailure: z.boolean().optional(),
    captureOnSuccess: z.boolean().optional(),
    captureSteps: z.boolean().optional(),
    screenshot: z.boolean().optional(),
    uiHierarchy: z.boolean().optional(),
    consoleLogs: z.boolean().optional(),
    jsErrors: z.boolean().optional(),
  })
  .strict();

const launchOptionsSchema = z
  .object({
    clearState: z.boolean().optional(),
    clearKeychain: z.boolean().optional(),
    deepLink: z.string().min(1).optional(),
    launchArguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const provConfigSchema = z
  .object({
    apps: z
      .object({
        web: appConfigSchema.optional(),
        android: appConfigSchema.optional(),
        ios: appConfigSchema.optional(),
      })
      .strict()
      .optional(),
    defaults: z
      .object({
        waitTimeout: z.number().positive().optional(),
        pollInterval: z.number().positive().optional(),
        settleTimeout: z.number().nonnegative().optional(),
        retries: z.number().int().nonnegative().optional(),
        waitForIdleTimeout: z.number().nonnegative().optional(),
        typingDelay: z.number().nonnegative().optional(),
        initialPollInterval: z.number().positive().optional(),
        hierarchyCacheTtl: z.number().nonnegative().optional(),
        retryDelay: z.number().nonnegative().optional(),
        workers: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    platforms: z.array(platformSchema).optional(),
    parallelPlatforms: z.boolean().optional(),
    flowDir: z.string().min(1).optional(),
    launchOptions: launchOptionsSchema.optional(),
    reporters: z.array(reporterSchema).optional(),
    hooks: z
      .object({
        beforeAll: hookSchema.optional(),
        beforeEach: hookSchema.optional(),
        afterEach: hookSchema.optional(),
        afterAll: hookSchema.optional(),
      })
      .strict()
      .optional(),
    artifacts: artifactConfigSchema.optional(),
    execution: executionConfigSchema.optional(),
  })
  .strict();

export function defineConfig(config: ProvConfig): ProvConfig {
  return config;
}

export function validateConfig(config: unknown): ProvConfig {
  return provConfigSchema.parse(config) as ProvConfig;
}

export function formatConfigValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
}
