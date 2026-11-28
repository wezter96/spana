import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";
import { createPromiseApp } from "../api/app.js";
import { byCss } from "../schemas/selector.js";
import type { Element } from "../schemas/element.js";
import type { RawDriverService } from "./raw-driver.js";

const parseJson = (raw: string): Element => JSON.parse(raw) as Element;

let server: Server;
let baseUrl: string;
let browser: DirectCdpBrowserHandle;
let driver: RawDriverService;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "spana-cdp-browser-test-"));
  server = createServer((req, res) => {
    if (req.url === "/beforeunload") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>
        <input id="dirty" />
        <script>
          window.addEventListener("beforeunload", (e) => {
            e.preventDefault();
            e.returnValue = "";
          });
        </script>
      </body></html>`);
      return;
    }
    if (req.url === "/after") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><div data-testid="arrived">Arrived</div></body></html>`);
      return;
    }
    if (req.url === "/late-upload") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>
        <div id="mount"></div>
        <script>
          setTimeout(() => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.setAttribute("data-testid", "late-file");
            inp.addEventListener("change", () => {
              window.__uploadedName = inp.files && inp.files[0] ? inp.files[0].name : "";
            });
            document.getElementById("mount").appendChild(inp);
          }, 250);
        </script>
      </body></html>`);
      return;
    }
    if (req.url === "/popup-opener") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>
        <button data-testid="open-popup" onclick="window.open('/popup-child', '_blank')">Open Popup</button>
      </body></html>`);
      return;
    }
    if (req.url === "/popup-child") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body>
        <script>fetch('/api/popup-data').then(r => r.json()).then(d => { window.__popupData = d; });</script>
      </body></html>`);
      return;
    }
    if (req.url === "/api/popup-data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, from: "popup-tab" }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
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
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}, 20_000);

describe("CDP browser driver 0.9.0 fixes", () => {
  test("#8: beforeunload dialog is auto-accepted and does not stall navigation", async () => {
    const app = createPromiseApp(
      driver,
      baseUrl,
      { parse: parseJson, platform: "web", defaults: { timeout: 3000, platform: "web" } },
      undefined,
      { platform: "web" },
    );
    await app.openLink(`${baseUrl}/beforeunload`);
    // Interact with the page so Chrome considers the page user-activated (required for beforeunload)
    await app.fill(byCss("#dirty"), "unsaved edit");
    await app.openLink(`${baseUrl}/after`);
    expect(await app.getText({ testID: "arrived" })).toBe("Arrived");
  });

  test("#9: uploadFile waits for asynchronously mounted <input type='file'>", async () => {
    const app = createPromiseApp(
      driver,
      baseUrl,
      { parse: parseJson, platform: "web", defaults: { timeout: 3000, platform: "web" } },
      undefined,
      { platform: "web" },
    );
    const samplePath = join(tmpDir, "hello.txt");
    writeFileSync(samplePath, "hello spana 0.9", "utf8");

    await app.openLink(`${baseUrl}/late-upload`);
    await app.uploadFile({ testID: "late-file" }, samplePath);
    const name = await app.evaluate<string>("window.__uploadedName || ''");
    expect(name).toBe("hello.txt");
  });

  test("#11e: waitForResponse captures responses initiated by a newly opened tab", async () => {
    const app = createPromiseApp(
      driver,
      baseUrl,
      { parse: parseJson, platform: "web", defaults: { timeout: 5000, platform: "web" } },
      undefined,
      { platform: "web" },
    );
    await app.openLink(`${baseUrl}/popup-opener`);
    const waitPromise = app.waitForResponse("/api/popup-data", { timeout: 5000 });
    await app.tap({ testID: "open-popup" });
    const res = await waitPromise;
    expect(res.status).toBe(200);
    expect(res.url).toContain("/api/popup-data");
    const json = await res.json!<{ ok: boolean; from: string }>();
    expect(json).toEqual({ ok: true, from: "popup-tab" });
  });
});
