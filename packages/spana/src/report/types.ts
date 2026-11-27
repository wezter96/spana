import type { Platform } from "../schemas/selector.js";

/** Result of a single test step (tap, assertVisible, typeText, etc.) within a flow. */
export interface StepResult {
  /** The command name (e.g., "tap", "assertVisible", "typeText"). */
  command: string;
  /** The selector used for this step, if any. */
  selector?: unknown;
  /** Whether this step passed or failed. */
  status: "passed" | "failed";
  /** Wall-clock duration of this step in milliseconds. */
  durationMs: number;
  /** Error message if this step failed. */
  error?: string;
  /** Screenshots or artifacts captured during this step. */
  attachments?: Attachment[];
}

/** A screenshot, hierarchy dump, or other artifact captured during a test. */
export interface Attachment {
  /** Display name for this attachment (e.g., "failure-screenshot"). */
  name: string;
  /** MIME type: "image/png", "application/json", or "text/plain". */
  contentType: string;
  /** Absolute file path to the attachment on disk. */
  path: string;
}

/** Gherkin step keywords used in scenario-style flows. */
export type ScenarioStepKeyword = "Given" | "When" | "Then" | "And" | "But" | "Before" | "After";

/** Result of a Gherkin scenario step (Given/When/Then). */
export interface ScenarioStepResult {
  /** The Gherkin keyword (Given, When, Then, And, But). */
  keyword: ScenarioStepKeyword;
  /** The step description text. */
  text: string;
  /** Whether this scenario step passed, failed, or was skipped. */
  status: "passed" | "failed" | "skipped";
  /** Wall-clock duration of this step in milliseconds. */
  durationMs: number;
  /** Error message if this step failed. */
  error?: string;
  /** Driver-level steps executed within this scenario step. */
  steps?: StepResult[];
}

/**
 * Classification of a test failure. Used by the error classifier to categorize
 * failures and provide actionable suggestions.
 */
export type FailureCategory =
  | "element-not-found"
  | "element-not-visible"
  | "element-off-screen"
  | "element-not-interactive"
  | "text-mismatch"
  | "timeout"
  | "device-disconnected"
  | "app-crashed"
  | "app-not-installed"
  | "driver-error"
  | "config-error"
  | "unknown";

/** Structured error from a failed flow, including classification and actionable suggestion. */
export interface FlowError {
  /** Human-readable error message. */
  message: string;
  /** Stack trace, if available. */
  stack?: string;
  /** Error category for classification and reporting. */
  category: FailureCategory;
  /** Actionable suggestion for resolving the failure (e.g., "increase waitTimeout"). */
  suggestion?: string;
  /** Machine-readable error code for programmatic handling. */
  errorCode?: string;
  /** Source file location in the user's flow where the failure originated. */
  location?: { file: string; line: number; column: number };
  /** Annotated source code snippet centered on `location`. */
  codeFrame?: string;
}

/** Result of a single flow execution on a specific platform. */
export interface FlowResult {
  /** Flow name as defined in the flow file. */
  name: string;
  /** Platform this flow ran on. */
  platform: Platform;
  /** Final status after all retry attempts. */
  status: "passed" | "failed" | "skipped";
  /** Declaration responsible for skipping the flow, if explicitly skipped. */
  modifier?: "skip" | "fixme";
  skipReason?: string;
  /** True if the flow failed initially but passed on retry. */
  flaky?: boolean;
  /** Number of attempts made (present when retries > 0). */
  attempts?: number;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  /** Error details if the flow failed. */
  error?: FlowError;
  /** Screenshots and artifacts captured during this flow. */
  attachments?: Attachment[];
  /** Driver-level step results (tap, assert, type, etc.). */
  steps?: StepResult[];
  /** Gherkin scenario step results (Given/When/Then). */
  scenarioSteps?: ScenarioStepResult[];
  /** Worker/device name when running in parallel mode. */
  workerName?: string;
  /** Tags configured on the flow (for traceability, filtering, and reporting). */
  tags?: string[];
  /** Custom annotations attached to the flow (reported in JSON & JUnit `<properties>`). */
  annotations?: Array<{ type: string; description?: string }>;
}

/** Aggregate summary of a complete test run across all platforms. */
export interface RunSummary {
  /** Total number of flow executions (flows x platforms). */
  total: number;
  /** Number of flows that passed. */
  passed: number;
  /** Number of flows that failed. */
  failed: number;
  /** Number of flows that were skipped. */
  skipped: number;
  /** Number of flows that were flaky (failed then passed on retry). */
  flaky: number;
  /** Total wall-clock duration of the entire run in milliseconds. */
  durationMs: number;
  /** Optional per-platform wall-clock durations in milliseconds. */
  platformDurations?: Partial<Record<Platform, number>>;
  /** All individual flow results. */
  results: FlowResult[];
  /** Platforms included in this run. */
  platforms: Platform[];
  /** True if the run was stopped early due to --bail. */
  bailedOut?: boolean;
  /** The bail limit that triggered early stop. */
  bailLimit?: number;
  /** Per-worker execution stats (parallel mode only). */
  workerStats?: Map<string, { flowCount: number; totalMs: number }>;
}

/**
 * Reporter interface for receiving test lifecycle events.
 *
 * Implement this interface to create custom reporters. All hooks except
 * `onRunComplete` are optional. Export a Reporter object or a factory
 * function as the default export of your reporter module.
 *
 * @example
 * ```ts
 * import type { Reporter } from "spana";
 *
 * const myReporter: Reporter = {
 *   onFlowFail(result) { console.log(`FAIL: ${result.name}`); },
 *   onRunComplete(summary) { console.log(`${summary.passed}/${summary.total} passed`); },
 * };
 * export default myReporter;
 * ```
 */
export interface Reporter {
  /** Called when a flow starts execution. */
  onFlowStart?(name: string, platform: Platform, workerName?: string): void;
  /** Called when a flow passes (after all steps succeed). */
  onFlowPass?(result: FlowResult): void;
  /** Called when a flow fails (after all retry attempts are exhausted). */
  onFlowFail?(result: FlowResult): void;
  /** Called when a flow is skipped (`skip`, `fixme`, conditional `when`, serial sibling skip, or bail). */
  onFlowSkip?(result: FlowResult): void;
  /** Called once after all flows complete. Required. */
  onRunComplete(summary: RunSummary): void;
  /** Total number of flows to run (for progress display). */
  flowCount?: number;
  /** Per-platform flow counts for detailed progress display. */
  platformFlowCounts?: Partial<Record<Platform, number>>;
}
