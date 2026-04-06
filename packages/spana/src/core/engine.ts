import type { RawDriverService, LaunchOptions } from "../drivers/raw-driver.js";
import type { FlowDefinition } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";
import type { Attachment, StepResult, ScenarioStepResult } from "../report/types.js";
import type { ArtifactConfig, ProvConfig } from "../schemas/config.js";
import { captureArtifacts, resolveArtifactConfig } from "./artifacts.js";
import { runDebugReplOnce } from "./debug-repl.js";
import { createStepRecorder } from "./step-recorder.js";

export interface TestResult {
  name: string;
  platform: Platform;
  status: "passed" | "failed" | "skipped";
  flaky?: boolean;
  attempts?: number;
  durationMs: number;
  error?: Error;
  attachments?: Attachment[];
  steps?: StepResult[];
  scenarioSteps?: ScenarioStepResult[];
}

export interface EngineConfig {
  appId: string;
  platform: Platform;
  coordinatorConfig: CoordinatorConfig;
  autoLaunch?: boolean;
  flowTimeout?: number;
  artifactConfig?: ArtifactConfig;
  launchOptions?: LaunchOptions;
  hooks?: ProvConfig["hooks"];
  debugOnFailure?: boolean;
}

export async function executeFlow(
  flow: FlowDefinition,
  driver: RawDriverService,
  config: EngineConfig,
): Promise<TestResult> {
  const start = Date.now();
  const { platform, coordinatorConfig, appId } = config;
  const autoLaunch = flow.config.autoLaunch ?? config.autoLaunch ?? true;
  const timeout = flow.config.timeout ?? config.flowTimeout ?? 60_000;
  const artifactConfig = resolveArtifactConfig(config.artifactConfig, flow.config.artifacts);
  const stepRecorder = createStepRecorder(driver, artifactConfig, flow.name, platform);
  const app = createPromiseApp(driver, appId, coordinatorConfig, stepRecorder);
  const expect = createPromiseExpect(driver, coordinatorConfig, stepRecorder);
  // Mutable context so compiled Gherkin flows can attach scenarioSteps via __scenarioSteps
  const flowCtx: any = { app, expect, platform };

  // beforeEach hook — if it throws, abort without running the flow
  if (config.hooks?.beforeEach) {
    try {
      await config.hooks.beforeEach({ app, platform } as any);
    } catch (error) {
      return {
        name: flow.name,
        platform,
        status: "failed",
        durationMs: Date.now() - start,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  let result: TestResult;

  try {
    if (autoLaunch) {
      await app.launch(config.launchOptions);
    }

    await Promise.race([
      flow.fn(flowCtx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Flow "${flow.name}" timed out after ${timeout}ms`)),
          timeout,
        ),
      ),
    ]);

    const attachments = await captureArtifacts(
      driver,
      artifactConfig,
      flow.name,
      platform,
      "passed",
    );

    result = {
      name: flow.name,
      platform,
      status: "passed",
      durationMs: Date.now() - start,
      attachments,
      steps: stepRecorder.getSteps(),
      scenarioSteps: flowCtx.__scenarioSteps,
    };
  } catch (error) {
    const attachments = await captureArtifacts(
      driver,
      artifactConfig,
      flow.name,
      platform,
      "failed",
    );

    result = {
      name: flow.name,
      platform,
      status: "failed",
      durationMs: Date.now() - start,
      error: error instanceof Error ? error : new Error(String(error)),
      attachments,
      steps: stepRecorder.getSteps(),
      scenarioSteps: flowCtx.__scenarioSteps,
    };

    if (config.debugOnFailure) {
      await runDebugReplOnce({
        app,
        expect,
        driver,
        error: result.error ?? new Error(`Flow "${flow.name}" failed`),
        flowName: flow.name,
        platform,
        parseHierarchy: coordinatorConfig.parse,
      });
    }
  }

  // afterEach hook — always runs, errors are warnings only
  if (config.hooks?.afterEach) {
    try {
      await config.hooks.afterEach({ app, platform, result } as any);
    } catch (hookError) {
      console.warn(
        `afterEach hook failed: ${hookError instanceof Error ? hookError.message : hookError}`,
      );
    }
  }

  return result;
}
