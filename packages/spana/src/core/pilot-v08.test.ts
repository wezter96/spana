import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  allocateFreePort,
  assertPortAvailable,
  byCss,
  byRole,
  createRemoteFlowClaimer,
  extractCodeFrame,
  filterSelector,
  first,
  flow,
  inFrame,
  isPortAvailable,
  last,
  nth,
  PersonaAuthCache,
  planProcessPool,
  startSharedFlowQueueServer,
  VirtualCredentialStore,
  within,
} from "../index.js";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "../drivers/cdp-browser.js";
import { makePlaywrightDriver } from "../drivers/playwright.js";
import { parseWebHierarchy } from "../drivers/playwright-parser.js";
import { executeFlow } from "./engine.js";
import {
  defaultDaemonStateDir,
  listWarmDaemons,
  registerWarmDaemon,
  stopWarmDaemon,
} from "../runtime/daemon-manager.js";

describe("Spana v0.8.0 pilot feedback suite — unit coverage", () => {
  test("selector combinators compose role, css, within, inFrame, filter, nth/first/last", () => {
    const sel = first(
      filterSelector(within({ css: ".card" }, byRole("button", "Save", { exact: true })), {
        hasText: /save/i,
        hasNotText: "Disabled",
      }),
    );
    expect(sel).toMatchObject({
      role: "button",
      name: "Save",
      exact: true,
      within: { css: ".card" },
      hasText: /save/i,
      hasNotText: "Disabled",
      first: true,
    });

    const framed = inFrame(byCss("iframe#checkout"), nth(byCss("input.qty"), 2));
    expect(framed).toMatchObject({
      css: "input.qty",
      nth: 2,
      frame: { css: "iframe#checkout" },
    });

    const lastBtn = last(byRole("listitem"));
    expect(lastBtn).toMatchObject({ role: "listitem", last: true });
  });

  test("OS free port allocator skips occupied TCP ports and assertPortAvailable fails loudly", async () => {
    const blocker = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const occupiedPort = (blocker.address() as AddressInfo).port;
    try {
      expect(await isPortAvailable(occupiedPort)).toBe(false);
      await expect(assertPortAvailable(occupiedPort, "test-daemon")).rejects.toThrow(/Port clash/);

      const freePort = await allocateFreePort(occupiedPort);
      expect(freePort).not.toBe(occupiedPort);
      expect(await isPortAvailable(freePort)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("per-scope warm daemon files avoid cross-process clobbering and detect port clashes", async () => {
    const scopeA = `test-scope-a-${Date.now()}`;
    const scopeB = `test-scope-b-${Date.now()}`;
    const portA = await allocateFreePort(19400);
    const portB = await allocateFreePort(portA + 1);
    try {
      registerWarmDaemon({
        kind: "chromium",
        deviceId: scopeA,
        host: "127.0.0.1",
        port: portA,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      registerWarmDaemon({
        kind: "chromium",
        deviceId: scopeB,
        host: "127.0.0.1",
        port: portB,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });

      expect(existsSync(defaultDaemonStateDir())).toBe(true);
      const list = listWarmDaemons();
      expect(list.some((d) => d.deviceId === scopeA && d.port === portA)).toBe(true);
      expect(list.some((d) => d.deviceId === scopeB && d.port === portB)).toBe(true);

      // Registering a different scope on portA while scopeA's PID is alive must throw loudly
      expect(() =>
        registerWarmDaemon({
          kind: "chromium",
          deviceId: `clash-${Date.now()}`,
          host: "127.0.0.1",
          port: portA,
          pid: 999999,
          startedAt: new Date().toISOString(),
        }),
      ).toThrow(/Port clash|port clash/i);
    } finally {
      // Remove records without killing our own test runner process
      registerWarmDaemon({
        kind: "chromium",
        deviceId: scopeA,
        host: "127.0.0.1",
        port: portA,
        pid: 0,
        startedAt: new Date().toISOString(),
      });
      registerWarmDaemon({
        kind: "chromium",
        deviceId: scopeB,
        host: "127.0.0.1",
        port: portB,
        pid: 0,
        startedAt: new Date().toISOString(),
      });
      stopWarmDaemon("chromium", scopeA);
      stopWarmDaemon("chromium", scopeB);
    }
  });

  test("planProcessPool respects explicit --processes M and dynamic shared HTTP queue steals work longest-first", async () => {
    const p1 = planProcessPool(4, 8, 4);
    expect(p1.processCount).toBe(4);
    expect(p1.workersPerProcess).toEqual([1, 1, 1, 1]);

    const p2 = planProcessPool(8, 8, 4);
    expect(p2.processCount).toBe(4);
    expect(p2.workersPerProcess).toEqual([2, 2, 2, 2]);

    const queue = await startSharedFlowQueueServer([
      "slow-journey-1",
      "slow-journey-2",
      "fast-1",
      "fast-2",
    ]);
    try {
      const claim = createRemoteFlowClaimer(queue.url);
      const claimed = await Promise.all([claim(), claim(), claim(), claim(), claim()]);
      expect(claimed.filter(Boolean)).toEqual([
        "slow-journey-1",
        "slow-journey-2",
        "fast-1",
        "fast-2",
      ]);
      expect(claimed[4]).toBeNull();
      expect(queue.remaining()).toBe(0);
    } finally {
      await queue.close();
    }
  });

  test("extractCodeFrame builds a Playwright-style annotated snippet from stack traces", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "spana-codeframe-"));
    const flowFile = join(tempDir, "sample.flow.ts");
    writeFileSync(
      flowFile,
      [
        'import { flow } from "spana-test";',
        'export default flow("checkout", async ({ app, expect }) => {',
        '  await app.tap({ role: "button", name: "Buy" });',
        '  await expect({ testID: "receipt" }).toBeVisible();',
        "});",
      ].join("\n"),
      "utf8",
    );
    try {
      const fakeStack = `Error: Element not found\n    at Object.run (${flowFile}:4:41)\n    at async executeFlow (/packages/spana/src/core/engine.ts:330:7)`;
      const extracted = extractCodeFrame(fakeStack, flowFile);
      expect(extracted).toBeDefined();
      expect(extracted!.location).toEqual({ file: flowFile, line: 4, column: 41 });
      expect(extracted!.frame).toContain(
        '> 4 |   await expect({ testID: "receipt" }).toBeVisible();',
      );
      expect(extracted!.frame).toContain("^");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("VirtualCredentialStore saves and restores passkeys into fresh contexts", async () => {
    const store = new VirtualCredentialStore();
    store.save("alice", [
      {
        credentialId: "cred-1",
        isResidentCredential: true,
        rpId: "example.com",
        privateKey: "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFAKEKEY",
        userHandle: "YWxpY2U=",
        signCount: 1,
      },
    ]);
    expect(store.has("alice")).toBe(true);

    const added: unknown[] = [];
    const restoredCount = await store.restore("alice", {
      enableVirtualAuthenticator: async () => "auth-fresh-1",
      addVirtualCredential: async (cred, authId) => {
        added.push({ cred, authId });
      },
    });
    expect(restoredCount).toBe(1);
    expect(added).toHaveLength(1);
    expect((added[0] as any).authId).toBe("auth-fresh-1");
    expect((added[0] as any).cred.credentialId).toBe("cred-1");
  });
});

// ── Live Chromium E2E tests covering all new pilot capabilities on Direct CDP & Playwright ──

function createPilotTestAppServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname === "/api/set-session") {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "sid=pilot-token-123; Path=/",
        });
        res.end(JSON.stringify({ ok: true, set: true }));
        return;
      }
      if (reqUrl.pathname === "/api/whoami") {
        const cookie = req.headers.cookie ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cookie, authenticated: cookie.includes("sid=pilot-token-123") }));
        return;
      }
      if (reqUrl.pathname === "/api/ping") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ pong: true, query: reqUrl.searchParams.get("q") ?? "" }));
        return;
      }
      if (reqUrl.pathname === "/iframe-inner") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body>
          <button id="frame-btn" onclick="document.getElementById('frame-out').textContent='clicked-in-frame'">Frame Action</button>
          <div id="frame-out" data-testid="frame-out">idle</div>
        </body></html>`);
        return;
      }
      if (reqUrl.pathname === "/csp-strict") {
        res.writeHead(200, {
          "content-type": "text/html",
          "content-security-policy": "default-src 'self'; script-src 'none'",
        });
        res.end(`<!doctype html><html><body><h1>Strict CSP Page</h1></body></html>`);
        return;
      }

      // Main pilot page with roles, lists, hover menu, remounting React-like input,
      // contenteditable rich editor, file input, same-origin iframe, and API trigger
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body>
        <h1>Pilot Dashboard</h1>
        <nav aria-label="Main">
          <div class="card" data-testid="card-alpha">
            <span>Alpha Item</span>
            <button aria-label="Delete Alpha" onclick="document.getElementById('status').textContent='deleted-alpha'">Delete</button>
          </div>
          <div class="card" data-testid="card-beta">
            <span>Beta Item</span>
            <button aria-label="Delete Beta" onclick="document.getElementById('status').textContent='deleted-beta'">Delete</button>
          </div>
        </nav>

        <ul class="items">
          <li class="row">First Row</li>
          <li class="row">Second Row</li>
          <li class="row">Third Row</li>
        </ul>

        <button id="hover-trigger" onmouseenter="document.getElementById('tooltip').style.display='block'">Hover Me</button>
        <div id="tooltip" style="display:none">Tooltip Visible</div>

        <label for="controlled-input">Controlled Title</label>
        <input id="controlled-input" data-testid="controlled-input" value="initial" />

        <div id="rich-editor" data-testid="rich-editor" contenteditable="true" style="border:1px solid #888;min-height:24px;padding:4px">Old editor text</div>

        <input id="file-upload" data-testid="file-upload" type="file" multiple onchange="document.getElementById('upload-count').textContent = String(this.files.length)" />
        <div id="upload-count" data-testid="upload-count">0</div>

        <button id="fetch-btn" onclick="fetch('/api/ping?q=hello').then(r=>r.json()).then(d=>{document.getElementById('status').textContent='ping:'+d.query; history.pushState({}, '', '/dashboard?done=1');})">Fetch Ping</button>
        <div id="status" data-testid="status">ready</div>

        <iframe id="inner-frame" src="/iframe-inner" style="width:300px;height:120px;border:1px solid #ccc"></iframe>

        <script>
          // Simulate a tricky controlled input that resets on first programmatic write once
          let resetOnce = false;
          const inp = document.getElementById("controlled-input");
          inp.addEventListener("input", () => {
            if (!resetOnce && inp.value === "Remount Safe") {
              resetOnce = true;
              setTimeout(() => { inp.value = ""; }, 2);
            }
          });
        </script>
      </body></html>`);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("Spana v0.8.0 live Chromium E2E (Direct CDP + Playwright parity)", () => {
  let appServer: Server;
  let baseUrl: string;
  let cdpHandle: DirectCdpBrowserHandle;
  let tempUploadDir: string;
  let uploadFileA: string;
  let uploadFileB: string;

  test.each(["playwright", "cdp"] as const)(
    "collects executed JavaScript on %s Chromium",
    async (engine) => {
      const driver = await Effect.runPromise(
        engine === "playwright"
          ? makePlaywrightDriver({ headless: true, baseUrl })
          : makeLightweightCdpDriver({ cdpUrl: cdpHandle.browserWsUrl, baseUrl }),
      );
      try {
        const result = await executeFlow(
          flow(`coverage on ${engine}`, async ({ expect: browserExpect }) => {
            await browserExpect({ text: "Pilot Dashboard" }).toBeVisible();
            if (engine === "playwright") {
              await browserExpect(byRole("heading", "Pilot Dashboard")).toMatchAriaSnapshot(
                `- heading "Pilot Dashboard" [level=1]`,
                { timeout: 300 },
              );
            }
          }),
          driver,
          {
            appId: baseUrl,
            platform: "web",
            coordinatorConfig: { parse: parseWebHierarchy },
            artifactConfig: {
              jsCoverage: true,
              outputDir: tempUploadDir,
              captureOnFailure: false,
              captureOnSuccess: false,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe("passed");
        const attachment = result.attachments?.find(({ name }) => name === "js-coverage");
        expect(attachment).toBeDefined();
        const entries = JSON.parse(readFileSync(attachment!.path, "utf8"));
        expect(entries).toContainEqual(
          expect.objectContaining({ url: `${baseUrl}/`, functions: expect.any(Array) }),
        );
      } finally {
        await Effect.runPromise(driver.killApp(baseUrl));
      }
    },
  );

  test("emulates geolocation, permissions, wall clock and viewport on Playwright Chromium", async () => {
    const driver = await Effect.runPromise(makePlaywrightDriver({ headless: true, baseUrl }));
    try {
      const result = await executeFlow(
        flow("web emulation", async ({ app }) => {
          await app.grantPermission("geolocation", { origin: baseUrl });
          await app.setGeolocation({ latitude: 12, longitude: 34 });
          expect(
            await app.evaluate<number[]>(
              `new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(({coords}) => resolve([coords.latitude, coords.longitude]), reject))`,
            ),
          ).toEqual([12, 34]);
          await app.denyPermission("geolocation", { origin: baseUrl });
          expect(
            await app.evaluate<string>(
              `navigator.permissions.query({name: 'geolocation'}).then((permission) => permission.state)`,
            ),
          ).toBe("denied");
          await app.setSystemTime("2030-01-01T00:00:00Z");
          expect(await app.evaluate<number>("new Date().getUTCFullYear()")).toBe(2030);
          await app.setOrientation("portrait");
          expect(await app.evaluate<boolean>("window.innerHeight > window.innerWidth")).toBe(true);
        }),
        driver,
        {
          appId: baseUrl,
          platform: "web",
          coordinatorConfig: { parse: parseWebHierarchy },
          artifactConfig: { captureOnFailure: false },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("passed");
    } finally {
      await Effect.runPromise(driver.killApp(baseUrl));
    }
  });

  beforeAll(async () => {
    const started = await createPilotTestAppServer();
    appServer = started.server;
    baseUrl = started.url;
    cdpHandle = await launchDirectCdpBrowser({ headless: true });
    tempUploadDir = mkdtempSync(join(tmpdir(), "spana-upload-"));
    uploadFileA = join(tempUploadDir, "a.txt");
    uploadFileB = join(tempUploadDir, "b.txt");
    writeFileSync(uploadFileA, "file A", "utf8");
    writeFileSync(uploadFileB, "file B", "utf8");
  });

  afterAll(async () => {
    await cdpHandle?.close().catch(() => {});
    if (appServer) {
      await new Promise<void>((resolve) => appServer.close(() => resolve()));
    }
    if (tempUploadDir) {
      rmSync(tempUploadDir, { recursive: true, force: true });
    }
  });

  test("Direct CDP executes composable selectors, new matchers, actions, cdp(), request, newContext, frame, fill reliability, passkeys, and code frames", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: cdpHandle.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: true,
      }),
    );

    try {
      const passkeyCache = new PersonaAuthCache();

      const mainFlow = flow("pilot-cdp-full-parity", async ({ app, expect: exp }) => {
        // 1. Composable selectors: role + name, within, css, filter({ hasText }), nth/first/last
        await exp(byRole("heading", "Pilot Dashboard")).toBeVisible();
        await exp(byCss("li.row")).toHaveCount(3);
        await exp(first(byCss("li.row"))).toHaveText("First Row");
        await exp(nth(byCss("li.row"), 1)).toHaveText("Second Row");
        await exp(last(byCss("li.row"))).toHaveText("Third Row");
        await exp(filterSelector(byCss("li.row"), { hasText: "Second" })).toHaveCount(1);

        // Scoped click with within() + accessible name assertion
        const betaDelete = within({ testID: "card-beta" }, byRole("button", /Delete/));
        await exp(betaDelete).toHaveAccessibleName("Delete Beta");
        await app.tap(betaDelete);
        await exp({ testID: "status" }).toHaveText("deleted-beta");

        // 4. Hover action
        await app.hover(byCss("#hover-trigger"));
        await exp(byCss("#tooltip")).toBeVisible();

        // 5. Bulletproof app.fill on resetting controlled input + contenteditable editor + toBeFocused
        await app.fill({ testID: "controlled-input" }, "Remount Safe");
        await exp({ testID: "controlled-input" }).toHaveValue("Remount Safe");
        await exp({ testID: "controlled-input" }).toBeFocused();

        await app.fill({ testID: "rich-editor" }, "TipTap Editor Content");
        await exp({ testID: "rich-editor" }).toContainText("TipTap Editor Content");

        // 4. Multi-file uploadFile with CSS selector
        await app.uploadFile(byCss("#file-upload"), [uploadFileA, uploadFileB]);
        await exp({ testID: "upload-count" }).toHaveText("2");

        // 4. Frame-scoped actions & assertions (app.frame)
        const inner = app.frame(byCss("#inner-frame"));
        await inner.tap(byRole("button", "Frame Action"));
        await inner.expect({ testID: "frame-out" }).toHaveText("clicked-in-frame");

        // 4. waitForResponse + waitForURL + expect.toHaveURL + app.url()
        const responsePromise = app.waitForResponse("/api/ping");
        await app.tap(byCss("#fetch-btn"));
        const resp = await responsePromise;
        expect(resp.status).toBe(200);
        const body = await resp.json!<{ pong: boolean; query: string }>();
        expect(body).toEqual({ pong: true, query: "hello" });
        await app.waitForURL(/\/dashboard\?done=1/);
        await exp.toHaveURL("/dashboard?done=1");
        expect(await app.url()).toContain("/dashboard?done=1");

        // 4. Cookie-sharing app.request client syncing Set-Cookie back into browser + getCookies
        const loginRes = await app.request.post<{ ok: boolean }>("/api/set-session");
        expect(loginRes.ok).toBe(true);
        const cookies = await app.getCookies();
        expect(cookies.some((c) => c.name === "sid" && c.value === "pilot-token-123")).toBe(true);
        const whoRes = await app.request.get<{ authenticated: boolean }>("/api/whoami");
        expect(whoRes.data.authenticated).toBe(true);

        // 4. Second isolated browser context (app.newContext) has zero cookies from primary context!
        const second = await app.newContext({ url: baseUrl });
        const secondCookies = await second.app.getCookies();
        expect(secondCookies.some((c) => c.name === "sid")).toBe(false);
        await second.expect(byRole("heading", "Pilot Dashboard")).toBeVisible();
        await second.close();

        // 4. Offline toggle + reload
        await app.setOffline(true);
        await app.setOffline(false);
        await app.reload();
        await exp(byRole("heading", "Pilot Dashboard")).toBeVisible();

        // 3. Raw CDP session escape hatch (app.cdp()) on Direct CDP engine
        const cdp = app.cdp();
        const titleEval = await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
          expression: "document.querySelector('h1')?.textContent",
          returnByValue: true,
        });
        expect(titleEval.result?.value).toBe("Pilot Dashboard");

        // 2. WebAuthn virtual authenticator + addVirtualCredential import
        const authId = await app.enableVirtualAuthenticator();
        expect(authId.length).toBeGreaterThan(0);
        // Generate an ECDSA P-256 PKCS#8 keypair using Node crypto for a real CDP WebAuthn.addCredential test
        const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const pkcs8Base64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
        const credId = Buffer.from("spana-pilot-cred-id-1").toString("base64");
        await app.addVirtualCredential(
          {
            credentialId: credId,
            isResidentCredential: true,
            rpId: "127.0.0.1",
            privateKey: pkcs8Base64,
            userHandle: Buffer.from("user-alice").toString("base64"),
            signCount: 1,
          },
          authId,
        );
        const creds = await app.getVirtualCredentials(authId);
        expect(creds.some((c) => c.credentialId === credId)).toBe(true);
        passkeyCache.credentials.save("alice", creds);
        expect(passkeyCache.credentials.has("alice")).toBe(true);

        // 9. Multi-arg evaluate on Direct CDP
        const sum = await app.evaluate((a: number, b: number, c: number) => a + b + c, 10, 20, 30);
        expect(sum).toBe(60);
      });

      const res = await executeFlow(mainFlow, driver, {
        appId: baseUrl,
        platform: "web",
        coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
      });
      if (res.status !== "passed") {
        throw new Error(`CDP pilot flow failed: ${res.error?.message}\n${res.error?.stack ?? ""}`);
      }
      expect(res.status).toBe("passed");
      // #8: evaluate() and cdp.* steps are recorded in step trace!
      expect(res.steps?.some((s) => s.command.startsWith("cdp.Runtime.evaluate"))).toBe(true);
      expect(res.steps?.some((s) => s.command.startsWith("evaluate("))).toBe(true);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });

  test("Playwright driver passes multi-arg evaluate under strict CSP (script-src 'none') and records raw page steps + codeFrame on failure", async () => {
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: "chromium",
        headless: true,
        baseUrl,
      }),
    );

    try {
      const cspFlow = flow("playwright-csp-eval-and-cdp", async ({ app }) => {
        await app.openLink(`${baseUrl}/csp-strict`);
        // #9: 3-arg evaluate MUST succeed even with `Content-Security-Policy: script-src 'none'`!
        const result = await app.evaluate(
          (a: number, b: number, tag: string) => `${tag}:${a + b}`,
          17,
          25,
          "csp-ok",
        );
        expect(result).toBe("csp-ok:42");

        // #3: app.cdp() also works on Playwright Chromium!
        const cdp = app.cdp();
        const heading = await cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
          expression: "document.querySelector('h1')?.textContent",
          returnByValue: true,
        });
        expect(heading.result?.value).toBe("Strict CSP Page");

        // #8: raw page calls get recorded in step list
        const rawPage = app.getPage<{ goto: (u: string) => Promise<unknown> }>();
        await rawPage.goto(baseUrl);
      });

      const okRes = await executeFlow(cspFlow, driver, {
        appId: baseUrl,
        platform: "web",
        coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
      });
      expect(okRes.status).toBe("passed");
      expect(okRes.steps?.some((s) => s.command.startsWith("page.goto("))).toBe(true);
      expect(okRes.steps?.some((s) => s.command.startsWith("cdp.Runtime.evaluate"))).toBe(true);

      // #8: Failing flow attaches a real codeFrame + location pointing to this test file
      const failFlow = flow("failing-codeframe-check", async ({ expect: exp }) => {
        await exp({ testID: "does-not-exist-xyz" }).toBeVisible({ timeout: 200 });
      });
      const failRes = await executeFlow(failFlow, driver, {
        appId: baseUrl,
        platform: "web",
        coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
      });
      expect(failRes.status).toBe("failed");
      expect(failRes.error?.location).toBeDefined();
      expect(failRes.error?.codeFrame).toContain("does-not-exist-xyz");
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });
});
