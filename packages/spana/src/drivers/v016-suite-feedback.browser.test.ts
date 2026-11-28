import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import {
  buildDirectChromiumLaunchArgs,
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { flow } from "../api/flow.js";
import { executeFlow } from "../core/engine.js";
import { byCss, inFrame } from "../schemas/selector.js";
import type { Element } from "../schemas/element.js";
import type { RawDriverService } from "./raw-driver.js";

const parseJson = (raw: string): Element => JSON.parse(raw) as Element;

let primaryServer: Server;
let secondaryServer: Server;
let baseUrl: string;
let secondaryUrl: string;
let browser: DirectCdpBrowserHandle;

function makeDriverHarness(driver: RawDriverService, url = baseUrl) {
  const cfg = {
    parse: parseJson,
    platform: "web" as const,
    defaults: { timeout: 4000, platform: "web" as const },
  };
  return {
    app: createPromiseApp(driver, url, cfg, undefined, { platform: "web" }),
    spanaExpect: createPromiseExpect(driver, cfg),
  };
}

beforeAll(async () => {
  secondaryServer = createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/oopif") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body>
        <button data-testid="oopif-btn" onclick="window.__oopifClicked=true; this.textContent='OOPIF Clicked'">OOPIF Action</button>
      </body></html>`);
      return;
    }
    if (pathname === "/store-origin") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body>
        <div id="origin-status"></div>
        <script>
          const params = new URLSearchParams(location.search);
          if (params.get("set")) {
            localStorage.setItem("cross_key", params.get("set"));
          }
          document.getElementById("origin-status").textContent = localStorage.getItem("cross_key") || "empty";
        </script>
      </body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => secondaryServer.listen(0, "127.0.0.1", () => r()));
  const secPort = (secondaryServer.address() as AddressInfo).port;
  secondaryUrl = `http://127.0.0.1:${secPort}`;

  primaryServer = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0] ?? "/";
    res.writeHead(200, { "content-type": "text/html" });

    if (pathname === "/home" || pathname === "/") {
      res.end(`<!doctype html><html><head><title>Home Page</title></head><body>
        <h1 data-testid="heading">Welcome Home</h1>
        <a data-testid="go-second" href="/second">Go Second</a>
        <div data-testid="init-val"></div>
        <script>
          document.getElementById = document.getElementById.bind(document);
          const el = document.querySelector('[data-testid="init-val"]');
          if (el) el.textContent = String(window.__flowInjectedFlag ?? "none");
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/second") {
      res.end(`<!doctype html><html><head><title>Second Page</title></head><body>
        <h1 data-testid="second-heading">Second Screen</h1>
        <a data-testid="go-home" href="/home">Back Home</a>
      </body></html>`);
      return;
    }

    if (pathname === "/webauthn") {
      res.end(`<!doctype html><html><body>
        <div data-testid="wa-status">ready</div>
        <script>
          window.registerPasskey = async function(userId) {
            const challenge = new Uint8Array(16);
            crypto.getRandomValues(challenge);
            const cred = await navigator.credentials.create({
              publicKey: {
                challenge,
                rp: { name: "Spana Test", id: location.hostname },
                user: { id: new TextEncoder().encode(userId), name: userId, displayName: userId },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
                timeout: 10000,
              }
            });
            return Boolean(cred && cred.id);
          };
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/multi-origin-host") {
      const mode = rawUrl.includes("set=1") ? "?set=leaked-val" : "";
      res.end(`<!doctype html><html><body>
        <iframe id="cross-storage-frame" src="${secondaryUrl}/store-origin${mode}" style="width:300px;height:80px;"></iframe>
      </body></html>`);
      return;
    }

    if (pathname === "/reload-mid-wait") {
      res.end(`<!doctype html><html><body>
        <div id="root">loading</div>
        <script>
          if (!sessionStorage.getItem("did_reload_once")) {
            sessionStorage.setItem("did_reload_once", "1");
            setTimeout(() => location.reload(), 120);
          } else {
            setTimeout(() => {
              const el = document.createElement("div");
              el.setAttribute("data-testid", "post-reload-ready");
              el.textContent = "Reload Survived";
              document.body.appendChild(el);
            }, 80);
          }
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/rapid-redirect-a") {
      res.end(`<!doctype html><html><body>
        <script>
          history.replaceState({}, "", "/rapid-redirect-b");
          setTimeout(() => history.replaceState({}, "", "/rapid-redirect-c"), 60);
        </script>
        <div data-testid="redir-box">Redirected</div>
      </body></html>`);
      return;
    }

    if (pathname === "/enabled-toggle") {
      res.end(`<!doctype html><html><body>
        <button data-testid="async-btn" disabled>Initially Disabled</button>
        <button data-testid="to-disable">Initially Enabled</button>
        <script>
          setTimeout(() => {
            document.querySelector('[data-testid="async-btn"]').disabled = false;
            document.querySelector('[data-testid="to-disable"]').disabled = true;
          }, 220);
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/popover") {
      res.end(`<!doctype html><html><body style="margin:0;height:2400px;">
        <div style="height:100px;">Top</div>
        <div id="popover-menu" style="position:fixed;top:120px;left:40px;padding:12px;background:#fff;border:1px solid #ccc;z-index:50;">
          <button data-testid="popover-item" style="width:140px;height:36px;" onclick="window.__popoverClicks=(window.__popoverClicks||0)+1">Popover Item</button>
        </div>
        <script>
          window.__scrollCount = 0;
          window.addEventListener("scroll", () => {
            window.__scrollCount++;
            const p = document.getElementById("popover-menu");
            if (p) p.remove();
          }, true);
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/clock-page") {
      res.end(`<!doctype html><html><body>
        <div data-testid="clock-val"></div>
        <script>
          window.__intervalHits = 0;
          window.__rafHits = 0;
          window.startTimers = () => {
            setInterval(() => { window.__intervalHits++; }, 100);
            requestAnimationFrame((ts) => { window.__rafHits++; window.__lastRafTs = ts; });
          };
          document.querySelector('[data-testid="clock-val"]').textContent = String(Date.now());
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/roles") {
      res.end(`<!doctype html><html><body>
        <header data-testid="top-header">Site Header</header>
        <article>
          <header data-testid="article-header">Article Header</header>
          <footer data-testid="article-footer">Article Footer</footer>
        </article>
        <section data-testid="unnamed-section">Plain Section</section>
        <section data-testid="named-section" aria-label="Features">Named Section</section>
        <img data-testid="decorative-img" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10" />
        <img data-testid="labeled-img" alt="Logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10" />
        <table><tr><th data-testid="row-th" scope="row">Row Title</th><th data-testid="col-th" scope="col">Col Title</th></tr></table>
        <a data-testid="no-href-a">No Href Link</a>
        <a data-testid="with-href-a" href="#go">Real Link</a>
      </body></html>`);
      return;
    }

    if (pathname === "/iframes") {
      res.end(`<!doctype html><html><body>
        <iframe id="frame-a" src="/frame-a" style="width:240px;height:80px;"></iframe>
        <iframe id="frame-b" src="/frame-b" style="width:240px;height:80px;"></iframe>
        <iframe id="outer-frame" src="/frame-outer" style="width:280px;height:120px;"></iframe>
        <iframe id="oopif-frame" src="${secondaryUrl}/oopif" style="width:240px;height:80px;"></iframe>
        <div id="late-slot"></div>
        <script>
          setTimeout(() => {
            const f = document.createElement("iframe");
            f.id = "late-frame";
            f.src = "/frame-late";
            f.style.width = "240px";
            f.style.height = "80px";
            document.getElementById("late-slot").appendChild(f);
          }, 220);
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/frame-a") {
      res.end(
        `<!doctype html><html><body><div data-testid="shared-id">From Frame A</div></body></html>`,
      );
      return;
    }
    if (pathname === "/frame-b") {
      res.end(
        `<!doctype html><html><body><div data-testid="shared-id">From Frame B</div></body></html>`,
      );
      return;
    }
    if (pathname === "/frame-outer") {
      res.end(
        `<!doctype html><html><body><iframe id="inner-frame" src="/frame-inner" style="width:240px;height:80px;"></iframe></body></html>`,
      );
      return;
    }
    if (pathname === "/frame-inner") {
      res.end(
        `<!doctype html><html><body><div data-testid="nested-target">Deep Nested Frame</div></body></html>`,
      );
      return;
    }
    if (pathname === "/frame-late") {
      res.end(
        `<!doctype html><html><body><div data-testid="late-target">Late Mounted Frame</div></body></html>`,
      );
      return;
    }

    if (pathname === "/visibility-edges") {
      res.end(`<!doctype html><html><body style="margin:0;height:2400px;">
        <div data-testid="contents-wrap" style="display:contents;">
          <span>Visible Inside Contents</span>
        </div>
        <div style="opacity:0;"><span data-testid="opacity-child">Hidden By Opacity</span></div>
        <div inert><span data-testid="inert-child">Hidden By Inert</span></div>
        <div aria-hidden="true"><span data-testid="aria-hidden-child">Hidden By Aria</span></div>
        <div style="height:1800px;"></div>
        <div data-testid="below-fold">Below The Fold Text 123</div>
      </body></html>`);
      return;
    }

    if (pathname === "/ready-expr") {
      res.end(`<!doctype html><html><body>
        <button data-testid="ready-btn" onclick="window.__readyClicked=document.documentElement.dataset.ready">Ready Btn</button>
        <script>
          setTimeout(() => { document.documentElement.dataset.ready = "yes"; }, 200);
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/p3-widgets") {
      res.end(`<!doctype html><html><body style="margin:0;">
        <div id="drag-zone" style="width:400px;height:150px;background:#eef;">Drag Area</div>
        <input id="locked-cb" data-testid="locked-cb" type="checkbox" onclick="event.preventDefault()" />
        <input id="normal-cb" data-testid="normal-cb" type="checkbox" />
        <input id="file-mime" data-testid="file-mime" type="file" />
        <div data-testid="regex-node" data-present="yes">Order #42 Confirmed</div>
        <script>
          window.__dragEvents = [];
          const dz = document.getElementById("drag-zone");
          dz.addEventListener("mousedown", (e) => window.__dragEvents.push(["down", Math.round(e.clientX), Math.round(e.clientY)]));
          dz.addEventListener("mousemove", (e) => { if (e.buttons) window.__dragEvents.push(["move", Math.round(e.clientX), Math.round(e.clientY)]); });
          dz.addEventListener("mouseup", (e) => window.__dragEvents.push(["up", Math.round(e.clientX), Math.round(e.clientY)]));
        </script>
      </body></html>`);
      return;
    }

    if (pathname === "/fail-fast") {
      res.end(
        `<!doctype html><html><body><div data-testid="static-only">Ready</div></body></html>`,
      );
      return;
    }

    res.end(`<!doctype html><html><body><p>Not found: ${pathname}</p></body></html>`);
  });

  await new Promise<void>((r) => primaryServer.listen(0, "127.0.0.1", () => r()));
  const port = (primaryServer.address() as AddressInfo).port;
  // Use `localhost` (not IP literal) so WebAuthn rp.id is a valid domain while `127.0.0.1` secondaryServer stays cross-origin!
  baseUrl = `http://localhost:${port}`;

  // 1.27: default chromiumSandbox: false launches cleanly on Ubuntu 23.10+ without manual --no-sandbox
  browser = await launchDirectCdpBrowser({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await new Promise<void>((r) => primaryServer?.close(() => r()));
  await new Promise<void>((r) => secondaryServer?.close(() => r()));
}, 20_000);

describe("v0.16.0 migration audit fixes — live Direct CDP Chromium E2E", () => {
  test("1.26, 2.14, 2.16, 1.24, 1.19, 2.27: hot-cache lifecycle, newContext isolation, WebAuthn, permissions/geo/multi-origin & closed context", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: true,
        contextIsolation: "hot-cache",
        virtualAuthenticator: true,
      }),
    );

    try {
      const { app, spanaExpect } = makeDriverHarness(driver);

      // Flow 1: open tabs + closeTab, spawn newContext + close it, use WebAuthn, add initScript/exposeFunction/permissions/geo/multi-origin storage
      await Effect.runPromise(driver.beginFlow!("flow-1"));
      await app.openLink(`${baseUrl}/home`);

      // Test newTab + closeTab (1.26)
      await app.newTab(`${baseUrl}/second`);
      await spanaExpect({ testID: "second-heading" }).toBeVisible();
      await app.closeTab();
      await spanaExpect({ testID: "heading" }).toBeVisible();

      // Test newContext + WebAuthn isolation (2.14) + closed context immediate rejection (2.27)
      await app.openLink(`${baseUrl}/webauthn`);
      const childCtx = await app.newContext({ url: `${baseUrl}/webauthn` });
      const childRegistered = await childCtx.app.evaluate<boolean>(
        "window.registerPasskey('child-user')",
      );
      expect(childRegistered).toBe(true);
      await childCtx.close();

      // 2.27: every method on closed context rejects immediately with "context closed"
      let closedErr = "";
      try {
        await childCtx.app.openLink(`${baseUrl}/home`);
      } catch (e) {
        closedErr = e instanceof Error ? e.message : String(e);
      }
      expect(closedErr.toLowerCase()).toContain("context closed");
      let closedCookieErr = "";
      try {
        await childCtx.app.getCookies();
      } catch (e) {
        closedCookieErr = e instanceof Error ? e.message : String(e);
      }
      expect(closedCookieErr.toLowerCase()).toContain("context closed");

      // 2.14: parent context's WebAuthn ceremony still works after child context closed!
      const parentRegistered = await app.evaluate<boolean>("window.registerPasskey('parent-user')");
      expect(parentRegistered).toBe(true);
      const credsFlow1 = await app.getVirtualCredentials();
      expect(credsFlow1.length).toBeGreaterThanOrEqual(1);

      // 1.19: add initScript + exposeFunction in flow 1
      await app.addInitScript("window.__flowInjectedFlag = 'from-flow-1';");
      await app.exposeFunction("secretFlow1Fn", () => "leaked-fn");
      await app.openLink(`${baseUrl}/home`);
      await spanaExpect({ testID: "init-val" }).toHaveText("from-flow-1");
      expect(await app.evaluate<string>("window.secretFlow1Fn()")).toBe("leaked-fn");

      // 1.24: mutate geolocation, permissions, and cross-origin iframe localStorage
      await app.setGeolocation({ latitude: 59.33, longitude: 18.06 });
      await app.grantPermission("geolocation", { origin: baseUrl });
      await app.openLink(`${baseUrl}/multi-origin-host?set=1`);
      await spanaExpect(inFrame(byCss("#cross-storage-frame"), byCss("#origin-status"))).toHaveText(
        "leaked-val",
      );

      // Flow 2 (hot-cache): everything from Flow 1 must be wiped, activeSlot alive, WebAuthn clean & working!
      await Effect.runPromise(driver.beginFlow!("flow-2"));
      await app.openLink(`${baseUrl}/home`);
      // 1.19: initScript and exposedFunction did NOT leak
      await spanaExpect({ testID: "init-val" }).toHaveText("none");
      const leakedFnType = await app.evaluate<string>("typeof window.secretFlow1Fn");
      expect(leakedFnType).toBe("undefined");

      // 2.16: WebAuthn credentials were cleared in hot-cache AND ceremony still works!
      const credsBeforeFlow2 = await app.getVirtualCredentials();
      expect(credsBeforeFlow2.length).toBe(0);
      await app.openLink(`${baseUrl}/webauthn`);
      const flow2Reg = await app.evaluate<boolean>("window.registerPasskey('flow2-user')");
      expect(flow2Reg).toBe(true);

      // 1.24: cross-origin iframe localStorage was wiped by hot-cache reset
      await app.openLink(`${baseUrl}/multi-origin-host`);
      await spanaExpect(inFrame(byCss("#cross-storage-frame"), byCss("#origin-status"))).toHaveText(
        "empty",
      );

      // 1.26: defensive session recovery if active target was killed externally
      const cdp = driver.getCdpSession?.();
      const raw = driver.getRawPage?.() as { sessionId?: string } | undefined;
      if (cdp) {
        const targetInfo = await cdp.send<{ targetInfo?: { targetId?: string } }>(
          "Target.getTargetInfo",
        );
        if (targetInfo?.targetInfo?.targetId && raw?.sessionId) {
          await cdp
            .send("Target.closeTarget", { targetId: targetInfo.targetInfo.targetId })
            .catch(() => {});
        }
      }
      await Effect.runPromise(driver.beginFlow!("flow-3-recovered"));
      await app.openLink(`${baseUrl}/home`);
      await spanaExpect({ testID: "heading" }).toHaveText("Welcome Home");
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  }, 30_000);

  test("2.13, 2.28, 2.30, 2.24, 1.18, 1.22, 1.17, 1.16: waits, reload recovery, redirects, enabled polling, popover no-scroll, failFastWhenIdle, relative URL, back/forward", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        useBrowserContexts: true,
        freshContextPerFlow: false,
      }),
    );

    try {
      const { app, spanaExpect } = makeDriverHarness(driver, "");

      // 2.28: page reloads mid-wait; waitForElement must NOT exit early on []
      await app.openLink(`${baseUrl}/reload-mid-wait`);
      await spanaExpect({ testID: "post-reload-ready" }).toBeVisible({ timeout: 4000 });
      await spanaExpect({ testID: "post-reload-ready" }).toHaveText("Reload Survived");

      // 1.17: relative URL resolves against current http(s) origin when baseUrl is unset
      await app.openLink("/second");
      await spanaExpect({ testID: "second-heading" }).toBeVisible();
      expect(await app.url()).toBe(`${baseUrl}/second`);

      // 1.16: back() / forward() settle cleanly
      await app.back();
      await app.waitForURL("/reload-mid-wait");
      await app.forward();
      await spanaExpect({ testID: "second-heading" }).toBeVisible();

      // 2.13: rapid redirect caught via navMark
      await app.openLink(`${baseUrl}/rapid-redirect-a`);
      await app.waitForURL("/rapid-redirect-b", { timeout: 2000 });
      await app.waitForURL("/rapid-redirect-c", { timeout: 2000 });

      // 2.24: toBeEnabled / toBeDisabled poll until state flips
      await app.openLink(`${baseUrl}/enabled-toggle`);
      await spanaExpect({ testID: "async-btn" }).toBeEnabled({ timeout: 2000 });
      await spanaExpect({ testID: "to-disable" }).toBeDisabled({ timeout: 2000 });

      // 1.18: already-in-viewport floating popover does NOT trigger window scroll
      await app.openLink(`${baseUrl}/popover`);
      await app.tap({ testID: "popover-item" });
      expect(await app.evaluate<number>("window.__popoverClicks || 0")).toBe(1);
      expect(await app.evaluate<number>("window.__scrollCount || 0")).toBe(0);

      // 1.22: failFastWhenIdle fails fast (~300-1000ms) instead of waiting 5000ms
      await app.openLink(`${baseUrl}/fail-fast`);
      const ffStart = Date.now();
      let ffFailed = false;
      try {
        await spanaExpect({ testID: "does-not-exist-ever" }).toBeVisible({
          timeout: 5000,
          failFastWhenIdle: true,
        });
      } catch {
        ffFailed = true;
      }
      const ffElapsed = Date.now() - ffStart;
      expect(ffFailed).toBe(true);
      // oxlint-disable-next-line landmines/no-elapsed-time-bound -- real-browser perf guard: fail-fast must beat the 5 s timeout; no in-process signal shows that
      expect(ffElapsed).toBeLessThan(2500);

      // 1.17: FlowConfig.baseUrl overrides default appId in executeFlow
      const baseUrlFlow = flow(
        "flow-baseurl-test",
        { baseUrl: `${baseUrl}` },
        async ({ app: fApp, expect: fExp }) => {
          await fApp.openLink("/second");
          await fExp({ testID: "second-heading" }).toHaveText("Second Screen");
        },
      );
      const flowRes = await executeFlow(baseUrlFlow, driver, {
        appId: "about:blank",
        platform: "web",
        coordinatorConfig: { parse: parseJson, platform: "web" },
      });
      expect(flowRes.status).toBe("passed");
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  }, 30_000);

  test("2.9, 2.10, 2.18, 2.21, 2.25, 2.26, 2.29, 2.31, 3.7, 3.21, 3.24, 3.26, 3.27: clock, ARIA roles, iframes, eval cancel, visibility, readyExpression, P3 quick wins", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: false,
        readyExpression:
          "!location.pathname.startsWith('/ready-expr') || document.documentElement.dataset.ready === 'yes'",
      }),
    );

    try {
      const { app, spanaExpect } = makeDriverHarness(driver);

      // 2.9: Fake clock (install running, setFixedTime frozen, pauseAt, fastForward vs runFor, rAF, reload persistence)
      await app.openLink(`${baseUrl}/clock-page`);
      const t0 = Date.parse("2026-06-01T12:00:00.000Z");
      await app.clock.install({ time: t0 });
      // oxlint-disable-next-line landmines/no-fixed-sleep -- proves the installed clock keeps running in real time
      await new Promise((r) => setTimeout(r, 40));
      const runningNow = await app.evaluate<number>(() => Date.now());
      expect(runningNow).toBeGreaterThan(t0);

      await app.clock.setFixedTime(t0);
      // oxlint-disable-next-line landmines/no-fixed-sleep -- proves setFixedTime freezes Date.now while real time passes
      await new Promise((r) => setTimeout(r, 30));
      expect(await app.evaluate<number>(() => Date.now())).toBe(t0);

      await app.clock.pauseAt(t0);
      await app.evaluate("window.startTimers()");
      // fastForward fires 100ms interval AT MOST ONCE over 500ms, plus 1 rAF
      await app.clock.fastForward(500);
      expect(await app.evaluate<number>("window.__intervalHits")).toBe(1);
      expect(await app.evaluate<number>("window.__rafHits")).toBe(1);

      // runFor fires 100ms interval EVERY tick (5 more times over 500ms)
      await app.clock.runFor(500);
      expect(await app.evaluate<number>("window.__intervalHits")).toBe(6);

      // Reload persistence: fake clock survives app.reload()!
      const preReloadNow = await app.evaluate<number>(() => Date.now());
      await app.reload();
      const postReloadText = await app.getText({ testID: "clock-val" });
      expect(Number(postReloadText)).toBe(preReloadNow);
      await app.clock.resume();
      await app.clock.resume();

      // 2.10: WAI-ARIA implicit role accuracy
      await app.openLink(`${baseUrl}/roles`);
      await spanaExpect({ testID: "top-header" }).toHaveRole("banner");
      await spanaExpect({ testID: "article-header" }).toHaveRole("generic");
      await spanaExpect({ testID: "article-footer" }).toHaveRole("generic");
      await spanaExpect({ testID: "unnamed-section" }).toHaveRole("generic");
      await spanaExpect({ testID: "named-section" }).toHaveRole("region");
      await spanaExpect({ testID: "decorative-img" }).toHaveRole("presentation");
      await spanaExpect({ testID: "labeled-img" }).toHaveRole("img");
      await spanaExpect({ testID: "row-th" }).toHaveRole("rowheader");
      await spanaExpect({ testID: "col-th" }).toHaveRole("columnheader");
      await spanaExpect({ testID: "no-href-a" }).toHaveRole("generic");
      await spanaExpect({ testID: "with-href-a" }).toHaveRole("link");

      // 2.18: same-origin pair, nested iframes, OOPIF, late-mounting iframe, missing iframe error
      await app.openLink(`${baseUrl}/iframes`);
      await spanaExpect(inFrame(byCss("#frame-a"), { testID: "shared-id" })).toHaveText(
        "From Frame A",
      );
      await spanaExpect(inFrame(byCss("#frame-b"), { testID: "shared-id" })).toHaveText(
        "From Frame B",
      );
      await spanaExpect(inFrame(byCss("#inner-frame"), { testID: "nested-target" })).toHaveText(
        "Deep Nested Frame",
      );
      await app.frame(byCss("#oopif-frame")).tap({ testID: "oopif-btn" });
      await app
        .frame(byCss("#oopif-frame"))
        .expect({ testID: "oopif-btn" })
        .toHaveText("OOPIF Clicked");
      await spanaExpect(inFrame(byCss("#late-frame"), { testID: "late-target" })).toHaveText(
        "Late Mounted Frame",
      );
      let missingIframeErr = "";
      try {
        await spanaExpect(inFrame(byCss("#no-such-iframe"), { testID: "x" })).toHaveText("x", {
          timeout: 300,
        });
      } catch (e) {
        missingIframeErr = e instanceof Error ? e.message : String(e);
      }
      expect(missingIframeErr).toContain("Iframe matching");

      // 2.21: hung Runtime.evaluate cancels promptly on navigation/context destruction (not 10s!)
      await app.openLink(`${baseUrl}/home`);
      const cancelStart = Date.now();
      const evalPromise = driver.evaluate("new Promise(() => {})").pipe(Effect.result);
      const evalRun = Effect.runPromise(evalPromise);
      setTimeout(() => {
        void Effect.runPromise(driver.openLink(`${baseUrl}/second`)).catch(() => {});
      }, 80);
      const evalOutcome = await evalRun;
      const cancelMs = Date.now() - cancelStart;
      expect(evalOutcome._tag).toBe("Failure");
      // oxlint-disable-next-line landmines/no-elapsed-time-bound -- real-browser regression guard: a hung evaluate must cancel on navigation, not after its 10 s timeout
      expect(cancelMs).toBeLessThan(2000);

      // 2.25 + 2.26 + 2.29 + 2.34: below-the-fold visible, display:contents visible, opacity:0, inert, and aria-hidden visible by testID (Playwright visibility semantics)
      await app.openLink(`${baseUrl}/visibility-edges`);
      await spanaExpect({ testID: "below-fold" }).toBeVisible();
      await spanaExpect({ testID: "below-fold" }).toHaveText(/Below The Fold.*\d+/);
      await spanaExpect({ testID: "contents-wrap" }).toBeVisible();
      await spanaExpect({ testID: "opacity-child" }).toBeVisible();
      await spanaExpect({ testID: "inert-child" }).toBeVisible();
      await spanaExpect({ testID: "aria-hidden-child" }).toBeVisible();

      // 2.31: execution.web.readyExpression gates tap until dataset.ready === "yes"
      await app.openLink(`${baseUrl}/ready-expr`);
      await app.tap({ testID: "ready-btn" });
      expect(await app.evaluate<string>("window.__readyClicked")).toBe("yes");

      // 3.7, 3.21, 3.24, 3.26, 3.27: swipe drag, check verify, uploadFile mimeType, getAttribute null, toHaveText(RegExp)
      await app.openLink(`${baseUrl}/p3-widgets`);
      await Effect.runPromise(driver.swipe(50, 50, 250, 80, 120));
      const dragEvts = await app.evaluate<Array<[string, number, number]>>("window.__dragEvents");
      expect(dragEvts[0]?.[0]).toBe("down");
      expect(dragEvts.some((e) => e[0] === "move")).toBe(true);
      expect(dragEvts[dragEvts.length - 1]?.[0]).toBe("up");

      // 3.21: check() succeeds on normal checkbox, fails loudly on preventDefault locked checkbox
      await app.check({ testID: "normal-cb" });
      await spanaExpect({ testID: "normal-cb" }).toBeChecked();
      let checkFailErr = "";
      try {
        await app.check({ testID: "locked-cb" }, { timeout: 600 });
      } catch (e) {
        checkFailErr = e instanceof Error ? e.message : String(e);
      }
      expect(checkFailErr).toContain("did not become checked");

      // 3.24: uploadFile preserves explicit mimeType
      await app.uploadFile(
        { testID: "file-mime" },
        { name: "report.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n1,2\n") },
      );
      const uploadedMeta = await app.evaluate<{ name: string; type: string; size: number }>(
        `(() => { const f = document.getElementById("file-mime").files[0]; return { name: f.name, type: f.type, size: f.size }; })()`,
      );
      expect(uploadedMeta).toEqual({ name: "report.csv", type: "text/csv", size: 8 });

      // 3.26: getAttribute returns null for missing attribute
      expect(await app.getAttribute({ testID: "regex-node" }, "data-present")).toBe("yes");
      expect(await app.getAttribute({ testID: "regex-node" }, "data-missing")).toBeNull();

      // 3.27: toHaveText(RegExp) and .not.toHaveText(RegExp)
      await spanaExpect({ testID: "regex-node" }).toHaveText(/^Order #\d+ Confirmed$/);
      await spanaExpect({ testID: "regex-node" }).not.toHaveText(/^Order #999/);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  }, 30_000);

  test("1.27: buildDirectChromiumLaunchArgs defaults to --no-sandbox unless chromiumSandbox: true", () => {
    const defaultArgs = buildDirectChromiumLaunchArgs({ userDataDir: "/tmp/spana-test-1" });
    expect(defaultArgs).toContain("--no-sandbox");

    const sandboxedArgs = buildDirectChromiumLaunchArgs({
      userDataDir: "/tmp/spana-test-2",
      chromiumSandbox: true,
    });
    expect(sandboxedArgs).not.toContain("--no-sandbox");
  });
});
