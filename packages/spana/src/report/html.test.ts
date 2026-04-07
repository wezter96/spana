import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHtmlReporter } from "./html.js";
import type { RunSummary } from "./types.js";

const createdDirs: string[] = [];
const originalConsoleLog = console.log;

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-html-report-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  console.log = originalConsoleLog;
});

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createHtmlReporter", () => {
  test("writes an escaped HTML report with embedded screenshots", () => {
    const outputDir = createTempDir();
    const screenshotDir = createTempDir();
    const finalScreenshot = join(screenshotDir, "final.png");
    const stepScreenshot = join(screenshotDir, "step.png");
    const consoleLogsPath = join(screenshotDir, "console-logs.json");
    const jsErrorsPath = join(screenshotDir, "js-errors.json");
    const logs: string[] = [];

    writeFileSync(finalScreenshot, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    writeFileSync(stepScreenshot, Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    writeFileSync(consoleLogsPath, JSON.stringify([{ type: "info", text: 'ready <ok> & "quoted"' }]));
    writeFileSync(jsErrorsPath, JSON.stringify([{ name: "Error", message: 'boom <bad> & "worse"' }]));
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    const reporter = createHtmlReporter(outputDir);
    const summary: RunSummary = {
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      flaky: 0,
      durationMs: 1_234,
      platforms: ["web"],
      results: [
        {
          name: 'Checkout <danger> & "quotes"',
          platform: "web",
          status: "failed",
          durationMs: 321,
          error: { message: 'boom <bad> & "worse"', category: "unknown" },
          attachments: [
            { name: "failed-screenshot", contentType: "image/png", path: finalScreenshot },
            { name: "failed-console-logs", contentType: "application/json", path: consoleLogsPath },
            { name: "failed-js-errors", contentType: "application/json", path: jsErrorsPath },
          ],
          steps: [
            {
              command: 'tap <cta> & "confirm"',
              status: "failed",
              durationMs: 12,
              selector: { text: "<Save>" },
              attachments: [{ name: "step-shot", contentType: "image/png", path: stepScreenshot }],
            },
          ],
        },
      ],
    };

    reporter.onRunComplete(summary);

    const html = readFileSync(join(outputDir, "report.html"), "utf8");
    expect(html).toContain("spana test report");
    expect(html).toContain("Checkout &lt;danger&gt; &amp; &quot;quotes&quot;");
    expect(html).toContain("boom &lt;bad&gt; &amp; &quot;worse&quot;");
    expect(html).toContain("tap &lt;cta&gt; &amp; &quot;confirm&quot;");
    expect(html).toContain("&lt;Save&gt;");
    expect(html).toContain("Playwright");
    expect(html).toContain("data:image/png;base64,3q2+7w==");
    expect(html).toContain("data:image/png;base64,yv66vg==");
    expect(html).toContain("Web diagnostics");
    expect(html).toContain("Console logs");
    expect(html).toContain("ready &lt;ok&gt; &amp; \\&quot;quoted\\&quot;");
    expect(html).toContain("JavaScript errors");
    expect(html).toContain("boom &lt;bad&gt; &amp; \\&quot;worse\\&quot;");
    expect(logs[0]).toContain(join(outputDir, "report.html"));
  });

  test("omits screenshot sections when files are missing", () => {
    const outputDir = createTempDir();
    const reporter = createHtmlReporter(outputDir);

    reporter.onRunComplete({
      total: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
      flaky: 0,
      durationMs: 500,
      platforms: ["android", "ios"],
      results: [
        {
          name: "Android smoke",
          platform: "android",
          status: "passed",
          durationMs: 100,
          attachments: [
            {
              name: "failed-screenshot",
              contentType: "image/png",
              path: join(outputDir, "missing.png"),
            },
          ],
        },
        {
          name: "iOS skip",
          platform: "ios",
          status: "skipped",
          durationMs: 50,
        },
      ],
    });

    const html = readFileSync(join(outputDir, "report.html"), "utf8");
    expect(html).toContain("<title>spana &mdash; 2 flows</title>");
    expect(html).not.toContain("Final state");
    expect(html).not.toContain("Step screenshots");
  });
});
