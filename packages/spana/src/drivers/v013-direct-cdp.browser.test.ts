import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import { allocateFreePort } from "../core/port-allocator.js";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { parseWebHierarchy } from "./playwright-parser.js";
import { byCss, byLabel, byRole, inFrame } from "../schemas/selector.js";

describe("Spana v0.13.0 Direct CDP parity & isolation regressions", () => {
  let server: Server;
  let port: number;
  let browser: DirectCdpBrowserHandle;

  beforeAll(async () => {
    port = await allocateFreePort(19_400);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname === "/echo-lang") {
        const al = req.headers["accept-language"] ?? "";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><body><p id="al">${al}</p><p id="nav"></p><script>document.getElementById("nav").textContent = navigator.language;</script></body></html>`,
        );
        return;
      }
      if (url.pathname === "/redirect-post" && req.method === "POST") {
        res.writeHead(303, { location: "/redirect-target" });
        res.end();
        return;
      }
      if (url.pathname === "/redirect-target") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body><h1>Redirected</h1></body></html>`);
        return;
      }
      if (url.pathname === "/frame-child") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <h1>Inside Cross-Origin Frame</h1>
          <button id="frame-btn" onclick="document.getElementById('frame-out').textContent='clicked'">Frame Action</button>
          <p id="frame-out">idle</p>
        </body></html>`);
        return;
      }
      if (url.pathname === "/frame-host") {
        // Same-site cross-origin iframe (b.localhost inside a.localhost): Chromium puts this in-process
        // without creating an OOPIF target, while SOP blocks iframe.contentDocument.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <h1>Host Page</h1>
          <iframe title="Preview Frame" src="http://b.localhost:${port}/frame-child" style="width:400px;height:200px;border:1px solid #ccc;"></iframe>
        </body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
      <html lang="en">
      <head><meta charset="utf-8"><title>v0.13 Direct CDP Fixture</title></head>
      <body>
        <main>
          <h1>Fixture</h1>
          <button type="button" id="add-btn">Add block</button>
          <label for="slot-sel">Add block</label>
          <select id="slot-sel">
            <option value="">Choose...</option>
          </select>

          <ul aria-label="Outline">
            <li><button type="button">Root Item</button></li>
          </ul>
          <ul>
            <li>Outline decoy text inside unnamed list</li>
          </ul>

          <div id="dnd-src" draggable="true" style="width:100px;height:40px;background:#333;color:#fff;">Drag HTML5</div>
          <div id="dnd-dst" style="width:120px;height:60px;background:#666;color:#fff;margin-top:8px;">Drop HTML5</div>
          <p id="dnd-result">none</p>

          <form method="POST" action="/redirect-post">
            <button type="submit">Submit 303</button>
          </form>
        </main>
        <script>
          // Async <option> arrives after 180ms to verify selectOption() auto-wait
          setTimeout(() => {
            const opt = document.createElement("option");
            opt.value = "left";
            opt.textContent = "Left Column";
            document.getElementById("slot-sel").appendChild(opt);
          }, 180);

          const src = document.getElementById("dnd-src");
          const dst = document.getElementById("dnd-dst");
          const out = document.getElementById("dnd-result");
          let dragged = "";
          src.addEventListener("dragstart", (e) => {
            dragged = "hero-1";
            if (e.dataTransfer) e.dataTransfer.setData("text/plain", "hero-1");
          });
          dst.addEventListener("dragover", (e) => e.preventDefault());
          dst.addEventListener("drop", (e) => {
            e.preventDefault();
            const val = (e.dataTransfer && e.dataTransfer.getData("text/plain")) || dragged;
            out.textContent = "dropped:" + val;
          });
        </script>
      </body>
      </html>`);
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    browser = await launchDirectCdpBrowser({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("resets locale, viewport, routes, network, storage and extra tabs cleanly in hot-cache mode", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl: `http://127.0.0.1:${port}`,
        useBrowserContexts: true,
        freshContextPerFlow: true,
        contextIsolation: "hot-cache",
      }),
    );
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const coordConfig = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 5_000, pollInterval: 50 },
      };
      const app = createPromiseApp(driver, baseUrl, coordConfig, undefined, { platform: "web" });

      // Flow 1: mutate locale, viewport, route, extra tab, and localStorage
      await Effect.runPromise(driver.beginFlow!("flow-1"));
      await app.setEmulation({ locale: "sv-SE" });
      await app.setViewport({ width: 390, height: 844 });
      await app.route("**/blocked-path", (r) => r.fulfill({ status: 200, body: "mocked" }));
      await app.openLink(`http://127.0.0.1:${port}/echo-lang`);
      const svLang = await app.evaluate<string>(`document.getElementById("al")?.textContent ?? ""`);
      expect(svLang).toContain("sv-SE");
      const vp1 = await app.evaluate<{ w: number; h: number }>(
        `({ w: window.innerWidth, h: window.innerHeight })`,
      );
      expect(vp1).toEqual({ w: 390, h: 844 });
      await app.evaluate(`localStorage.setItem("leak-test", "dirty")`);
      // Also verify newTab works cleanly on Chromium 145+ without Target position error
      const tab2 = await app.newTab(`http://127.0.0.1:${port}/redirect-target`);
      expect(tab2).toBeTruthy();

      // Flow 2: beginFlow() in hot-cache must reset EVERYTHING
      await Effect.runPromise(driver.beginFlow!("flow-2"));
      await app.openLink(`http://127.0.0.1:${port}/echo-lang`);
      const al2 = await app.evaluate<string>(`document.getElementById("al")?.textContent ?? ""`);
      expect(al2).not.toContain("sv-SE");
      const vp2 = await app.evaluate<{ w: number; h: number }>(
        `({ w: window.innerWidth, h: window.innerHeight })`,
      );
      expect(vp2).toEqual({ w: 1280, h: 720 });
      const leaked = await app.evaluate<string | null>(`localStorage.getItem("leak-test")`);
      expect(leaked).toBeNull();
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });

  it("handles byLabel, byRole('list'), async selectOption, HTML5 dragTo, 303 waitForResponse, same-site cross-origin frame, and cached axe", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl: `http://127.0.0.1:${port}`,
        useBrowserContexts: true,
        contextIsolation: "hot-cache",
      }),
    );
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const coordConfig = {
        parse: parseWebHierarchy,
        platform: "web" as const,
        defaults: { timeout: 5_000, pollInterval: 50 },
      };
      const app = createPromiseApp(driver, baseUrl, coordConfig, undefined, { platform: "web" });
      const pExpect = createPromiseExpect(driver, { parse: parseWebHierarchy, platform: "web" });

      await app.openLink(`http://127.0.0.1:${port}/`);

      // 1. byLabel("Add block") targets the <select>, NEVER <button>Add block</button>, and selectOption auto-waits for async <option>
      const selected = await app.selectOption(byLabel("Add block"), "left");
      expect(selected).toEqual(["left"]);

      // 2. byRole("list", "Outline") matches ONLY <ul aria-label="Outline">, NOT unnamed <ul> whose textContent contains "Outline"
      await pExpect(byRole("list", "Outline")).toHaveCount(1);
      await pExpect(byRole("list", "Outline")).toContainText("Root Item");

      // 3. HTML5 draggable="true" dragTo dispatches DragEvent with DataTransfer
      await app.dragTo(byCss("#dnd-src"), byCss("#dnd-dst"));
      await pExpect(byCss("#dnd-result")).toHaveText("dropped:hero-1");

      // 4. Cached axe-core: second accessibilityAudit on the same SPA skips re-injecting 580KB axe.js
      const audit1 = await app.accessibilityAudit();
      expect(audit1.violations).toBeArray();
      // Tag the loaded axe instance; a re-injection would replace it and drop the tag.
      await app.evaluate("window.axe.__spanaCacheProbe = true");
      const audit2 = await app.accessibilityAudit();
      expect(audit2.violations).toBeArray();
      expect(await app.evaluate<boolean>("window.axe.__spanaCacheProbe === true")).toBe(true);

      // 5. waitForResponse captures 303 redirectResponse with original POST method
      const [redirectRes] = await Promise.all([
        app.waitForResponse((r) => r.url.includes("/redirect-post") && r.method === "POST"),
        app.tap(byRole("button", "Submit 303")),
      ]);
      expect(redirectRes.status).toBe(303);
      await pExpect(byRole("heading", "Redirected")).toBeVisible();

      // 6. Same-site cross-origin iframe (b.localhost inside a.localhost) works via app.frame()
      await app.openLink(`http://a.localhost:${port}/frame-host`);
      const frame = app.frame('iframe[title="Preview Frame"]');
      await pExpect(
        inFrame('iframe[title="Preview Frame"]', byRole("heading", "Inside Cross-Origin Frame")),
      ).toBeVisible();
      await frame.tap(byRole("button", "Frame Action"));
      await pExpect(inFrame('iframe[title="Preview Frame"]', byCss("#frame-out"))).toHaveText(
        "clicked",
      );
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });
});
