import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import { createPromiseApp } from "../api/app.js";
import { createPromiseExpect } from "../api/expect.js";
import { byCss, byLabel, inFrame } from "../schemas/selector.js";
import { launchDirectCdpBrowser, makeLightweightCdpDriver } from "./cdp-browser.js";

const parseJson = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const HTML_PAGE = `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8" />
  <title>Wave 2 Fixes Fixture</title>
  <style>
    body { margin: 0; font-family: sans-serif; }
    .spacer { height: 2200px; background: linear-gradient(#f8fafc, #e2e8f0); }
    .sr-only-input { display: none; }
  </style>
</head>
<body>
  <main>
    <!-- 1. Async enabled/disabled + fieldset disabled + ancestor aria-disabled + hidden file input -->
    <button id="async-en-btn" data-testid="async-en-btn" disabled>Will Enable</button>
    <button id="async-dis-btn" data-testid="async-dis-btn">Will Disable</button>
    <fieldset id="fs-dis" disabled>
      <button id="fs-child-btn" data-testid="fs-child-btn">Fieldset Child</button>
    </fieldset>
    <div id="aria-dis-parent" aria-disabled="true">
      <button id="aria-child-btn" data-testid="aria-child-btn">Aria Child</button>
    </div>
    <label class="upload-label">
      Upload
      <input id="hidden-file" data-testid="hidden-file" type="file" disabled class="sr-only-input" />
    </label>

    <!-- 2. WebGL / Canvas for addInitScript isolation test -->
    <canvas id="probe-canvas" width="40" height="40"></canvas>

    <!-- 3. Unicode NBSP & narrow NBSP price formatting (sv-SE) -->
    <div id="nbsp-price" data-testid="nbsp-price">4\u00a0200\u00a0000\u00a0kr</div>
    <div id="nnbsp-price" data-testid="nnbsp-price">9\u202f500\u202fkr</div>

    <!-- 4. Sandboxed same-origin iframe WITHOUT allow-scripts -->
    <iframe
      id="sb-noscript"
      data-testid="sb-noscript"
      sandbox="allow-same-origin"
      width="320"
      height="140"
      srcdoc="<!doctype html><html><body><h3 data-testid='sb-heading'>Sandboxed Portal</h3><input id='sb-in' data-testid='sb-in' value='' /><div id='sb-badge' data-testid='sb-badge'>visible-badge</div></body></html>"
    ></iframe>

    <!-- 5. Label with nested <span> + sibling <input> via for= -->
    <div class="work-add-pic">
      <label for="_r_3_-alt"><span>Lägg till en bild i galleriet</span>: <span>beskriv bilden</span></label>
      <input id="_r_3_-alt" data-testid="span-label-input" type="text" value="" />
    </div>

    <!-- 6. Non-ASCII Swedish keyboard.type targets -->
    <input id="sv-input" data-testid="sv-input" type="text" value="" />
    <div id="sv-ce" data-testid="sv-ce" contenteditable="true" style="min-height:24px;border:1px solid #999;"></div>

    <div class="spacer">Spacer</div>

    <!-- 7. Off-fold aria-disabled button for { force: true } scrollIntoView + scrollUntilVisible -->
    <button
      id="off-fold-force-btn"
      data-testid="off-fold-force-btn"
      aria-disabled="true"
      onclick="document.getElementById('off-fold-out').textContent='forced-clicked:' + Math.round(window.scrollY)"
    >Off-Fold Force Target</button>
    <div id="off-fold-out" data-testid="off-fold-out">idle</div>
  </main>
  <script>
    setTimeout(() => {
      document.getElementById('async-en-btn').disabled = false;
      document.getElementById('async-dis-btn').disabled = true;
    }, 120);
  </script>
</body>
</html>`;

