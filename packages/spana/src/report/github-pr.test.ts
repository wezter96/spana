import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { createGitHubPrReporter, formatGitHubPrMarkdown } from "./github-pr.js";
import { createFailureBundle } from "./failure-bundle.js";
import { compareScreenshots } from "../core/screenshot-compare.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("GitHub PR reporter, inline failure diagnostics, and layout-tolerant screenshot diff", () => {
  test("formatGitHubPrMarkdown & createGitHubPrReporter emit PR summary with filter savings and failure details", () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-gh-pr-"));
    tempDirs.push(dir);

    const summary = {
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      flaky: 0,
      durationMs: 2450,
      platforms: ["web" as const, "ios" as const],
      results: [
        {
          name: "sign-in",
          platform: "web" as const,
          status: "passed" as const,
          durationMs: 450,
          steps: [],
        },
        {
          name: "checkout",
          platform: "ios" as const,
          status: "failed" as const,
          durationMs: 2000,
          steps: [],
          error: {
            message: "Element not found: pay-btn",
            category: "element-not-found" as const,
            suggestion: "Add data-testid='pay-btn'",
          },
        },
      ],
    };

    const md = formatGitHubPrMarkdown(summary, ["decision kept 2 of 20 flows, left out 18"]);
    expect(md).toContain("Spana E2E — 1 flow(s) failed");
    expect(md).toContain("decision kept 2 of 20 flows, left out 18");
    expect(md).toContain("Element not found: pay-btn");

    const reporter = createGitHubPrReporter({
      outputDir: dir,
      filterSummaries: ["decision kept 2 of 20 flows, left out 18"],
      writeStepSummary: false,
    });
    reporter.onRunComplete(summary);
    const writtenPath = join(dir, "github-pr-summary.md");
    expect(existsSync(writtenPath)).toBe(true);
    expect(readFileSync(writtenPath, "utf-8")).toContain("Platform Breakdown");
  });

  test("createFailureBundle inlines runtimeDiagnostics from console-logs.json and js-errors.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-bundle-diag-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "console-logs.json"),
      JSON.stringify([
        { type: "warning", text: "deprecated prop" },
        { type: "error", text: "POST /api/orders 500" },
      ]),
    );
    writeFileSync(
      join(dir, "js-errors.json"),
      JSON.stringify([{ message: "ReferenceError: cart is not defined" }]),
    );

    const bundle = createFailureBundle(
      "checkout",
      "web",
      [
        {
          command: "tap",
          selector: { testID: "pay" },
          status: "failed",
          durationMs: 50,
          error: "missing",
        },
      ],
      { message: "missing", category: "element-not-found" },
      dir,
    );

    expect(bundle.runtimeDiagnostics).toEqual({
      consoleErrorCount: 1,
      consoleWarnCount: 1,
      recentConsoleErrors: ["POST /api/orders 500"],
      jsErrorCount: 1,
      recentJsErrors: ["ReferenceError: cart is not defined"],
    });
  });

  test("compareScreenshots layout-tolerant mode ignores subtle subpixel shifts but catches real layout diffs", () => {
    const base = makeSolidPng(16, 16, 200, 200, 200);
    const slightShift = makeSolidPng(16, 16, 205, 205, 205);
    const bigChange = makeSolidPng(16, 16, 40, 40, 40);

    const tolerantPass = compareScreenshots(base, slightShift, { mode: "layout-tolerant" });
    expect(tolerantPass.match).toBe(true);
    expect(tolerantPass.mode).toBe("layout-tolerant");

    const tolerantFail = compareScreenshots(base, bigChange, { mode: "layout-tolerant" });
    expect(tolerantFail.match).toBe(false);
    expect(tolerantFail.diffImage).toBeDefined();
  });
});
