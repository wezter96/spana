import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { flow } from "../api/flow.js";
import { executeFlow } from "./engine.js";
import { createHtmlReporter } from "../report/html.js";
import { launchDirectCdpBrowser, makeLightweightCdpDriver } from "../drivers/cdp-browser.js";
import { buildWebRuntime, resolveWebEngine } from "../runtime/local.js";
import type { FlowPlaybackTrace } from "./video-recorder.js";
import type { ProvConfig } from "../schemas/config.js";

function hasLocalChrome(): boolean {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.some((p) => existsSync(p));
}

function startStaticServer(html: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind server"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const describeWithChrome = hasLocalChrome() ? describe : describe.skip;

describeWithChrome("E2E: Video Playback, Cross-Origin Iframe (OOPIF) & engine: auto", () => {
  it("records live Chromium CDP screencast frames and embeds interactive player in report.html", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "spana-e2e-video-"));
    const appHtml = `<!doctype html><html><body style="background:#0f172a;color:#fff;font-family:sans-serif;padding:40px">
      <h1 data-testid="heading">Spana Video E2E</h1>
      <input data-testid="name-input" placeholder="Your name" />
      <button data-testid="save-btn" onclick="document.querySelector('[data-testid=result]').textContent='Saved: '+document.querySelector('[data-testid=name-input]').value">Save</button>
      <p data-testid="result">Idle</p>
    </body></html>`;

    const { server, port } = await startStaticServer(appHtml);
    const browser = await launchDirectCdpBrowser({ headless: true });
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl: `http://127.0.0.1:${port}`,
        useBrowserContexts: true,
        freshContextPerFlow: true,
      }),
    );

    try {
      const f = flow("video playback e2e", async ({ app, expect: spanaExpect }) => {
        await app.openLink(`http://127.0.0.1:${port}/`);
        await app.fill({ testID: "name-input" }, "Anton");
        await app.tap({ testID: "save-btn" });
        await spanaExpect({ testID: "result" }).toContainText("Saved: Anton");
      });

      const res = await executeFlow(f, driver, {
        appId: `http://127.0.0.1:${port}`,
        platform: "web",
        autoLaunch: false,
        coordinatorConfig: {
          parse: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 } }),
        },
        artifactConfig: {
          outputDir: outDir,
          playback: true,
          video: "on",
        },
      });

      expect(res.status).toBe("passed");
      const pbAtt = res.attachments?.find((a) => a.name === "playback");
      expect(pbAtt).toBeDefined();
      expect(existsSync(pbAtt!.path)).toBe(true);

      const trace = JSON.parse(readFileSync(pbAtt!.path, "utf8")) as FlowPlaybackTrace;
      expect(trace.version).toBe(1);
      expect(trace.frames.length).toBeGreaterThan(0);
      expect(trace.steps.length).toBeGreaterThanOrEqual(3);

      const reporter = createHtmlReporter(outDir);
      reporter.onRunComplete({
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        flaky: 0,
        durationMs: res.durationMs,
        platforms: ["web"],
        results: [res],
      });

      const reportPath = join(outDir, "report.html");
      expect(existsSync(reportPath)).toBe(true);
      const html = readFileSync(reportPath, "utf8");
      expect(html).toContain("Visual playback");
      expect(html).toContain('class="pb-scrubber"');
      expect(html).toContain('class="pb-ripple"');
      expect(html).toContain('data-action="toggle"');
    } finally {
      await driver.domChannel?.disconnect();
      await browser.close();
      await closeServer(server);
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("video: 'retain-on-failure' drops recording on pass and retains playback trace on failure", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "spana-e2e-retain-"));
    const appHtml = `<!doctype html><html><body style="background:#111;color:#fff;padding:40px">
      <button data-testid="ok-btn" onclick="this.textContent='Done'">Click me</button>
    </body></html>`;

    const { server, port } = await startStaticServer(appHtml);
    const browser = await launchDirectCdpBrowser({ headless: true });
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl: `http://127.0.0.1:${port}`,
        useBrowserContexts: true,
        freshContextPerFlow: true,
      }),
    );

    try {
      const passingFlow = flow("retain pass", async ({ app }) => {
        await app.openLink(`http://127.0.0.1:${port}/`);
        await app.tap({ testID: "ok-btn" });
      });

      const passRes = await executeFlow(passingFlow, driver, {
        appId: `http://127.0.0.1:${port}`,
        platform: "web",
        autoLaunch: false,
        coordinatorConfig: {
          parse: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 } }),
        },
        artifactConfig: {
          outputDir: outDir,
          video: "retain-on-failure",
          playback: false,
        },
      });

      expect(passRes.status).toBe("passed");
      expect(passRes.attachments?.find((a) => a.name === "playback")).toBeUndefined();
      expect(passRes.attachments?.find((a) => a.name === "video")).toBeUndefined();

      const failingFlow = flow("retain fail", async ({ app, expect: spanaExpect }) => {
        await app.openLink(`http://127.0.0.1:${port}/`);
        await app.tap({ testID: "ok-btn" });
        await spanaExpect({ testID: "ok-btn" }).toContainText("NEVER_MATCHES", { timeout: 300 });
      });

      const failRes = await executeFlow(failingFlow, driver, {
        appId: `http://127.0.0.1:${port}`,
        platform: "web",
        autoLaunch: false,
        coordinatorConfig: {
          parse: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 } }),
        },
        artifactConfig: {
          outputDir: outDir,
          video: "retain-on-failure",
          playback: false,
        },
      });

      expect(failRes.status).toBe("failed");
      const failPb = failRes.attachments?.find((a) => a.name === "playback");
      expect(failPb).toBeDefined();
      expect(existsSync(failPb!.path)).toBe(true);
    } finally {
      await driver.domChannel?.disconnect();
      await browser.close();
      await closeServer(server);
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("interacts with elements inside a real cross-origin iframe (OOPIF) over Direct CDP", async () => {
    const iframeHtml = `<!doctype html><html><body style="margin:0;padding:16px;background:#1e293b;color:#fff;font-family:sans-serif">
      <input data-testid="oopif-card" placeholder="Card number" />
      <button data-testid="oopif-pay" onclick="document.querySelector('[data-testid=oopif-status]').textContent='Paid:'+document.querySelector('[data-testid=oopif-card]').value">Pay</button>
      <p data-testid="oopif-status">Waiting</p>
    </body></html>`;

    const iframeSrv = await startStaticServer(iframeHtml);
    // Distinct origin: parent uses 127.0.0.1:<hostPort>, iframe uses localhost:<iframePort>
    const hostHtml = `<!doctype html><html><body style="margin:0;padding:80px;background:#020617;color:#fff;font-family:sans-serif">
      <h1 data-testid="checkout-title">Checkout</h1>
      <iframe src="http://localhost:${iframeSrv.port}/" width="420" height="220" style="border:1px solid #334155"></iframe>
    </body></html>`;
    const hostSrv = await startStaticServer(hostHtml);

    const browser = await launchDirectCdpBrowser({ headless: true });
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl: `http://127.0.0.1:${hostSrv.port}`,
        useBrowserContexts: true,
      }),
    );

    try {
      const f = flow("cross origin iframe e2e", async ({ app, expect: spanaExpect }) => {
        await app.openLink(`http://127.0.0.1:${hostSrv.port}/`);
        await spanaExpect({ testID: "checkout-title" }).toBeVisible();
        await app.fill({ testID: "oopif-card" }, "4242-0000");
        await app.tap({ testID: "oopif-pay" });
        await spanaExpect({ testID: "oopif-status" }).toContainText("Paid:4242-0000");
      });

      const res = await executeFlow(f, driver, {
        appId: `http://127.0.0.1:${hostSrv.port}`,
        platform: "web",
        autoLaunch: false,
        coordinatorConfig: {
          parse: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 } }),
        },
      });

      expect(res.status).toBe("passed");
    } finally {
      await driver.domChannel?.disconnect();
      await browser.close();
      await closeServer(hostSrv.server);
      await closeServer(iframeSrv.server);
    }
  }, 30_000);

  it("engine: 'auto' launches Direct CDP via buildWebRuntime and executes a flow end-to-end", async () => {
    const appHtml = `<!doctype html><html><body>
      <h1 data-testid="auto-title">Auto Direct CDP Works</h1>
    </body></html>`;
    const { server, port } = await startStaticServer(appHtml);

    const config: ProvConfig = {
      apps: { web: { url: `http://127.0.0.1:${port}` } },
      execution: {
        web: {
          engine: "auto",
          browser: "chromium",
          headless: true,
        },
      },
    };

    expect(resolveWebEngine(config)).toBe("cdp");
    const { runtime, engineConfig } = await buildWebRuntime(config);
    try {
      const f = flow("auto engine e2e", async ({ expect: spanaExpect }) => {
        await spanaExpect({ testID: "auto-title" }).toContainText("Auto Direct CDP Works");
      });

      const res = await executeFlow(f, runtime.driver, engineConfig);
      expect(res.status).toBe("passed");
    } finally {
      await runtime.cleanup();
      await closeServer(server);
    }
  }, 30_000);
});
