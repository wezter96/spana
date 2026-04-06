import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createConsoleReporter } from "./console.js";

const originalLog = console.log;
const logs: string[] = [];

beforeEach(() => {
  logs.length = 0;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
});

describe("console reporter", () => {
  test("prints flow results and nested step attachments", () => {
    const reporter = createConsoleReporter();

    reporter.onFlowPass?.({
      name: "Home flow",
      platform: "web",
      status: "passed",
      durationMs: 120,
      attachments: [
        {
          name: "failed-screenshot",
          contentType: "image/png",
          path: "/tmp/screenshot.png",
        },
      ],
      steps: [
        {
          command: "tap",
          status: "passed",
          durationMs: 20,
          attachments: [
            {
              name: "tap",
              contentType: "image/png",
              path: "/tmp/step.png",
            },
          ],
        },
      ],
    });

    expect(logs).toEqual([
      "  ✓ [web] Home flow (120ms)",
      "    ↳ failed-screenshot: /tmp/screenshot.png",
      "    ↳ step 1 tap: /tmp/step.png",
    ]);
  });

  test("groups summaries by platform and prints failures", () => {
    const reporter = createConsoleReporter();

    reporter.onRunComplete({
      total: 3,
      passed: 1,
      failed: 2,
      skipped: 0,
      flaky: 0,
      durationMs: 3456,
      platforms: ["android", "ios"],
      results: [
        {
          name: "Android pass",
          platform: "android",
          status: "passed",
          durationMs: 1500,
        },
        {
          name: "Android fail",
          platform: "android",
          status: "failed",
          durationMs: 900,
          error: { message: "android boom", category: "unknown" },
        },
        {
          name: "iOS fail",
          platform: "ios",
          status: "failed",
          durationMs: 2100,
          error: { message: "ios boom", category: "unknown" },
        },
      ],
    });

    expect(logs.some((line) => line.includes("android (UiAutomator2)"))).toBe(true);
    expect(logs.some((line) => line.includes("ios (WebDriverAgent)"))).toBe(true);
    expect(logs.some((line) => line.includes("--- Failures ---"))).toBe(true);
    expect(logs.some((line) => line.includes("✗ [android] Android fail"))).toBe(true);
    expect(logs.some((line) => line.includes("android boom"))).toBe(true);
    expect(logs.some((line) => line.includes("✗ [ios] iOS fail"))).toBe(true);
    expect(logs.some((line) => line.includes("1/3 passed, 2 failed (3.5s)"))).toBe(true);
  });
});
