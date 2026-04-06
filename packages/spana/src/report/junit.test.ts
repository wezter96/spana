import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJUnitReporter } from "./junit.js";

const outputDir = mkdtempSync(join(tmpdir(), "spana-junit-"));
const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
});

afterAll(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

describe("junit reporter", () => {
  test("writes escaped xml with attachments and step output", () => {
    const reporter = createJUnitReporter(outputDir);
    const logs: string[] = [];

    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    reporter.onRunComplete({
      total: 2,
      passed: 0,
      failed: 1,
      skipped: 1,
      flaky: 0,
      durationMs: 1500,
      platforms: ["web", "ios"],
      results: [
        {
          name: "broken <flow>",
          platform: "web",
          status: "failed",
          durationMs: 1000,
          error: { message: 'boom & "bust"', stack: "line <1>", category: "unknown" },
          attachments: [{ name: "shot", contentType: "image/png", path: "/tmp/shot.png" }],
          steps: [
            {
              command: "tap",
              status: "failed",
              durationMs: 50,
              selector: { testID: "login" },
              error: "missing",
            },
          ],
        },
        {
          name: "skipped",
          platform: "ios",
          status: "skipped",
          durationMs: 500,
        },
      ],
    });

    const reportPath = join(outputDir, "junit-report.xml");
    const xml = readFileSync(reportPath, "utf8");

    expect(logs[0]).toBe(`JUnit report written to ${reportPath}`);
    expect(xml).toContain('name="broken &lt;flow&gt;"');
    expect(xml).toContain('<failure message="boom &amp; &quot;bust&quot;">');
    expect(xml).toContain("<skipped/>");
    expect(xml).toContain("attachment shot (image/png): /tmp/shot.png");
    expect(xml).toContain("selector={&quot;testID&quot;:&quot;login&quot;}");
  });
});
