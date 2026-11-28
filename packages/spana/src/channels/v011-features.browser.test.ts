import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import { allocateFreePort } from "../core/port-allocator.js";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "../drivers/cdp-browser.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import {
  buildComponentTreeScript,
  buildPerformanceProfileScript,
  type ComponentTreeReport,
  type PerformanceProfileReport,
} from "../diagnostics/live-inspector.js";

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Spana v0.11 Parity Test</title>
<style>
  .highlight { color: rgb(255, 0, 0); }
  #drag-source { width: 80px; height: 40px; background: #3b82f6; color: #fff; user-select: none; }
  #drag-target { width: 120px; height: 60px; background: #10b981; color: #fff; margin-top: 20px; }
</style>
</head>
<body>
  <h1 data-testid="heading" class="title highlight">Welcome</h1>
  <input data-testid="name-input" type="text" value="initial" />
  <input data-testid="readonly-input" type="text" readonly value="locked" />
  <input data-testid="agree-box" type="checkbox" />
  <select data-testid="plan-select">
    <option value="free">Free Plan</option>
    <option value="pro">Pro Plan</option>
    <option value="enterprise">Enterprise</option>
  </select>
  <div id="drag-source" data-testid="drag-src">Drag me</div>
  <div id="drag-target" data-testid="drag-dst">Drop here</div>
  <div data-testid="drag-status">idle</div>

  <button data-testid="prompt-btn" onclick="document.querySelector('[data-testid=dialog-out]').textContent = String(window.prompt('Enter code:', 'default'))">Prompt</button>
  <div data-testid="dialog-out"></div>

  <a data-testid="download-link" href="/download" download="report.txt">Download Report</a>
  <my-widget data-testid="custom-widget"></my-widget>

  <script>
    let dragging = false;
    const src = document.getElementById("drag-source");
    const dst = document.getElementById("drag-target");
    const status = document.querySelector("[data-testid=drag-status]");
    src.addEventListener("mousedown", () => { dragging = true; });
    dst.addEventListener("mouseup", () => { if (dragging) { dragging = false; status.textContent = "dropped"; } });
    window.addEventListener("mouseup", () => { dragging = false; });
  </script>
</body>
</html>`;

describe("v0.11 competitive-parity features in real headless Chromium (Direct CDP)", () => {
  let server: Server;
  let baseUrl = "";
  let browser: DirectCdpBrowserHandle;

  beforeAll(async () => {
    const port = await allocateFreePort(18600);
    server = createServer((req, res) => {
      if (req.url === "/download") {
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        res.end("spana-download-payload-42");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(TEST_PAGE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${port}`;
    browser = await launchDirectCdpBrowser({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("supports form/pointer actions, new matchers, viewport/emulation, dialogs, clipboard, downloads & live profilers", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
      }),
    );
    const coordConfig = {
      parse: parseWebHierarchy,
      defaults: { timeout: 5_000, pollInterval: 50 },
    };
    const app = createPromiseApp(driver, baseUrl, coordConfig, undefined, { platform: "web" });
    const appExpect = createPromiseExpect(driver, coordConfig);

    try {
      await app.launch();

      // #2: expect.toHaveTitle + matchers + form & pointer actions
      await appExpect.toHaveTitle("Spana v0.11 Parity Test");
      await appExpect.toHaveTitle(/Parity Test/);
      await appExpect.not.toHaveTitle("Wrong Title");

      await appExpect({ testID: "heading" }).toHaveClass("highlight");
      await appExpect({ testID: "heading" }).toHaveCSS("color", "rgb(255, 0, 0)");

      await appExpect({ testID: "name-input" }).toBeEditable();
      await appExpect({ testID: "readonly-input" }).not.toBeEditable();
      await appExpect({ testID: "name-input" }).not.toBeEmpty();
      await app.clear({ testID: "name-input" });
      await appExpect({ testID: "name-input" }).toBeEmpty();

      await app.focus({ testID: "name-input" });
      const activeTestId = await app.evaluate<string | null>(
        "document.activeElement?.getAttribute('data-testid') ?? null",
      );
      expect(activeTestId).toBe("name-input");

      await appExpect({ testID: "agree-box" }).not.toBeChecked();
      await app.check({ testID: "agree-box" });
      await appExpect({ testID: "agree-box" }).toBeChecked();
      await app.uncheck({ testID: "agree-box" });
      await appExpect({ testID: "agree-box" }).not.toBeChecked();

      const selected = await app.selectOption({ testID: "plan-select" }, { label: "Pro Plan" });
      expect(selected).toEqual(["pro"]);
      await appExpect({ testID: "plan-select" }).toHaveValue("pro");

      await app.dragTo({ testID: "drag-src" }, { testID: "drag-dst" });
      await appExpect({ testID: "drag-status" }).toHaveText("dropped");

      // #3: Viewport, Emulation, and custom Dialogs
      await app.setViewport({ width: 900, height: 640 });
      const vp = await app.evaluate<{ w: number; h: number }>(
        "({ w: window.innerWidth, h: window.innerHeight })",
      );
      expect(vp).toEqual({ w: 900, h: 640 });

      await app.setEmulation({ colorScheme: "dark", reducedMotion: "reduce" });
      const media = await app.evaluate<{ dark: boolean; reduced: boolean }>(
        "({ dark: matchMedia('(prefers-color-scheme: dark)').matches, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })",
      );
      expect(media).toEqual({ dark: true, reduced: true });

      const seenDialogs: string[] = [];
      await app.onDialog(async (dialog) => {
        seenDialogs.push(`${dialog.type}:${dialog.message}`);
        await dialog.accept("SECRET-99");
      });
      await app.tap({ testID: "prompt-btn" });
      await appExpect({ testID: "dialog-out" }).toHaveText("SECRET-99");
      expect(seenDialogs).toEqual(["prompt:Enter code:"]);
      await app.onDialog(null);

      // #9: Clipboard & waitForDownload
      await app.setClipboard("hello-spana-clipboard");
      expect(await app.getClipboard()).toBe("hello-spana-clipboard");

      const dl = await app.waitForDownload(() => app.tap({ testID: "download-link" }));
      expect(dl.suggestedFilename).toBe("report.txt");
      expect(await dl.text()).toBe("spana-download-payload-42");

      // #6: Argent-inspired live component tree + performance profiler
      const tree = await app.evaluate<ComponentTreeReport>(buildComponentTreeScript());
      expect(tree.detectedFrameworks).toContain("web-component");
      expect(tree.roots.some((r) => r.name === "my-widget")).toBe(true);

      const profile = await app.evaluate<PerformanceProfileReport>(buildPerformanceProfileScript());
      expect(profile.url).toContain("127.0.0.1");
      expect(profile.domNodeCount).toBeGreaterThan(5);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });
});
