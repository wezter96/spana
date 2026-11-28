import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "../drivers/cdp-browser.js";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { byCss, byRole, filterSelector, or } from "../schemas/selector.js";
import { classifyError } from "../report/classify-error.js";
import type { Element } from "../schemas/element.js";
import type { RawDriverService } from "../drivers/raw-driver.js";

const parseJson = (raw: string): Element => JSON.parse(raw) as Element;

let server: Server;
let baseUrl: string;
let browser: DirectCdpBrowserHandle;
let driver: RawDriverService;

const PAGES: Record<string, string> = {
  "/sticky": `<!doctype html><html><body style="margin:0;padding:0;height:2400px;">
    <header style="position:fixed;top:0;left:0;right:0;height:90px;background:#111;color:#fff;z-index:100;">Header</header>
    <div style="height:640px;"></div>
    <button data-testid="sticky-target" style="height:40px;width:160px;" onclick="window.__stickyClicks=(window.__stickyClicks||0)+1">Click Sticky</button>
    <div style="height:1400px;"></div>
    <footer class="sticky-footer" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#222;color:#fff;z-index:100;">Footer Bar</footer>
  </body></html>`,

  "/covered": `<!doctype html><html><body style="margin:0;">
    <button data-testid="covered-btn" style="position:fixed;top:100px;left:100px;width:160px;height:50px;" onclick="window.__coveredClicks=(window.__coveredClicks||0)+1">Blocked</button>
    <div id="modal-blocker" class="overlay-shield" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999;">Modal Shield</div>
  </body></html>`,

  "/moving": `<!doctype html><html><body style="margin:0;">
    <button data-testid="slider-btn" style="position:fixed;top:80px;left:10px;width:120px;height:40px;" onclick="window.__clickedLeft=parseFloat(this.style.left)">Slide</button>
    <script>
      const btn = document.querySelector('[data-testid="slider-btn"]');
      let x = 10;
      function tick() {
        x += 30;
        if (x <= 310) {
          btn.style.left = x + "px";
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    </script>
  </body></html>`,

  "/ancestor-hittest": `<!doctype html><html><body style="margin:0;">
    <div id="wrapper" style="position:relative;width:300px;height:200px;">
      <button data-testid="inner-btn" style="position:absolute;top:20px;left:20px;width:140px;height:40px;" onclick="window.__innerClicks=(window.__innerClicks||0)+1">Inner</button>
      <div id="sibling-cover" style="position:absolute;inset:0;background:rgba(255,0,0,0.4);z-index:10;">Cover</div>
    </div>
    <label for="cb-1" style="display:inline-block;position:relative;padding:20px;background:#eee;">
      <input id="cb-1" data-testid="labeled-cb" type="checkbox" style="position:relative;z-index:1;" />
      <span style="position:absolute;inset:0;z-index:2;">Accept terms</span>
    </label>
  </body></html>`,

  "/roles-and-accname": `<!doctype html><html><body>
    <button style="display:none">Hidden Display</button>
    <button style="visibility:hidden">Hidden Vis</button>
    <div aria-hidden="true"><button>Aria Hidden</button></div>
    <button data-testid="real-btn"><span aria-hidden="true">★</span> Save <span style="display:none">draft</span></button>
    <h1>Main Title</h1>
    <h2>Section Title</h2>
    <div role="heading" aria-level="3">Sub Section</div>
    <span id="email-hint">Must be a company email</span>
    <input data-testid="email" aria-label="Email" aria-describedby="email-hint" />
    <button data-testid="desc-btn" aria-description="Deletes the item permanently">Delete</button>
  </body></html>`,

  "/selectors-and-text": `<!doctype html><html><body>
    <div class="card" data-testid="card-1"><h3>Alpha</h3><button>Buy</button></div>
    <div class="card" data-testid="card-2"><h3>Beta</h3><span>Sold out</span><button>Buy</button></div>
    <div class="card" data-testid="card-3"><h3>Gamma</h3><span>Coming soon</span></div>
    <span data-testid="upper" style="text-transform:uppercase;">Submit Order</span>
    <table>
      <tr data-testid="row-1"><td>Alice</td><td>Admin</td><td>Active</td></tr>
    </table>
    <input type="hidden" name="csrf" value="tok-123" />
    <div data-testid="hidden-meta" style="display:none" data-state="ready"></div>
    <ul id="items"><li class="item">One</li><li class="item">Two</li><li class="item">Three</li></ul>
    <div data-testid="or-target">Fallback Hit</div>
  </body></html>`,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const html = PAGES[req.url ?? "/"] ?? "<html><body>Not found</body></html>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  browser = await launchDirectCdpBrowser({ headless: true, warmBrowser: false });
  driver = await Effect.runPromise(
    makeLightweightCdpDriver({
      cdpUrl: browser.browserWsUrl,
      baseUrl,
      useBrowserContexts: true,
    }),
  );
}, 30_000);

