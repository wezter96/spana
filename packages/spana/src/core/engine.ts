import type { RawDriverService, LaunchOptions } from "../drivers/raw-driver.js";
import type { FlowDefinition } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";
import { Effect } from "effect";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { mergeLaunchOptions } from "../drivers/launch-options.js";
import type { CoordinatorConfig } from "../smart/coordinator.js";
import type { Attachment, StepResult, ScenarioStepResult, FlowError } from "../report/types.js";
import type { ArtifactConfig, ProvConfig, StorybookConfig } from "../schemas/config.js";
import { captureArtifacts, resolveArtifactConfig } from "./artifacts.js";
import { runDebugReplOnce } from "./debug-repl.js";
import { createStepRecorder } from "./step-recorder.js";
import { classifyError } from "../report/classify-error.js";
import { join } from "node:path";
import { createFailureBundle, writeFailureBundle } from "../report/failure-bundle.js";
import { SessionManager, createSessions } from "./session-manager.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";

export interface TestResult {
  name: string;
  platform: Platform;
  status: "passed" | "failed" | "skipped";
  flaky?: boolean;
  attempts?: number;
  durationMs: number;
  error?: FlowError;
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
  updateBaselines?: boolean;
  storybook?: StorybookConfig;
  visualRegression?: ProvConfig["visualRegression"];
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
  const launchOptions = mergeLaunchOptions(config.launchOptions, flow.config.launchOptions);

  // Merge per-flow defaults into coordinator config
  const flowDefaults = flow.config.defaults;
  const mergedCoordinatorConfig = flowDefaults
    ? {
        ...coordinatorConfig,
        defaults: {
          ...coordinatorConfig.defaults,
          timeout: flowDefaults.waitTimeout ?? coordinatorConfig.defaults?.timeout,
          pollInterval: flowDefaults.pollInterval ?? coordinatorConfig.defaults?.pollInterval,
          settleTimeout: flowDefaults.settleTimeout ?? coordinatorConfig.defaults?.settleTimeout,
          initialPollInterval:
            flowDefaults.initialPollInterval ?? coordinatorConfig.defaults?.initialPollInterval,
        },
        waitForIdleTimeout: flowDefaults.waitForIdleTimeout ?? coordinatorConfig.waitForIdleTimeout,
        typingDelay: flowDefaults.typingDelay ?? coordinatorConfig.typingDelay,
        hierarchyCacheTtl: flowDefaults.hierarchyCacheTtl ?? coordinatorConfig.hierarchyCacheTtl,
      }
    : coordinatorConfig;

  const app = createPromiseApp(driver, appId, mergedCoordinatorConfig, stepRecorder, {
    platform,
    storybook: config.storybook,
    launchOptions,
  });
  const flowMeta = {
    flowFilePath: flow.sourcePath ?? "",
    flowName: flow.name,
    platform,
    updateBaselines: config.updateBaselines ?? false,
  };
  const expect = createPromiseExpect(
    driver,
    mergedCoordinatorConfig,
    stepRecorder,
    flowMeta,
    config.visualRegression,
  );
  // Mutable context so compiled Gherkin flows can attach scenarioSteps via __scenarioSteps
  const flowCtx: any = { app, expect, platform, updateBaselines: flowMeta.updateBaselines };
  const sessionManager = new SessionManager();
  const sessions = createSessions(
    sessionManager,
    async (opts) => {
      const pwDriver = await Effect.runPromise(
        makePlaywrightDriver({
          browser: opts.browser,
          headless: opts.headless ?? true,
          baseUrl: opts.baseUrl,
          storageState: opts.storageState,
          verboseLogging: opts.verboseLogging,
        }),
      );
      return pwDriver;
    },
    { parse: (raw: string) => parseWebHierarchy(raw) },
  );
  flowCtx.sessions = sessions;
  const buildFailureResult = async (error: unknown): Promise<TestResult> => {
    const attachments = await captureArtifacts(
      driver,
      artifactConfig,
      flow.name,
      platform,
      "failed",
    );
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      name: flow.name,
      platform,
      status: "failed",
      durationMs: Date.now() - start,
      error: classifyError(normalized),
      attachments,
      steps: stepRecorder.getSteps(),
      scenarioSteps: flowCtx.__scenarioSteps,
    };
  };

  if (driver.beginFlow) {
    try {
      await Effect.runPromise(driver.beginFlow(flow.name));
    } catch (error) {
      return buildFailureResult(error);
    }
  }

  // beforeEach hook — if it throws, abort without running the flow
  if (config.hooks?.beforeEach) {
    try {
      await config.hooks.beforeEach({ app, platform } as any);
    } catch (error) {
      return buildFailureResult(error);
    }
  }

  let result: TestResult;

  try {
    if (autoLaunch) {
      await app.launch();
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

    const flowError = error instanceof Error ? error : new Error(String(error));
    result = {
      name: flow.name,
      platform,
      status: "failed",
      durationMs: Date.now() - start,
      error: classifyError(flowError),
      attachments,
      steps: stepRecorder.getSteps(),
      scenarioSteps: flowCtx.__scenarioSteps,
    };

    // Write structured failure bundle alongside artifacts
    if (artifactConfig.captureOnFailure && result.error) {
      try {
        const artDir = join(
          artifactConfig.outputDir,
          `${
            flow.name
              .replaceAll(/[^a-zA-Z0-9-_]/g, "_")
              .replaceAll(/_+/g, "_")
              .slice(0, 80) || "artifact"
          }-${platform}`,
        );
        const bundle = createFailureBundle(
          flow.name,
          platform,
          stepRecorder.getSteps(),
          result.error,
          artDir,
          attachments,
        );
        writeFailureBundle(bundle, artDir);
      } catch {
        // Bundle writing is best-effort — don't block test execution
      }
    }

    if (config.debugOnFailure) {
      await runDebugReplOnce({
        app,
        expect,
        driver,
        error: flowError,
        flowName: flow.name,
        platform,
        parseHierarchy: coordinatorConfig.parse,
      });
    }
  }

  // Clean up all secondary sessions
  try {
    await sessionManager.disconnectAll();
  } catch {
    // Best-effort cleanup — don't mask the primary result
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