describe("v0.18 Wave-2 zero-bug fixes (Direct CDP)", () => {
  let server: Server;
  let baseUrl = "";
  let lastSeenUa = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastSeenUa = String(req.headers["user-agent"] ?? "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HTML_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  for (const isolation of ["fresh", "hot-cache"] as const) {
    test(`verifies all Wave-2 fixes under Direct CDP (${isolation})`, async () => {
      const browser = await launchDirectCdpBrowser({ headless: true });
      try {
        const driver = await Effect.runPromise(
          makeLightweightCdpDriver({
            cdpUrl: browser.browserWsUrl,
            baseUrl,
            useBrowserContexts: true,
            freshContextPerFlow: true,
            contextIsolation: isolation,
            waitUntil: "domcontentloaded",
          }),
        );
        const coordCfg = {
          parse: parseJson,
          platform: "web" as const,
          defaults: { timeout: 5_000, platform: "web" as const },
        };
        const app = createPromiseApp(driver, baseUrl, coordCfg, undefined, { platform: "web" });
        const exp = createPromiseExpect(driver, coordCfg);

        // --- Flow 1: addInitScript overrides canvas getContext + verify all Wave-2 features ---
        await Effect.runPromise(driver.beginFlow!("wave2-flow-1"));
        await app.addInitScript(() => {
          (globalThis as any).HTMLCanvasElement.prototype.getContext = () => null;
        });
        await app.openLink("/");

        // 8. Default HeadlessChrome UA sanitized to Chrome/ in both HTTP header & navigator.userAgent
        const navUa = await app.evaluate<string>("navigator.userAgent");
        expect(navUa).toContain("Chrome/");
        expect(navUa).not.toContain("HeadlessChrome");
        expect(lastSeenUa).toContain("Chrome/");
        expect(lastSeenUa).not.toContain("HeadlessChrome");

        // Verify Flow 1's init script took effect in Flow 1
        const flow1Canvas = await app.evaluate<boolean>(
          'Boolean(document.getElementById("probe-canvas") && document.getElementById("probe-canvas").getContext("2d") === null)',
        );
        expect(flow1Canvas).toBe(true);

        // 1. toBeEnabled / toBeDisabled / .not.* (async transitions + fieldset + aria-disabled + hidden input)
        await exp({ testID: "async-en-btn" }).toBeEnabled({ timeout: 3_000 });
        await exp({ testID: "async-en-btn" }).not.toBeDisabled({ timeout: 1_000 });
        await exp({ testID: "async-dis-btn" }).toBeDisabled({ timeout: 3_000 });
        await exp({ testID: "async-dis-btn" }).not.toBeEnabled({ timeout: 1_000 });
        await exp({ testID: "fs-child-btn" }).toBeDisabled({ timeout: 1_000 });
        await exp({ testID: "aria-child-btn" }).toBeDisabled({ timeout: 1_000 });
        await exp({ testID: "hidden-file" }).toBeDisabled({ timeout: 1_000 });

        // 5. Unicode NBSP (\u00a0) & narrow NBSP (\u202f) text & hasText normalization
        await exp({ text: "4 200 000 kr" }).toBeVisible({ timeout: 2_000 });
        await exp({ text: "4 200 000 kr", exact: true }).toBeVisible({ timeout: 2_000 });
        await exp(byCss("div", { hasText: "4 200 000 kr" })).toBeVisible({ timeout: 2_000 });
        await exp({ testID: "nbsp-price" }).toHaveText("4 200 000 kr");
        await exp({ testID: "nbsp-price" }).toContainText("200 000");
        await exp({ testID: "nbsp-price" }).toHaveText(/4 200 000 kr/);
        await exp({ text: "9 500 kr", exact: true }).toBeVisible({ timeout: 2_000 });

        // 6. Sandboxed same-origin iframe WITHOUT allow-scripts: DOM query, fill, waitForHidden, frame.evaluate
        const sbFrame = app.frame({ testID: "sb-noscript" });
        await sbFrame.expect({ testID: "sb-heading" }).toHaveText("Sandboxed Portal");
        await sbFrame.fill({ testID: "sb-in" }, "portal-ok");
        await sbFrame.expect({ testID: "sb-in" }).toHaveValue("portal-ok");
        const evalRes = await sbFrame.evaluate((doc: any, _win: any, tag: string) => {
          const badge = doc.getElementById("sb-badge");
          if (badge) badge.style.display = "none";
          return `${doc.getElementById("sb-in")?.value}:${tag}`;
        }, "parent-realm");
        expect(evalRes).toBe("portal-ok:parent-realm");
        await exp(inFrame({ testID: "sb-noscript" }, { testID: "sb-badge" })).not.toBeVisible({
          timeout: 2_000,
        });

        // 7. app.evaluate recursive undefined, NaN, Infinity, -0, Date, RegExp serialization
        const evalPayload = await app.evaluate(
          (
            tuple: [string, string, unknown],
            obj: { a: number; b?: number; nested: unknown[] },
            special: { nan: number; inf: number; negZero: number; date: Date; re: RegExp },
          ) => ({
            isUndefItem: tuple[2] === undefined,
            tupleLen: tuple.length,
            hasBKey: "b" in obj,
            bIsUndef: obj.b === undefined,
            nestedUndef: obj.nested[1] === undefined,
            isNaN: Number.isNaN(special.nan),
            isInf: special.inf === Infinity,
            isNegZero: Object.is(special.negZero, -0),
            dateMs: special.date instanceof Date ? special.date.getTime() : -1,
            reMatch: special.re instanceof RegExp && special.re.test("Wave2"),
          }),
          ["GET", "/api/items", undefined],
          { a: 1, b: undefined, nested: [10, undefined, 30] },
          {
            nan: Number.NaN,
            inf: Number.POSITIVE_INFINITY,
            negZero: -0,
            date: new Date(1_700_000_000_000),
            re: /wave2/i,
          },
        );
        expect(evalPayload).toEqual({
          isUndefItem: true,
          tupleLen: 3,
          hasBKey: true,
          bIsUndef: true,
          nestedUndef: true,
          isNaN: true,
          isInf: true,
          isNegZero: true,
          dateMs: 1_700_000_000_000,
          reMatch: true,
        });

        // 9. byLabel with <label for="_r_3_-alt"><span>...</span>: <span>...</span></label> sibling <input>
        await app.fill(byLabel("Lägg till en bild i galleriet: beskriv bilden"), "Kök i ek");
        await exp({ testID: "span-label-input" }).toHaveValue("Kök i ek");

        // 10. Non-ASCII Swedish + shifted punctuation keyboard.type in both <input> and contenteditable
        await app.tap({ testID: "sv-input" });
        await app.keyboard.type("Vårkampanj: 20 % på blandare (!@#$%^&*) — åäöÅÄÖ");
        await exp({ testID: "sv-input" }).toHaveValue(
          "Vårkampanj: 20 % på blandare (!@#$%^&*) — åäöÅÄÖ",
        );
        await app.tap({ testID: "sv-ce" });
        await app.keyboard.type("Älskad övning ÅÄÖ");
        await exp({ testID: "sv-ce" }).toHaveText("Älskad övning ÅÄÖ");

        // 4a. scrollUntilVisible scrolls an off-fold web element into the viewport
        await app.scrollUntilVisible({ testID: "off-fold-force-btn" });
        const scrollAfterUntilVisible = await app.evaluate<number>("window.scrollY");
        expect(scrollAfterUntilVisible).toBeGreaterThan(1000);

        // 4b. Reset scroll to top, then tap off-fold aria-disabled button with { force: true } -> MUST scrollIntoView first!
        await app.evaluate("window.scrollTo(0, 0)");
        expect(await app.evaluate<number>("window.scrollY")).toBe(0);
        await app.tap({ testID: "off-fold-force-btn" }, { force: true });
        await exp({ testID: "off-fold-out" }).toContainText("forced-clicked:");
        const scrollAfterForceTap = await app.evaluate<number>("window.scrollY");
        expect(scrollAfterForceTap).toBeGreaterThan(1000);

        // Emulation locale mutation should keep sanitized Chrome/ UA
        await app.setEmulation({ locale: "sv-SE" });
        const svUa = await app.evaluate<string>("navigator.userAgent");
        expect(svUa).toContain("Chrome/");
        expect(svUa).not.toContain("HeadlessChrome");

        // --- Flow 2 on SAME worker: Flow 1's addInitScript MUST NOT leak! ---
        await Effect.runPromise(driver.beginFlow!("wave2-flow-2"));
        await app.openLink("/");
        const flow2Canvas = await app.evaluate<boolean>(
          'Boolean(document.getElementById("probe-canvas") && document.getElementById("probe-canvas").getContext("2d") !== null)',
        );
        expect(flow2Canvas).toBe(true);
        const flow2Ua = await app.evaluate<string>("navigator.userAgent");
        expect(flow2Ua).toContain("Chrome/");
        expect(flow2Ua).not.toContain("HeadlessChrome");

        await Effect.runPromise(driver.killApp(""));
      } finally {
        await browser.close();
      }
    });
  }
});