afterAll(async () => {
  if (driver) {
    await Effect.runPromise(driver.killApp("test")).catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

function makeHarness() {
  const cfg = {
    parse: parseJson,
    platform: "web" as const,
    defaults: { timeout: 2500, platform: "web" as const },
  };
  return {
    app: createPromiseApp(driver, baseUrl, cfg, undefined, { platform: "web" }),
    spanaExpect: createPromiseExpect(driver, cfg),
  };
}

describe("0.9.0 pilot fixes in real Chromium", () => {
  test("#1a: sticky footer obscuring target scrolls to unobscure and clicks", async () => {
    const { app } = makeHarness();
    await app.openLink(`${baseUrl}/sticky`);
    await app.tap({ testID: "sticky-target" });
    const clicks = await app.evaluate<number>("window.__stickyClicks || 0");
    expect(clicks).toBe(1);
  });

  test("#1b: permanently covered element fails loudly with blocker description and never clicks through", async () => {
    const { app } = makeHarness();
    await app.openLink(`${baseUrl}/covered`);
    let errMsg = "";
    try {
      await app.tap({ testID: "covered-btn" }, { timeout: 500 });
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
    }
    expect(errMsg).toContain("covered by");
    expect(errMsg).toContain("modal-blocker");
    const clicks = await app.evaluate<number>("window.__coveredClicks || 0");
    expect(clicks).toBe(0);
  });

  test("#2: action stability default (2 frames) waits for moving target to settle", async () => {
    const { app } = makeHarness();
    await app.openLink(`${baseUrl}/moving`);
    await app.tap({ testID: "slider-btn" });
    const clickedLeft = await app.evaluate<number>("window.__clickedLeft || 0");
    expect(clickedLeft).toBeGreaterThanOrEqual(280);
  });

  test("#3: hit test rejects sibling/ancestor overlay but accepts associated <label>", async () => {
    const { app } = makeHarness();
    await app.openLink(`${baseUrl}/ancestor-hittest`);
    let errMsg = "";
    try {
      await app.tap({ testID: "inner-btn" }, { timeout: 400 });
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
    }
    expect(errMsg).toContain("covered by");
    expect(await app.evaluate<number>("window.__innerClicks || 0")).toBe(0);

    // Clicking checkbox covered by its own <label> succeeds
    await app.tap({ testID: "labeled-cb" });
    expect(await app.evaluate<boolean>("document.getElementById('cb-1').checked")).toBe(true);
  });

  test("#4, #5, #11a, #11d: role hidden filtering, aria-hidden accName, heading level, accessibleDescription", async () => {
    const { app, spanaExpect } = makeHarness();
    await app.openLink(`${baseUrl}/roles-and-accname`);

    // #4: hidden buttons skipped by default
    expect(await app.count(byRole("button"))).toBe(2);
    expect(await app.count(byRole("button", "Hidden Display"))).toBe(0);
    expect(await app.count(byRole("button", "Hidden Vis"))).toBe(0);
    expect(await app.count(byRole("button", "Aria Hidden"))).toBe(0);

    // #5: accessible name excludes aria-hidden="true" and display:none children
    await spanaExpect(byRole("button", "Save", { exact: true })).toBeVisible();
    await spanaExpect({ testID: "real-btn" }).toHaveAccessibleName("Save");

    // #11a: heading level matching (h1, h2, aria-level=3)
    await spanaExpect(byRole("heading", { level: 1 })).toHaveText("Main Title");
    await spanaExpect(byRole("heading", { level: 2 })).toHaveText("Section Title");
    await spanaExpect(byRole("heading", { level: 3 })).toHaveText("Sub Section");
    expect(await app.count(byRole("heading", { level: 4 }))).toBe(0);

    // #11d: toHaveAccessibleDescription & .not.toHaveAccessibleDescription
    await spanaExpect({ testID: "email" }).toHaveAccessibleDescription("Must be a company email");
    await spanaExpect({ testID: "desc-btn" }).toHaveAccessibleDescription(/permanently/i);
    await spanaExpect({ testID: "desc-btn" }).not.toHaveAccessibleDescription("Wrong desc");
  });

  test("#11b, #11c, #11f, #11g, #11h, #11i: or, filter has/hasNot, .not, count, toPass/poll, textContent, getText tr, boxless getAttribute, fill error", async () => {
    const { app, spanaExpect } = makeHarness();
    await app.openLink(`${baseUrl}/selectors-and-text`);

    // #11b: or() + filterSelector({ has, hasNot }) + .not.*
    await spanaExpect(or({ testID: "missing-x" }, { testID: "or-target" })).toHaveText(
      "Fallback Hit",
    );
    const buyableCard = filterSelector(byCss(".card"), {
      has: byRole("button", "Buy"),
      hasNot: { text: "Sold out" },
    });
    expect(await app.count(buyableCard)).toBe(1);
    await spanaExpect(buyableCard).toContainText("Alpha");

    await spanaExpect({ testID: "missing-x" }).not.toBeVisible({ timeout: 500 });
    await spanaExpect({ testID: "upper" }).not.toHaveText("Cancel", { timeout: 500 });
    await spanaExpect(byCss("li.item")).not.toHaveCount(2, { timeout: 500 });
    await spanaExpect.not.toHaveURL("/does-not-match", { timeout: 500 });

    // #11c: app.count + expect(fn).toPass + expect.poll
    expect(await app.count(byCss("li.item"))).toBe(3);
    expect(await app.count(byCss(".nonexistent"))).toBe(0);

    let tries = 0;
    await spanaExpect(async () => {
      tries += 1;
      if (tries < 2) throw new Error("not ready yet");
    }).toPass({ timeout: 1000, intervals: [20] });
    expect(tries).toBe(2);

    let polled = 0;
    await spanaExpect
      .poll(
        async () => {
          polled += 1;
          return polled;
        },
        { timeout: 1000, intervals: [20] },
      )
      .toBe(3);
    expect(polled).toBe(3);

    // #11f: CSS text-transform: uppercase does not break toHaveText/toContainText/toMatchText
    await spanaExpect({ testID: "upper" }).toHaveText("Submit Order");
    await spanaExpect({ testID: "upper" }).toContainText("Submit");
    await spanaExpect({ testID: "upper" }).toMatchText(/^Submit Order$/);

    // #11g: getText on <tr> returns full row text
    const rowText = await app.getText({ testID: "row-1" });
    expect(rowText).toContain("Alice");
    expect(rowText).toContain("Admin");
    expect(rowText).toContain("Active");

    // #11h: getAttribute works on elements without a layout box
    expect(await app.getAttribute(byCss("input[name='csrf']"), "value")).toBe("tok-123");
    expect(await app.getAttribute({ testID: "hidden-meta" }, "data-state")).toBe("ready");

    // #11i: fill on missing target fails cleanly with ElementNotFoundError (not raw CDP timeout)
    let fillErr: unknown;
    try {
      await app.fill({ testID: "no-such-input" }, "hello", { timeout: 300 });
    } catch (e) {
      fillErr = e;
    }
    expect(fillErr).toBeDefined();
    expect(classifyError(fillErr as Error).category).toBe("element-not-found");
    expect(String(fillErr)).toContain("not fillable");
    expect(String(fillErr)).not.toContain("Runtime.evaluate");
  });
});
