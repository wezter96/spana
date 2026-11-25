import type { Platform, TapMode } from "./selector.js";
import type {
  DeviceStateConfig,
  LaunchOptions,
  VirtualAuthenticatorOptions,
} from "../drivers/raw-driver.js";
import { z, type ZodError } from "zod";

export type { DeviceStateConfig, LaunchOptions, VirtualAuthenticatorOptions };

export interface IOSSigningConfig {
  /** Apple Development Team ID (from developer.apple.com or Xcode) */
  teamId: string;
  /** Code signing identity (default: "Apple Development") */
  signingIdentity?: string;
}

export interface BridgeConfig {
  /** Enable the in-app spana-bridge WebSocket server. Default: auto-detected when port/url is set. */
  enabled?: boolean;
  /** Port for the runner's spana-bridge WebSocket server (default: 9333). */
  port?: number;
  /** Host to bind the bridge server on (default: "127.0.0.1"). */
  host?: string;
  /** Explicit external bridge URL if already running (e.g. ws://127.0.0.1:9333). */
  url?: string;
  /** Connection timeout in ms when waiting for the app bridge to connect (default: 5000). */
  connectTimeout?: number;
}

export interface WarmDaemonConfig {
  /** Keep WDA / UiAutomator2 daemons alive across test runs and reuse them. Default: false. */
  enabled?: boolean;
  /** Reuse a single browser process across flows with fresh BrowserContexts. Default: true. */
  reuseBrowserProcess?: boolean;
  /** Reuse an active WDA/UiAutomator2 session across flows instead of recreating. Default: true when warm daemons enabled. */
  reuseSession?: boolean;
  /** Optional path to store warm daemon metadata. */
  stateFile?: string;
}

export interface AppConfig {
  url?: string;
  packageName?: string;
  bundleId?: string;
  /** Path to .app or .ipa for auto-install on device/simulator */
  appPath?: string;
  /** iOS code signing config for physical devices */
  signing?: IOSSigningConfig;
  /** Explicit WebKit Inspector URL or port for iOS WKWebView direct DOM access */
  webkitInspectorUrl?: string;
  webkitInspectorPort?: number;
  /** Explicit CDP port for Android WebView or desktop targets */
  cdpPort?: number;
  /** Pin device locale (e.g. "en_US", "sv_SE") for predictable system UI labels */
  locale?: string;
  /** Optional spana-bridge override for this app target */
  bridge?: BridgeConfig;
}

export interface ElectronAppConfig {
  /** Path to Electron main entry file or app directory (passed to Playwright _electron.launch) */
  entry?: string;
  /** Path to a packaged Electron executable */
  executablePath?: string;
  /** Extra CLI arguments passed to Electron */
  args?: string[];
  /** Working directory for Electron launch */
  cwd?: string;
  /** Additional environment variables for Electron */
  env?: Record<string, string>;
  /** Attach to an already-running Electron app over CDP instead of launching */
  cdpUrl?: string;
  /** Remote debugging port when launching or attaching over CDP */
  cdpPort?: number;
  /** Optional URL to navigate to after launch */
  url?: string;
  /** Optional spana-bridge config */
  bridge?: BridgeConfig;
}

export type ElectrobunRenderer = "native" | "cef";

export interface ElectrobunAppConfig {
  /** Path to Electrobun binary or packaged .app/.exe */
  executablePath?: string;
  /** Path to Electrobun project root (containing electrobun.config.ts) */
  appDir?: string;
  /** Extra CLI arguments passed to the Electrobun process */
  args?: string[];
  /** Working directory for launch */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Renderer engine used by the Electrobun build: "native" (WKWebView/WebView2/WebKitGTK) or "cef" */
  renderer?: ElectrobunRenderer;
  /** Attach to an already-running Electrobun CEF/WebView2 app over CDP */
  cdpUrl?: string;
  /** Remote debugging port (ELECTROBUN_CDP_PORT / WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) */
  cdpPort?: number;
  /** WebKit Inspector port for macOS WKWebView or Linux WebKitGTK */
  webkitInspectorPort?: number;
  /** Optional URL to navigate to after launch */
  url?: string;
  /** Optional spana-bridge config */
  bridge?: BridgeConfig;
}

export type BrowserName = "chromium" | "firefox" | "webkit";
export type WebBrowserEngine = "auto" | "playwright" | "cdp" | "lightpanda";
export type WebContextIsolation = "fresh" | "hot-cache";
export type WebResourceBlockType = "image" | "font" | "media" | "stylesheet";
export type VideoRecordingMode = "off" | "on" | "retain-on-failure";

export type StorybookValue = string | number | boolean | null;

