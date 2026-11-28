import { describe, expect, test } from "bun:test";
import { createJsonReporter } from "./json.js";

describe("json reporter", () => {
  test("emits structured flow and run events", () => {
    const output: string[] = [];
    const reporter = createJsonReporter(undefined, {
      write: (line) => {
        output.push(line);
      },
    });

    reporter.onFlowPass?.({
      name: "flow",
      platform: "web",
      status: "passed",
      durationMs: 12,
    });
    reporter.onFlowFail?.({
      name: "broken",
      platform: "ios",
      status: "failed",
      durationMs: 34,
      error: { message: "boom", category: "unknown" },
    });
    reporter.onRunComplete({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
      durationMs: 46,
      platforms: ["web", "ios"],
      results: [],
    });

    expect(output.map((line) => JSON.parse(line))).toEqual([
      { event: "flowPass", name: "flow", platform: "web", status: "passed", durationMs: 12 },
      {
        event: "flowFail",
        name: "broken",
        platform: "ios",
        status: "failed",
        durationMs: 34,
        error: { message: "boom", category: "unknown" },
      },
      {
        event: "runComplete",
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        flaky: 0,
        durationMs: 46,
        platforms: ["web", "ios"],
        results: [],
      },
    ]);
  });
});
