import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRichFlowTrace, renderTraceViewerHtml, writeRichTraceBundle } from "./trace-viewer.js";

describe("Playwright-style interactive Trace Viewer", () => {
  it("builds trace.json and self-contained trace-viewer.html with steps, network, console, errors & DOM", () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-trace-"));
    try {
      const trace = buildRichFlowTrace({
        flowName: "checkout <script>alert(1)</script>",
        platform: "web",
        status: "failed",
        durationMs: 420,
        viewport: { width: 1280, height: 720 },
        steps: [
          { command: "tap", selector: { testID: "buy" }, status: "passed", durationMs: 120 },
          {
            command: "expect.toBeVisible",
            status: "failed",
            durationMs: 300,
            error: "Not visible",
          },
        ],
        consoleLogs: [{ type: "log", text: "Mounted checkout" }],
        jsErrors: [{ name: "TypeError", message: "Cannot read properties of undefined" }],
        liveNetwork: [
          {
            requestId: "1",
            url: "https://api.example.com/pay",
            method: "POST",
            status: 500,
            startedAt: 100,
            finishedAt: 220,
            durationMs: 120,
          },
        ],
        domSnapshot: "<main><button>Buy</button></main>",
        ariaSnapshot: '- main:\n  - button "Buy"',
        error: { message: "Not visible" },
      });

      expect(trace.steps).toHaveLength(2);
      expect(trace.steps[1]?.startedAtMs).toBe(120);
      expect(trace.network).toHaveLength(1);

      const html = renderTraceViewerHtml(trace);
      expect(html).toContain("Spana Trace Viewer");
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");

      const { traceJsonPath, traceViewerHtmlPath } = writeRichTraceBundle(trace, dir);
      expect(existsSync(traceJsonPath)).toBe(true);
      expect(existsSync(traceViewerHtmlPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(traceJsonPath, "utf8"));
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.steps).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