export interface StorybookConfig {
  /** Optional dedicated Storybook URL (falls back to apps.web.url when omitted) */
  url?: string;
  /** Preview iframe path used to render isolated stories (default: /iframe.html) */
  iframePath?: string;
}

export interface WebExecutionConfig {
  browser?: BrowserName;
  /** Browser engine backend: "playwright" (default), "cdp" (direct CDP WebSocket — zero Playwright pipe), or "lightpanda". */
  engine?: WebBrowserEngine;
  /** Connect to an existing CDP browser / Lightpanda endpoint (e.g. "http://127.0.0.1:9222"). */
  cdpUrl?: string;
  /** Connect to a remote Playwright server WebSocket (e.g. BrowserStack Automate Web `wss://cdp.browserstack.com/playwright?...`). */
  wsEndpoint?: string;
  /** Explicit browser executable path (e.g. system Chrome or custom Chromium binary). */
  executablePath?: string;
  /** Browser release channel (e.g. "chrome", "chrome-beta", "msedge"). */
  channel?: string;
  headless?: boolean;
  /** Navigation readiness event for launchApp/openLink (default: "load"). */
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  /** Collapse CSS transitions & animations to 0.001ms for faster deterministic runs. */
  instantAnimations?: boolean;
  /** Abort heavy asset requests ("image" | "font" | "media" | "stylesheet") during web runs. */
  blockResources?: WebResourceBlockType[];
  /** Reuse a persistent warm Chromium daemon across runs via CDP (chromium only). */
  warmBrowser?: boolean;
  /** Scope key for isolating warm Chromium daemons across concurrent repos/runs (defaults to cwd hash). */
  warmBrowserScope?: string;
  /** Create a fresh isolated BrowserContext per flow using pre-warmed context pooling + background teardown. */
  freshContextPerFlow?: boolean;
  /**
   * Context isolation strategy when `freshContextPerFlow` is enabled (Direct CDP):
   * - `"fresh"` (default): new `Target.createBrowserContext` per flow (strictest isolation).
   * - `"hot-cache"`: keeps Chromium's HTTP & V8 bytecode cache hot while wiping cookies, localStorage,
   *   sessionStorage, IndexedDB, CacheStorage, and service workers between flows (~4 ms reset!).
   */
  contextIsolation?: WebContextIsolation;
  /** Max worker contexts sharing one Chromium browser process under `--parallel` (default: 2 to avoid CDP/IO contention). */
  maxContextsPerBrowser?: number;
  /** Automatically attach a CDP WebAuthn virtual authenticator (passkey) to every fresh context. */
  virtualAuthenticator?: boolean | VirtualAuthenticatorOptions;
  /** Optional Playwright storage state JSON file to preload for web runs */
  storageState?: string;
  /** Print verbose Playwright runtime events to stdout for local web debugging */
  verboseLogging?: boolean;
  /** Optional Storybook config for isolated component/story flows in the browser runtime */
  storybook?: StorybookConfig;
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
  /**
   * Platform-specific capabilities merged on top of `capabilities` when the
   * matching platform runs. Useful when you want different `appium:deviceName`
   * or `appium:platformVersion` for Android vs iOS.
   */
  platformCapabilities?: {
    android?: Record<string, unknown>;
    ios?: Record<string, unknown>;
  };
  capabilitiesFile?: string;
  reportToProvider?: boolean;
  browserstack?: BrowserStackHelperConfig;
  saucelabs?: SauceLabsHelperConfig;
  /** Path to a custom cloud provider module (default export must conform to CloudProvider interface). */
  cloudProvider?: string;
  /**
   * Opt in to having spana spawn a local `appium` subprocess for the
   * duration of the test run. Requires `appium` to be on PATH. When true,
   * `serverUrl` (if set) is ignored and a URL is assigned to the
   * auto-started server instead. Off by default — spana never spawns
   * background processes unless you ask.
   */
  autoStart?: boolean;
  /** Override the `appium` binary name. Default: "appium". */
  autoStartBinary?: string;
  /** Extra CLI args to forward to the spawned Appium process. */
  autoStartArgs?: readonly string[];
}

