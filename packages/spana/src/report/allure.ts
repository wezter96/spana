import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Reporter, FlowResult, StepResult } from "./types.js";

function historyId(name: string, platform: string): string {
  return createHash("md5").update(`${name}:${platform}`).digest("hex");
}

function allureStatus(status: string): string {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "broken";
}

function mapSteps(steps: StepResult[], startTime: number): unknown[] {
  let time = startTime;
  return steps.map((step) => {
    const stepStart = time;
    const stepStop = time + step.durationMs;
    time = stepStop;
    return {
      name: step.selector ? `${step.command} ${JSON.stringify(step.selector)}` : step.command,
      status: allureStatus(step.status),
      start: stepStart,
      stop: stepStop,
      steps: [],
      ...(step.error ? { statusDetails: { message: step.error } } : {}),
    };
  });
}

function copyAttachments(result: FlowResult, outputDir: string): unknown[] {
  const allureAttachments: unknown[] = [];

  // Flow-level attachments
  for (const att of result.attachments ?? []) {
    if (att.path && existsSync(att.path)) {
      const ext = att.contentType === "image/png" ? ".png" : ".json";
      const filename = `${randomUUID()}-attachment${ext}`;
      copyFileSync(att.path, join(outputDir, filename));
      allureAttachments.push({
        name: att.name,
        source: filename,
        type: att.contentType,
      });
    }
  }

  // Step-level attachments
  for (const step of result.steps ?? []) {
    for (const att of step.attachments ?? []) {
      if (att.path && existsSync(att.path)) {
        const ext = att.contentType === "image/png" ? ".png" : ".json";
        const filename = `${randomUUID()}-attachment${ext}`;
        copyFileSync(att.path, join(outputDir, filename));
        allureAttachments.push({
          name: att.name,
          source: filename,
          type: att.contentType,
        });
      }
    }
  }

  return allureAttachments;
}

function writeResult(result: FlowResult, outputDir: string): void {
  const uuid = randomUUID();
  const now = Date.now();
  const startTime = now - result.durationMs;

  const labels: { name: string; value: string }[] = [
    { name: "suite", value: result.platform },
    { name: "framework", value: "spana" },
  ];

  if (result.flaky) {
    labels.push({ name: "tag", value: "flaky" });
  }

  const allureResult: Record<string, unknown> = {
    uuid,
    historyId: historyId(result.name, result.platform),
    name: result.name,
    fullName: `[${result.platform}] ${result.name}`,
    status: result.flaky ? "passed" : allureStatus(result.status),
    stage: "finished",
    start: startTime,
    stop: now,
    labels,
    steps: result.steps ? mapSteps(result.steps, startTime) : [],
    attachments: copyAttachments(result, outputDir),
  };

  if (result.error) {
    allureResult.statusDetails = {
      message: result.error.message,
      trace: result.error.stack,
    };
  } else if (result.flaky) {
    allureResult.statusDetails = {
      message: `Flaky: passed on attempt ${result.attempts}`,
    };
  }

  writeFileSync(join(outputDir, `${uuid}-result.json`), JSON.stringify(allureResult, null, 2));
}

export function createAllureReporter(outputDir: string = "allure-results"): Reporter {
  mkdirSync(outputDir, { recursive: true });

  return {
    onFlowPass(result: FlowResult) {
      writeResult(result, outputDir);
    },

    onFlowFail(result: FlowResult) {
      writeResult(result, outputDir);
    },

    onRunComplete(summary) {
      const envContent = [
        `Platform=${summary.platforms.join(", ")}`,
        `Framework=spana`,
        `Total=${summary.total}`,
        `Passed=${summary.passed}`,
        `Failed=${summary.failed}`,
      ].join("\n");
      writeFileSync(join(outputDir, "environment.properties"), envContent);

      console.log(`Allure results written to ${outputDir}/`);
      console.log(`Run: npx allure generate ${outputDir} --clean -o allure-report`);
    },
  };
}
