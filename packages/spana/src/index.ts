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
  type BrowserRequestOptions,
  type BrowserRequestResponse,
  type BrowserRequestClient,
  type IsolatedBrowserContext,
  type FrameScope,
} from "./api/app.js";
export {
  type PromiseExpectation,
  type NegatedPromiseExpectation,
  type PromiseExpectFn,
  type ToPassExpectation,
  type PollExpectation,
  type PollMatchers,
  type RetryAssertionOptions,
} from "./api/expect.js";

// Secondary sessions
export {
  type SecondarySession,
  type SecondarySessionOptions,
  type Sessions,
} from "./core/session-manager.js";

// Schemas & selector helpers
export {
  systemUI,
  byRole,
  byCss,
  or,
  within,
  inFrame,
  nth,
  first,
  last,
  filterSelector,
  isSystemUISelector,
  isTestIDSelector,
  isComposableDomSelector,
  type Selector,
  type ObjectSelector,
  type SelectorModifiers,
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
  type WebBrowserEngine,
  type WebContextIsolation,
  type VideoRecordingMode,
  type WebResourceBlockType,
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
  type BrowserCookie,
  type BrowserResponseInfo,
  type BrowserNetworkConditions,
  type BrowserConsoleLog,
  type BrowserHAR,
  type BrowserJSError,
  type CdpSessionHandle,
  type TouchAction,
  type TouchSequence,
  type VirtualAuthenticatorOptions,
  type VirtualCredential,
  type VirtualCredentialInput,
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
  type DomWaitForSelectorOptions,
  type DomWaitForHiddenOptions,
  type DomWaitForMatchOptions,
  type DomWaitForMatchResult,
  type DomFillOptions,
  type DomStorageEntries,
  type DomClearStorageOptions,
  type DomTargetInfo,
  buildDomWaitForSelectorScript,
  buildDomWaitForHiddenScript,
  buildDomWaitForMatchScript,
  buildDomFillScript,
  buildDomActionabilityDiagScript,
  SPANA_INJECTED_RUNTIME_SCRIPT,
  buildInjectedCallScript,
  type InjectedRuntimeMethod,
} from "./channels/dom-channel.js";
export {
  createCdpDomChannel,
  CdpDomChannel,
  type CdpDomChannelOptions,
  type CdpChildSessionInfo,
  type CdpFrameOffsetResolver,
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
  invalidateWebViewFrameCache,
  domRectToScreenBounds,
  isOffscreenInViewport,
  resolveElementAcrossChannels,
  type ResolvedElementResult,
} from "./smart/channel-resolver.js";
export {
  ensureWarmBrowserDaemon,
  launchPlaywrightBrowser,
  connectPlaywrightOverCDP,
  connectPlaywrightOverWS,
} from "./drivers/playwright.js";
export {
  resolveWebEngine,
  speculativelyPrelaunchWebBrowser,
  type PrelaunchedWebBrowser,
} from "./runtime/local.js";
export {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  UPLOAD_ATTACH_TIMEOUT_MS,
  type DirectCdpBrowserLaunchOptions,
  type DirectCdpBrowserHandle,
  type LightweightCdpDriverOptions,
} from "./drivers/cdp-browser.js";
export { orderFlowsLongestFirst } from "./core/parallel.js";
export { makeElectronDriver, type ElectronDriverOptions } from "./drivers/electron.js";
export {
  makeElectrobunDriver,
  resolveElectrobunLaunchPlan,
  type ElectrobunDriverOptions,
  type ElectrobunLaunchPlan,
} from "./drivers/electrobun.js";
export {
  DEFAULT_WARM_DAEMON_IDLE_TTL_MS,
  listWarmDaemons,
  stopWarmDaemon,
  stopAllWarmDaemons,
  reapIdleWarmDaemons,
  sweepOrphanedSpanaBrowsers,
  getHealthyWarmDaemon,
  updateWarmDaemonSession,
  defaultDaemonStateDir,
  type WarmDaemonRecord,
} from "./runtime/daemon-manager.js";
export { allocateFreePort, isPortAvailable, assertPortAvailable } from "./core/port-allocator.js";
export {
  extractCodeFrame,
  formatCodeFrame,
  type CodeLocation,
  type ExtractedCodeFrame,
} from "./report/code-frame.js";

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
  deterministicImpactFilter,
  createOllamaDecisionJudge,
  createLogprobDecisionJudge,
  probabilityFromTopLogprobs,
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
  type DecisionBatchJudge,
  type DecisionBatchJudgeResult,
  type DecisionFilterOptions,
  type OllamaDecisionJudgeOptions,
  type LogprobDecisionJudgeOptions,
  type PathRule,
  type PathRuleFilterOptions,
  type DeterministicImpactFilterOptions,
  type AppliedFilterReport,
  type ApplyFiltersResult,
} from "./core/filters.js";

// Composable lazy fixtures, API setup client & per-persona auth cache
export {
  defineSetup,
  applyNamedSetup,
  createFlowWithFixtures,
  extractDestructuredParamNames,
  createApiClient,
  createApiFixture,
  definePersona,
  PersonaAuthCache,
  VirtualCredentialStore,
  type NamedSetupDefinition,
  type FixtureFn,
  type FixtureDefinition,
  type FixtureMap,
  type ExtendedFlowConfig,
  type CreateFixturesOptions,
  type ApiClientOptions,
  type ApiRequestOptions,
  type ApiResponse,
  type ApiClient,
  type PersonaDefinition,
  type CachedPersonaState,
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

export {
  isNativeAcceleratorActive,
  getNativeAcceleratorPath,
  comparePngNative,
  tokenizeXmlNative,
  type NativePngCompareResult,
  type NativeXmlRawNode,
} from "./core/native-accel.js";

// Cross-platform video recording & interactive playback trace
export {
  startCdpScreencastRecorder,
  exportFramesToMp4,
  startAndroidVideoRecorder,
  startIosSimulatorVideoRecorder,
  buildPlaybackTraceFromSteps,
  type PlaybackFrame,
  type PlaybackStepMarker,
  type FlowPlaybackTrace,
  type StopRecordingOptions,
  type StopRecordingResult,
  type VideoRecorderHandle,
  type CdpScreencastLike,
  type CdpScreencastRecorderOptions,
} from "./core/video-recorder.js";

// Hybrid multi-process × in-process worker pool (16–32+ CI workers)
export {
  DEFAULT_MAX_WORKERS_PER_PROCESS,
  planProcessPool,
  partitionFlowsAcrossProcesses,
  runMultiProcessPool,
  writeWorkerProcessReport,
  startSharedFlowQueueServer,
  createRemoteFlowClaimer,
  type SharedFlowQueueServer,
  type ProcessPartitionPlan,
  type ProcessShardCommand,
  type ProcessShardOutcome,
  type MultiProcessPoolOptions,
  type MultiProcessPoolResult,
} from "./core/worker-pool.js";

// Deterministic local API network replay cache & iOS simulator cloning
export {
  NetworkReplayCache,
  attachNetworkReplayCache,
  buildNetworkCacheKey,
  type NetworkCacheMode,
  type CachedNetworkEntry,
  type NetworkReplayCacheOptions,
  type AttachNetworkCacheOptions,
  type AttachNetworkCacheResult,
} from "./core/network-cache.js";
export { cloneIOSSimulator, deleteIOSSimulator } from "./device/ios.js";

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
