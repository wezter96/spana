import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { Effect } from "effect";
import type { ArtifactConfig as ArtifactConfigInput } from "../schemas/config.js";
import type { Attachment } from "../report/types.js";

export interface ResolvedArtifactConfig {
  outputDir: string;
  captureOnFailure: boolean;
  captureOnSuccess: boolean;
  captureSteps: boolean;
  screenshot: boolean;
  uiHierarchy: boolean;
  consoleLogs: boolean;
  jsErrors: boolean;
  har: boolean;
}

export const DEFAULT_ARTIFACT_CONFIG: ResolvedArtifactConfig = {
  outputDir: "./spana-output",
  captureOnFailure: true,
  captureOnSuccess: false,
  captureSteps: false,
  screenshot: true,
  uiHierarchy: true,
  consoleLogs: true,
  jsErrors: true,
  har: true,
};

function safeName(value: string): string {
  return (
    value
      .replaceAll(/[^a-zA-Z0-9-_]/g, "_")
      .replaceAll(/_+/g, "_")
      .replaceAll(/^_+|_+$/g, "")
      .slice(0, 80) || "artifact"
  );
}

function flowArtifactDir(
  config: ResolvedArtifactConfig,
  flowName: string,
  platform: string,
): string {
  const dir = join(config.outputDir, `${safeName(flowName)}-${platform}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createAttachment(name: string, contentType: string, path: string): Attachment {
  return { name, contentType, path };
}

function writeJsonAttachment(
  dir: string,
  fileName: string,
  attachmentName: string,
  value: unknown,
): Attachment {
  const path = join(dir, fileName);
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
  return createAttachment(attachmentName, "application/json", path);
}

function writeTextAttachment(
  dir: string,
  fileName: string,
  attachmentName: string,
  value: string,
): Attachment {
  const path = join(dir, fileName);
  writeFileSync(path, value, "utf-8");
  return createAttachment(attachmentName, "text/plain", path);
}

export function resolveArtifactConfig(
  ...configs: Array<ArtifactConfigInput | undefined>
): ResolvedArtifactConfig {
  return configs.reduce<ResolvedArtifactConfig>(
    (resolved, config) => ({
      ...resolved,
      ...config,
    }),
    { ...DEFAULT_ARTIFACT_CONFIG },
  );
}

/** Capture artifacts (screenshot + hierarchy) from the current driver state */
export async function captureArtifacts(
  driver: RawDriverService,
  config: ResolvedArtifactConfig,
  flowName: string,
  platform: string,
  status: "passed" | "failed",
): Promise<Attachment[]> {
  const shouldCapture =
    (status === "failed" && config.captureOnFailure) ||
    (status === "passed" && config.captureOnSuccess);

  if (!shouldCapture) return [];

  const attachments: Attachment[] = [];
  const dir = flowArtifactDir(config, flowName, platform);

  if (config.screenshot) {
    try {
      const screenshot = await Effect.runPromise(Effect.orDie(driver.takeScreenshot()));
      const path = join(dir, "screenshot.png");
      writeFileSync(path, screenshot);
      attachments.push(createAttachment(`${status}-screenshot`, "image/png", path));
    } catch {
      // Screenshot capture failed — don't block test execution
    }
  }

  if (config.uiHierarchy) {
    try {
      const hierarchy = await Effect.runPromise(Effect.orDie(driver.dumpHierarchy()));
      const path = join(dir, "hierarchy.json");
      writeFileSync(path, hierarchy, "utf-8");
      attachments.push(createAttachment(`${status}-hierarchy`, "application/json", path));
    } catch {
      // Hierarchy capture failed — don't block test execution
    }
  }

  if (config.consoleLogs && driver.getConsoleLogs) {
    try {
      const consoleLogs = await Effect.runPromise(Effect.orDie(driver.getConsoleLogs()));
      if (consoleLogs.length > 0) {
        attachments.push(
          writeJsonAttachment(dir, "console-logs.json", `${status}-console-logs`, consoleLogs),
        );
      }
    } catch {
      // Console log capture failed — don't block test execution
    }
  }

  if (config.jsErrors && driver.getJSErrors) {
    try {
      const jsErrors = await Effect.runPromise(Effect.orDie(driver.getJSErrors()));
      if (jsErrors.length > 0) {
        attachments.push(
          writeJsonAttachment(dir, "js-errors.json", `${status}-js-errors`, jsErrors),
        );
      }
    } catch {
      // JS error capture failed — don't block test execution
    }
  }

  if (config.har && driver.getHAR) {
    try {
      const har = await Effect.runPromise(Effect.orDie(driver.getHAR()));
      if (har.log.entries.length > 0) {
        attachments.push(writeJsonAttachment(dir, "network.har", `${status}-network-har`, har));
      }
    } catch {
      // HAR capture failed — don't block test execution
    }
  }

  if (status === "failed" && driver.getDriverLogs) {
    try {
      const driverLogs = await Effect.runPromise(Effect.orDie(driver.getDriverLogs()));
      if (driverLogs.length > 0) {
        attachments.push(
          writeTextAttachment(
            dir,
            "driver-logs.txt",
            `${status}-driver-logs`,
            driverLogs.join("\n"),
          ),
        );
      }
    } catch {
      // Driver log capture failed — don't block test execution
    }
  }

  return attachments;
}

export async function captureStepScreenshot(
  driver: RawDriverService,
  config: ResolvedArtifactConfig,
  flowName: string,
  platform: string,
  stepIndex: number,
  stepName: string,
  screenshot?: Uint8Array,
): Promise<Attachment | undefined> {
  if (!config.screenshot) return undefined;

  try {
    const dir = join(flowArtifactDir(config, flowName, platform), "steps");
    mkdirSync(dir, { recursive: true });
    const fileName = `${String(stepIndex).padStart(3, "0")}-${safeName(stepName)}.png`;
    const path = join(dir, fileName);
    const bytes = screenshot ?? (await Effect.runPromise(Effect.orDie(driver.takeScreenshot())));
    writeFileSync(path, bytes);
    return createAttachment(stepName, "image/png", path);
  } catch {
    return undefined;
  }
}
