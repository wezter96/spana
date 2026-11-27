import { afterAll, beforeAll, describe, expect as bunExpect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import {
  byCss,
  byLabel,
  byRole,
  createCdpApp,
  createPromiseApp,
  createPromiseExpect,
  flow,
  launchDirectCdpBrowser,
  launchDirectCdpPage,
  loadCachedAxeSource,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
  type RawDriverService,
} from "../index.js";
import { makePlaywrightDriver } from "./playwright.js";
import { validateConfig } from "../schemas/config.js";
import { parseWebHierarchy } from "./playwright-parser.js";
import { executeFlow, type EngineConfig } from "../core/engine.js";
import { parseSetCookieHeader } from "../api/app.js";

const expectedAuthHeader = `Basic ${Buffer.from("admin:secret").toString("base64")}`;

function startWave3Server() {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolveServer) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      const path = reqUrl.pathname;

      if (path === "/headers") {
        const ua = String(req.headers["user-agent"] || "");
        const al = String(req.headers["accept-language"] || "");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Headers</title></head><body>
            <main>
              <h1>Headers Page</h1>
              <div data-testid="srv-ua">${ua.replaceAll("<", "&lt;")}</div>
              <div data-testid="srv-al">${al.replaceAll("<", "&lt;")}</div>
            </main>
          </body></html>`);
        return;
      }

      if (path === "/basic-auth") {
        if (req.headers.authorization !== expectedAuthHeader) {
          res.writeHead(401, {
            "www-authenticate": 'Basic realm="SpanaWave3"',
            "content-type": "text/html; charset=utf-8",
          });
          res.end(
            `<!doctype html><html><body><h1 data-testid="auth-denied">Unauthorized</h1></body></html>`,
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><body><h1 data-testid="auth-ok">Basic Auth OK</h1></body></html>`,
        );
        return;
      }

      if (path === "/status-200") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body><h1 data-testid="st">OK 200</h1></body></html>`);
        return;
      }
      if (path === "/status-404") {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body><h1 data-testid="st">Missing 404</h1></body></html>`);
        return;
      }
      if (path === "/status-500") {
        res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body><h1 data-testid="st">Error 500</h1></body></html>`);
        return;
      }
      if (path === "/status-redirect") {
        res.writeHead(302, { location: "/status-200" });
        res.end();
        return;
      }

      if (path === "/a11y-clean") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en">
            <head><title>Clean A11y Page</title></head>
            <body>
              <main>
                <h1>Accessible Heading</h1>
                <button type="button" data-testid="clean-btn">Continue</button>
              </main>
            </body>
          </html>`);
        return;
      }

      if (path === "/a11y-broken") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html>
            <head><title>Broken A11y</title></head>
            <body>
              <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
              <button type="button"></button>
            </body>
          </html>`);
        return;
      }

      if (path === "/nav-a") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><title>Nav A</title></head><body>
            <main>
              <h1 data-testid="nav-title">Page A</h1>
              <a data-testid="go-b" href="/nav-b">Go to B</a>
              <script>window.__NAV_PAGE__ = "A";</script>
            </main>
          </body></html>`);
        return;
      }

      if (path === "/nav-b") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en"><head><title>Nav B</title></head><body>
            <main>
              <h1 data-testid="nav-title">Page B</h1>
              <script>window.__NAV_PAGE__ = "B";</script>
            </main>
          </body></html>`);
        return;
      }

      if (path === "/bolagy-lab") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html lang="en">
            <head>
              <title>Bolagy & Wave-3 Lab</title>
              <style>
                body { margin: 0; padding: 20px; font-family: sans-serif; }
                .opacity-card { opacity: 0; padding: 8px; }
                .opacity-card:hover, .opacity-card:focus-within { opacity: 1; }
                .clip-shell {
                  position: relative;
                  width: 140px;
                  height: 50px;
                  overflow: hidden;
                  border: 1px solid #999;
                }
                .half-clipped-btn {
                  position: absolute;
                  left: 70px;
                  top: 6px;
                  width: 240px;
                  height: 36px;
                  background: #2563eb;
                  color: white;
                  border: 0;
                }
                .clip-blocker {
                  position: absolute;
                  left: 140px;
                  top: 0;
                  width: 220px;
                  height: 60px;
                  background: rgba(255, 0, 0, 0.2);
                }
              </style>
            </head>
            <body>
              <main>
                <h1>Wave-3 Lab</h1>

                <!-- Hidden / visible checkboxes for includeHidden -->
                <input type="checkbox" data-testid="vis-chk" checked />
                <input type="checkbox" data-testid="hidden-chk" data-tag="secret-attr" checked style="display:none" />

                <!-- Opacity:0 hover-revealed & inert controls -->
                <div class="opacity-card" data-testid="opacity-parent">
                  <button type="button" data-testid="opacity-btn"
                    onfocus="document.getElementById('focus-log').textContent='focused-opacity'"
                    onblur="document.getElementById('focus-log').textContent='blurred-opacity'"
                    onclick="document.getElementById('opacity-log').textContent='clicked-opacity'">Hover Reveal Action</button>
                </div>
                <div id="focus-log" data-testid="focus-log">idle</div>
                <div id="opacity-log" data-testid="opacity-log">idle</div>
                <div inert data-testid="inert-parent">
                  <button type="button" data-testid="inert-btn">Inert Button</button>
                </div>

                <!-- Closed native select with options -->
                <label for="country-sel">Country</label>
                <select id="country-sel" data-testid="country-sel">
                  <option value="se">Sweden</option>
                  <option value="no">Norway</option>
                </select>

                <!-- Selector string containing JS keyword "return" -->
                <button type="button" data-testid="vat-btn"
                  onclick="document.getElementById('vat-out').textContent='vat-submitted'">VAT return</button>
                <div id="vat-out" data-testid="vat-out">idle</div>

                <!-- File input with regex-matched label -->
                <label for="receipt-file">Upload Expense Receipt (PDF)</label>
                <input id="receipt-file" data-testid="receipt-file" type="file"
                  onchange="document.getElementById('file-out').textContent = this.files[0]?.name || 'none'" />
                <div id="file-out" data-testid="file-out">none</div>

                <!-- Half-clipped button whose geometric center (x=190) lies OUTSIDE overflow:hidden clip (right=140) -->
                <div style="position:relative; height:64px; margin-top:12px;">
                  <div class="clip-shell">
                    <button type="button" class="half-clipped-btn" data-testid="clipped-btn"
                      onclick="document.getElementById('clip-out').textContent='clipped-clicked'">Clipped CTA</button>
                  </div>
                  <div class="clip-blocker"
                    onclick="document.getElementById('clip-out').textContent='blocker-clicked'"></div>
                </div>
                <div id="clip-out" data-testid="clip-out">idle</div>

                <!-- Implicit ARIA roles & accessible names -->
                <table>
                  <caption>Quarterly Ledger</caption>
                  <thead><tr><th>Item</th></tr></thead>
                  <tbody><tr><td>Invoice #1</td></tr></tbody>
                </table>
                <figure>
                  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Revenue Chart" width="16" height="16" />
                  <figcaption>Q4 Performance Figure</figcaption>
                </figure>
                <meter value="0.7" min="0" max="1" aria-label="Disk Usage">70%</meter>
                <output aria-label="Total Summary">42 SEK</output>
                <p>Paragraph Role Content</p>
                <strong>Bold Emphasis</strong>
                <button type="button" data-testid="img-btn">
                  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Export Report" width="16" height="16" />
                </button>
                <button type="button" data-testid="svg-btn">
                  <svg role="img" aria-label="Close Modal" width="16" height="16"><rect width="16" height="16" /></svg>
                </button>
                <label for="promo-video">Demo Video</label>
                <video id="promo-video" data-testid="promo-video" width="20" height="20"></video>
              </main>
            </body>
          </html>`);
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html lang="en"><body><h1 data-testid="root-h1">Wave-3 Root</h1></body></html>`,
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolveServer({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("Wave-3 Zero-Bug Polish & Monotirith Regression Suite", () => {
  let server: { url: string; close: () => Promise<void> };
  let browser: DirectCdpBrowserHandle;
  let driver: RawDriverService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "spana-wave3-test-"));
    server = await startWave3Server();
    browser = await launchDirectCdpBrowser({ headless: true });
    driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl: server.url,
        useBrowserContexts: true,
        freshContextPerFlow: true,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    try {
      await Effect.runPromise(driver.killApp(""));
    } catch {}
    try {
      await browser.close();
    } catch {}
    try {
      await server.close();
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAppAndExpect() {
    const coordConfig = {
      parse: parseWebHierarchy,
      platform: "web" as const,
      defaults: { timeout: 4_000, platform: "web" as const },
    };
    const app = createPromiseApp(driver, server.url, coordConfig, undefined, { platform: "web" });
    const expect = createPromiseExpect(driver, coordConfig);
    return { app, expect };
  }

  test("1. setEmulation({ locale }) preserves sanitized Chrome UA and custom userAgent", async () => {
    await Effect.runPromise(driver.beginFlow!("wave3-ua-locale"));
    const { app } = makeAppAndExpect();

    // Locale-only call must NEVER revert UA to HeadlessChrome
    await app.setEmulation({ locale: "sv-SE" });
    await app.openLink(`${server.url}/headers`);
    const navUa = await app.evaluate<string>("navigator.userAgent");
    const navLang = await app.evaluate<string>("navigator.language");
    const srvUa = await app.getText({ testID: "srv-ua" });
    const srvAl = await app.getText({ testID: "srv-al" });
    bunExpect(navUa).toContain("Chrome/");
    bunExpect(navUa).not.toContain("HeadlessChrome");
    bunExpect(srvUa).toContain("Chrome/");
    bunExpect(srvUa).not.toContain("HeadlessChrome");
    bunExpect(navLang).toMatch(/^sv/i);
    bunExpect(srvAl.toLowerCase()).toContain("sv-se");

    // Custom userAgent then locale change must preserve custom UA
    await app.setEmulation({ userAgent: "SpanaCustomUA/3.0" });
    await app.setEmulation({ locale: "de-DE" });
    await app.openLink(`${server.url}/headers`);
    bunExpect(await app.evaluate<string>("navigator.userAgent")).toBe("SpanaCustomUA/3.0");
    bunExpect(await app.getText({ testID: "srv-ua" })).toBe("SpanaCustomUA/3.0");
    bunExpect((await app.getText({ testID: "srv-al" })).toLowerCase()).toContain("de-de");

    // Combined locale + userAgent works atomically
    await app.setEmulation({ locale: "fr-FR", userAgent: "SpanaCombinedUA/3.0" });
    await app.openLink(`${server.url}/headers`);
    bunExpect(await app.getText({ testID: "srv-ua" })).toBe("SpanaCombinedUA/3.0");
    bunExpect((await app.getText({ testID: "srv-al" })).toLowerCase()).toContain("fr-fr");
  }, 20_000);

  test("2. toPassAccessibilityAudit caches axe-core and skips redundant ~560KB re-injection", async () => {
    await Effect.runPromise(driver.beginFlow!("wave3-axe-cache"));
    const { app, expect } = makeAppAndExpect();

    const src1 = await loadCachedAxeSource();
    const src2 = await loadCachedAxeSource();
    bunExpect(src1.length).toBeGreaterThan(100_000);
    bunExpect(src1).toBe(src2);

    await app.openLink(`${server.url}/a11y-clean`);
    await expect(byCss("body")).toPassAccessibilityAudit();
    // Mark window.axe to prove repeat audit reuses the already-injected axe instance without re-injecting
    await app.evaluate("window.axe.__spanaMarker = 'cached-ok'");
    await expect(byCss("body")).toPassAccessibilityAudit();
    const markerStillThere = await app.evaluate<string>("window.axe && window.axe.__spanaMarker");
    bunExpect(markerStillThere).toBe("cached-ok");

    // Navigating to a broken page re-injects from memory cache and detects violations
    await app.openLink(`${server.url}/a11y-broken`);
    let failed = false;
    try {
      await expect(byCss("body")).toPassAccessibilityAudit();
    } catch (err) {
      failed = true;
      bunExpect(String(err)).toContain("Accessibility audit failed");
    }
    bunExpect(failed).toBe(true);
  }, 20_000);

  test("3. runtime ctx.skip() and flow.skip() skip cleanly on BOTH Direct CDP and Playwright", async () => {
    const cdpEngineConfig: EngineConfig = {
      appId: server.url,
      platform: "web",
      coordinatorConfig: {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { timeout: 3_000 },
      },
      autoLaunch: false,
      artifactConfig: {
        captureOnFailure: true,
        screenshot: true,
        outputDir: join(tmpDir, "skip-artifacts"),
      },
    };

    const skippedUnconditional = flow("skip-uncond", async (ctx) => {
      await ctx.app.openLink(`${server.url}/status-200`);
      ctx.skip("feature flag off");
      throw new Error("must not run after ctx.skip");
    });

    const skippedConditional = flow("skip-cond", async ({ skip }) => {
      skip(false, "should not skip");
      skip(true, "env condition matched");
      throw new Error("must not run");
    });

    const skippedInlineFlow = flow("skip-inline-flow", async () => {
      flow.skip("skipped via flow.skip()");
      throw new Error("must not run");
    });

    const cdpRes1 = await executeFlow(skippedUnconditional, driver, cdpEngineConfig);
    bunExpect(cdpRes1.status).toBe("skipped");
    bunExpect(cdpRes1.modifier).toBe("skip");
    bunExpect(cdpRes1.skipReason).toBe("feature flag off");
    bunExpect(cdpRes1.attachments ?? []).toHaveLength(0);

    const cdpRes2 = await executeFlow(skippedConditional, driver, cdpEngineConfig);
    bunExpect(cdpRes2.status).toBe("skipped");
    bunExpect(cdpRes2.skipReason).toBe("env condition matched");

    const cdpRes3 = await executeFlow(skippedInlineFlow, driver, cdpEngineConfig);
    bunExpect(cdpRes3.status).toBe("skipped");
    bunExpect(cdpRes3.skipReason).toBe("skipped via flow.skip()");

    // Verify Playwright driver produces identical clean skipped results + lastNavigationStatus + regex upload
    const pwDriver = await Effect.runPromise(
      makePlaywrightDriver({ headless: true, baseUrl: server.url }),
    );
    try {
      const pwRes = await executeFlow(skippedUnconditional, pwDriver, cdpEngineConfig);
      bunExpect(pwRes.status).toBe("skipped");
      bunExpect(pwRes.modifier).toBe("skip");
      bunExpect(pwRes.skipReason).toBe("feature flag off");
      bunExpect(pwRes.attachments ?? []).toHaveLength(0);

      // Also check Playwright lastNavigationStatus() & regex uploadFile
      const pwCoord = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 4_000, platform: "web" as const },
      };
      const pwApp = createPromiseApp(pwDriver, server.url, pwCoord, undefined, { platform: "web" });
      await pwApp.openLink(`${server.url}/status-404`);
      bunExpect(pwApp.lastNavigationStatus()).toBe(404);
      await pwApp.openLink(`${server.url}/status-redirect`);
      bunExpect(pwApp.lastNavigationStatus()).toBe(200);
      await pwApp.openLink(`${server.url}/bolagy-lab`);
      await pwApp.uploadFile(byLabel(/upload expense receipt/i), {
        name: "pw-receipt.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("pdf"),
      });
      bunExpect(await pwApp.getText({ testID: "file-out" })).toBe("pw-receipt.pdf");
    } finally {
      await Effect.runPromise(pwDriver.killApp("cleanup")).catch(() => {});
    }
  }, 30_000);

  test("4. Promise-only Direct CDP embedding (createCdpApp & launchDirectCdpPage)", async () => {
    const session = await createCdpApp({
      browser,
      baseUrl: server.url,
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      userAgent: "SpanaEmbedUA/1.0",
    });
    try {
      await session.app.openLink("/headers");
      await session.expect({ testID: "srv-ua" }).toHaveText("SpanaEmbedUA/1.0");
      const metrics = await session.app.evaluate<{ dpr: number; touch: boolean; w: number }>(
        "({ dpr: window.devicePixelRatio, touch: 'ontouchstart' in window, w: window.innerWidth })",
      );
      bunExpect(metrics.dpr).toBe(2);
      bunExpect(metrics.touch).toBe(true);
      bunExpect(metrics.w).toBe(390);
      await session.beginFlow("next-embedded-test");
      await session.app.openLink("/status-200");
      bunExpect(session.app.lastNavigationStatus()).toBe(200);
    } finally {
      await session.close();
    }

    const pageSession = await launchDirectCdpPage({ browser, baseUrl: server.url });
    try {
      await pageSession.app.openLink("/status-200");
      await pageSession.expect({ testID: "st" }).toHaveText("OK 200");
    } finally {
      await pageSession.close();
    }
  }, 20_000);

  test("5. Mobile viewport/device config validation & includeHidden on count/isChecked/getAttribute", async () => {
    const validated = validateConfig({
      execution: {
        web: {
          engine: "cdp",
          userAgent: "MobileAgent/1.0",
          httpCredentials: { username: "u", password: "p" },
          viewport: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
          },
          device: {
            name: "iPhone 14",
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            userAgent: "iPhoneUA",
          },
        },
      },
    });
    bunExpect(validated.execution?.web?.viewport?.deviceScaleFactor).toBe(3);
    bunExpect(validated.execution?.web?.httpCredentials?.username).toBe("u");

    await Effect.runPromise(driver.beginFlow!("wave3-mobile-hidden"));
    const { app } = makeAppAndExpect();
    await app.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await app.openLink(`${server.url}/bolagy-lab`);

    const metrics = await app.evaluate<{ dpr: number; touch: boolean }>(
      "({ dpr: window.devicePixelRatio, touch: 'ontouchstart' in window })",
    );
    bunExpect(metrics.dpr).toBe(2);
    bunExpect(metrics.touch).toBe(true);

    // Switching back to desktop (or next hot-cache flow) must restore (any-hover: hover) media query!
    await app.setViewport({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });
    // Navigate to verify the restored desktop hover capability on the next document
    // (Chrome 147 refreshes availableHoverTypes after disabling touch emulation on document load).
    await app.openLink(`${server.url}/bolagy-lab`);
    const restoredHover = await app.evaluate<boolean>("matchMedia('(any-hover: hover)').matches");
    bunExpect(restoredHover).toBe(true);

    // count() defaults to visible only, includeHidden: true counts hidden too
    bunExpect(await app.count(byRole("checkbox"))).toBe(1);
    bunExpect(await app.count(byRole("checkbox"), { includeHidden: true })).toBe(2);
    bunExpect(await app.isChecked({ testID: "hidden-chk" }, { includeHidden: true })).toBe(true);
    bunExpect(
      await app.getAttribute({ testID: "hidden-chk" }, "data-tag", { includeHidden: true }),
    ).toBe("secret-attr");
  }, 20_000);

  test("6. Direct CDP httpCredentials, lastNavigationStatus(), and file:// -> https:// route() with CORS OPTIONS", async () => {
    await Effect.runPromise(driver.beginFlow!("wave3-network-auth-cors"));
    const { app } = makeAppAndExpect();

    // lastNavigationStatus on Direct CDP: 200, 404, 500, 302->200
    await app.openLink(`${server.url}/status-200`);
    bunExpect(app.lastNavigationStatus()).toBe(200);
    await app.openLink(`${server.url}/status-404`);
    bunExpect(app.lastNavigationStatus()).toBe(404);
    await app.openLink(`${server.url}/status-500`);
    bunExpect(app.lastNavigationStatus()).toBe(500);
    await app.openLink(`${server.url}/status-redirect`);
    bunExpect(app.lastNavigationStatus()).toBe(200);

    // Basic Auth via httpCredentials in isolated context
    const authed = await app.newContext({
      httpCredentials: { username: "admin", password: "secret" },
    });
    try {
      await authed.app.openLink(`${server.url}/basic-auth`);
      bunExpect(authed.app.lastNavigationStatus()).toBe(200);
      bunExpect(await authed.app.getText({ testID: "auth-ok" })).toBe("Basic Auth OK");
    } finally {
      await authed.close();
    }

    // Wrong credentials must return 401 cleanly (no infinite auth retry hang)
    const badAuthed = await app.newContext({
      httpCredentials: { username: "admin", password: "wrong" },
    });
    try {
      await badAuthed.app.openLink(`${server.url}/basic-auth`);
      bunExpect(badAuthed.app.lastNavigationStatus()).toBe(401);
      bunExpect(await badAuthed.app.getText({ testID: "auth-denied" })).toBe("Unauthorized");
    } finally {
      await badAuthed.close();
    }

    // file:// page calling https:// API with custom header (triggers CORS preflight OPTIONS!)
    const localHtmlPath = join(tmpDir, "file-cors-test.html");
    writeFileSync(
      localHtmlPath,
      `<!doctype html><html><body>
        <button id="go" data-testid="go">Send</button>
        <div id="res" data-testid="res">idle</div>
        <script>
          document.getElementById("go").addEventListener("click", async () => {
            try {
              const r = await fetch("https://mocked.spana.test/api/data", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Spana-Test": "1" },
                body: JSON.stringify({ hello: "world" })
              });
              const j = await r.json();
              document.getElementById("res").textContent = "ok:" + j.reply;
            } catch (e) {
              document.getElementById("res").textContent = "err:" + String(e);
            }
          });
        </script>
      </body></html>`,
    );

    await app.route("**/api/data", async (route) => {
      await route.fulfill({
        status: 200,
        json: { reply: "mocked-over-cors" },
        headers: { "access-control-allow-origin": "*" },
      });
    });
    await app.openLink(pathToFileURL(localHtmlPath).href);
    await app.tap({ testID: "go" });
    await app.waitForFunction('document.getElementById("res").textContent !== "idle"', undefined, {
      timeout: 4_000,
    });
    bunExpect(await app.getText({ testID: "res" })).toBe("ok:mocked-over-cors");
  }, 25_000);

  test("7. Monotirith fixes: opacity:0/inert, closed select option, evaluate across nav, return keyword, regex upload, half-clipped click, ARIA roles, Set-Cookie domain, child-context screenshot", async () => {
    await Effect.runPromise(driver.beginFlow!("wave3-bolagy-fixes"));
    const { app, expect } = makeAppAndExpect();

    // parseSetCookieHeader leading dot for Domain=
    const parsed = parseSetCookieHeader(
      "session=abc123; Domain=monotirith.localhost; Path=/; HttpOnly",
      new URL("https://app.monotirith.localhost"),
    );
    bunExpect(parsed?.domain).toBe(".monotirith.localhost");

    await app.openLink(`${server.url}/bolagy-lab`);

    // 0.16.0 regression #1: opacity:0 & inert elements visible & focusable (matching Playwright)
    await expect(byRole("button", { name: "Hover Reveal Action" })).toBeVisible();
    await app.focus(byRole("button", { name: "Hover Reveal Action" }));
    await expect({ testID: "focus-log" }).toHaveText("focused-opacity");
    await app.blur(byRole("button", { name: "Hover Reveal Action" }));
    await expect({ testID: "focus-log" }).toHaveText("blurred-opacity");
    await expect(byRole("button", { name: "Inert Button" })).toBeVisible();

    // Closed <select> <option> accessible via byRole("option")
    bunExpect(await app.count(byRole("option", { name: "Sweden" }))).toBe(1);

    // JS keyword "return" inside selector string must NOT corrupt evaluation
    await expect(byRole("button", { name: "VAT return" })).toBeVisible();
    await app.tap(byRole("button", { name: "VAT return" }));
    await expect({ testID: "vat-out" }).toHaveText("vat-submitted");

    // RegExp byLabel in uploadFile over Direct CDP
    await app.uploadFile(byLabel(/upload expense receipt/i), {
      name: "cdp-receipt.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("pdf-bytes"),
    });
    await expect({ testID: "file-out" }).toHaveText("cdp-receipt.pdf");

    // Half-clipped button: geometric center is covered by blocker, visible clipped portion is clickable!
    await app.tap({ testID: "clipped-btn" });
    await expect({ testID: "clip-out" }).toHaveText("clipped-clicked");

    // Implicit ARIA roles & accessible names
    await expect(byRole("table", { name: "Quarterly Ledger" })).toBeVisible();
    await expect(byRole("figure", { name: "Q4 Performance Figure" })).toBeVisible();
    await expect(byRole("meter", { name: "Disk Usage" })).toBeVisible();
    await expect(byRole("status", { name: "Total Summary" })).toBeVisible();
    await expect(byRole("paragraph")).toBeVisible();
    await expect(byRole("strong")).toBeVisible();
    await expect(byRole("button", { name: "Export Report" })).toBeVisible();
    await expect(byRole("button", { name: "Close Modal" })).toBeVisible();
    await expect(byLabel("Demo Video")).toBeVisible();

    // 0.16.0 regression #2: evaluate() across link-triggered navigation does not throw spurious executionContextsCleared
    await app.openLink(`${server.url}/nav-a`);
    await app.tap({ testID: "go-b" });
    const navPageVal = await app.evaluate<string>("window.__NAV_PAGE__ || document.title");
    bunExpect(navPageVal.length).toBeGreaterThan(0);
    await app.waitForFunction('window.__NAV_PAGE__ === "B"', undefined, { timeout: 3_000 });

    // Failure screenshot captured from active failing child context (not blank primary tab)
    const artifactDir = join(tmpDir, "child-ctx-artifacts");
    const failingChildFlow = flow("child-ctx-fail-shot", async ({ app: flowApp }) => {
      // Primary tab stays on about:blank; work happens inside child context!
      const child = await flowApp.newContext({ url: `${server.url}/bolagy-lab` });
      try {
        await child.expect({ testID: "definitely-missing-element" }).toBeVisible({ timeout: 400 });
      } finally {
        await child.close();
      }
    });
    const failRes = await executeFlow(failingChildFlow, driver, {
      appId: server.url,
      platform: "web",
      coordinatorConfig: {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { timeout: 1_000 },
      },
      autoLaunch: false,
      artifactConfig: { captureOnFailure: true, screenshot: true, outputDir: artifactDir },
    });
    bunExpect(failRes.status).toBe("failed");
    const shotAtt = (failRes.attachments ?? []).find((a) => a.name.includes("screenshot"));
    bunExpect(shotAtt).toBeDefined();
    if (shotAtt) {
      const pngBytes = readFileSync(shotAtt.path);
      bunExpect(pngBytes.length).toBeGreaterThan(1000);
    }
  }, 30_000);
});
