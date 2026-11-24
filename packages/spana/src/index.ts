// spana — Web-first cross-platform E2E testing (Web, Capacitor iOS/Android, Electron, Electrobun)

// User-facing API
export {
  flow,
  type FlowConfig,
  type FlowContext,
  type FlowFn,
  type FlowDefinition,
} from "./api/flow.js";
export {
  type PromiseApp,
  type BackUntilVisibleOptions,
  type DismissKeyboardOptions,
  type ScrollUntilVisibleOptions,
  type StorybookOpenOptions,
} from "./api/app.js";
export { type PromiseExpectation } from "./api/expect.js";

// Secondary sessions
export {
  type SecondarySession,
  type SecondarySessionOptions,
  type Sessions,
} from "./core/session-manager.js";

// Schemas & selector helpers
export {
  systemUI,
  isSystemUISelector,
  isTestIDSelector,
  type Selector,
  type ExtendedSelector,
  type RelativeSelector,
  type Platform,
  type TapMode,
} from "./schemas/selector.js";
export {
  defineConfig,
  type ProvConfig,
  type AppConfig,
  type ElectronAppConfig,
  type ElectrobunAppConfig,
  type ElectrobunRenderer,
  type BridgeConfig,
  type WarmDaemonConfig,
  type BrowserName,
  type StorybookConfig,
  type StorybookValue,
  type WebExecutionConfig,
  type DeviceStateConfig,
  type LaunchOptions,
  type ArtifactConfig,
} from "./schemas/config.js";
export { type Element } from "./schemas/element.js";
export { type DeviceInfo } from "./schemas/device.js";
export {
  type BrowserRouteMatcher,
  type BrowserMockResponse,
  type BrowserNetworkConditions,
  type BrowserConsoleLog,
  type BrowserHAR,
  type BrowserJSError,
  type TouchAction,
  type TouchSequence,
} from "./drivers/raw-driver.js";

// Target × Channel Matrix & DOM Channels
export {
  TARGET_CHANNEL_MATRIX,
  resolveTargetDescriptor,
  resolveElectrobunEngine,
  formatTargetMatrixTable,
  type TargetShell,
  type TargetEngine,
  type TargetChannel,
  type TargetDescriptor,
  type HostOS,
} from "./core/target-matrix.js";
export {
  type DomChannel,
  type DomChannelKind,
  type DomElementMatch,
  type DomRect,
  type DomIdleOptions,
  type DomStorageEntries,
  type DomClearStorageOptions,
  type DomTargetInfo,
} from "./channels/dom-channel.js";
export {
  createCdpDomChannel,
  CdpDomChannel,
  type CdpDomChannelOptions,
} from "./channels/cdp-client.js";
export {
  createAndroidWebViewCdpChannel,
  AndroidWebViewCdpChannel,
  parseAndroidWebViewSockets,
  type AndroidWebViewCdpOptions,
} from "./channels/android-cdp.js";
export {
  createWebKitInspectorChannel,
  WebKitInspectorChannel,
  type WebKitInspectorOptions,
} from "./channels/webkit-inspector.js";
export {
  AppleWebInspectorClient,
  encodeWebInspectorPacket,
  decodeWebInspectorFrames,
  parseWebInspectorXmlFrame,
  findSimulatorWebInspectorSocket,
  type WebInspectorListingPage,
} from "./channels/apple-webinspector.js";
export {
  createSpanaBridgeChannel,
  createCompositeDomChannel,
  SpanaBridgeChannel,
  type SpanaBridgeServerOptions,
} from "./channels/bridge-server.js";

// Channel resolver & Desktop drivers
export {
  findWebViewFrame,
  domRectToScreenBounds,
  isOffscreenInViewport,
  resolveElementAcrossChannels,
  type ResolvedElementResult,
} from "./smart/channel-resolver.js";
export { launchPlaywrightBrowser } from "./drivers/playwright.js";
export { makeElectronDriver, type ElectronDriverOptions } from "./drivers/electron.js";
export {
  makeElectrobunDriver,
  resolveElectrobunLaunchPlan,
  type ElectrobunDriverOptions,
  type ElectrobunLaunchPlan,
} from "./drivers/electrobun.js";
export {
  listWarmDaemons,
  stopWarmDaemon,
  stopAllWarmDaemons,
  getHealthyWarmDaemon,
  updateWarmDaemonSession,
  type WarmDaemonRecord,
} from "./runtime/daemon-manager.js";

// Cloud provider API — for custom cloud provider authors
export { type CloudProvider, type CloudProviderHelper } from "./cloud/provider.js";

// Reporter API — for custom reporter authors
export {
  type Reporter,
  type FlowResult,
  type RunSummary,
  type StepResult,
  type ScenarioStepResult,
  type Attachment,
  type FlowError,
  type FailureCategory,
} from "./report/types.js";
export {
  createGitHubPrReporter,
  formatGitHubPrMarkdown,
  type GitHubPrReporterOptions,
} from "./report/github-pr.js";

// CI Filters API (--changed-since)
export {
  decisionFilter,
  pathRuleFilter,
  applyTestFilters,
  collectGitChanges,
  buildFilterCandidates,
  formatFilterSummary,
  type TestFilter,
  type FilterCandidate,
  type FilterContext,
  type FilterDecisionOutput,
  type FilterUsage,
  type GitChanges,
  type ChangedFile,
  type DecisionModelJudge,
  type DecisionFilterOptions,
  type PathRule,
  type PathRuleFilterOptions,
  type AppliedFilterReport,
  type ApplyFiltersResult,
} from "./core/filters.js";

// Composable lazy fixtures & named setup states
export {
  defineSetup,
  applyNamedSetup,
  createFlowWithFixtures,
  extractDestructuredParamNames,
  type NamedSetupDefinition,
  type FixtureFn,
  type FixtureDefinition,
  type FixtureMap,
  type ExtendedFlowConfig,
  type CreateFixturesOptions,
} from "./api/fixtures.js";

// Verified Replay Cache (.spana/cache) & self-healing agent hook
export {
  ReplayCacheStore,
  ReplaySession,
  buildReplayCacheKey,
  replayRecordedAction,
  type RecordedAction,
  type ReplayCacheEntry,
  type ReplayCacheMode,
  type CacheWriteStatus,
  type ReplayStepOutcome,
  type ReplayCacheSummary,
  type AgentActExecutor,
  type ReplaySessionOptions,
} from "./core/replay-cache.js";

// Stdio MCP Server (spana mcp)
export {
  SpanaMcpServer,
  SPANA_MCP_TOOLS,
  formatSelectorCode,
  buildFlowFileFromLines,
  type McpToolDefinition,
  type McpContentBlock,
  type McpToolResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SpanaMcpServerOptions,
} from "./mcp/server.js";
