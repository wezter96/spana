import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAllureReporter } from "./allure.js";
import type { FlowResult, RunSummary } from "./types.js";

function makeFlowResult(overrides: Partial<FlowResult> = {}): FlowResult {
  return {
    name: "Login flow",
    platform: "web",
    status: "passed",
    durationMs: 5000,
    steps: [
      { command: "tap", selector: { testID: "login" }, status: "passed", durationMs: 300 },
      {
        command: "assertVisible",
        selector: { text: "Welcome" },
        status: "passed",
        durationMs: 200,
      },
    ],
    ...overrides,
  };
}

function makeSummary(results: FlowResult[]): RunSummary {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: 0,
    flaky: 0,
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    results,
    platforms: ["web"],
  };
}

describe("Allure reporter", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync("/tmp/spana-allure-test-");
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it("creates the output directory", () => {
    const nested = join(outputDir, "nested", "allure-results");
    createAllureReporter(nested);
    const files = readdirSync(nested);
    expect(files).toBeDefined();
  });

  it("writes a result file on onFlowPass with correct structure", () => {
    const reporter = createAllureReporter(outputDir);
    const result = makeFlowResult();
    reporter.onFlowPass!(result);

    const files = readdirSync(outputDir).filter((f) => f.endsWith("-result.json"));
    expect(files).toHaveLength(1);

    const content = JSON.parse(readFileSync(join(outputDir, files[0]!), "utf-8"));
    expect(content.uuid).toBeDefined();
    expect(content.historyId).toBeDefined();
    expect(content.name).toBe("Login flow");
    expect(content.fullName).toBe("[web] Login flow");
    expect(content.status).toBe("passed");
    expect(content.stage).toBe("finished");
    expect(content.start).toBeLessThanOrEqual(content.stop);
    expect(content.labels).toEqual(
      expect.arrayContaining([
        { name: "suite", value: "web" },
        { name: "framework", value: "spana" },
      ]),
    );
    expect(content.steps).toHaveLength(2);
    expect(content.steps[0].name).toBe('tap {"testID":"login"}');
    expect(content.steps[0].status).toBe("passed");
    expect(content.steps[1].name).toBe('assertVisible {"text":"Welcome"}');
  });

  it("includes error details on onFlowFail", () => {
    const reporter = createAllureReporter(outputDir);
    const result = makeFlowResult({
      status: "failed",
      error: { message: "Element not found", stack: "Error: Element not found\n    at test.ts:10" },
    });
    reporter.onFlowFail!(result);

    const files = readdirSync(outputDir).filter((f) => f.endsWith("-result.json"));
    expect(files).toHaveLength(1);

    const content = JSON.parse(readFileSync(join(outputDir, files[0]!), "utf-8"));
    expect(content.status).toBe("failed");
    expect(content.statusDetails).toBeDefined();
    expect(content.statusDetails.message).toBe("Element not found");
    expect(content.statusDetails.trace).toContain("test.ts:10");
  });

  it("marks flaky tests as passed with flaky tag", () => {
    const reporter = createAllureReporter(outputDir);
    const result = makeFlowResult({
      status: "passed",
      flaky: true,
      attempts: 3,
    });
    reporter.onFlowPass!(result);

    const files = readdirSync(outputDir).filter((f) => f.endsWith("-result.json"));
    const content = JSON.parse(readFileSync(join(outputDir, files[0]!), "utf-8"));
    expect(content.status).toBe("passed");
    expect(content.statusDetails.message).toContain("Flaky");
    expect(content.labels).toEqual(expect.arrayContaining([{ name: "tag", value: "flaky" }]));
  });

  it("copies attachments into allure output directory", () => {
    const reporter = createAllureReporter(outputDir);
    // Create a fake screenshot file
    const fakePng = join(outputDir, "screenshot.png");
    writeFileSync(fakePng, "fake-png-data");

    const result = makeFlowResult({
      attachments: [{ name: "screenshot", contentType: "image/png", path: fakePng }],
    });
    reporter.onFlowPass!(result);

    const attachmentFiles = readdirSync(outputDir).filter((f) => f.endsWith("-attachment.png"));
    expect(attachmentFiles).toHaveLength(1);

    const resultFiles = readdirSync(outputDir).filter((f) => f.endsWith("-result.json"));
    const content = JSON.parse(readFileSync(join(outputDir, resultFiles[0]!), "utf-8"));
    expect(content.attachments).toHaveLength(1);
    expect(content.attachments[0].name).toBe("screenshot");
    expect(content.attachments[0].type).toBe("image/png");
    expect(content.attachments[0].source).toMatch(/-attachment\.png$/);
  });

  it("writes environment.properties on onRunComplete", () => {
    const reporter = createAllureReporter(outputDir);
    const results = [makeFlowResult()];
    reporter.onRunComplete(makeSummary(results));

    const envPath = join(outputDir, "environment.properties");
    const content = readFileSync(envPath, "utf-8");
    expect(content).toContain("Platform=web");
    expect(content).toContain("Framework=spana");
    expect(content).toContain("Total=1");
    expect(content).toContain("Passed=1");
    expect(content).toContain("Failed=0");
  });
});
