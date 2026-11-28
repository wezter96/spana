import { afterAll, beforeAll, describe, expect as bunExpect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { PNG } from "pngjs";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { byRole } from "../index.js";
import { applyMask, parseMaskColor } from "../core/screenshot-compare.js";
import { parseWebHierarchy } from "./playwright-parser.js";
import { findElements } from "../smart/element-matcher.js";
import { waitForElement } from "../smart/auto-wait.js";
import type { RawDriverService } from "./raw-driver.js";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  mapPermissionToCdpDescriptor,
  mapPermissionToCdpGrantName,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";

const describeBrowser = process.env["SPANA_SKIP_BROWSER_TESTS"] ? describe.skip : describe;

describeBrowser("v0.18.0 feedback fixes (Direct CDP)", () => {
  let server: Server;
  let baseUrl = "";
  let browserHandle: DirectCdpBrowserHandle | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/aria-and-inert") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <div aria-hidden="true" data-testid="modal-bg">
            <button type="button" data-testid="bg-btn" onclick="window.__bgClicked = (window.__bgClicked || 0) + 1">Save</button>
          </div>
          <div inert data-testid="inert-zone">
            <button type="button" data-testid="inert-btn">Save</button>
          </div>
          <div role="dialog" aria-modal="true">
            <button type="button" data-testid="active-btn" onclick="window.__activeClicked = (window.__activeClicked || 0) + 1">Save</button>
          </div>
        </body></html>`);
        return;
      }

      if (url.pathname === "/slow-fetch-page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <div id="status">loading</div>
          <script>
            fetch("/api/delayed").then((r) => r.text()).then((txt) => {
              const el = document.createElement("div");
              el.setAttribute("data-testid", "fetched-item");
              el.textContent = txt;
              document.body.appendChild(el);
            });
          </script>
        </body></html>`);
        return;
      }

      if (url.pathname === "/api/delayed") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("arrived-after-fetch");
        }, 650);
        return;
      }

      if (url.pathname === "/static-idle") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body><h1>Static Idle Page</h1></body></html>`);
        return;
      }

      if (url.pathname === "/slow-ssr") {
        const delayMs = Number.parseInt(url.searchParams.get("delay") ?? "900", 10);
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><html><body><h1 data-testid="ssr-ready">SSR OK ${delayMs}</h1></body></html>`,
          );
        }, delayMs);
        return;
      }

      if (url.pathname === "/actionability-diag") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <button type="button" data-testid="pe-none-btn" style="pointer-events:none;width:120px;height:40px;">No Pointer</button>
          <button type="button" data-testid="hidden-btn" style="display:none;">Hidden Btn</button>
          <button type="button" data-testid="disabled-btn" disabled>Disabled Btn</button>
        </body></html>`);
        return;
      }

      if (url.pathname === "/download-page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <a data-testid="dl-link" href="/download-file" download="report.txt">Download Report</a>
        </body></html>`);
        return;
      }

      if (url.pathname === "/download-file") {
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        res.end("hello-from-fresh-context");
        return;
      }

      if (url.pathname === "/tall-page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body style="margin:0;">
          <div style="height:2200px;background:linear-gradient(#2563eb,#10b981);">Tall Page</div>
        </body></html>`);
        return;
      }

      if (url.pathname === "/tap-guard-frame") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <iframe id="child" name="child" src="/tap-guard-frame-inner" style="width:400px;height:200px;border:1px solid #ccc;"></iframe>
          <button type="button" data-testid="settle-btn" onclick="window.__settleClicks = (window.__settleClicks || 0) + 1">Settle Tap</button>
        </body></html>`);
        return;
      }

      if (url.pathname === "/tap-guard-frame-inner") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <button type="button" data-testid="inner-btn" onclick="window.__innerClicks = (window.__innerClicks || 0) + 1">Inner Click</button>
        </body></html>`);
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    browserHandle = await launchDirectCdpBrowser({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browserHandle?.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("2.34 & 2.35: aria-hidden stays visible (Playwright semantics) while role selectors skip aria-hidden and inert", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle!.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: true,
      }),
    );
    try {
      const coordCfg = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 4_000 },
      };
      const app = createPromiseApp(driver, baseUrl, coordCfg, undefined, { platform: "web" });
      const spanaExpect = createPromiseExpect(driver, coordCfg, undefined, {
        flowFilePath: "v018.test.ts",
        flowName: "aria-inert",
        platform: "web",
      });

      await app.openLink(`${baseUrl}/aria-and-inert`);

      // 2.34: aria-hidden="true" ancestor does NOT hide elements for visibility/isVisible/count/tap
      await spanaExpect({ testID: "bg-btn" }).toBeVisible();
      bunExpect(await app.isVisible({ testID: "bg-btn" })).toBe(true);
      bunExpect(await app.count({ css: "button" }, { visible: true })).toBe(3);
      await app.tap({ testID: "bg-btn" });
      bunExpect(await app.evaluate<number>("window.__bgClicked")).toBe(1);

      // 2.34 & 2.35: role selectors skip BOTH aria-hidden="true" AND inert subtrees!
      bunExpect(await app.count(byRole("button", { name: "Save" }))).toBe(1);
      await app.tap(byRole("button", { name: "Save" }));
      bunExpect(await app.evaluate<number>("window.__activeClicked")).toBe(1);
      bunExpect(await app.evaluate<number>("window.__bgClicked")).toBe(1);

      // includeHidden: true opts back in for role selectors
      bunExpect(await app.count(byRole("button", { name: "Save", includeHidden: true }))).toBe(3);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  }, 20_000);

  test("1.22: failFastWhenIdle waits for in-flight fetch before failing, and fails fast on truly static idle pages", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle!.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: true,
      }),
    );
    try {
      const coordCfg = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 5_000, failFastWhenIdle: true, idleQuietMs: 150 },
      };
      const app = createPromiseApp(driver, baseUrl, coordCfg, undefined, { platform: "web" });
      const spanaExpect = createPromiseExpect(driver, coordCfg, undefined, {
        flowFilePath: "v018.test.ts",
        flowName: "fail-fast-net",
        platform: "web",
      });

      // Fetch takes 650ms (> 150ms idleQuietMs) — must NOT fail fast while fetch is in flight!
      await app.openLink(`${baseUrl}/slow-fetch-page`);
      await spanaExpect({ testID: "fetched-item" }).toBeVisible({ timeout: 4_000 });
      await spanaExpect({ testID: "fetched-item" }).toHaveText("arrived-after-fetch");

      // On a static idle page with no in-flight requests, missing element should fail fast (< 2s vs 5s timeout)
      await app.openLink(`${baseUrl}/static-idle`);
      const t0 = Date.now();
      let errMsg = "";
      try {
        await spanaExpect({ testID: "never-exists" }).toBeVisible({ timeout: 5_000 });
      } catch (e) {
        errMsg = e instanceof Error ? e.message : String(e);
      }
      const elapsed = Date.now() - t0;
      bunExpect(errMsg.length).toBeGreaterThan(0);
      bunExpect(elapsed).toBeLessThan(2_500);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  }, 20_000);

  test("1.28: execution.web.navigationTimeout allows slow SSR (> evaluateTimeout) and throws on timeout", async () => {
    // Low evaluateTimeout (500ms) but generous navigationTimeout (3000ms) — 900ms SSR must succeed!
    const driverOk = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle!.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        evaluateTimeout: 500,
        navigationTimeout: 3_000,
      }),
    );
    try {
      const coordCfg = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 3_000 },
      };
      const app = createPromiseApp(driverOk, baseUrl, coordCfg, undefined, { platform: "web" });
      await app.openLink(`${baseUrl}/slow-ssr?delay=900`);
      bunExpect(await app.getText({ testID: "ssr-ready" })).toBe("SSR OK 900");
    } finally {
      await Effect.runPromise(driverOk.killApp(""));
    }

    // Tight navigationTimeout (250ms) against 1500ms SSR — must throw explicit timeout error!
    const driverTimeout = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle!.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        navigationTimeout: 250,
      }),
    );
    try {
      let errMsg = "";
      try {
        await Effect.runPromise(driverTimeout.openLink(`${baseUrl}/slow-ssr?delay=1500`));
      } catch (e) {
        errMsg = e instanceof Error ? e.message : String(e);
      }
      bunExpect(errMsg.toLowerCase()).toContain("timed out");
    } finally {
      await Effect.runPromise(driverTimeout.killApp(""));
    }
  }, 20_000);

  test("3.28: waitForDownload routes downloads across fresh contexts and newContext()", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle!.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: true,
        contextIsolation: "fresh",
      }),
    );
    try {
      const coordCfg = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 5_000 },
      };
      const app = createPromiseApp(driver, baseUrl, coordCfg, undefined, { platform: "web" });

      // Flow 1 (first context)
      await Effect.runPromise(driver.beginFlow!("dl-flow-1"));
      await app.openLink(`${baseUrl}/download-page`);
      const dl1 = await app.waitForDownload(() => app.tap({ testID: "dl-link" }), {
        timeout: 8_000,
      });
      bunExpect(dl1.suggestedFilename).toBe("report.txt");
      bunExpect(await dl1.text()).toBe("hello-from-fresh-context");

      // Flow 2 (brand-new browserContextId via freshContextPerFlow + contextIsolation: "fresh")
      await Effect.runPromise(driver.beginFlow!("dl-flow-2"));
      await app.openLink(`${baseUrl}/download-page`);
      const dl2 = await app.waitForDownload(() => app.tap({ testID: "dl-link" }), {
        timeout: 8_000,
      });
      bunExpect(dl2.suggestedFilename).toBe("report.txt");
      bunExpect(await dl2.text()).toBe("hello-from-fresh-context");

      // Second isolated context via app.newContext()
      const ctx2 = await app.newContext({ url: `${baseUrl}/download-page` });
      try {
        const dl3 = await ctx2.app.waitForDownload(() => ctx2.app.tap({ testID: "dl-link" }), {
          timeout: 8_000,
        });
        bunExpect(dl3.suggestedFilename).toBe("report.txt");
        bunExpect(await dl3.text()).toBe("hello-from-fresh-context");
      } finally {
        await ctx2.close();
      }
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  }, 25_000);

  test("3.29, 3.30, 2.33, 1.11(b): permissions mapping, fullPage screenshot, actionability diagnostics & tap guard", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle!.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
      }),
    );
    try {
      const coordCfg = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 3_000 },
      };
      const app = createPromiseApp(driver, baseUrl, coordCfg, undefined, { platform: "web" });

      // 3.29: grantPermission("camera" / "microphone" / "clipboard-read") & denyPermission("camera")
      await app.openLink(`${baseUrl}/static-idle`);
      await app.grantPermission("camera", { origin: baseUrl });
      await app.grantPermission("microphone", { origin: baseUrl });
      await app.grantPermission("clipboard-read", { origin: baseUrl });
      await app.denyPermission("camera", { origin: baseUrl });

      // 3.30: takeScreenshot(name, { fullPage: true }) returns taller image than viewport
      await app.openLink(`${baseUrl}/tall-page`);
      const vpPng = PNG.sync.read(Buffer.from(await app.takeScreenshot("vp")));
      const fullPng = PNG.sync.read(
        Buffer.from(await app.takeScreenshot("full", { fullPage: true })),
      );
      bunExpect(fullPng.height).toBeGreaterThan(vpPng.height);
      bunExpect(fullPng.height).toBeGreaterThanOrEqual(2000);

      // 2.33: actionability diagnostic reports exact failure check (pointer-events: none, display: none, disabled)
      await app.openLink(`${baseUrl}/actionability-diag`);
      let peErr = "";
      try {
        await app.tap({ testID: "pe-none-btn" }, { timeout: 500 });
      } catch (e) {
        peErr = e instanceof Error ? e.message : String(e);
      }
      bunExpect(peErr).toContain("pointer-events: none");

      let hiddenErr = "";
      try {
        await app.tap({ testID: "hidden-btn" }, { timeout: 500 });
      } catch (e) {
        hiddenErr = e instanceof Error ? e.message : String(e);
      }
      bunExpect(hiddenErr).toContain("display: none");

      let disabledErr = "";
      try {
        await app.tap({ testID: "disabled-btn" }, { timeout: 500 });
      } catch (e) {
        disabledErr = e instanceof Error ? e.message : String(e);
      }
      bunExpect(disabledErr).toContain("disabled");

      // 1.11(b): tap guard works cleanly with settleTimeout > 0, same-origin iframe, and tapMode: "dom"
      await app.openLink(`${baseUrl}/tap-guard-frame`);
      await app.tap({ testID: "settle-btn" }, { settleTimeout: 50 });
      bunExpect(await app.evaluate<number>("window.__settleClicks")).toBe(1);
      await app.tap({ testID: "settle-btn" }, { tapMode: "dom" });
      bunExpect(await app.evaluate<number>("window.__settleClicks")).toBe(2);
      await app.tap({ frame: { css: "#child" }, testID: "inner-btn" });
      bunExpect(
        await app.evaluate<number>(
          'document.getElementById("child").contentWindow.__innerClicks || 0',
        ),
      ).toBe(1);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  }, 25_000);
});

describe("v0.18.0 unit checks (2.32, 3.29, 3.30)", () => {
  test("2.32: hierarchy fallback computes accessible name from visible descendants & skips aria-hidden/inert", () => {
    const root = {
      id: "root",
      elementType: "body",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      enabled: true,
      clickable: false,
      children: [
        {
          id: "hidden-wrap",
          elementType: "div",
          bounds: { x: 0, y: 0, width: 100, height: 40 },
          visible: true,
          enabled: true,
          clickable: false,
          attributes: { "aria-hidden": "true" },
          children: [
            {
              id: "aria-hidden-save",
              elementType: "button",
              text: "Save",
              bounds: { x: 0, y: 0, width: 100, height: 40 },
              visible: true,
              enabled: true,
              clickable: true,
              children: [],
            },
          ],
        },
        {
          id: "nested-save-btn",
          elementType: "button",
          bounds: { x: 10, y: 50, width: 100, height: 40 },
          visible: true,
          enabled: true,
          clickable: true,
          children: [
            {
              elementType: "span",
              text: "Save",
              bounds: { x: 12, y: 55, width: 50, height: 20 },
              visible: true,
              enabled: true,
              clickable: false,
              children: [],
            },
          ],
        },
      ],
    };

    const hits = findElements(root, { role: "button", name: "Save" });
    bunExpect(hits.length).toBe(1);
    bunExpect(hits[0]!.id).toBe("nested-save-btn");
  });

  test("2.32: waitForElement surfaces Last DOM channel error when domChannel.query fails", async () => {
    const mockDriver: RawDriverService = {
      domChannel: {
        kind: "cdp",
        isConnected: () => true,
        connect: async () => {},
        disconnect: async () => {},
        query: async () => {
          throw new Error("Execution context was destroyed (session detached)");
        },
        evaluate: async () => {
          throw new Error("Execution context was destroyed (session detached)");
        },
        scrollIntoView: async () => null,
        tapDom: async () => false,
      },
      tapAtCoordinate: () => Effect.void,
      doubleTapAtCoordinate: () => Effect.void,
      longPressAtCoordinate: () => Effect.void,
      swipe: () => Effect.void,
      inputText: () => Effect.void,
      pressKey: () => Effect.void,
      hideKeyboard: () => Effect.void,
      dumpHierarchy: () =>
        Effect.succeed(
          JSON.stringify({
            tag: "body",
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            visible: true,
            enabled: true,
            clickable: false,
            children: [],
          }),
        ),
      takeScreenshot: () => Effect.succeed(new Uint8Array()),
      getDeviceInfo: () =>
        Effect.succeed({
          platform: "web" as const,
          deviceId: "mock",
          name: "mock",
          isEmulator: true,
          screenWidth: 800,
          screenHeight: 600,
          driverType: "playwright" as const,
        }),
      launchApp: () => Effect.void,
      stopApp: () => Effect.void,
      killApp: () => Effect.void,
      clearAppState: () => Effect.void,
      openLink: () => Effect.void,
      back: () => Effect.void,
      evaluate: () => Effect.succeed(undefined as never),
    };

    let errMsg = "";
    try {
      await Effect.runPromise(
        waitForElement(mockDriver, { testID: "missing" }, parseWebHierarchy, {
          timeout: 150,
          pollInterval: 50,
          platform: "web",
        }),
      );
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    }
    bunExpect(errMsg).toContain("Last DOM channel error:");
    bunExpect(errMsg).toContain("Execution context was destroyed");
  });

  test("3.29: permission name maps translate Playwright names to CDP grant & descriptor names", () => {
    bunExpect(mapPermissionToCdpGrantName("camera")).toBe("videoCapture");
    bunExpect(mapPermissionToCdpGrantName("microphone")).toBe("audioCapture");
    bunExpect(mapPermissionToCdpGrantName("clipboard-read")).toBe("clipboardReadWrite");
    bunExpect(mapPermissionToCdpGrantName("clipboard-write")).toBe("clipboardSanitizedWrite");
    bunExpect(mapPermissionToCdpGrantName("midi-sysex")).toBe("midiSysex");
    bunExpect(mapPermissionToCdpDescriptor("videoCapture")).toEqual({ name: "camera" });
    bunExpect(mapPermissionToCdpDescriptor("midi-sysex")).toEqual({ name: "midi", sysex: true });
  });

  test("3.30: parseMaskColor & applyMask paint custom maskColor accurately", async () => {
    bunExpect(parseMaskColor("#ff00ff")).toEqual([255, 0, 255, 255]);
    bunExpect(parseMaskColor("#0f8")).toEqual([0, 255, 136, 255]);
    bunExpect(parseMaskColor("rgb(10, 20, 30)")).toEqual([10, 20, 30, 255]);
    bunExpect(parseMaskColor(undefined)).toEqual([128, 128, 128, 255]);

    const png = new PNG({ width: 10, height: 10 });
    png.data.fill(255);
    const maskedBuf = await applyMask(
      PNG.sync.write(png),
      [{ x: 2, y: 2, width: 4, height: 4 }],
      "#ff00ff",
    );
    const decoded = PNG.sync.read(maskedBuf);
    const insideIdx = (3 * 10 + 3) * 4;
    const outsideIdx = 0;
    bunExpect([
      decoded.data[insideIdx],
      decoded.data[insideIdx + 1],
      decoded.data[insideIdx + 2],
      decoded.data[insideIdx + 3],
    ]).toEqual([255, 0, 255, 255]);
    bunExpect([
      decoded.data[outsideIdx],
      decoded.data[outsideIdx + 1],
      decoded.data[outsideIdx + 2],
      decoded.data[outsideIdx + 3],
    ]).toEqual([255, 255, 255, 255]);
  });

  test("1.28: validateConfig accepts execution.web.navigationTimeout", async () => {
    const { validateConfig } = await import("../schemas/config.js");
    const valid = validateConfig({
      apps: { web: { url: "http://127.0.0.1:3000" } },
      execution: { web: { engine: "cdp", navigationTimeout: 45_000 } },
    });
    bunExpect(valid.execution?.web?.navigationTimeout).toBe(45_000);
  });
});
