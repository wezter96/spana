import { afterEach, describe, expect, test } from "bun:test";
import { createJsonReporter } from "./json.js";

const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
});

describe("json reporter", () => {
  test("emits structured flow and run events", () => {
    const reporter = createJsonReporter();
    const output: string[] = [];

    console.log = (...args: unknown[]) => {
      output.push(args.join(" "));
    };

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
      error: { message: "boom" },
    });
    reporter.onRunComplete({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
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
        error: { message: "boom" },
      },
      {
        event: "runComplete",
        total: 2,
        passed: 1,
        failed: 1,
        skipped: 0,
        durationMs: 46,
        platforms: ["web", "ios"],
        results: [],
      },
    ]);
  });
});
