import type { RawDriverService } from "../drivers/raw-driver.js";
import type { Attachment, StepResult } from "../report/types.js";
import type { ResolvedArtifactConfig } from "./artifacts.js";
import { captureStepScreenshot } from "./artifacts.js";

export interface StepRecordOptions {
  selector?: unknown;
  captureScreenshot?: boolean;
}

export interface ScreenshotStepOptions {
  selector?: unknown;
  name?: string;
}

export interface StepRecorder {
  runStep<A>(command: string, action: () => Promise<A>, opts?: StepRecordOptions): Promise<A>;
  runScreenshotStep(
    command: string,
    action: () => Promise<Uint8Array>,
    opts?: ScreenshotStepOptions,
  ): Promise<Uint8Array>;
  getSteps(): StepResult[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createStepResult(
  command: string,
  durationMs: number,
  status: "passed" | "failed",
  selector?: unknown,
  error?: string,
  attachments?: Attachment[],
): StepResult {
  return {
    command,
    selector,
    status,
    durationMs,
    error,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  };
}

export function createStepRecorder(
  driver: RawDriverService,
  artifactConfig: ResolvedArtifactConfig,
  flowName: string,
  platform: string,
): StepRecorder {
  const steps: StepResult[] = [];

  return {
    async runStep<A>(command: string, action: () => Promise<A>, opts?: StepRecordOptions) {
      const startedAt = Date.now();

      try {
        const result = await action();
        const attachments: Attachment[] = [];

        if (opts?.captureScreenshot && artifactConfig.captureSteps) {
          const attachment = await captureStepScreenshot(
            driver,
            artifactConfig,
            flowName,
            platform,
            steps.length + 1,
            command,
          );
          if (attachment) attachments.push(attachment);
        }

        steps.push(
          createStepResult(
            command,
            Date.now() - startedAt,
            "passed",
            opts?.selector,
            undefined,
            attachments,
          ),
        );
        return result;
      } catch (error) {
        steps.push(
          createStepResult(
            command,
            Date.now() - startedAt,
            "failed",
            opts?.selector,
            errorMessage(error),
          ),
        );
        throw error;
      }
    },

    async runScreenshotStep(
      command: string,
      action: () => Promise<Uint8Array>,
      opts?: ScreenshotStepOptions,
    ) {
      const startedAt = Date.now();

      try {
        const screenshot = await action();
        const attachment = await captureStepScreenshot(
          driver,
          artifactConfig,
          flowName,
          platform,
          steps.length + 1,
          opts?.name ?? command,
          screenshot,
        );

        steps.push(
          createStepResult(
            command,
            Date.now() - startedAt,
            "passed",
            opts?.selector,
            undefined,
            attachment ? [attachment] : undefined,
          ),
        );
        return screenshot;
      } catch (error) {
        steps.push(
          createStepResult(
            command,
            Date.now() - startedAt,
            "failed",
            opts?.selector,
            errorMessage(error),
          ),
        );
        throw error;
      }
    },

    getSteps() {
      return steps;
    },
  };
}
