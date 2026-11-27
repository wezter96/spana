import { afterAll, beforeAll, describe, expect as bunExpect, test } from "bun:test";
import http from "node:http";
import { Effect } from "effect";
import {
  byCss,
  byRole,
  createPromiseApp,
  createPromiseExpect,
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  within,
  type DirectCdpBrowserHandle,
  type RawDriverService,
} from "../index.js";
import { parseWebHierarchy } from "./playwright-parser.js";

function startWave4Server() {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolveServer) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      const path = reqUrl.pathname;

      if (path === "/fixed-modal-inner-scroll") {
        // Exact reproduction of Sökhem's Base-UI auth modal:
        // position: fixed dialog (y: 65..655, 590px tall on 720px viewport) with inner
        // overflow-y: auto body, full-viewport backdrop, and checkbox clipped ~28px below
        // dialog bottom (y: 683..696) yet still inside the 720px window viewport!
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><meta charset="utf-8"><title>Fixed Modal</title><style>
            * { box-sizing: border-box; }
            html, body { margin: 0; padding: 0; height: 100%; font-family: sans-serif; }
            .backdrop {
              position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 40;
            }
            .dialog {
              position: fixed;
              left: 360px; top: 65px; width: 560px; height: 590px; max-height: 590px;
              z-index: 50; background: #fff; border-radius: 12px;
              display: flex; flex-direction: column; overflow: hidden;
            }
            .dialog-header { height: 56px; flex: 0 0 auto; padding: 16px; border-bottom: 1px solid #ddd; }
            .dialog-scroll { flex: 1 1 auto; overflow-y: auto; padding: 16px; }
            .spacer { height: 546px; background: #f8fafc; }
            .terms-row { display: flex; align-items: center; gap: 8px; height: 24px; }
            .submit-btn { margin-top: 12px; padding: 8px 16px; }
          </style></head><body>
            <div class="backdrop" data-testid="backdrop"></div>
            <div role="dialog" aria-label="Sign up" class="dialog">
              <div class="dialog-header">Create account</div>
              <div class="dialog-scroll" id="scroll-body">
                <div class="spacer">Form fields above</div>
                <label class="terms-row">
                  <input type="checkbox" name="termsAccepted" id="terms-cb" />
                  <span>I accept the terms</span>
                </label>
                <button type="button" class="submit-btn" id="submit-btn" onclick="document.body.dataset.submitted='yes'">Create account</button>
              </div>
            </div>
          </body></html>`);
        return;
      }

      if (path === "/fixed-self-scrollable") {
        // The position: fixed element ITSELF has overflow-y: auto
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><meta charset="utf-8"><title>Self Scrollable Fixed Dialog</title><style>
            * { box-sizing: border-box; }
            html, body { margin: 0; padding: 0; height: 100%; }
            .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); z-index: 10; }
            .fixed-scroll-dialog {
              position: fixed; left: 320px; top: 60px; width: 520px; max-height: 500px;
              overflow-y: auto; z-index: 20; background: #fff; padding: 16px;
            }
            .spacer { height: 520px; }
          </style></head><body>
            <div class="backdrop"></div>
            <div role="dialog" aria-label="Scrollable Sheet" class="fixed-scroll-dialog" id="fixed-sheet">
              <div class="spacer">Long content</div>
              <label><input type="checkbox" id="sheet-cb" /> Accept policy</label>
              <button type="button" id="sheet-btn" onclick="document.body.dataset.clicked='ok'">Confirm</button>
            </div>
          </body></html>`);
        return;
      }

      if (path === "/fixed-modal-sticky-footer") {
        // Scrollable position: fixed dialog with a sticky footer covering a button inside the visible rect
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><meta charset="utf-8"><title>Sticky Footer Modal</title><style>
            * { box-sizing: border-box; }
            html, body { margin: 0; padding: 0; height: 100%; }
            .dialog {
              position: fixed; left: 300px; top: 80px; width: 500px; height: 420px;
              overflow-y: auto; background: #fff; border: 1px solid #ccc;
            }
            .sticky-footer {
              position: sticky; bottom: 0; left: 0; right: 0; height: 70px;
              background: rgba(255, 255, 255, 0.98); border-top: 1px solid #aaa; z-index: 5;
            }
            .top-filler { height: 370px; }
            .bottom-filler { height: 260px; }
          </style></head><body>
            <div role="dialog" aria-label="Sticky Dialog" class="dialog">
              <div class="top-filler">Content</div>
              <button type="button" id="covered-btn" onclick="document.body.dataset.stickyClicked='yes'">Hidden Under Sticky</button>
              <div class="bottom-filler">More content</div>
              <div class="sticky-footer">Sticky Footer Bar</div>
            </div>
          </body></html>`);
        return;
      }

      if (path === "/fixed-blocked-overlay") {
        // Non-scrollable position: fixed dialog covered by a full-viewport blocking overlay
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><meta charset="utf-8"><title>Blocked Fixed</title><style>
            html, body { margin: 0; padding: 0; height: 100%; }
            .dialog { position: fixed; left: 300px; top: 100px; width: 400px; height: 200px; z-index: 10; background: #fff; }
            .overlay { position: fixed; inset: 0; z-index: 999; background: rgba(0,0,0,0.6); }
          </style></head><body>
            <div role="dialog" class="dialog">
              <button type="button" id="blocked-btn" onclick="document.body.dataset.blocked='oops'">Blocked</button>
            </div>
            <div class="overlay" data-testid="blocker">Loading...</div>
          </body></html>`);
        return;
      }

      if (path === "/simple") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><meta charset="utf-8"><title>Simple</title></head><body>
            <main>
              <h1>Simple Page</h1>
              <button type="button" id="ok-btn">OK</button>
            </main>
          </body></html>`);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolveServer({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

describe("Wave 4 Fixes — Scrollable Fixed Dialogs & Zero-Overhead Hot-Cache Dirty Tracking", () => {
  let server: { url: string; close: () => Promise<void> };
  let browser: DirectCdpBrowserHandle;
  let driver: RawDriverService;

  beforeAll(async () => {
    server = await startWave4Server();
    browser = await launchDirectCdpBrowser({ headless: true });
    driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl: server.url,
        viewport: { width: 1280, height: 720 },
        useBrowserContexts: true,
        freshContextPerFlow: true,
        contextIsolation: "hot-cache",
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (driver) await Effect.runPromise(driver.killApp("")).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  });

  const makeAppAndExpect = () => {
    const coordConfig = {
      parse: parseWebHierarchy,
      platform: "web" as const,
      defaults: { timeout: 5_000, actionStableFrames: 0 },
    };
    const app = createPromiseApp(driver, server.url, coordConfig, undefined, { platform: "web" });
    const expect = createPromiseExpect(driver, coordConfig);
    return { app, expect };
  };

  test("FIX A1: app.check() & app.tap() scroll checkbox clipped 28px below position:fixed dialog bottom (inside 720px viewport)", async () => {
    await Effect.runPromise(driver.beginFlow!("wave4-fix-a1"));
    const { app } = makeAppAndExpect();
    await app.openLink(`${server.url}/fixed-modal-inner-scroll`);

    // Verify exact Sökhem geometry preconditions before clicking:
    // checkbox is inside window viewport (<= 720px) BUT below the scrollable dialog bottom (~655px).
    const preGeom = await app.evaluate<{
      windowHeight: number;
      dialogBottom: number;
      cbTop: number;
      cbBottom: number;
      scrollTopBefore: number;
    }>(`(() => {
      const dlg = document.querySelector('[role="dialog"]').getBoundingClientRect();
      const cb = document.getElementById("terms-cb").getBoundingClientRect();
      const scrollBody = document.getElementById("scroll-body");
      return {
        windowHeight: window.innerHeight,
        dialogBottom: Math.round(dlg.bottom),
        cbTop: Math.round(cb.top),
        cbBottom: Math.round(cb.bottom),
        scrollTopBefore: scrollBody.scrollTop,
      };
    })()`);
    bunExpect(preGeom.cbBottom).toBeLessThanOrEqual(preGeom.windowHeight);
    bunExpect(preGeom.cbTop).toBeGreaterThan(preGeom.dialogBottom);
    bunExpect(preGeom.scrollTopBefore).toBe(0);

    const dialog = byRole("dialog");
    await app.check(within(dialog, byRole("checkbox")));

    const checked = await app.isChecked(within(dialog, byRole("checkbox")));
    bunExpect(checked).toBe(true);

    const scrollTopAfter = await app.evaluate<number>(
      `document.getElementById("scroll-body").scrollTop`,
    );
    bunExpect(scrollTopAfter).toBeGreaterThan(0);

    await app.tap(within(dialog, byRole("button", { name: "Create account" })));
    const submitted = await app.evaluate<string>(`document.body.dataset.submitted || ""`);
    bunExpect(submitted).toBe("yes");
  }, 20_000);

  test("FIX A2: position:fixed element that is ITSELF scrollable scrolls target checkbox & button into view", async () => {
    await Effect.runPromise(driver.beginFlow!("wave4-fix-a2"));
    const { app } = makeAppAndExpect();
    await app.openLink(`${server.url}/fixed-self-scrollable`);

    const dialog = byRole("dialog", { name: "Scrollable Sheet" });
    await app.check(within(dialog, byRole("checkbox")));
    bunExpect(await app.isChecked(within(dialog, byRole("checkbox")))).toBe(true);

    await app.tap(within(dialog, byRole("button", { name: "Confirm" })));
    bunExpect(await app.evaluate<string>(`document.body.dataset.clicked || ""`)).toBe("ok");
  }, 20_000);

  test("FIX A3: scrollable position:fixed dialog scrolls target clear of internal sticky footer", async () => {
    await Effect.runPromise(driver.beginFlow!("wave4-fix-a3"));
    const { app } = makeAppAndExpect();
    await app.openLink(`${server.url}/fixed-modal-sticky-footer`);

    await app.tap(byRole("button", { name: "Hidden Under Sticky" }));
    bunExpect(await app.evaluate<string>(`document.body.dataset.stickyClicked || ""`)).toBe("yes");
  }, 20_000);

  test("FIX A4: non-scrollable position:fixed dialog covered by full-viewport overlay remains blocked", async () => {
    await Effect.runPromise(driver.beginFlow!("wave4-fix-a4"));
    const { app } = makeAppAndExpect();
    await app.openLink(`${server.url}/fixed-blocked-overlay`);

    let failed = false;
    try {
      await app.tap(byRole("button", { name: "Blocked" }), { timeout: 600 });
    } catch {
      failed = true;
    }
    bunExpect(failed).toBe(true);
    bunExpect(await app.evaluate<string>(`document.body.dataset.blocked || ""`)).toBe("");
  }, 20_000);

  test("FIX C: hot-cache dirty-tracking emits ZERO redundant CDP commands on untouched flows & restores mutated state cleanly", async () => {
    // Spy on CDP sendCommand calls on the underlying domChannel
    const channel = driver.domChannel as unknown as {
      sendCommand: (
        method: string,
        params?: Record<string, unknown>,
        ...rest: unknown[]
      ) => Promise<unknown>;
    };
    const origSend = channel.sendCommand.bind(channel);
    const recordedMethods: string[] = [];
    channel.sendCommand = (
      method: string,
      params?: Record<string, unknown>,
      ...rest: unknown[]
    ) => {
      recordedMethods.push(method);
      return origSend(method, params, ...rest);
    };

    try {
      // Flow 1: untouched desktop navigation (no viewport/touch/emulation/network/routes/initScripts)
      await Effect.runPromise(driver.beginFlow!("wave4-fix-c-1"));
      const { app, expect } = makeAppAndExpect();
      await app.openLink(`${server.url}/simple`);

      // Flow 2 beginFlow: MUST emit ZERO redundant health-check, frameTree, storageKey, emulation, network, fetch, or script-removal commands!
      recordedMethods.length = 0;
      await Effect.runPromise(driver.beginFlow!("wave4-fix-c-2"));
      const cleanResetMethods = [...recordedMethods];
      bunExpect(cleanResetMethods).not.toContain("Page.getFrameTree");
      bunExpect(cleanResetMethods).not.toContain("Storage.getStorageKeyForFrame");
      bunExpect(cleanResetMethods).not.toContain("Emulation.clearDeviceMetricsOverride");
      bunExpect(cleanResetMethods).not.toContain("Emulation.setTouchEmulationEnabled");
      bunExpect(cleanResetMethods).not.toContain("Emulation.setEmitTouchEventsForMouse");
      bunExpect(cleanResetMethods).not.toContain("Emulation.setDeviceMetricsOverride");
      bunExpect(cleanResetMethods).not.toContain("Emulation.setUserAgentOverride");
      bunExpect(cleanResetMethods).not.toContain("Emulation.setLocaleOverride");
      bunExpect(cleanResetMethods).not.toContain("Emulation.setEmulatedMedia");
      bunExpect(cleanResetMethods).not.toContain("Emulation.setTimezoneOverride");
      bunExpect(cleanResetMethods).not.toContain("Network.emulateNetworkConditions");
      bunExpect(cleanResetMethods).not.toContain("Fetch.disable");
      bunExpect(cleanResetMethods).not.toContain("Page.removeScriptToEvaluateOnNewDocument");
      // Runtime.evaluate should only be called once (for the in-page storage/OPFS clear), NOT twice with a separate "1" health check
      bunExpect(
        cleanResetMethods.filter((m) => m === "Runtime.evaluate").length,
      ).toBeLessThanOrEqual(1);

      // Flow 2: plain desktop viewport resize (like Sökhem landscape) — NO mobile/touch mutation
      await app.setViewport({ width: 852, height: 393 });
      await app.openLink(`${server.url}/simple`);

      // Flow 3 beginFlow: MUST emit Emulation.setDeviceMetricsOverride ONLY (ZERO touch/clearDeviceMetricsOverride!)
      recordedMethods.length = 0;
      await Effect.runPromise(driver.beginFlow!("wave4-fix-c-3"));
      const resizeResetMethods = [...recordedMethods];
      bunExpect(resizeResetMethods).toContain("Emulation.setDeviceMetricsOverride");
      bunExpect(resizeResetMethods).not.toContain("Emulation.clearDeviceMetricsOverride");
      bunExpect(resizeResetMethods).not.toContain("Emulation.setTouchEmulationEnabled");
      bunExpect(resizeResetMethods).not.toContain("Emulation.setEmitTouchEventsForMouse");

      // Flow 3: mobile + touch + dark mode + locale + network mutation
      await app.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await app.setEmulation({ colorScheme: "dark", locale: "sv-SE" });
      await app.setNetworkConditions({ offline: false, latencyMs: 5 });
      await app.openLink(`${server.url}/simple`);

      // Flow 4 beginFlow: MUST restore mobile/touch hover media, dark mode, locale, AND network cleanly!
      recordedMethods.length = 0;
      await Effect.runPromise(driver.beginFlow!("wave4-fix-c-4"));
      const mutatedResetMethods = [...recordedMethods];
      bunExpect(mutatedResetMethods).toContain("Emulation.clearDeviceMetricsOverride");
      bunExpect(mutatedResetMethods).toContain("Emulation.setTouchEmulationEnabled");
      bunExpect(mutatedResetMethods).toContain("Emulation.setEmitTouchEventsForMouse");
      bunExpect(mutatedResetMethods).toContain("Emulation.setDeviceMetricsOverride");
      bunExpect(mutatedResetMethods).toContain("Emulation.setLocaleOverride");
      bunExpect(mutatedResetMethods).toContain("Emulation.setUserAgentOverride");
      bunExpect(mutatedResetMethods).toContain("Emulation.setEmulatedMedia");
      bunExpect(mutatedResetMethods).toContain("Network.emulateNetworkConditions");

      await app.openLink(`${server.url}/simple`);
      const restored = await app.evaluate<{ width: number; anyHover: boolean; dark: boolean }>(
        `({
          width: window.innerWidth,
          anyHover: window.matchMedia("(any-hover: hover)").matches,
          dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
        })`,
      );
      bunExpect(restored.width).toBe(1280);
      bunExpect(restored.anyHover).toBe(true);
      bunExpect(restored.dark).toBe(false);

      // Fresh-page axe audit: first call in a coordinator runs in 1 Runtime.evaluate (no wasted probe RTT),
      // while second call on the same document reuses window.axe without re-injecting.
      recordedMethods.length = 0;
      await expect(byCss("body")).toPassAccessibilityAudit();
      const firstAuditEvals = recordedMethods.filter((m) => m === "Runtime.evaluate").length;
      bunExpect(firstAuditEvals).toBe(1);

      await app.evaluate("window.axe.__wave4Cached = true");
      await expect(byCss("body")).toPassAccessibilityAudit();
      bunExpect(
        await app.evaluate<boolean>("Boolean(window.axe && window.axe.__wave4Cached)"),
      ).toBe(true);
    } finally {
      channel.sendCommand = origSend;
    }
  }, 30_000);
});
