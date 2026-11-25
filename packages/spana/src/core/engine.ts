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
import {
  captureArtifacts,
  flowArtifactDir,
  resolveArtifactConfig,
  safeArtifactName,
} from "./artifacts.js";
import { runDebugReplOnce } from "./debug-repl.js";
import { createStepRecorder } from "./step-recorder.js";
import { classifyError } from "../report/classify-error.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFailureBundle, writeFailureBundle } from "../report/failure-bundle.js";
import { SessionManager, createSessions } from "./session-manager.js";
import { getFlowSkip } from "./runner.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import {
  buildPlaybackTraceFromSteps,
  startAndroidVideoRecorder,
  startCdpScreencastRecorder,
  startIosSimulatorVideoRecorder,
  type CdpScreencastLike,
  type PlaybackStepMarker,
  type VideoRecorderHandle,
} from "./video-recorder.js";

function isCdpScreencastCapable(channel: unknown): channel is CdpScreencastLike {
  return (
    Boolean(channel) &&
    typeof (channel as CdpScreencastLike).sendCommand === "function" &&
    typeof (channel as CdpScreencastLike).onEvent === "function"
  );
}

function buildPlaybackStepMarkers(steps: StepResult[]): PlaybackStepMarker[] {
  let cursorMs = 0;
  return steps.map((step, index) => {
    const startedAtMs = cursorMs;
    cursorMs += Math.max(1, step.durationMs);
    const sel = step.selector as Record<string, unknown> | undefined;
    const pt =
      sel && typeof sel === "object"
        ? (sel["point"] as Record<string, unknown> | undefined)
        : undefined;
    const tapPoint =
      pt && typeof pt["x"] === "number" && typeof pt["y"] === "number"
        ? { x: pt["x"], y: pt["y"] }
        : undefined;
    return {
      index,
      command: step.command,
      selector: step.selector,
      startedAtMs,
      durationMs: step.durationMs,
      status: step.status,
      error: step.error,
      ...(tapPoint ? { tapPoint } : {}),
    };
  });
}

export interface TestResult {
  name: string;
  platform: Platform;
  status: "passed" | "failed" | "skipped";
  modifier?: "skip" | "fixme";
  skipReason?: string;
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
  const skip = getFlowSkip(flow, platform);
  if (skip) return skip;
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

