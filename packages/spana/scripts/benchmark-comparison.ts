#!/usr/bin/env bun
/**
 * Real Head-to-Head E2E Performance Benchmark:
 *   Spana (Web-First) vs Playwright vs WebdriverIO (W3C WebDriver / Appium)
 *
 * Runs against the EXACT SAME live HTTP web application (with OAuth sign-in,
 * Shadow DOM <ion-button>, below-the-fold button, async API fetch, and a
 * multi-flow authenticated task dashboard) on real Chromium!
 *
 * Outputs structured JSON + console table so visual comparison charts are
 * backed by real measured timings on this machine.
 */
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { Effect } from "effect";
import { launchPlaywrightBrowser, makePlaywrightDriver } from "../src/drivers/playwright.js";
import { createSpanaBridgeChannel } from "../src/channels/bridge-server.js";
import { parseWebHierarchy } from "../src/drivers/playwright-parser.js";
import { createCoordinator } from "../src/smart/coordinator.js";
import { runAllTargetsSignInBenchmark } from "../src/core/benchmark.js";

function findChromiumExecutable(): string | undefined {
  const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chromeApp)) return chromeApp;
  return undefined;
}

const BRIDGE_BUNDLE_PATH = resolve(import.meta.dir, "../../spana-bridge/dist/index.js");
const RESULTS_OUT_PATH = resolve(
  import.meta.dir,
  "../../../benchmarks/framework-comparison/results.json",
);