export interface ExecutionConfig {
  mode?: "local" | "appium";
  web?: WebExecutionConfig;
  appium?: AppiumExecutionConfig;
  /** In-app spana-bridge configuration shared across webview targets */
  bridge?: BridgeConfig;
  /** Warm daemon & process reuse settings for fast repeated runs */
  warmDaemons?: WarmDaemonConfig;
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
  har?: boolean;
  /** Video / screencast recording mode: "off" (default), "on", or "retain-on-failure". */
  video?: VideoRecordingMode;
  /** Embed interactive step-by-step visual playback timeline inside report.html (auto-enabled when video !== "off"). */
  playback?: boolean;
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
    electron?: ElectronAppConfig;
    electrobun?: ElectrobunAppConfig;
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
    /** Max depth for UI hierarchy snapshots on iOS. Default: 100. */
    snapshotMaxDepth?: number;
    /** Delay in ms between retry attempts of a failed flow. Default: 0 (immediate). */
    retryDelay?: number;
    /** Max workers per platform when using --parallel. */
    workers?: number;
    /** Number of isolated OS worker processes sharing a dynamic longest-first flow queue (`--processes M`). */
    processes?: number;
    /** Max in-process workers before automatically sharding across multiple OS processes (default: 8). */
    maxWorkersPerProcess?: number;
    /** Default tap mode when a DOM channel resolves an element: "native" (real touch, default) or "dom" (fast synthetic click). */
    tapMode?: TapMode;
    /** Pin device locale across targets so system UI sheet labels stay deterministic. */
    locale?: string;
    /** Fail web element waits early when the page is idle & readyState === "complete" instead of waiting full waitTimeout. */
    failFastWhenIdle?: boolean;
    /** Consecutive stable animation frames required before pointer actions on web. Default: 2. Set 0 to disable. */
    actionStableFrames?: number;
  };
  platforms?: Platform[];
  /** Run platforms concurrently when they use independent resources. Default: false (serial). */
  parallelPlatforms?: boolean;
  flowDir?: string;
  launchOptions?: LaunchOptions;
  /**
   * Reporter names or module paths. Built-in: "console", "json", "junit", "html", "allure".
   * Custom reporters: provide a relative path (e.g., "./reporters/slack.ts") that default-exports
   * a Reporter object or a `(options: { outputDir: string }) => Reporter` factory function.
   */
  reporters?: string[];
  hooks?: {
    beforeAll?: (ctx: HookContext) => Promise<void>;
    beforeEach?: (ctx: HookContext) => Promise<void>;
    afterEach?: (ctx: HookContext) => Promise<void>;
    afterAll?: (ctx: HookContext) => Promise<void>;
  };
  artifacts?: ArtifactConfig;
  execution?: ExecutionConfig;
  visualRegression?: {
    threshold?: number;
    maxDiffPixelRatio?: number;
    baselinesDir?: string;
    mode?: "pixel" | "layout-tolerant";
  };
  /** Pluggable CI filters evaluated when `--changed-since <ref>` is passed. */
  filters?: Array<{
    name: string;
    filter: (flows: any[], context: any) => Promise<any> | any;
  }>;
  /** Verified replay cache settings for optional agentic steps (`.spana/cache/`). */
  replayCache?: {
    mode?: "read-write" | "strict" | "off";
    dir?: string;
  };
}

const platformSchema = z.enum(["web", "android", "ios", "electron", "electrobun"]);
const reporterSchema = z.string().min(1);
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

const bridgeConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    port: z.number().int().positive().optional(),
    host: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    connectTimeout: z.number().positive().optional(),
  })
  .strict();

const warmDaemonConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    reuseBrowserProcess: z.boolean().optional(),
    reuseSession: z.boolean().optional(),
    stateFile: z.string().min(1).optional(),
  })
  .strict();

const appConfigSchema = z
  .object({
    url: z.string().url().optional(),
    packageName: z.string().min(1).optional(),
    bundleId: z.string().min(1).optional(),
    appPath: z.string().min(1).optional(),
    signing: iosSigningConfigSchema.optional(),
    webkitInspectorUrl: z.string().min(1).optional(),
    webkitInspectorPort: z.number().int().positive().optional(),
    cdpPort: z.number().int().positive().optional(),
    locale: z.string().min(1).optional(),
    bridge: bridgeConfigSchema.optional(),
  })
  .strict();

const electronAppConfigSchema = z
  .object({
    entry: z.string().min(1).optional(),
    executablePath: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cdpUrl: z.string().url().optional(),
    cdpPort: z.number().int().positive().optional(),
    url: z.string().url().optional(),
    bridge: bridgeConfigSchema.optional(),
  })
  .strict();

