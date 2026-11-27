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

    expect(
      logs.some(
        (line) => line.includes("✓") && line.includes("Home flow") && line.includes("(120ms)"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("↳ failed-screenshot: /tmp/screenshot.png"))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes("↳ step 1 tap: /tmp/step.png"))).toBe(true);
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
          error: { message: "android boom", category: "element-not-visible" },
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
    expect(logs.some((line) => line.includes("Android fail"))).toBe(true);
    expect(logs.some((line) => line.includes("Category: element-not-visible"))).toBe(true);
    expect(logs.some((line) => line.includes("android boom"))).toBe(true);
    expect(logs.some((line) => line.includes("iOS fail"))).toBe(true);
    expect(logs.some((line) => line.includes("1/3 passed, 2 failed (3.5s)"))).toBe(true);
  });

  test("prefixes output with worker name in parallel mode", () => {
    const reporter = createConsoleReporter();

    reporter.onFlowStart?.("Login flow", "android", "Pixel 8");
    reporter.onFlowPass?.({
      name: "Login flow",
      platform: "android",
      status: "passed",
      durationMs: 1234,
      workerName: "Pixel 8",
    });

    expect(logs.some((line) => line.includes("[Pixel 8]") && line.includes("Login flow"))).toBe(
      true,
    );
  });

  test("omits worker prefix when workerName is absent", () => {
    const reporter = createConsoleReporter();

    reporter.onFlowStart?.("Login flow", "android");
    reporter.onFlowPass?.({
      name: "Login flow",
      platform: "android",
      status: "passed",
      durationMs: 1234,
    });

    const passLine = logs.find((line) => line.includes("Login flow") && line.includes("✓"));
    expect(passLine).toBeDefined();
    expect(passLine!.includes("[Pixel 8]")).toBe(false);
    // Should not have any bracket-prefixed device name between ✓ and flow name
    expect(passLine!).not.toMatch(/✓.*\[(?!0|1|2|3|4|5|6|7|8|9)\w/);
  });

  test("prints worker stats in summary when workerStats present", () => {
    const reporter = createConsoleReporter();

    const workerStats = new Map<string, { flowCount: number; totalMs: number }>();
    workerStats.set("Pixel 8", { flowCount: 5, totalMs: 12300 });
    workerStats.set("iPhone 15", { flowCount: 3, totalMs: 8700 });

    reporter.onRunComplete({
      total: 8,
      passed: 8,
      failed: 0,
      skipped: 0,
      flaky: 0,
      durationMs: 12300,
      platforms: ["android", "ios"],
      results: [
        { name: "Flow A", platform: "android", status: "passed", durationMs: 1000 },
        { name: "Flow B", platform: "ios", status: "passed", durationMs: 2000 },
      ],
      workerStats,
    });

    expect(logs.some((line) => line.includes("Worker Stats"))).toBe(true);
    expect(logs.some((line) => line.includes("Pixel 8") && line.includes("5 flows"))).toBe(true);
    expect(logs.some((line) => line.includes("iPhone 15") && line.includes("3 flows"))).toBe(true);
  });

  test("shows per-platform progress when platformFlowCounts is set", () => {
    const reporter = createConsoleReporter();
    reporter.platformFlowCounts = { web: 2, android: 3 };

    reporter.onFlowPass?.({
      name: "Flow A",
      platform: "web",
      status: "passed",
      durationMs: 100,
    });

    reporter.onFlowPass?.({
      name: "Flow B",
      platform: "android",
      status: "passed",
      durationMs: 200,
    });

    const progressLines = logs.filter((line) => line.includes("✓"));
    expect(progressLines.length).toBe(2);
    expect(progressLines[0]).toContain("[1/2");
    expect(progressLines[1]).toContain("[1/3");
  });

  test("prints selector warnings after flow results", () => {
    const reporter = createConsoleReporter();

    reporter.onFlowPass?.({
      name: "Tappy flow",
      platform: "web",
      status: "passed",
      durationMs: 100,
      steps: [
        { command: "tapXY", status: "passed", durationMs: 50 },
        { command: "tap", selector: { testID: "btn" }, status: "passed", durationMs: 50 },
      ],
    });

    expect(logs.some((line) => line.includes("coordinate tap"))).toBe(true);
  });

  test("suppresses selector warnings in quiet mode", () => {
    const reporter = createConsoleReporter({ quiet: true });

    reporter.onFlowPass?.({
      name: "Tappy flow",
      platform: "web",
      status: "passed",
      durationMs: 100,
      steps: [{ command: "tapXY", status: "passed", durationMs: 50 }],
    });

    expect(logs.some((line) => line.includes("coordinate tap"))).toBe(false);
  });

  test("quiet mode suppresses pass output but shows failures", () => {
    const reporter = createConsoleReporter({ quiet: true });

    reporter.onFlowPass?.({
      name: "Passing flow",
      platform: "web",
      status: "passed",
      durationMs: 100,
    });

    reporter.onFlowFail?.({
      name: "Failing flow",
      platform: "android",
      status: "failed",
      durationMs: 200,
      error: { message: "boom", category: "unknown" },
    });

    // Pass output suppressed
    expect(logs.some((line) => line.includes("Passing flow"))).toBe(false);
    // Fail output shown
    expect(logs.some((line) => line.includes("Failing flow"))).toBe(true);
  });

  test("uses true elapsed wall time for platform summary bar and prints skipped flows cleanly", () => {
    const reporter = createConsoleReporter({ webEngine: "cdp" });

    reporter.onFlowSkip?.({
      name: "Conditional feature",
      platform: "web",
      status: "skipped",
      durationMs: 12,
      skipReason: "disabled in staging",
    });

    reporter.onRunComplete({
      total: 3,
      passed: 2,
      failed: 0,
      skipped: 1,
      flaky: 0,
      durationMs: 6200,
      platformDurations: { web: 6200 },
      platforms: ["web"],
      results: [
        { name: "Flow 1", platform: "web", status: "passed", durationMs: 3000 },
        { name: "Flow 2", platform: "web", status: "passed", durationMs: 3100 },
        {
          name: "Conditional feature",
          platform: "web",
          status: "skipped",
          durationMs: 12,
          skipReason: "disabled in staging",
        },
      ],
    });

    expect(
      logs.some(
        (line) =>
          line.includes("–") &&
          line.includes("Conditional feature") &&
          line.includes("disabled in staging"),
      ),
    ).toBe(true);
    // Platform bar MUST show true elapsed 6.2s (not Math.max 3.1s) and label web (Direct CDP)
    expect(logs.some((line) => line.includes("web (Direct CDP)") && line.includes("(6.2s)"))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes("2/3 passed, 0 failed, 1 skipped (6.2s)"))).toBe(true);
  });
});