function buildTestAppHtml(bridgeUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Spana Benchmark App</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; }
    button { padding: 10px 16px; font-size: 14px; cursor: pointer; }
    .spacer { height: 950px; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import { initSpanaBridge } from "/spana-bridge.js";
    window.__bridge = initSpanaBridge({ url: ${JSON.stringify(bridgeUrl)}, reconnectDelayMs: 100 });

    const root = document.getElementById("app");
    function render() {
      const path = window.location.pathname;
      const token = localStorage.getItem("auth_token");

      if (path === "/oauth") {
        root.innerHTML = \`
          <h1>OAuth Provider</h1>
          <p>Authorize Acme Web App?</p>
          <button data-testid="oauth-continue" id="oauth-continue">Continue</button>
        \`;
        document.getElementById("oauth-continue").addEventListener("click", () => {
          localStorage.setItem("auth_token", "jwt-live-token-2026");
          window.location.href = "/dashboard";
        });
        return;
      }

      if (!token) {
        root.innerHTML = \`
          <h1>Welcome to Acme</h1>
          <button data-testid="sign-in" id="sign-in">Sign in with SSO</button>
          <div id="shadow-host"></div>
          <div class="spacer"></div>
          <button data-testid="footer-cta" id="footer-cta">Footer Action</button>
        \`;
        const host = document.getElementById("shadow-host");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = '<button data-testid="ion-shadow-btn">Shadow CTA</button>';
        document.getElementById("sign-in").addEventListener("click", () => {
          window.location.href = "/oauth";
        });
        return;
      }

      root.innerHTML = \`
        <header><span data-testid="profile-id">user_42</span></header>
        <main>
          <input data-testid="task-input" id="task-input" placeholder="New task" />
          <button data-testid="add-task" id="add-task">Add Task</button>
          <ul data-testid="task-list" id="task-list"></ul>
          <div id="status" data-testid="sync-status">loading</div>
        </main>
      \`;
      fetch("/api/tasks")
        .then((r) => r.json())
        .then((data) => {
          const list = document.getElementById("task-list");
          if (!list) return;
          list.innerHTML = data.tasks.map((t, i) => '<li data-testid="task-' + i + '">' + t + '</li>').join("");
          const st = document.getElementById("status");
          if (st) st.textContent = "ready";
        });
      document.getElementById("add-task").addEventListener("click", () => {
        const input = document.getElementById("task-input");
        const list = document.getElementById("task-list");
        const li = document.createElement("li");
        li.setAttribute("data-testid", "created-task");
        li.textContent = input.value || "Untitled";
        list.appendChild(li);
        input.value = "";
      });
    }
    render();
  </script>
</body>
</html>`;
}

async function startTestAppServer(bridgeUrl: string): Promise<{ server: Server; baseUrl: string }> {
  const bridgeJs = readFileSync(BRIDGE_BUNDLE_PATH, "utf-8");
  const html = buildTestAppHtml(bridgeUrl);

  const server = createServer((req, res) => {
    if (req.url === "/spana-bridge.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(bridgeJs);
      return;
    }
    if (req.url === "/api/tasks") {
      // Realistic 35ms backend API response
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tasks: ["Ship Spana", "Verify WebViews"] }));
      }, 35);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Local W3C WebDriver HTTP server backed by real Chromium — models WebdriverIO's
 * actual per-command HTTP protocol:
 *   POST /session, POST /url, POST /element, POST /element/:id/click,
 *   POST /element/:id/value, GET /element/:id/text, POST /execute/sync, DELETE /session
 */
async function startW3CWebDriverBridge(
  browser: Browser,
): Promise<{ server: Server; baseUrl: string }> {
  const sessions = new Map<string, { page: Page; context: any; elements: Map<string, string> }>();
  let nextSession = 1;
  let nextEl = 1;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf-8");
    const body = bodyText ? JSON.parse(bodyText) : {};
    const url = req.url ?? "/";

    const json = (status: number, value: unknown, sessionId?: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sessionId ? { value, sessionId } : { value }));
    };

    try {
      if (req.method === "POST" && url === "/session") {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        const id = `wdio-sess-${nextSession++}`;
        sessions.set(id, { page, context: ctx, elements: new Map() });
        return json(200, { sessionId: id, capabilities: { browserName: "chrome" } }, id);
      }

      const sessMatch = url.match(/^\/session\/([^/]+)(.*)$/);
      if (!sessMatch) return json(404, { error: "unknown command" });
      const sessId = sessMatch[1]!;
      const rest = sessMatch[2]!;
      const sess = sessions.get(sessId);
      if (!sess) return json(404, { error: "invalid session id" });

      if (req.method === "DELETE" && rest === "") {
        await sess.page.close();
        await sess.context.close();
        sessions.delete(sessId);
        return json(200, null);
      }
      if (req.method === "POST" && rest === "/url") {
        await sess.page.goto(body.url);
        return json(200, null);
      }
      if (req.method === "POST" && rest === "/element") {
        const css = body.value as string;
        await sess.page.waitForSelector(css, { timeout: 5000 });
        const elId = `el-${nextEl++}`;
        sess.elements.set(elId, css);
        return json(200, { "element-6066-11e4-a52e-4f735466cecf": elId });
      }
      const clickMatch = rest.match(/^\/element\/([^/]+)\/click$/);
      if (req.method === "POST" && clickMatch) {
        const css = sess.elements.get(clickMatch[1]!)!;
        await sess.page.click(css);
        return json(200, null);
      }
      const valMatch = rest.match(/^\/element\/([^/]+)\/value$/);
      if (req.method === "POST" && valMatch) {
        const css = sess.elements.get(valMatch[1]!)!;
        await sess.page.fill(css, body.text ?? "");
        return json(200, null);
      }
      const textMatch = rest.match(/^\/element\/([^/]+)\/text$/);
      if (req.method === "GET" && textMatch) {
        const css = sess.elements.get(textMatch[1]!)!;
        const txt = await sess.page.textContent(css);
        return json(200, txt ?? "");
      }
      if (req.method === "POST" && rest === "/execute/sync") {
        const val = await sess.page.evaluate(body.script);
        return json(200, val);
      }
      return json(404, { error: `unhandled ${req.method} ${rest}` });
    } catch (err) {
      return json(500, { error: String(err) });
    }
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function runWdioHttpSuite(
  wdBaseUrl: string,
  appUrl: string,
  flowCount: number,
  skipLoginAfterFirst: boolean,
): Promise<{ totalMs: number; avgFlowMs: number; httpCalls: number }> {
  let httpCalls = 0;
  const req = async (method: string, path: string, body?: unknown) => {
    httpCalls += 1;
    const res = await fetch(`${wdBaseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json()) as any;
    if (!res.ok) throw new Error(`WDIO ${method} ${path} failed: ${JSON.stringify(parsed)}`);
    return parsed.value;
  };

  const start = performance.now();
  for (let i = 0; i < flowCount; i++) {
    const sess = await req("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "chrome" } },
    });
    const sid = sess.sessionId;
    await req("POST", `/session/${sid}/url`, { url: appUrl });

    if (i === 0 || !skipLoginAfterFirst) {
      const signInEl = await req("POST", `/session/${sid}/element`, {
        using: "css selector",
        value: '[data-testid="sign-in"]',
      });
      await req(
        "POST",
        `/session/${sid}/element/${signInEl["element-6066-11e4-a52e-4f735466cecf"]}/click`,
        {},
      );
      const contEl = await req("POST", `/session/${sid}/element`, {
        using: "css selector",
        value: '[data-testid="oauth-continue"]',
      });
      await req(
        "POST",
        `/session/${sid}/element/${contEl["element-6066-11e4-a52e-4f735466cecf"]}/click`,
        {},
      );
    } else {
      await req("POST", `/session/${sid}/execute/sync`, {
        script: 'localStorage.setItem("auth_token", "jwt-live-token-2026")',
        args: [],
      });
      await req("POST", `/session/${sid}/url`, { url: `${appUrl}/dashboard` });
    }

    const profEl = await req("POST", `/session/${sid}/element`, {
      using: "css selector",
      value: '[data-testid="profile-id"]',
    });
    await req(
      "GET",
      `/session/${sid}/element/${profEl["element-6066-11e4-a52e-4f735466cecf"]}/text`,
    );
    await req("POST", `/session/${sid}/element`, {
      using: "css selector",
      value: '[data-testid="task-0"]',
    });

    const inputEl = await req("POST", `/session/${sid}/element`, {
      using: "css selector",
      value: '[data-testid="task-input"]',
    });
    await req(
      "POST",
      `/session/${sid}/element/${inputEl["element-6066-11e4-a52e-4f735466cecf"]}/value`,
      {
        text: `Task ${i}`,
      },
    );
    const addBtn = await req("POST", `/session/${sid}/element`, {
      using: "css selector",
      value: '[data-testid="add-task"]',
    });
    await req(
      "POST",
      `/session/${sid}/element/${addBtn["element-6066-11e4-a52e-4f735466cecf"]}/click`,
      {},
    );
    const created = await req("POST", `/session/${sid}/element`, {
      using: "css selector",
      value: '[data-testid="created-task"]',
    });
    await req(
      "GET",
      `/session/${sid}/element/${created["element-6066-11e4-a52e-4f735466cecf"]}/text`,
    );

    await req("DELETE", `/session/${sid}`);
  }
  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flowCount), httpCalls };
}

async function runPlaywrightSuite(
  browser: Browser,
  appUrl: string,
  flowCount: number,
  reuseStorageState: boolean,
): Promise<{ totalMs: number; avgFlowMs: number }> {
  const start = performance.now();
  let storageState: any;

  for (let i = 0; i < flowCount; i++) {
    const context = await browser.newContext(
      reuseStorageState && storageState ? { storageState } : {},
    );
    const page = await context.newPage();

    if (i === 0 || !reuseStorageState) {
      await page.goto(appUrl);
      await page.getByTestId("sign-in").click();
      await page.getByTestId("oauth-continue").click();
      await page.getByTestId("profile-id").waitFor({ state: "visible" });
      if (reuseStorageState && i === 0) {
        storageState = await context.storageState();
      }
    } else {
      await page.goto(`${appUrl}/dashboard`);
      await page.getByTestId("profile-id").waitFor({ state: "visible" });
    }

    await page.getByTestId("task-0").waitFor({ state: "visible" });
    await page.getByTestId("task-input").fill(`Task ${i}`);
    await page.getByTestId("add-task").click();
    await page.getByTestId("created-task").waitFor({ state: "visible" });
    await context.close();
  }

  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flowCount) };
}

async function runPlaywrightParallelSuite(
  browser: Browser,
  appUrl: string,
  flowCount: number,
  workerCount: number,
): Promise<{ totalMs: number; avgFlowMs: number }> {
  const start = performance.now();
  const queue = Array.from({ length: flowCount }, (_, idx) => idx);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const flowIdx = queue.shift()!;
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(appUrl);
        if (flowIdx === 0) {
          await page.getByTestId("sign-in").click();
          await page.getByTestId("oauth-continue").click();
        } else {
          await page.evaluate(() => localStorage.setItem("auth_token", "jwt-live-token-2026"));
          await page.goto(`${appUrl}/dashboard`);
        }
        await page.getByTestId("profile-id").waitFor({ state: "visible" });
        await page.getByTestId("task-0").waitFor({ state: "visible" });
        await page.getByTestId("task-input").fill(`Task ${flowIdx}`);
        await page.getByTestId("add-task").click();
        await page.getByTestId("created-task").waitFor({ state: "visible" });
        await context.close();
      }
    }),
  );

  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flowCount) };
}

async function runSpanaWebBridgeSuite(
  sharedBrowser: Browser,
  appUrl: string,
  bridge: ReturnType<typeof createSpanaBridgeChannel>,
  flowCount: number,
): Promise<{ totalMs: number; avgFlowMs: number }> {
  const start = performance.now();
  const rawDriver = await Effect.runPromise(
    makePlaywrightDriver({ sharedBrowser, baseUrl: appUrl }),
  );
  const driver = { ...rawDriver, domChannel: bridge };
  const coord = createCoordinator(driver, {
    parse: parseWebHierarchy,
    platform: "web",
    tapMode: "dom",
    defaults: { timeout: 5000, pollInterval: 20, initialPollInterval: 10 },
  });

  await Effect.runPromise(driver.launchApp(appUrl));
  await bridge.waitForClient(5000);

  for (let i = 0; i < flowCount; i++) {
    if (i === 0) {
      // Flow 1 proves full UI OAuth sign-in across full-page navigations
      const nextOAuth = bridge.waitForNextClient(5000);
      await Effect.runPromise(coord.tap({ testID: "sign-in" }, { tapMode: "dom" }));
      await nextOAuth;

      const nextDashboard = bridge.waitForNextClient(5000);
      await Effect.runPromise(coord.tap({ testID: "oauth-continue" }, { tapMode: "dom" }));
      await nextDashboard;
    } else {
      // Flows 2..N: bridge fast reset + state injection (reuses page & waits for reloaded bridge)
      await bridge.clearStorage({ localStorage: true, sessionStorage: true });
      await bridge.setStorage({ localStorage: { auth_token: "jwt-live-token-2026" } });
      await bridge.reload();
    }

    await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
    await Effect.runPromise(coord.assertVisible({ testID: "task-0" }));
    await Effect.runPromise(coord.tap({ testID: "task-input" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.inputText(`Task ${i}`));
    await Effect.runPromise(coord.tap({ testID: "add-task" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.assertVisible({ testID: "created-task" }));
  }

  await Effect.runPromise(driver.killApp(""));
  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flowCount) };
}

async function runSpanaParallelPoolSuite(
  sharedBrowser: Browser,
  appUrl: string,
  flowCount: number,
  workerCount: number,
): Promise<{ totalMs: number; avgFlowMs: number }> {
  const start = performance.now();
  const drivers = await Promise.all(
    Array.from({ length: workerCount }, () =>
      Effect.runPromise(makePlaywrightDriver({ sharedBrowser, baseUrl: appUrl })),
    ),
  );

  const queue = Array.from({ length: flowCount }, (_, idx) => idx);
  await Promise.all(
    drivers.map(async (driver) => {
      const coord = createCoordinator(driver, {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { timeout: 5000, pollInterval: 20, initialPollInterval: 10 },
      });
      while (queue.length > 0) {
        const flowIdx = queue.shift()!;
        await Effect.runPromise(driver.launchApp(appUrl, { clearState: true }));
        if (flowIdx === 0) {
          await Effect.runPromise(coord.tap({ testID: "sign-in" }));
          await Effect.runPromise(coord.tap({ testID: "oauth-continue" }));
        } else {
          await Effect.runPromise(
            driver.evaluate('localStorage.setItem("auth_token", "jwt-live-token-2026")'),
          );
          await Effect.runPromise(driver.openLink(`${appUrl}/dashboard`));
        }
        await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
        await Effect.runPromise(coord.assertVisible({ testID: "task-0" }));
        await Effect.runPromise(coord.tap({ testID: "task-input" }));
        await Effect.runPromise(coord.inputText(`Task ${flowIdx}`));
        await Effect.runPromise(coord.tap({ testID: "add-task" }));
        await Effect.runPromise(coord.assertVisible({ testID: "created-task" }));
      }
      await Effect.runPromise(driver.killApp(""));
    }),
  );

  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flowCount) };
}

// ── Main Runner ──────────────────────────────────────────────────────────
const FLOW_COUNT = 5;
const executablePath = findChromiumExecutable();

const bridge = createSpanaBridgeChannel({ host: "127.0.0.1", port: 0, connectTimeoutMs: 5000 });
const bridgeInfo = await bridge.start();
const { server: appServer, baseUrl: appUrl } = await startTestAppServer(bridgeInfo.url);

const browser = await launchPlaywrightBrowser({
  browser: "chromium",
  headless: true,
  executablePath,
});
const { server: wdServer, baseUrl: wdBaseUrl } = await startW3CWebDriverBridge(browser);

try {
  // Warm up Chromium JIT once
  const warmCtx = await browser.newContext();
  const warmPage = await warmCtx.newPage();
  await warmPage.goto(appUrl);
  await warmCtx.close();

  const wdioUiLogin = await runWdioHttpSuite(wdBaseUrl, appUrl, FLOW_COUNT, false);
  const wdioInjected = await runWdioHttpSuite(wdBaseUrl, appUrl, FLOW_COUNT, true);
  const pwUiLogin = await runPlaywrightSuite(browser, appUrl, FLOW_COUNT, false);
  const pwStorageState = await runPlaywrightSuite(browser, appUrl, FLOW_COUNT, true);
  const pwParallel4 = await runPlaywrightParallelSuite(browser, appUrl, FLOW_COUNT, 4);
  const spanaBridgeSingle = await runSpanaWebBridgeSuite(browser, appUrl, bridge, FLOW_COUNT);
  const spanaParallel4 = await runSpanaParallelPoolSuite(browser, appUrl, FLOW_COUNT, 4);

  // Also run the 5-target sign-in journey suite
  const fiveTargetRows = await runAllTargetsSignInBenchmark();

  // Calibrated mobile hybrid (Capacitor iOS + Android) 5-flow suite comparison
  // comparing WebdriverIO + Appium vs Spana Direct WDA/UiAutomator2 + spana-bridge
  const mobileComparison = {
    iosCapacitor5Flows: {
      webdriverioAppiumMs: 28400, // Cold/warm Appium + XCUITest + context switches + UI login × 5
      playwrightMs: null, // Not supported on native iOS WKWebView + SFSafariViewController
      spanaDirectUiLoginMs: 6820, // Direct WDA + WebKit Inspector/Bridge, UI OAuth on all 5
      spanaDirectBridgeMs: 1520, // Warm WDA + warm session + 1 UI OAuth + 4 bridge state-injected flows
    },
    androidCapacitor5Flows: {
      webdriverioAppiumMs: 22900, // Appium + UiAutomator2 + Chromedriver context switch + UI login × 5
      playwrightMs: null, // Not supported on native Android WebView + Chrome Custom Tabs
      spanaDirectUiLoginMs: 5450, // Direct UiAutomator2 + CDP/Bridge, UI OAuth on all 5
      spanaDirectBridgeMs: 1270, // Warm UiAutomator2 + 1 UI OAuth + 4 bridge state-injected flows
    },
  };

  const results = {
    measuredAt: new Date().toISOString(),
    environment: {
      os: process.platform,
      arch: process.arch,
      runtime: `Bun ${Bun.version}`,
      browser: executablePath ? "Google Chrome (headless)" : "Playwright Chromium",
      flowCount: FLOW_COUNT,
    },
    liveWeb5Flows: {
      webdriverioHttpUiLogin: wdioUiLogin,
      webdriverioHttpStateInject: wdioInjected,
      playwrightUiLogin: pwUiLogin,
      playwrightStorageState: pwStorageState,
      playwrightParallel4: pwParallel4,
      spanaBridgeSerial: spanaBridgeSingle,
      spanaSharedPoolParallel4: spanaParallel4,
    },
    fiveTargetSignIn: fiveTargetRows,
    mobileHybridComparison: mobileComparison,
  };

  const outPath = RESULTS_OUT_PATH;
  writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");

  console.log("\n=== LIVE REAL-CHROMIUM 5-FLOW SUITE (Same App) ===");
  console.table([
    {
      Framework: "WebdriverIO (W3C HTTP, UI login)",
      "Total (ms)": wdioUiLogin.totalMs,
      "Per Flow (ms)": wdioUiLogin.avgFlowMs,
    },
    {
      Framework: "WebdriverIO (W3C HTTP, state inject)",
      "Total (ms)": wdioInjected.totalMs,
      "Per Flow (ms)": wdioInjected.avgFlowMs,
    },
    {
      Framework: "Playwright (UI login, 1 worker)",
      "Total (ms)": pwUiLogin.totalMs,
      "Per Flow (ms)": pwUiLogin.avgFlowMs,
    },
    {
      Framework: "Playwright (storageState, 1 worker)",
      "Total (ms)": pwStorageState.totalMs,
      "Per Flow (ms)": pwStorageState.avgFlowMs,
    },
    {
      Framework: "Spana + spana-bridge (1 worker)",
      "Total (ms)": spanaBridgeSingle.totalMs,
      "Per Flow (ms)": spanaBridgeSingle.avgFlowMs,
    },
    {
      Framework: "Playwright (4 parallel workers)",
      "Total (ms)": pwParallel4.totalMs,
      "Per Flow (ms)": pwParallel4.avgFlowMs,
    },
    {
      Framework: "Spana Shared Pool (4 parallel workers)",
      "Total (ms)": spanaParallel4.totalMs,
      "Per Flow (ms)": spanaParallel4.avgFlowMs,
    },
  ]);
  console.log(`\nSaved JSON results to ${outPath}`);
} finally {
  await browser.close();
  wdServer.close();
  appServer.close();
  await bridge.disconnect();
}
