import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { Effect } from "effect";
import {
  buildDirectChromiumLaunchArgs,
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { byCss, byRole, filterSelector, first, inFrame, nth } from "../schemas/selector.js";
import { startWebServers } from "../runtime/web-server.js";

const parseJson = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

describe("v0.17.0 real-world migration fixes — unit & live Direct CDP E2E", () => {
  let primaryServer: http.Server;
  let crossServer: http.Server;
  let primaryUrl: string;
  let crossUrl: string;
  let handle: DirectCdpBrowserHandle;

  beforeAll(async () => {
    crossServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (req.url === "/oopif-dyn") {
        res.end(
          `<!doctype html><html><body><button data-testid="dyn-btn" onclick="document.getElementById('dyn-out').textContent='dyn-ok'">Dyn</button><div id="dyn-out" data-testid="dyn-out">idle</div></body></html>`,
        );
        return;
      }
      res.end("<!doctype html><html><body>cross</body></html>");
    });
    await new Promise<void>((r) => crossServer.listen(0, "127.0.0.1", r));
    const crossAddr = crossServer.address();
    crossUrl = `http://127.0.0.1:${typeof crossAddr === "object" && crossAddr ? crossAddr.port : 0}`;

    primaryServer = http.createServer((req, res) => {
      if (req.url === "/api/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            client: req.headers["x-client"] ?? null,
            extra: req.headers["x-extra"] ?? null,
          }),
        );
        return;
      }
      if (req.url === "/api/items") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ from: "server" }));
        return;
      }
      if (req.url === "/scaled-child") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><body><button style="margin:40px" data-testid="scaled-btn" onclick="document.getElementById('scaled-out').textContent='scaled-ok'">Scaled</button><div id="scaled-out" data-testid="scaled-out">idle</div></body></html>`,
        );
        return;
      }
      if (req.url === "/popup") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body><h1 data-testid="pop-h1">Popup</h1></body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
      <html>
      <head>
        <style>
          .hrow { width: 240px; padding: 8px; border: 1px solid #ccc; }
          .hbtn { display: none; }
          @media (any-hover: hover) and (hover: hover) { .hrow:hover .hbtn { display: inline-block; } }
        </style>
      </head>
      <body>
        <div id="split"></div>
        <p id="md">Read <a href="#x">https://spana.dev</a> today</p>
        <input id="txt-in" type="text" value="OnlyInInputValue" />
        <input id="sub-in" type="submit" value="Submit Form" onclick="document.getElementById('out').textContent='sub-ok'" />
        <div class="upper" style="text-transform: uppercase">hello world</div>
        <button data-testid="bui" id="bui">BaseUI</button>
        <fieldset><legend>Shipping</legend><input aria-label="City" /></fieldset>
        <button aria-pressed="true">Pinned</button>
        <button aria-pressed="false">Muted</button>
        <div class="hrow" data-testid="hrow">Row <button class="hbtn" data-testid="hbtn" onclick="document.getElementById('out').textContent='hovered'">Edit</button></div>
        <aside style="display:none"><button data-testid="dup">Hidden</button></aside>
        <div><button data-testid="dup" onclick="document.getElementById('out').textContent='vis-0'">Vis0</button><button data-testid="dup" onclick="document.getElementById('out').textContent='vis-1'">Vis1</button></div>
        <input data-testid="kinput" />
        <button id="mclick" data-testid="mclick">ModClick</button>
        <a data-testid="pop-link" href="/popup" target="_blank">Pop</a>
        <div style="width:240px;height:140px;overflow:hidden">
          <iframe data-testid="scaled-f" src="/scaled-child" style="width:480px;height:280px;transform:scale(0.5);transform-origin:0 0;border:0"></iframe>
        </div>
        <iframe id="dyn-oopif" data-testid="dyn-oopif" src="about:blank" style="width:200px;height:100px"></iframe>
        <iframe data-testid="sb-f" sandbox="allow-scripts" srcdoc="<!doctype html><html><body><button data-testid='sbb' onclick=&quot;document.getElementById('sbo').textContent='sb-ok'&quot;>SB</button><div id='sbo' data-testid='sbo'>idle</div></body></html>"></iframe>
        <div id="out" data-testid="out">idle</div>
        <div id="ua" data-testid="ua"></div>
        <script>
          const s = document.getElementById("split");
          s.appendChild(document.createTextNode("Bob"));
          s.appendChild(document.createTextNode(" (20 min)"));
          document.getElementById("ua").textContent = navigator.userAgent;
          document.getElementById("bui").addEventListener("pointerdown", (e) => {
            document.getElementById("out").textContent = e.pointerType + ":" + e.buttons;
          });
          document.getElementById("mclick").addEventListener("pointerdown", (e) => {
            document.getElementById("out").textContent = "ctrl=" + e.ctrlKey;
          });
          document.getElementById("mclick").addEventListener("click", (e) => {
            document.getElementById("out").textContent = "ctrl=" + e.ctrlKey;
          });
          window.addEventListener("keydown", (e) => {
            if (e.ctrlKey || e.metaKey || e.key === "F12") {
              e.preventDefault();
              document.getElementById("out").textContent = (e.ctrlKey ? "C+" : e.metaKey ? "M+" : "") + e.key + "(" + e.code + ")";
            }
          });
          setTimeout(() => {
            document.getElementById("dyn-oopif").src = "${crossUrl}/oopif-dyn";
          }, 80);
        </script>
      </body>
      </html>`);
    });
    await new Promise<void>((r) => primaryServer.listen(0, "127.0.0.1", r));
    const addr = primaryServer.address();
    primaryUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    handle = await launchDirectCdpBrowser({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await handle?.close().catch(() => {});
    primaryServer?.close();
    crossServer?.close();
  });

  test("buildDirectChromiumLaunchArgs enables hover/pointer media queries and sandbox flags", () => {
    const args = buildDirectChromiumLaunchArgs({
      headless: true,
      userDataDir: "/tmp/spana-test-profile",
    });
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--hide-scrollbars");
    expect(args).toContain("--mute-audio");
    expect(
      args.some((a) => a.startsWith("--blink-settings=") && a.includes("primaryHoverType=2")),
    ).toBe(true);
  });

  test("webServer inheritEnv: false strips ambient parent env vars while keeping PATH and config.env", async () => {
    process.env.__SPANA_PARENT_SECRET__ = "should-not-leak";
    const srv = await startWebServers(
      {
        command: `node -e 'const h=require("http");const s=h.createServer((q,r)=>{r.end(JSON.stringify({parent:process.env.__SPANA_PARENT_SECRET__||null,explicit:process.env.__SPANA_EXPLICIT__||null}))});s.listen(0,"127.0.0.1",()=>console.log("PORT="+s.address().port))'`,
        url: undefined as unknown as string,
        port: 0,
        inheritEnv: false,
        env: { __SPANA_EXPLICIT__: "present-ok" },
        timeout: 5000,
      },
      { cwd: process.cwd() },
    ).catch(() => null);
    // Test with an explicit free port instead
    delete process.env.__SPANA_PARENT_SECRET__;
    if (srv) await srv.stopAll();

    // Allocate a clean free port
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as { port: number }).port;
    probe.close();

    process.env.__SPANA_PARENT_SECRET__ = "must-not-leak";
    const started = await startWebServers(
      {
        command: `${process.execPath} -e 'const h=require("http");h.createServer((q,r)=>{r.writeHead(200,{"content-type":"application/json"});r.end(JSON.stringify({parent:process.env.__SPANA_PARENT_SECRET__||null,explicit:process.env.__SPANA_EXPLICIT__||null}))}).listen(${port},"127.0.0.1")'`,
        url: `http://127.0.0.1:${port}`,
        inheritEnv: false,
        env: { __SPANA_EXPLICIT__: "ok-123" },
        timeout: 5000,
      },
      { cwd: process.cwd() },
    );
    try {
      const res = await fetch(`http://127.0.0.1:${port}`);
      const json = (await res.json()) as { parent: string | null; explicit: string | null };
      expect(json.parent).toBeNull();
      expect(json.explicit).toBe("ok-123");
    } finally {
      delete process.env.__SPANA_PARENT_SECRET__;
      await started.stopAll();
    }
  }, 15_000);

  test("covers hover media, focus, pointerdown, fieldset/pressed, split text, scaled/dynamic/sandbox iframes, routes, fresh-mode Collie #12, keys, and instant isVisible", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: handle.browserWsUrl,
        baseUrl: primaryUrl,
        freshContextPerFlow: true,
        contextIsolation: "fresh",
        viewport: { width: 1280, height: 800 },
      }),
    );
    const coordCfg = {
      parse: parseJson,
      platform: "web" as const,
      defaults: { timeout: 5000, platform: "web" as const },
    };
    const app = createPromiseApp(driver, primaryUrl, coordCfg, undefined, { platform: "web" });
    const exp = createPromiseExpect(driver, coordCfg);

    try {
      await driver.beginFlow?.("v017-flow-1");
      await app.openLink(primaryUrl);

      // Focus + hover media
      expect(await app.evaluate<boolean>("document.hasFocus()")).toBe(true);
      expect(await app.evaluate<boolean>('window.matchMedia("(any-hover: hover)").matches')).toBe(
        true,
      );
      await app.hover({ testID: "hrow" });
      await app.tap({ testID: "hbtn" });
      await exp({ testID: "out" }).toHaveText("hovered");

      // @base-ui pointerdown buttons===1 & pointerType===mouse
      await app.tap({ testID: "bui" });
      await exp({ testID: "out" }).toHaveText("mouse:1");

      // fieldset -> role=group + legend name, pressed role attr
      await exp(byRole("group", { name: "Shipping" })).toBeVisible();
      await exp(byRole("button", { name: "Pinned", pressed: true })).toBeVisible();
      await exp(byRole("button", { name: "Muted", pressed: false })).toBeVisible();

      // Multi-node split text & RegExp, not matching <input type=text>, matching <input type=submit>
      await exp({ text: "Bob (20 min)" }).toBeVisible();
      await exp({ text: /Read https:\/\/spana\.dev today/ }).toBeVisible();
      expect(await app.isVisible({ text: "OnlyInInputValue" })).toBe(false);
      await app.tap({ text: "Submit Form" });
      await exp({ testID: "out" }).toHaveText("sub-ok");

      // text-transform uppercase hasText
      await exp(filterSelector(byCss(".upper"), { hasText: "hello world" })).toBeVisible();
      await exp(filterSelector(byCss(".upper"), { hasText: "HELLO WORLD" })).toBeVisible();

      // first()/nth() skip hidden drawer before visible controls + instant isVisible
      await app.tap(first({ testID: "dup" }));
      await exp({ testID: "out" }).toHaveText("vis-0");
      await app.tap(nth({ testID: "dup" }, 1));
      await exp({ testID: "out" }).toHaveText("vis-1");
      const t0 = performance.now();
      expect(await app.isVisible({ testID: "nonexistent-fast-check" })).toBe(false);
      expect(performance.now() - t0).toBeLessThan(300);

      // Keyboard chords + held modifier click
      await app.tap({ testID: "kinput" });
      await app.keyboard.press("F12");
      await exp({ testID: "out" }).toHaveText("F12(F12)");
      await app.keyboard.press("ControlOrMeta+k");
      expect(await app.getText({ testID: "out" })).toMatch(/^[CM]\+k\(KeyK\)$/);
      await app.keyboard.down("Control");
      try {
        await app.tap({ testID: "mclick" });
      } finally {
        await app.keyboard.up("Control");
      }
      await exp({ testID: "out" }).toHaveText("ctrl=true");

      // Scaled iframe, dynamic OOPIF (Target.targetInfoChanged), sandboxed allow-scripts srcdoc
      await app.tap(inFrame({ testID: "scaled-f" }, { testID: "scaled-btn" }));
      await exp(inFrame({ testID: "scaled-f" }, { testID: "scaled-out" })).toHaveText("scaled-ok");
      await app.tap(inFrame({ testID: "dyn-oopif" }, { testID: "dyn-btn" }));
      await exp(inFrame({ testID: "dyn-oopif" }, { testID: "dyn-out" })).toHaveText("dyn-ok");
      await app.tap(inFrame({ testID: "sb-f" }, { testID: "sbb" }));
      await exp(inFrame({ testID: "sb-f" }, { testID: "sbo" })).toHaveText("sb-ok");

      // route.fallback() + unroute + multi-tab routed flow
      const h1 = async (r: any) => {
        await r.continue({ headers: { ...r.request().headers, "x-extra": "one" } });
      };
      const h2 = async (r: any) => {
        await r.fallback({ headers: { ...r.request().headers, "x-client": "two" } });
      };
      await app.route("**/api/echo", h1);
      await app.route("**/api/echo", h2);
      const echo1 = await app.evaluate(async () => (await fetch("/api/echo")).json());
      expect(echo1).toEqual({ client: "two", extra: "one" });
      await app.unroute("**/api/echo", h2);
      const echo2 = await app.evaluate(async () => (await fetch("/api/echo")).json());
      expect(echo2).toEqual({ client: null, extra: "one" });

      // Multi-tab with active route then next flow in fresh mode (Collie #12!)
      const pop = await app.waitForPopup(async () => {
        await app.tap({ testID: "pop-link" });
      });
      const tabIds = await app.getTabIds();
      const idx = tabIds.indexOf(pop);
      await app.switchToTab(idx >= 0 ? idx : 1);
      await exp({ testID: "pop-h1" }).toHaveText("Popup");
      await app.closeTab();

      // Flow 2 in fresh mode: MUST NOT hang 10s on Page.navigate!
      await driver.beginFlow?.("v017-flow-2");
      const navStart = performance.now();
      await app.openLink(primaryUrl);
      expect(performance.now() - navStart).toBeLessThan(4000);

      // expect.poll(...).toBeNull() + newContext({ userAgent })
      await exp
        .poll(async () => await app.evaluate<null>('document.querySelector("#nope")'))
        .toBeNull();
      const iso = await app.newContext({ url: primaryUrl, userAgent: "SpanaTestUA/9.9" });
      try {
        await iso.expect({ testID: "ua" }).toHaveText("SpanaTestUA/9.9");
      } finally {
        await iso.close();
      }
    } finally {
      await Effect.runPromise(driver.killApp("test")).catch(() => {});
    }
  }, 30_000);

  test("launchDirectCdpBrowser succeeds with deep TMPDIR > 108 bytes", async () => {
    const deep = `/tmp/spana-deep-test-${"x".repeat(95)}`;
    mkdirSync(deep, { recursive: true });
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = deep;
    let h: DirectCdpBrowserHandle | undefined;
    try {
      h = await launchDirectCdpBrowser({ headless: true });
      expect(h.browserWsUrl).toContain("ws://127.0.0.1:");
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
      await h?.close().catch(() => {});
      rmSync(deep, { recursive: true, force: true });
    }
  }, 15_000);
});