const electrobunAppConfigSchema = z
  .object({
    executablePath: z.string().min(1).optional(),
    appDir: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    renderer: z.enum(["native", "cef"]).optional(),
    cdpUrl: z.string().url().optional(),
    cdpPort: z.number().int().positive().optional(),
    webkitInspectorPort: z.number().int().positive().optional(),
    url: z.string().url().optional(),
    bridge: bridgeConfigSchema.optional(),
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

const storybookConfigSchema = z
  .object({
    url: z.string().url().optional(),
    iframePath: z.string().min(1).optional(),
  })
  .strict();

const appiumExecutionConfigSchema = z
  .object({
    serverUrl: z.string().url().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    platformCapabilities: z
      .object({
        android: z.record(z.string(), z.unknown()).optional(),
        ios: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
    capabilitiesFile: z.string().min(1).optional(),
    reportToProvider: z.boolean().optional(),
    browserstack: browserStackHelperSchema.optional(),
    saucelabs: sauceLabsHelperSchema.optional(),
    cloudProvider: z.string().min(1).optional(),
    autoStart: z.boolean().optional(),
    autoStartBinary: z.string().min(1).optional(),
    autoStartArgs: z.array(z.string()).optional(),
  })
  .strict();

const virtualAuthenticatorOptionsSchema = z
  .object({
    protocol: z.enum(["ctap2", "u2f"]).optional(),
    transport: z.enum(["usb", "nfc", "ble", "cable", "internal"]).optional(),
    hasResidentKey: z.boolean().optional(),
    hasUserVerification: z.boolean().optional(),
    isUserVerified: z.boolean().optional(),
    automaticPresenceSimulation: z.boolean().optional(),
  })
  .strict();

const webExecutionConfigSchema = z
  .object({
    browser: z.enum(["chromium", "firefox", "webkit"]).optional(),
    engine: z.enum(["auto", "playwright", "cdp", "lightpanda"]).optional(),
    cdpUrl: z.string().url().optional(),
    wsEndpoint: z.string().url().optional(),
    executablePath: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    headless: z.boolean().optional(),
    waitUntil: z.enum(["domcontentloaded", "load", "networkidle", "commit"]).optional(),
    instantAnimations: z.boolean().optional(),
    blockResources: z.array(z.enum(["image", "font", "media", "stylesheet"])).optional(),
    warmBrowser: z.boolean().optional(),
    warmBrowserScope: z.string().min(1).optional(),
    freshContextPerFlow: z.boolean().optional(),
    contextIsolation: z.enum(["fresh", "hot-cache"]).optional(),
    maxContextsPerBrowser: z.number().int().positive().optional(),
    virtualAuthenticator: z.union([z.boolean(), virtualAuthenticatorOptionsSchema]).optional(),
    storageState: z.string().min(1).optional(),
    verboseLogging: z.boolean().optional(),
    storybook: storybookConfigSchema.optional(),
  })
  .strict();

const executionConfigSchema = z
  .object({
    mode: z.enum(["local", "appium"]).optional(),
    web: webExecutionConfigSchema.optional(),
    appium: appiumExecutionConfigSchema.optional(),
    bridge: bridgeConfigSchema.optional(),
    warmDaemons: warmDaemonConfigSchema.optional(),
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
    har: z.boolean().optional(),
    video: z.enum(["off", "on", "retain-on-failure"]).optional(),
    playback: z.boolean().optional(),
  })
  .strict();

const deviceStateSchema = z
  .object({
    language: z.string().min(1).optional(),
    locale: z.string().min(1).optional(),
    timeZone: z.string().min(1).optional(),
  })
  .strict();

const launchOptionsSchema = z
  .object({
    clearState: z.boolean().optional(),
    clearKeychain: z.boolean().optional(),
    deepLink: z.string().min(1).optional(),
    launchArguments: z.record(z.string(), z.unknown()).optional(),
    deviceState: deviceStateSchema.optional(),
  })
  .strict();

export const provConfigSchema = z
  .object({
    apps: z
      .object({
        web: appConfigSchema.optional(),
        android: appConfigSchema.optional(),
        ios: appConfigSchema.optional(),
        electron: electronAppConfigSchema.optional(),
        electrobun: electrobunAppConfigSchema.optional(),
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
        snapshotMaxDepth: z.number().int().positive().optional(),
        retryDelay: z.number().nonnegative().optional(),
        workers: z.number().int().positive().optional(),
        processes: z.number().int().positive().optional(),
        maxWorkersPerProcess: z.number().int().positive().optional(),
        tapMode: z.enum(["native", "dom"]).optional(),
        locale: z.string().min(1).optional(),
        failFastWhenIdle: z.boolean().optional(),
        actionStableFrames: z.number().int().nonnegative().optional(),
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
    visualRegression: z
      .object({
        threshold: z.number().min(0).max(1).optional(),
        maxDiffPixelRatio: z.number().min(0).max(1).optional(),
        baselinesDir: z.string().optional(),
        mode: z.enum(["pixel", "layout-tolerant"]).optional(),
      })
      .optional(),
    filters: z
      .array(
        z.custom<{ name: string; filter: (...args: unknown[]) => unknown }>(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as Record<string, unknown>).name === "string" &&
            typeof (value as Record<string, unknown>).filter === "function",
          { message: "Expected TestFilter ({ name, filter })" },
        ),
      )
      .optional(),
    replayCache: z
      .object({
        mode: z.enum(["read-write", "strict", "off"]).optional(),
        dir: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
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