  const softFailures: unknown[] = [];
  const aggregateFailures = (hardFailure?: Error) => {
    const messages = softFailures.map(
      (error, i) => `${i + 1}. ${error instanceof Error ? error.message : String(error)}`,
    );
    return new AggregateError(
      hardFailure ? [hardFailure, ...softFailures] : softFailures,
      `${hardFailure ? `${hardFailure.message}\n` : ""}${softFailures.length} soft assertion(s) failed:\n${messages.join("\n")}`,
      { cause: hardFailure ?? softFailures[0] },
    );
  };
  const flowMeta = {
    flowFilePath: flow.sourcePath ?? "",
    flowName: flow.name,
    platform,
    updateBaselines: config.updateBaselines ?? false,
    recordSoftFailure: (error: unknown) => {
      softFailures.push(error);
    },
  };
  const extraCleanups: Array<() => Promise<void>> = [];
  const app = createPromiseApp(driver, appId, mergedCoordinatorConfig, stepRecorder, {
    platform,
    storybook: config.storybook,
    launchOptions,
    onRegisterCleanup: (fn) => extraCleanups.push(fn),
    flowContext: flowMeta,
    visualRegression: config.visualRegression,
  });
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
    { ...flowMeta, platform: "web" },
  );
  flowCtx.sessions = sessions;
  let videoRecorder: VideoRecorderHandle | undefined;
  let collectingCoverage = false;
  let recordingFinalized = false;
  const wantRecording = artifactConfig.video !== "off" || artifactConfig.playback;

  const captureCoverage = async (attachments: Attachment[], status: "passed" | "failed") => {
    if (!collectingCoverage || !driver.stopJSCoverage) return;
    collectingCoverage = false;
    try {
      const entries = await Effect.runPromise(driver.stopJSCoverage());
      const path = join(flowArtifactDir(artifactConfig, flow.name, platform), "js-coverage.json");
      writeFileSync(path, JSON.stringify(entries), "utf8");
      attachments.push({ name: "js-coverage", contentType: "application/json", path });
    } catch (error) {
      if (status === "passed") throw error;
      console.warn(
        `Failed to capture JavaScript coverage: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const finalizeRecording = async (
    status: "passed" | "failed",
    attachments: Attachment[],
    steps: StepResult[],
    durationMs: number,
  ): Promise<void> => {
    if (recordingFinalized || !wantRecording) return;
    recordingFinalized = true;

    const keep =
      artifactConfig.video === "on" ||
      artifactConfig.playback ||
      (artifactConfig.video === "retain-on-failure" && status === "failed");

    const fileStem = safeArtifactName(flow.name);
    const outputDir = keep
      ? flowArtifactDir(artifactConfig, flow.name, platform)
      : artifactConfig.outputDir;

    let viewport: { width: number; height: number } | undefined;
    try {
      const info = await Effect.runPromise(Effect.orDie(driver.getDeviceInfo()));
      if (info.screenWidth > 0 && info.screenHeight > 0) {
        viewport = { width: info.screenWidth, height: info.screenHeight };
      }
    } catch {
      // viewport lookup best-effort
    }

    let stopRes: { playbackJsonPath?: string; videoPath?: string; frameCount: number } | undefined;
    if (videoRecorder) {
      try {
        stopRes = await videoRecorder.stop({
          keep,
          outputDir,
          fileStem,
          steps: buildPlaybackStepMarkers(steps),
          viewport,
        });
      } catch {
        // best-effort stop
      }
    }

    if (!keep) return;

    if (stopRes?.videoPath) {
      attachments.push({
        name: "video",
        contentType: stopRes.videoPath.endsWith(".webm") ? "video/webm" : "video/mp4",
        path: stopRes.videoPath,
      });
    }

    if (stopRes?.playbackJsonPath) {
      attachments.push({
        name: "playback",
        contentType: "application/json",
        path: stopRes.playbackJsonPath,
      });
      return;
    }

    const fallbackTrace = buildPlaybackTraceFromSteps({
      flowName: flow.name,
      platform,
      durationMs,
      steps,
      viewport,
      videoPath: stopRes?.videoPath,
    });
    if (fallbackTrace) {
      const playbackPath = join(outputDir, `${fileStem}-playback.json`);
      writeFileSync(playbackPath, JSON.stringify(fallbackTrace), "utf8");
      attachments.push({
        name: "playback",
        contentType: "application/json",
        path: playbackPath,
      });
    }
  };

  const buildFailureResult = async (error: unknown): Promise<TestResult> => {
    const attachments = await captureArtifacts(
      driver,
      artifactConfig,
      flow.name,
      platform,
      "failed",
    );
    await captureCoverage(attachments, "failed");
    const steps = stepRecorder.getSteps();
    const durationMs = Date.now() - start;
    await finalizeRecording("failed", attachments, steps, durationMs);
    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      name: flow.name,
      platform,
      status: "failed",
      durationMs,
      error: classifyError(normalized, {
        flowFilePath: flow.sourcePath,
        fallbackStack: stepRecorder.getLastFailureStack?.(),
      }),
      attachments,
      steps,
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

  if (artifactConfig.jsCoverage && platform === "web") {
    if (!driver.startJSCoverage || !driver.stopJSCoverage) {
      return buildFailureResult(
        new Error(
          "JavaScript coverage is not supported on web with the current driver; use Chromium with Playwright or direct CDP",
        ),
      );
    }
    try {
      await Effect.runPromise(driver.startJSCoverage());
      collectingCoverage = true;
    } catch (error) {
      return buildFailureResult(error);
    }
  }

  if (wantRecording) {
    try {
      if (isCdpScreencastCapable(driver.domChannel)) {
        videoRecorder = await startCdpScreencastRecorder(driver.domChannel, {
          flowName: flow.name,
          platform,
          exportMp4: artifactConfig.video !== "off",
        });
      } else if (artifactConfig.video !== "off" && (platform === "android" || platform === "ios")) {
        const info = await Effect.runPromise(Effect.orDie(driver.getDeviceInfo())).catch(
          () => undefined,
        );
        if (info?.deviceId) {
          const outDir = flowArtifactDir(artifactConfig, flow.name, platform);
          const videoOut = join(outDir, `${safeArtifactName(flow.name)}.mp4`);
          videoRecorder =
            platform === "android"
              ? startAndroidVideoRecorder(info.deviceId, { outputPath: videoOut })
              : startIosSimulatorVideoRecorder(info.deviceId, { outputPath: videoOut });
        }
      }
    } catch {
      // Recording startup is best-effort — never block test execution
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
  let softFailureError: Error | undefined;

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
    if (softFailures.length > 0) {
      softFailureError = aggregateFailures();
      throw softFailureError;
    }

    const attachments = await captureArtifacts(
      driver,
      artifactConfig,
      flow.name,
      platform,
      "passed",
    );
    await captureCoverage(attachments, "passed");
    const steps = stepRecorder.getSteps();
    const durationMs = Date.now() - start;
    await finalizeRecording("passed", attachments, steps, durationMs);

    result = {
      name: flow.name,
      platform,
      status: "passed",
      durationMs,
      attachments,
      steps,
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
    await captureCoverage(attachments, "failed");
    const steps = stepRecorder.getSteps();
    const durationMs = Date.now() - start;
    await finalizeRecording("failed", attachments, steps, durationMs);

    const normalized = error instanceof Error ? error : new Error(String(error));
    const flowError =
      softFailures.length > 0 && error !== softFailureError
        ? aggregateFailures(normalized)
        : normalized;
    result = {
      name: flow.name,
      platform,
      status: "failed",
      durationMs,
      error: classifyError(flowError, {
        flowFilePath: flow.sourcePath,
        fallbackStack: stepRecorder.getLastFailureStack?.(),
      }),
      attachments,
      steps,
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
          flow.sourcePath,
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

  // Clean up all secondary contexts created via app.newContext() and secondary sessions
  for (const cleanup of extraCleanups.toReversed()) {
    try {
      await cleanup();
    } catch {
      // Best-effort cleanup — don't mask the primary result
    }
  }
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
