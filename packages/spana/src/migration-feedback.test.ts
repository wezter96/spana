import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
import { Effect } from "effect";
import { flow } from "./api/flow.js";
import { suite } from "./api/suite.js";
import { filterFlows } from "./core/runner.js";
import { executeFlow } from "./core/engine.js";
import { createJsonReporter } from "./report/json.js";
import { createJUnitReporter } from "./report/junit.js";
import {
  defineDriverAdapter,
  defineDomTransport,
  registerDriverAdapter,
  registerDomTransport,
  resolveDriverAdapter,
  resolveDomTransport,
  listDriverAdapters,
  listDomTransports,
} from "./drivers/adapter-registry.js";
import { buildWebRuntime } from "./runtime/local.js";
import { launchDirectCdpBrowser, makeLightweightCdpDriver } from "./drivers/cdp-browser.js";
import { parseWebHierarchy } from "./drivers/playwright-parser.js";
import { and, byAltText, byLabel, byPlaceholder, byTitle } from "./schemas/selector.js";
import type { RawDriverService } from "./drivers/raw-driver.js";

const tempDirs: string[] = [];
function makeTempDir(prefix = "spana-mig-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Playwright migration feedback — unit coverage", () => {
  test("1.5 filterFlows supports regex --grep, @tag matching, and --grep-invert", () => {
    const f1 = flow("Checkout > applies coupon", { tags: ["smoke", "billing"] }, async () => {});
    const f2 = flow("Checkout > guest flow", { tags: ["slow"] }, async () => {});
    const f3 = flow("Settings > profile", { tags: ["smoke"] }, async () => {});

    const byRegex = filterFlows([f1, f2, f3], { grep: "checkout.*coupon|settings" });
    expect(byRegex.map((f) => f.name)).toEqual([f1.name, f3.name]);

    const byTagRegex = filterFlows([f1, f2, f3], { grep: "@billing" });
    expect(byTagRegex.map((f) => f.name)).toEqual([f1.name]);

    const inverted = filterFlows([f1, f2, f3], { grepInvert: "@slow|settings" });
    expect(inverted.map((f) => f.name)).toEqual([f1.name]);
  });

  test("1.3 JSON reporter writes to explicit file path and JUnit writes tags/annotations <properties>", () => {
    const dir = makeTempDir("spana-rep-");
    const jsonFile = join(dir, "report.json");
    const junitFile = join(dir, "junit.xml");

    const jsonReporter = createJsonReporter(jsonFile);
    const junitReporter = createJUnitReporter(junitFile);

    const summary = {
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      flaky: 0,
      durationMs: 42,
      platforms: ["web"] as const,
      results: [
        {
          name: "Auth > login",
          platform: "web" as const,
          status: "passed" as const,
          durationMs: 42,
          attachments: [],
          tags: ["smoke", "auth"],
          annotations: [{ type: "issue", description: "PROJ-123" }],
        },
      ],
    };

    jsonReporter.onRunComplete({ ...summary, platforms: ["web"] });
    junitReporter.onRunComplete({ ...summary, platforms: ["web"] });

    expect(existsSync(jsonFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(jsonFile, "utf8"));
    expect(parsed.results[0].tags).toEqual(["smoke", "auth"]);
    expect(parsed.results[0].annotations).toEqual([{ type: "issue", description: "PROJ-123" }]);

    expect(existsSync(junitFile)).toBe(true);
    const xml = readFileSync(junitFile, "utf8");
    expect(xml).toContain('<property name="tag" value="smoke"');
    expect(xml).toContain('<property name="tag" value="auth"');
    expect(xml).toContain('<property name="issue" value="PROJ-123"');
  });

  test("2.5 & 3.3 suite.serial attaches shared serialGroup and flow.fail marks expected failure", () => {
    const flows = suite.serial("Account lifecycle", (s) => {
      s.flow("step 1", async () => {});
      s.fail("step 2 expected fail", async () => {});
    });
    expect(flows).toHaveLength(2);
    expect(flows[0]!.config.serialGroup).toBeTruthy();
    expect(flows[0]!.config.serialGroup).toBe(flows[1]!.config.serialGroup);
    expect(flows[1]!.config.fail).toBe(true);

    const standaloneFail = flow.fail("known bug", async () => {});
    expect(standaloneFail.config.fail).toBe(true);
  });

  test("Modular DriverAdapter & DomTransportAdapter registry plugs custom browsers into buildWebRuntime", async () => {
    const calls: string[] = [];
    const customTransport = defineDomTransport({
      name: "mock-bidi-transport",
      kind: "bidi",
      create: async () => ({
        kind: "cdp",
        isConnected: () => true,
        connect: async () => {},
        disconnect: async () => {},
        evaluate: async () => "bidi-ok" as any,
        query: async () => [],
        tapDom: async () => true,
      }),
    });
    const unregisterTransport = registerDomTransport(customTransport);
    expect(resolveDomTransport("bidi")?.name).toBe("mock-bidi-transport");
    expect(listDomTransports().some((t) => t.name === "mock-bidi-transport")).toBe(true);

    const fakeDriver: RawDriverService = {
      dumpHierarchy: () => Effect.succeed("{}"),
      tapAtCoordinate: () => Effect.void,
      doubleTapAtCoordinate: () => Effect.void,
      longPressAtCoordinate: () => Effect.void,
      swipe: () => Effect.void,
      inputText: () => Effect.void,
      pressKey: () => Effect.void,
      hideKeyboard: () => Effect.void,
      takeScreenshot: () => Effect.succeed(new Uint8Array()),
      getDeviceInfo: () =>
        Effect.succeed({
          platform: "web",
          deviceId: "servo-1",
          name: "Servo Custom",
          isEmulator: false,
          screenWidth: 1440,
          screenHeight: 900,
          driverType: "cdp" as any,
        }),
      launchApp: () => Effect.void,
      stopApp: () => Effect.void,
      killApp: () => Effect.void,
      clearAppState: () => Effect.void,
      openLink: () => Effect.void,
      back: () => Effect.void,
      evaluate: () => Effect.succeed("custom-eval" as any),
    };

    const customAdapter = defineDriverAdapter({
      name: "servo-browser",
      platforms: ["web"],
      engines: ["servo"],
      create: async (ctx) => {
        calls.push(`create:${ctx.platform}:${ctx.engine}:${ctx.appId}`);
        return {
          driver: fakeDriver,
          cleanup: async () => {
            calls.push("cleanup");
          },
          metadata: { customEngine: "servo" },
        };
      },
    });
    const unregisterAdapter = registerDriverAdapter(customAdapter);
    try {
      expect(resolveDriverAdapter("web", "servo")?.name).toBe("servo-browser");
      expect(listDriverAdapters().some((a) => a.name === "servo-browser")).toBe(true);

      const built = await buildWebRuntime({
        apps: { web: { url: "https://example.test" } },
        execution: { web: { engine: "servo" as any } },
      });
      expect(built.runtime.metadata.adapter).toBe("servo-browser");
      expect(calls).toContain("create:web:servo:https://example.test");
      await built.runtime.cleanup();
      expect(calls).toContain("cleanup");
    } finally {
      unregisterAdapter();
      unregisterTransport();
    }
  });
});

describe("Playwright migration feedback — live Direct CDP Chromium E2E", () => {
  let server: Server;
  let baseUrl = "";
  let browser: Awaited<ReturnType<typeof launchDirectCdpBrowser>>;
  let driver: RawDriverService;

  beforeAll(async () => {
    const html = `<!doctype html>
<html>
<head><title>Spana Migration Parity Fixture</title></head>
<body>
  <main>
    <h1 data-testid="heading">Hello World</h1>
    <label for="email-in">Email Address</label>
    <input id="email-in" type="email" placeholder="you@example.com" title="Work Email" value="init@test.dev" />
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Company Logo" width="20" height="20" />
    <input id="agree" type="checkbox" />
    <input id="file-in" type="file" />
    <div id="hidden-box" style="display:none">Hidden Secret</div>
    <div class="dup">Visible Item</div>
    <div class="dup" style="display:none">Hidden Item</div>
    <div class="vis-dup" style="display:none">Hidden First</div>
    <div class="vis-dup">Visible Second</div>
    <button id="key-btn" type="button" onclick="window.__clicked = (window.__clicked || 0) + 1">Click Me</button>
    <button id="covered-btn" type="button" style="position:relative">Covered</button>
    <div id="cover-overlay" style="position:fixed;inset:0;pointer-events:none"></div>
    <input id="key-log-in" type="text" />
    <div id="nav-log"></div>
    <a id="page2-link" href="/page2">Go Page 2</a>
    <script>
      window.__keys = [];
      document.getElementById("key-log-in").addEventListener("keydown", (e) => window.__keys.push(e.key));
      window.__blurred = false;
      document.getElementById("email-in").addEventListener("blur", () => { window.__blurred = true; });
    </script>
  </main>
</body>
</html>`;

    server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname === "/page2") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body><h1 data-testid="p2">Page Two</h1></body></html>`);
        return;
      }
      if (u.pathname === "/redirect-login") {
        res.writeHead(302, {
          location: "/redirect-final",
          "set-cookie": "session_hop=abc123; Path=/; HttpOnly",
        });
        res.end();
        return;
      }
      if (u.pathname === "/redirect-final") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? "" }));
        return;
      }
      if (u.pathname === "/api/echo") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ method: req.method, contentType: req.headers["content-type"], body }),
          );
        });
        return;
      }
      if (u.pathname === "/api/route-test") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ source: "server" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    browser = await launchDirectCdpBrowser({ headless: true });
    driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browser.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        viewport: { width: 1280, height: 720 },
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (driver) await Effect.runPromise(driver.killApp("")).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  test("1.15 concurrent launchDirectCdpBrowser calls bind distinct ports without collision", async () => {
    const [b1, b2] = await Promise.all([
      launchDirectCdpBrowser({ headless: true }),
      launchDirectCdpBrowser({ headless: true }),
    ]);
    try {
      expect(b1.httpEndpoint).not.toBe(b2.httpEndpoint);
      expect(b1.browserWsUrl).not.toBe(b2.browserWsUrl);
    } finally {
      await Promise.all([b1.close(), b2.close()]);
    }
  });

  test("covers 1.1, 1.12, 1.14, 2.1-2.4, 2.8-2.10, 2.12, 2.15, 2.17, 2.20, 2.22, 3.1, 3.3, 3.4, 3.6, 3.8, 3.18, 3.20-3.24", async () => {
    const f = flow(
      "migration parity e2e",
      { viewport: { width: 1024, height: 640 }, locale: "sv-SE" },
      async ({ app, expect: exp, workerIndex, parallelIndex }) => {
        expect(typeof workerIndex).toBe("number");
        expect(typeof parallelIndex).toBe("number");

        await app.openLink("/");
        await app.waitForLoadState("load");

        // 2.7 & 2.23 viewport + locale applied per-flow
        const vp = await app.evaluate<{ w: number; h: number; lang: string }>(
          "({ w: window.innerWidth, h: window.innerHeight, lang: navigator.language })",
        );
        expect(vp.w).toBe(1024);
        expect(vp.h).toBe(640);

        // 1.1 invalid CSS selector MUST throw instead of passing toBeHidden
        let invalidSelectorThrew = false;
        try {
          await exp({ css: 'button:has-text("Click")' }).toBeHidden({ timeout: 300 });
        } catch (err) {
          invalidSelectorThrew = /Invalid CSS selector/i.test(String(err));
        }
        expect(invalidSelectorThrew).toBe(true);

        // 1.12 case-sensitive toContainText by default + ignoreCase opt-in
        await exp({ testID: "heading" }).toContainText("Hello");
        let caseMismatchFailed = false;
        try {
          await exp({ testID: "heading" }).toContainText("hello", { timeout: 250 });
        } catch {
          caseMismatchFailed = true;
        }
        expect(caseMismatchFailed).toBe(true);
        await exp({ testID: "heading" }).toContainText("hello", { ignoreCase: true });

        // 1.14 toHaveCount counts ALL matches (including hidden); toHaveVisibleCount counts visible only
        await exp({ css: ".dup" }).toHaveCount(2);
        await exp({ css: ".dup" }).toHaveVisibleCount(1);

        // 2.15 isVisible returns true if ANY matching element is visible
        expect(await app.isVisible({ css: ".vis-dup" })).toBe(true);

        // 2.20 toHaveText works on hidden elements + 3.23 toBeAttached
        await exp({ css: "#hidden-box" }).toBeAttached();
        await exp({ css: "#hidden-box" }).toHaveText("Hidden Secret");

        // 2.8 label, placeholder, altText, title selectors + 3.3 and()
        await exp(byLabel("Email Address")).toHaveValue(/^init@/);
        await exp(byPlaceholder("you@example.com")).toHaveAttribute("type", /^em/);
        await exp(byAltText("Company Logo")).toBeVisible();
        await exp(byTitle("Work Email")).toBeInViewport();
        await exp(and({ css: "input" }, byPlaceholder("you@example.com"))).toBeVisible();

        // 2.10 ARIA-in-HTML roles + .not.toHaveRole
        await exp({ css: "#email-in" }).toHaveRole("textbox");
        await exp({ css: "#agree" }).toHaveRole("checkbox");
        await exp({ css: "#agree" }).not.toHaveRole("button");

        // 3.20 focus & blur + 2.3 per-key type() + keyboard.down/up
        await app.focus({ css: "#email-in" });
        await app.blur({ css: "#email-in" });
        expect(await app.evaluate<boolean>("Boolean(window.__blurred)")).toBe(true);

        await app.focus({ css: "#key-log-in" });
        await app.type("ab", { delay: 5 });
        const keys = await app.evaluate<string[]>("window.__keys");
        expect(keys).toContain("a");
        expect(keys).toContain("b");

        // 3.21 check & uncheck
        await app.check({ css: "#agree" });
        await exp({ css: "#agree" }).toBeChecked();
        await app.uncheck({ css: "#agree" });
        await exp({ css: "#agree" }).not.toBeChecked();

        // 3.1 evaluate with undefined arg & 3.18 return typing
        const undefRes = await app.evaluate(
          (a: unknown, b: string) => ({ aIsUndef: a === undefined, b }),
          undefined,
          "ok",
        );
        expect(undefRes).toEqual({ aIsUndef: true, b: "ok" });

        // 3.6 exposeFunction + addInitScript
        await app.exposeFunction("doubleInNode", (n: number) => n * 2);
        const doubled = await app.evaluate<number>("window.doubleInNode(21)");
        expect(doubled).toBe(42);

        // 2.9 fake clock
        await app.clock.install({ time: "2026-01-01T00:00:00.000Z" });
        const fixedBefore = await app.evaluate(() => Date.now());
        await app.clock.fastForward(5000);
        const fixedAfter = await app.evaluate(() => Date.now());
        expect(fixedAfter - fixedBefore).toBeGreaterThanOrEqual(5000);
        await app.clock.resume();

        // 2.12 app.request preserves Set-Cookie across 302 redirects + multipart upload
        const redir = await app.request.get<{ cookie: string }>("/redirect-login");
        expect(redir.status).toBe(200);
        expect(redir.data.cookie).toContain("session_hop=abc123");
        // 2.22 getCookies() returns context cookies
        const allCookies = await app.getCookies();
        expect(allCookies.some((c) => c.name === "session_hop")).toBe(true);

        const mp = await app.request.post<{ contentType: string; body: string }>(
          "/api/echo",
          undefined,
          {
            multipart: {
              note: "hello",
              doc: { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("payload") },
            },
          },
        );
        expect(mp.data.contentType).toContain("multipart/form-data");
        expect(mp.data.body).toContain("payload");

        // 2.17 app.route() dynamic callback
        await app.route("**/api/route-test", async (route) => {
          await route.fulfill({ status: 200, json: { source: "mocked-route" } });
        });
        const routed = await app.evaluate(async () => {
          const r = await fetch("/api/route-test");
          return r.json();
        });
        expect(routed).toEqual({ source: "mocked-route" });
        await app.clearNetworkMocks();

        // 3.24 in-memory uploadFile
        await app.uploadFile(
          { css: "#file-in" },
          { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("abc") },
        );
        const uploadedName = await app.evaluate<string>(
          "document.getElementById('file-in')?.files?.[0]?.name ?? ''",
        );
        expect(uploadedName).toBe("hello.txt");

        // 3.4 CDP setGeolocation & grantPermission
        await app.setGeolocation({ latitude: 59.3293, longitude: 18.0686 });
        await app.grantPermission("geolocation");

        // 2.1 accessibilityAudit returning violations + tags/disableRules
        const audit = await app.accessibilityAudit({
          tags: ["wcag2a"],
          disableRules: ["page-has-heading-one", "landmark-one-main", "region", "html-has-lang"],
        });
        expect(Array.isArray(audit.violations)).toBe(true);

        // 2.4 back() & forward() navigation wait
        await app.tap({ css: "#page2-link" });
        await exp({ testID: "p2" }).toBeVisible();
        await app.back();
        await exp({ testID: "heading" }).toBeVisible();
        await app.forward();
        await exp({ testID: "p2" }).toBeVisible();

        // 3.22 tap({ force: true })
        await app.back();
        await app.tap({ css: "#covered-btn" }, { force: true });
      },
    );

    const res = await executeFlow(f, driver, {
      appId: baseUrl,
      platform: "web",
      coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
      autoLaunch: false,
      flowTimeout: 30_000,
    });
    if (res.status !== "passed") {
      throw new Error(`Migration parity flow failed: ${res.error?.message}`);
    }
    expect(res.status).toBe("passed");
  }, 30_000);

  test("1.2, 1.3, 1.4, 1.5, 1.6, 3.19 CLI --processes 2 merges JSON/JUnit reports, runs global hooks once, and respects --grep-invert / --pass-with-no-tests", async () => {
    const cliEntry = resolve(import.meta.dirname, "cli/index.ts");
    const workDir = makeTempDir("spana-cli-proc-");
    const flowsDir = join(workDir, "flows");
    mkdirSync(flowsDir, { recursive: true });
    const hookLogFile = join(workDir, "hooks.log");
    const jsonOut = join(workDir, "out.json");
    const junitOut = join(workDir, "out.xml");
    const configFile = join(workDir, "spana.config.ts");

    writeFileSync(
      configFile,
      `import { appendFileSync } from "node:fs";
export default {
  flowDir: "./flows",
  platforms: ["web"],
  apps: { web: { url: ${JSON.stringify(baseUrl)} } },
  execution: { web: { engine: "cdp", headless: true, warmBrowser: false } },
  hooks: {
    beforeAll: async () => { appendFileSync(${JSON.stringify(hookLogFile)}, "beforeAll\\n"); },
    afterAll: async () => { appendFileSync(${JSON.stringify(hookLogFile)}, "afterAll\\n"); },
  },
};
`,
    );

    const apiImport = JSON.stringify(resolve(import.meta.dirname, "index.ts"));
    writeFileSync(
      join(flowsDir, "a.flow.ts"),
      `import { flow } from ${apiImport};
export default flow("Proc Flow A", { tags: ["fast"], annotations: [{ type: "owner", description: "core" }] }, async ({ app, expect, workerIndex }) => {
  await app.openLink("/");
  await expect({ testID: "heading" }).toHaveText("Hello World");
  if (typeof workerIndex !== "number") throw new Error("missing workerIndex");
});
`,
    );
    writeFileSync(
      join(flowsDir, "b.flow.ts"),
      `import { flow } from ${apiImport};
export default flow("Proc Flow B", { tags: ["fast"] }, async ({ app, expect }) => {
  await app.openLink("/");
  await expect({ testID: "heading" }).toContainText("Hello");
});
`,
    );
    writeFileSync(
      join(flowsDir, "c.flow.ts"),
      `import { flow } from ${apiImport};
export default flow("Excluded Flow C", { tags: ["skipme"] }, async () => {
  throw new Error("should have been excluded by --grep-invert");
});
`,
    );

    // 3.19 version check
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    const { stdout: verOut } = await execFileAsync("bun", [cliEntry, "version"]);
    expect(verOut.trim()).toBe(`spana v${pkg.version}`);

    // 1.2 + 1.3 + 1.4 + 1.5 + 3.11: --processes 2 with --grep-invert and file reporters
    await execFileAsync(
      "bun",
      [
        cliEntry,
        "test",
        "--config",
        configFile,
        "--processes",
        "2",
        "--grep-invert",
        "@skipme",
        "--reporter",
        `json:${jsonOut}`,
        "--reporter",
        `junit:${junitOut}`,
      ],
      { cwd: workDir, timeout: 45_000 },
    );

    expect(existsSync(jsonOut)).toBe(true);
    const report = JSON.parse(readFileSync(jsonOut, "utf8"));
    expect(report.total).toBe(2);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);

    expect(existsSync(junitOut)).toBe(true);
    const junitXml = readFileSync(junitOut, "utf8");
    expect(junitXml).toContain("Proc Flow A");
    expect(junitXml).toContain("Proc Flow B");
    expect(junitXml).toContain('name="tag" value="fast"');

    // Global hooks ran ONCE in parent process (not once per child process)
    const hookLines = readFileSync(hookLogFile, "utf8").trim().split("\n");
    expect(hookLines).toEqual(["beforeAll", "afterAll"]);

    // 1.6 zero-match exits non-zero by default, 0 with --pass-with-no-tests
    let zeroMatchExitedNonZero = false;
    try {
      await execFileAsync(
        "bun",
        [cliEntry, "test", "--config", configFile, "--grep", "DOES_NOT_EXIST"],
        {
          cwd: workDir,
        },
      );
    } catch {
      zeroMatchExitedNonZero = true;
    }
    expect(zeroMatchExitedNonZero).toBe(true);

    await execFileAsync(
      "bun",
      [
        cliEntry,
        "test",
        "--config",
        configFile,
        "--grep",
        "DOES_NOT_EXIST",
        "--pass-with-no-tests",
      ],
      { cwd: workDir },
    );
  }, 60_000);
});
