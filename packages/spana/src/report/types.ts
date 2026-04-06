import type { Platform } from "../schemas/selector.js";

export interface StepResult {
  command: string;
  selector?: unknown;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
  attachments?: Attachment[];
}

export interface Attachment {
  name: string;
  contentType: string; // "image/png", "application/json", "text/plain"
  path: string;
}

export type ScenarioStepKeyword = "Given" | "When" | "Then" | "And" | "But" | "Before" | "After";

export interface ScenarioStepResult {
  keyword: ScenarioStepKeyword;
  text: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  steps?: StepResult[];
}

export interface FlowResult {
  name: string;
  platform: Platform;
  status: "passed" | "failed" | "skipped";
  flaky?: boolean;
  attempts?: number;
  durationMs: number;
  error?: { message: string; stack?: string };
  attachments?: Attachment[];
  steps?: StepResult[];
  scenarioSteps?: ScenarioStepResult[];
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  results: FlowResult[];
  platforms: Platform[];
  bailedOut?: boolean;
  bailLimit?: number;
}

export interface Reporter {
  onFlowStart?(name: string, platform: Platform): void;
  onFlowPass?(result: FlowResult): void;
  onFlowFail?(result: FlowResult): void;
  onRunComplete(summary: RunSummary): void;
}
