// spana — TypeScript-native E2E testing for React Native + Web

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

// Schemas
export {
  type Selector,
  type ExtendedSelector,
  type RelativeSelector,
  type Platform,
} from "./schemas/selector.js";
export {
  defineConfig,
  type ProvConfig,
  type AppConfig,
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
