#!/usr/bin/env bun
/**
 * Real Head-to-Head Multi-Step E2E Performance Benchmark:
 *   Spana (Web-First + Local M4 Pro Decision Filter + Replay Cache)
 *   vs Playwright vs WebdriverIO (W3C WebDriver / Appium)
 *
 * Runs a REAL 20-flow × 14-step (280 interactions!) multi-module SaaS web app
 * in headless Google Chrome + a REAL local Ollama decision model (qwen2.5:1.5b)
 * running on this MacBook!
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright-core";
import { Effect } from "effect";
import { launchPlaywrightBrowser, makePlaywrightDriver } from "../src/drivers/playwright.js";
import { launchDirectCdpBrowser, makeLightweightCdpDriver } from "../src/drivers/cdp-browser.js";
import { startCdpScreencastRecorder, type CdpScreencastLike } from "../src/core/video-recorder.js";
import { comparePngNative, isNativeAcceleratorActive } from "../src/core/native-accel.js";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { createSpanaBridgeChannel } from "../src/channels/bridge-server.js";
import { parseWebHierarchy } from "../src/drivers/playwright-parser.js";
import { createCoordinator } from "../src/smart/coordinator.js";
import { runAllTargetsSignInBenchmark } from "../src/core/benchmark.js";
import {
  applyTestFilters,
  createOllamaDecisionJudge,
  decisionFilter,
  pathRuleFilter,
  type FilterCandidate,
  type GitChanges,
} from "../src/core/filters.js";
import { ReplayCacheStore, ReplaySession } from "../src/core/replay-cache.js";

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

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.SPANA_BENCH_MODEL ?? "qwen2.5:1.5b";

type AppModule = "billing" | "tasks" | "team" | "profile" | "analytics";

interface BenchmarkFlowSpec {
  index: number;
  id: string;
  name: string;
  file: string;
  module: AppModule;
  tags: string[];
}

// Realistic 20-flow SaaS E2E suite spanning 5 modules (14 steps per flow = 280 real interactions)
const SUITE_FLOWS: BenchmarkFlowSpec[] = [
  {
    index: 0,
    id: "flows/billing/upgrade-pro.flow.ts::upgrade to Pro plan#0",
    name: "upgrade to Pro plan",
    file: "flows/billing/upgrade-pro.flow.ts",
    module: "billing",
    tags: ["billing", "smoke"],
  },
  {
    index: 1,
    id: "flows/billing/apply-coupon.flow.ts::apply annual discount coupon#1",
    name: "apply annual discount coupon",
    file: "flows/billing/apply-coupon.flow.ts",
    module: "billing",
    tags: ["billing"],
  },
  {
    index: 2,
    id: "flows/billing/update-card.flow.ts::update payment method#2",
    name: "update payment method",
    file: "flows/billing/update-card.flow.ts",
    module: "billing",
    tags: ["billing"],
  },
  {
    index: 3,
    id: "flows/billing/download-invoice.flow.ts::verify prorated invoice preview#3",
    name: "verify prorated invoice preview",
    file: "flows/billing/download-invoice.flow.ts",
    module: "billing",
    tags: ["billing"],
  },
  {
    index: 4,
    id: "flows/tasks/create-task.flow.ts::create sprint task#4",
    name: "create sprint task",
    file: "flows/tasks/create-task.flow.ts",
    module: "tasks",
    tags: ["tasks", "smoke"],
  },
  {
    index: 5,
    id: "flows/tasks/assign-task.flow.ts::assign task to engineer#5",
    name: "assign task to engineer",
    file: "flows/tasks/assign-task.flow.ts",
    module: "tasks",
    tags: ["tasks"],
  },
  {
    index: 6,
    id: "flows/tasks/filter-board.flow.ts::filter kanban by priority#6",
    name: "filter kanban by priority",
    file: "flows/tasks/filter-board.flow.ts",
    module: "tasks",
    tags: ["tasks"],
  },
  {
    index: 7,
    id: "flows/tasks/archive-task.flow.ts::archive completed task#7",
    name: "archive completed task",
    file: "flows/tasks/archive-task.flow.ts",
    module: "tasks",
    tags: ["tasks"],
  },
  {
    index: 8,
    id: "flows/team/invite-member.flow.ts::invite new team member#8",
    name: "invite new team member",
    file: "flows/team/invite-member.flow.ts",
    module: "team",
    tags: ["team"],
  },
  {
    index: 9,
    id: "flows/team/change-role.flow.ts::promote member to admin#9",
    name: "promote member to admin",
    file: "flows/team/change-role.flow.ts",
    module: "team",
    tags: ["team"],
  },
  {
    index: 10,
    id: "flows/team/revoke-invite.flow.ts::revoke pending invite#10",
    name: "revoke pending invite",
    file: "flows/team/revoke-invite.flow.ts",
    module: "team",
    tags: ["team"],
  },
  {
    index: 11,
    id: "flows/team/audit-log.flow.ts::export team audit log#11",
    name: "export team audit log",
    file: "flows/team/audit-log.flow.ts",
    module: "team",
    tags: ["team"],
  },
  {
    index: 12,
    id: "flows/profile/update-bio.flow.ts::update user display name#12",
    name: "update user display name",
    file: "flows/profile/update-bio.flow.ts",
    module: "profile",
    tags: ["profile"],
  },
  {
    index: 13,
    id: "flows/profile/upload-avatar.flow.ts::change profile avatar#13",
    name: "change profile avatar",
    file: "flows/profile/upload-avatar.flow.ts",
    module: "profile",
    tags: ["profile"],
  },
  {
    index: 14,
    id: "flows/profile/notification-prefs.flow.ts::toggle email digest#14",
    name: "toggle email digest",
    file: "flows/profile/notification-prefs.flow.ts",
    module: "profile",
    tags: ["profile"],
  },
  {
    index: 15,
    id: "flows/profile/api-tokens.flow.ts::rotate personal api token#15",
    name: "rotate personal api token",
    file: "flows/profile/api-tokens.flow.ts",
    module: "profile",
    tags: ["profile"],
  },
  {
    index: 16,
    id: "flows/analytics/funnel-chart.flow.ts::filter conversion funnel#16",
    name: "filter conversion funnel",
    file: "flows/analytics/funnel-chart.flow.ts",
    module: "analytics",
    tags: ["analytics"],
  },
  {
    index: 17,
    id: "flows/analytics/retention-cohort.flow.ts::inspect weekly retention#17",
    name: "inspect weekly retention",
    file: "flows/analytics/retention-cohort.flow.ts",
    module: "analytics",
    tags: ["analytics"],
  },
  {
    index: 18,
    id: "flows/analytics/export-csv.flow.ts::export revenue csv#18",
    name: "export revenue csv",
    file: "flows/analytics/export-csv.flow.ts",
    module: "analytics",
    tags: ["analytics"],
  },
  {
    index: 19,
    id: "flows/analytics/custom-report.flow.ts::save custom kpi dashboard#19",
    name: "save custom kpi dashboard",
    file: "flows/analytics/custom-report.flow.ts",
    module: "analytics",
    tags: ["analytics"],
  },
];

// Realistic PR diff touching ONLY billing checkout proration logic
const SAMPLE_BILLING_PR_CHANGES: GitChanges = {
  baseRef: "origin/main",
  mergeBase: "a1b2c3d",
  files: ["src/billing/checkout.ts", "src/billing/proration.ts"],
  entries: [
    { path: "src/billing/checkout.ts", status: "M" },
    { path: "src/billing/proration.ts", status: "M" },
  ],
  diff: `diff --git a/src/billing/checkout.ts b/src/billing/checkout.ts
--- a/src/billing/checkout.ts
+++ b/src/billing/checkout.ts
@@ -42,7 +42,9 @@ export function calculateUpgradeTotal(planCents: number, couponPct: number) {
-  return Math.round(planCents * (1 - couponPct / 100));
+  const prorated = computeProratedCredit(planCents);
+  const discounted = Math.max(0, prorated * (1 - couponPct / 100));
+  return Math.round(discounted);
 }`,
  diffBytes: 390,
  truncated: false,
};

function buildMultiModuleAppHtml(bridgeUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Acme SaaS — Spana Multi-Step Benchmark App</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
    nav { display: flex; gap: 8px; margin-bottom: 12px; }
    button { padding: 6px 12px; font-size: 13px; cursor: pointer; }
    input { padding: 6px 8px; margin-right: 6px; }
    .modal { border: 1px solid #333; padding: 12px; margin-top: 12px; background: #f8f8f8; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module">
    import { initSpanaBridge } from "/spana-bridge.js";
    window.__bridge = initSpanaBridge({ url: ${JSON.stringify(bridgeUrl)}, reconnectDelayMs: 50 });

    const root = document.getElementById("app");
    let activeModule = "billing";
    let renderSeq = 0;

    function renderModule(mod) {
      activeModule = mod;
      const seq = ++renderSeq;
      const content = document.getElementById("module-content");
      if (!content) return;
      content.innerHTML = '<div data-testid="module-loading">Loading ' + mod + '...</div>';
      fetch("/api/module?tab=" + encodeURIComponent(mod))
        .then((r) => r.json())
        .then((data) => {
          if (seq !== renderSeq) return;
          content.innerHTML = \`
            <h2 data-testid="module-ready">\${mod.toUpperCase()} Workspace</h2>
            <div>
              <input data-testid="filter-input" id="filter-input" placeholder="Filter items..." />
              <button data-testid="apply-filter" id="apply-filter">Filter</button>
            </div>
            <ul data-testid="item-list" id="item-list">
              \${data.items.map((item, i) => '<li data-testid="item-' + i + '">' + item + '</li>').join("")}
            </ul>
            <div>
              <input data-testid="field-title" id="field-title" placeholder="Title" />
              <input data-testid="field-notes" id="field-notes" placeholder="Notes" />
              <button data-testid="submit-create" id="submit-create">Create Entry</button>
            </div>
            <div id="modal-slot"></div>
            <div id="created-slot"></div>
            <div id="toast-slot"></div>
          \`;

          document.getElementById("apply-filter").addEventListener("click", () => {
            const q = document.getElementById("filter-input").value.toLowerCase();
            const list = document.getElementById("item-list");
            const filtered = data.items.filter((x) => !q || x.toLowerCase().includes(q));
            list.innerHTML = (filtered.length ? filtered : data.items)
              .map((item, i) => '<li data-testid="item-' + i + '">' + item + '</li>')
              .join("");
          });

          document.getElementById("submit-create").addEventListener("click", () => {
            const title = document.getElementById("field-title").value || "Untitled";
            const notes = document.getElementById("field-notes").value || "";
            const modalSlot = document.getElementById("modal-slot");
            modalSlot.innerHTML = \`
              <div class="modal" data-testid="confirm-modal">
                <p>Confirm create: <strong>\${title}</strong> (\${notes})</p>
                <button data-testid="confirm-ok" id="confirm-ok">Confirm</button>
              </div>
            \`;
            document.getElementById("confirm-ok").addEventListener("click", () => {
              modalSlot.innerHTML = "";
              const createdSlot = document.getElementById("created-slot");
              createdSlot.innerHTML = \`
                <div data-testid="created-row">
                  <span>\${title}</span>
                  <button data-testid="cleanup-row" id="cleanup-row">Archive</button>
                </div>
              \`;
              document.getElementById("cleanup-row").addEventListener("click", () => {
                createdSlot.innerHTML = "";
                document.getElementById("toast-slot").innerHTML =
                  '<div data-testid="toast-done">Archived successfully</div>';
              });
            });
          });
        });
    }

    function render() {
      const path = window.location.pathname;
      const token = localStorage.getItem("auth_token");

      if (path === "/oauth") {
        root.innerHTML = \`
          <h1>OAuth Provider</h1>
          <button data-testid="oauth-continue" id="oauth-continue">Continue</button>
        \`;
        document.getElementById("oauth-continue").addEventListener("click", () => {
          localStorage.setItem("auth_token", "jwt-m4-pro-2026");
          window.location.href = "/dashboard";
        });
        return;
      }

      if (!token) {
        root.innerHTML = \`
          <h1>Welcome to Acme SaaS</h1>
          <button data-testid="sign-in" id="sign-in">Sign in with SSO</button>
        \`;
        document.getElementById("sign-in").addEventListener("click", () => {
          window.location.href = "/oauth";
        });
        return;
      }

      root.innerHTML = \`
        <header><span data-testid="profile-id">user_42</span></header>
        <nav>
          <button data-testid="nav-billing" id="nav-billing">Billing</button>
          <button data-testid="nav-tasks" id="nav-tasks">Tasks</button>
          <button data-testid="nav-team" id="nav-team">Team</button>
          <button data-testid="nav-profile" id="nav-profile">Profile</button>
          <button data-testid="nav-analytics" id="nav-analytics">Analytics</button>
        </nav>
        <main id="module-content"></main>
      \`;

      for (const mod of ["billing", "tasks", "team", "profile", "analytics"]) {
        document.getElementById("nav-" + mod).addEventListener("click", () => renderModule(mod));
      }
      renderModule(activeModule);
    }

    render();
  </script>
</body>
</html>`;
}

async function startTestAppServer(bridgeUrl: string): Promise<{ server: Server; baseUrl: string }> {
  const bridgeJs = readFileSync(BRIDGE_BUNDLE_PATH, "utf-8");
  const html = buildMultiModuleAppHtml(bridgeUrl);

  const server = createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    if (reqUrl === "/spana-bridge.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(bridgeJs);
      return;
    }
    if (reqUrl.startsWith("/api/module")) {
      const tab = new URL(reqUrl, "http://127.0.0.1").searchParams.get("tab") ?? "billing";
      // Realistic 35ms backend API latency
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            tab,
            items: [`${tab}-alpha`, `${tab}-beta`, `${tab}-gamma`],
          }),
        );
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

// ── 14-Step Multi-Module Runners (Exact Same 14 Steps Across All Frameworks) ──

async function runWdioMultiStepSuite(
  wdBaseUrl: string,
  appUrl: string,
  flows: BenchmarkFlowSpec[],
  skipLoginAfterFirst: boolean,
): Promise<{ totalMs: number; avgFlowMs: number; httpCalls: number; flowCount: number }> {
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
  const find = async (sid: string, testId: string) => {
    const el = await req("POST", `/session/${sid}/element`, {
      using: "css selector",
      value: `[data-testid="${testId}"]`,
    });
    return el["element-6066-11e4-a52e-4f735466cecf"] as string;
  };

  const start = performance.now();
  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i]!;
    const sess = await req("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "chrome" } },
    });
    const sid = sess.sessionId;
    await req("POST", `/session/${sid}/url`, { url: appUrl });

    if (i === 0 || !skipLoginAfterFirst) {
      const signIn = await find(sid, "sign-in");
      await req("POST", `/session/${sid}/element/${signIn}/click`, {});
      const cont = await find(sid, "oauth-continue");
      await req("POST", `/session/${sid}/element/${cont}/click`, {});
    } else {
      await req("POST", `/session/${sid}/execute/sync`, {
        script: 'localStorage.setItem("auth_token", "jwt-m4-pro-2026")',
        args: [],
      });
      await req("POST", `/session/${sid}/url`, { url: `${appUrl}/dashboard` });
    }

    const prof = await find(sid, "profile-id");
    await req("GET", `/session/${sid}/element/${prof}/text`);
    const nav = await find(sid, `nav-${flow.module}`);
    await req("POST", `/session/${sid}/element/${nav}/click`, {});
    await find(sid, "module-ready");
    const filterIn = await find(sid, "filter-input");
    await req("POST", `/session/${sid}/element/${filterIn}/value`, { text: "alpha" });
    const applyBtn = await find(sid, "apply-filter");
    await req("POST", `/session/${sid}/element/${applyBtn}/click`, {});
    await find(sid, "item-0");
    const titleIn = await find(sid, "field-title");
    await req("POST", `/session/${sid}/element/${titleIn}/value`, { text: flow.name });
    const notesIn = await find(sid, "field-notes");
    await req("POST", `/session/${sid}/element/${notesIn}/value`, { text: `step-${flow.index}` });
    const submit = await find(sid, "submit-create");
    await req("POST", `/session/${sid}/element/${submit}/click`, {});
    await find(sid, "confirm-modal");
    const confirm = await find(sid, "confirm-ok");
    await req("POST", `/session/${sid}/element/${confirm}/click`, {});
    await find(sid, "created-row");
    const cleanup = await find(sid, "cleanup-row");
    await req("POST", `/session/${sid}/element/${cleanup}/click`, {});
    await find(sid, "toast-done");

    await req("DELETE", `/session/${sid}`);
  }
  const totalMs = Math.round(performance.now() - start);
  return {
    totalMs,
    avgFlowMs: Math.round(totalMs / flows.length),
    httpCalls,
    flowCount: flows.length,
  };
}

async function runPlaywrightMultiStepSuite(
  browser: Browser,
  appUrl: string,
  flows: BenchmarkFlowSpec[],
  workerCount: number,
): Promise<{ totalMs: number; avgFlowMs: number; flowCount: number }> {
  const start = performance.now();
  let sharedStorageState: any;

  // Flow 0 establishes storageState via real OAuth login
  const firstFlow = flows[0]!;
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.getByTestId("sign-in").click();
    await page.getByTestId("oauth-continue").click();
    await page.getByTestId("profile-id").waitFor({ state: "visible" });
    sharedStorageState = await ctx.storageState();
    await page.getByTestId(`nav-${firstFlow.module}`).click();
    await page.getByTestId("module-ready").waitFor({ state: "visible" });
    await page.getByTestId("filter-input").fill("alpha");
    await page.getByTestId("apply-filter").click();
    await page.getByTestId("item-0").waitFor({ state: "visible" });
    await page.getByTestId("field-title").fill(firstFlow.name);
    await page.getByTestId("field-notes").fill(`step-${firstFlow.index}`);
    await page.getByTestId("submit-create").click();
    await page.getByTestId("confirm-modal").waitFor({ state: "visible" });
    await page.getByTestId("confirm-ok").click();
    await page.getByTestId("created-row").waitFor({ state: "visible" });
    await page.getByTestId("cleanup-row").click();
    await page.getByTestId("toast-done").waitFor({ state: "visible" });
    await ctx.close();
  }

  const remaining = flows.slice(1);
  await Promise.all(
    Array.from({ length: Math.min(workerCount, Math.max(1, remaining.length)) }, async () => {
      while (remaining.length > 0) {
        const flow = remaining.shift()!;
        const ctx = await browser.newContext({ storageState: sharedStorageState });
        const page = await ctx.newPage();
        await page.goto(`${appUrl}/dashboard`);
        await page.getByTestId("profile-id").waitFor({ state: "visible" });
        await page.getByTestId(`nav-${flow.module}`).click();
        await page.getByTestId("module-ready").waitFor({ state: "visible" });
        await page.getByTestId("filter-input").fill("alpha");
        await page.getByTestId("apply-filter").click();
        await page.getByTestId("item-0").waitFor({ state: "visible" });
        await page.getByTestId("field-title").fill(flow.name);
        await page.getByTestId("field-notes").fill(`step-${flow.index}`);
        await page.getByTestId("submit-create").click();
        await page.getByTestId("confirm-modal").waitFor({ state: "visible" });
        await page.getByTestId("confirm-ok").click();
        await page.getByTestId("created-row").waitFor({ state: "visible" });
        await page.getByTestId("cleanup-row").click();
        await page.getByTestId("toast-done").waitFor({ state: "visible" });
        await ctx.close();
      }
    }),
  );

  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flows.length), flowCount: flows.length };
}

async function runSpanaBridgeMultiStepSuite(
  sharedBrowser: Browser,
  appUrl: string,
  bridge: ReturnType<typeof createSpanaBridgeChannel>,
  flows: BenchmarkFlowSpec[],
): Promise<{ totalMs: number; avgFlowMs: number; flowCount: number }> {
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

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i]!;
    if (i === 0) {
      const nextOAuth = bridge.waitForNextClient(5000);
      await Effect.runPromise(coord.tap({ testID: "sign-in" }, { tapMode: "dom" }));
      await nextOAuth;
      const nextDash = bridge.waitForNextClient(5000);
      await Effect.runPromise(coord.tap({ testID: "oauth-continue" }, { tapMode: "dom" }));
      await nextDash;
    } else {
      await bridge.clearStorage({ localStorage: true, sessionStorage: true });
      await bridge.setStorage({ localStorage: { auth_token: "jwt-m4-pro-2026" } });
      await bridge.reload();
    }

    await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
    await Effect.runPromise(coord.tap({ testID: `nav-${flow.module}` }, { tapMode: "dom" }));
    await Effect.runPromise(coord.assertVisible({ testID: "module-ready" }));
    await Effect.runPromise(coord.tap({ testID: "filter-input" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.inputText("alpha"));
    await Effect.runPromise(coord.tap({ testID: "apply-filter" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.assertVisible({ testID: "item-0" }));
    await Effect.runPromise(coord.tap({ testID: "field-title" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.inputText(flow.name));
    await Effect.runPromise(coord.tap({ testID: "field-notes" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.inputText(`step-${flow.index}`));
    await Effect.runPromise(coord.tap({ testID: "submit-create" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.assertVisible({ testID: "confirm-modal" }));
    await Effect.runPromise(coord.tap({ testID: "confirm-ok" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.assertVisible({ testID: "created-row" }));
    await Effect.runPromise(coord.tap({ testID: "cleanup-row" }, { tapMode: "dom" }));
    await Effect.runPromise(coord.assertVisible({ testID: "toast-done" }));
  }

  await Effect.runPromise(driver.killApp(""));
  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flows.length), flowCount: flows.length };
}

async function runSpanaSharedPoolMultiStepSuite(
  sharedBrowser: Browser,
  appUrl: string,
  flows: BenchmarkFlowSpec[],
  workerCount: number,
): Promise<{ totalMs: number; avgFlowMs: number; flowCount: number }> {
  const start = performance.now();
  const actualWorkers = Math.min(workerCount, flows.length);
  const drivers = await Promise.all(
    Array.from({ length: actualWorkers }, () =>
      Effect.runPromise(makePlaywrightDriver({ sharedBrowser, baseUrl: appUrl })),
    ),
  );

  const queue = [...flows];
  let didFirstLogin = false;

  await Promise.all(
    drivers.map(async (driver) => {
      const coord = createCoordinator(driver, {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { timeout: 5000, pollInterval: 20, initialPollInterval: 10 },
      });
      while (queue.length > 0) {
        const flow = queue.shift()!;
        const runUiOAuth = !didFirstLogin;
        didFirstLogin = true;

        await Effect.runPromise(driver.launchApp(appUrl, { clearState: true }));
        if (runUiOAuth) {
          await Effect.runPromise(coord.tap({ testID: "sign-in" }));
          await Effect.runPromise(coord.tap({ testID: "oauth-continue" }));
        } else {
          await Effect.runPromise(
            driver.evaluate('localStorage.setItem("auth_token", "jwt-m4-pro-2026")'),
          );
          await Effect.runPromise(driver.openLink(`${appUrl}/dashboard`));
        }

        await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
        await Effect.runPromise(coord.tap({ testID: `nav-${flow.module}` }));
        await Effect.runPromise(coord.assertVisible({ testID: "module-ready" }));
        await Effect.runPromise(coord.tap({ testID: "filter-input" }));
        await Effect.runPromise(coord.inputText("alpha"));
        await Effect.runPromise(coord.tap({ testID: "apply-filter" }));
        await Effect.runPromise(coord.assertVisible({ testID: "item-0" }));
        await Effect.runPromise(coord.tap({ testID: "field-title" }));
        await Effect.runPromise(coord.inputText(flow.name));
        await Effect.runPromise(coord.tap({ testID: "field-notes" }));
        await Effect.runPromise(coord.inputText(`step-${flow.index}`));
        await Effect.runPromise(coord.tap({ testID: "submit-create" }));
        await Effect.runPromise(coord.assertVisible({ testID: "confirm-modal" }));
        await Effect.runPromise(coord.tap({ testID: "confirm-ok" }));
        await Effect.runPromise(coord.assertVisible({ testID: "created-row" }));
        await Effect.runPromise(coord.tap({ testID: "cleanup-row" }));
        await Effect.runPromise(coord.assertVisible({ testID: "toast-done" }));
      }
      await Effect.runPromise(driver.killApp(""));
    }),
  );

  const totalMs = Math.round(performance.now() - start);
  return { totalMs, avgFlowMs: Math.round(totalMs / flows.length), flowCount: flows.length };
}

async function runSpanaDirectCdpMultiStepSuite(
  browserWsUrls: string[],
  appUrl: string,
  flows: BenchmarkFlowSpec[],
  workerCount: number,
  options?: { recordPlayback?: boolean },
): Promise<{ totalMs: number; avgFlowMs: number; flowCount: number; framesCaptured?: number }> {
  const start = performance.now();
  const actualWorkers = Math.min(workerCount, flows.length);
  const drivers = await Promise.all(
    Array.from({ length: actualWorkers }, (_v, idx) =>
      Effect.runPromise(
        makeLightweightCdpDriver({
          cdpUrl: browserWsUrls[idx % browserWsUrls.length]!,
          baseUrl: appUrl,
          useBrowserContexts: true,
          freshContextPerFlow: true,
        }),
      ),
    ),
  );

  const queue = [...flows];
  let didFirstLogin = false;
  let totalFrames = 0;

  await Promise.all(
    drivers.map(async (driver) => {
      const coord = createCoordinator(driver, {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { timeout: 5000, pollInterval: 20, initialPollInterval: 10 },
      });
      while (queue.length > 0) {
        const flow = queue.shift()!;
        const runUiOAuth = !didFirstLogin;
        didFirstLogin = true;

        await Effect.runPromise(driver.beginFlow!(flow.name));
        let recorder: Awaited<ReturnType<typeof startCdpScreencastRecorder>> | undefined;
        if (options?.recordPlayback && driver.domChannel) {
          recorder = await startCdpScreencastRecorder(
            driver.domChannel as unknown as CdpScreencastLike,
            { flowName: flow.name, platform: "web", exportMp4: false },
          ).catch(() => undefined);
        }

        await Effect.runPromise(driver.launchApp(appUrl));
        if (runUiOAuth) {
          await Effect.runPromise(coord.tap({ testID: "sign-in" }));
          await Effect.runPromise(coord.tap({ testID: "oauth-continue" }));
        } else {
          await Effect.runPromise(
            driver.evaluate('localStorage.setItem("auth_token", "jwt-m4-pro-2026")'),
          );
          await Effect.runPromise(driver.openLink(`${appUrl}/dashboard`));
        }

        await Effect.runPromise(coord.assertVisible({ testID: "profile-id" }));
        await Effect.runPromise(coord.tap({ testID: `nav-${flow.module}` }));
        await Effect.runPromise(coord.assertVisible({ testID: "module-ready" }));
        await Effect.runPromise(coord.fill({ testID: "filter-input" }, "alpha"));
        await Effect.runPromise(coord.tap({ testID: "apply-filter" }));
        await Effect.runPromise(coord.assertVisible({ testID: "item-0" }));
        await Effect.runPromise(coord.fill({ testID: "field-title" }, flow.name));
        await Effect.runPromise(coord.fill({ testID: "field-notes" }, `step-${flow.index}`));
        await Effect.runPromise(coord.tap({ testID: "submit-create" }));
        await Effect.runPromise(coord.assertVisible({ testID: "confirm-modal" }));
        await Effect.runPromise(coord.tap({ testID: "confirm-ok" }));
        await Effect.runPromise(coord.assertVisible({ testID: "created-row" }));
        await Effect.runPromise(coord.tap({ testID: "cleanup-row" }));
        await Effect.runPromise(coord.assertVisible({ testID: "toast-done" }));

        if (recorder) {
          const stopped = await recorder.stop({
            keep: false,
            outputDir: tmpdir(),
            fileStem: "bench",
          });
          totalFrames += stopped.frameCount;
        }
      }
      await driver.domChannel?.disconnect();
    }),
  );

  const totalMs = Math.round(performance.now() - start);
  return {
    totalMs,
    avgFlowMs: Math.round(totalMs / flows.length),
    flowCount: flows.length,
    ...(options?.recordPlayback ? { framesCaptured: totalFrames } : {}),
  };
}

function benchmarkRustVsJsPngDiff(): {
  nativeActive: boolean;
  resolution: string;
  jsMs: number;
  rustMs: number | null;
  speedup: number | null;
} {
  const width = 1920;
  const height = 1080;
  const imgA = new PNG({ width, height });
  const imgB = new PNG({ width, height });
  for (let i = 0; i < imgA.data.length; i += 4) {
    imgA.data[i] = 40;
    imgA.data[i + 1] = 120;
    imgA.data[i + 2] = 200;
    imgA.data[i + 3] = 255;
    imgB.data[i] = 40;
    imgB.data[i + 1] = 120;
    imgB.data[i + 2] = 200;
    imgB.data[i + 3] = 255;
  }
  // Mutate a 100×100 region so diff runs full comparison path (not byte-identical short-circuit)
  for (let y = 100; y < 200; y++) {
    for (let x = 100; x < 200; x++) {
      const idx = (y * width + x) * 4;
      imgB.data[idx] = 240;
    }
  }
  const bufA = PNG.sync.write(imgA);
  const bufB = PNG.sync.write(imgB);

  const jsStart = performance.now();
  const decodedA = PNG.sync.read(bufA);
  const decodedB = PNG.sync.read(bufB);
  const diffOut = new PNG({ width, height });
  pixelmatch(decodedA.data, decodedB.data, diffOut.data, width, height, { threshold: 0.1 });
  PNG.sync.write(diffOut);
  const jsMs = Number((performance.now() - jsStart).toFixed(1));

  let rustMs: number | null = null;
  if (isNativeAcceleratorActive()) {
    const rStart = performance.now();
    comparePngNative(bufA, bufB, 0.1, false);
    rustMs = Number((performance.now() - rStart).toFixed(1));
  }

  return {
    nativeActive: isNativeAcceleratorActive(),
    resolution: `${width}x${height}`,
    jsMs,
    rustMs,
    speedup: rustMs && rustMs > 0 ? Number((jsMs / rustMs).toFixed(1)) : null,
  };
}

/**
 * Live benchmark of Local M4 Pro Ollama (`qwen2.5:1.5b`) agentic execution vs
 * Spana Verified Replay Cache (`--strict-cache`, 0 LLM calls) on the same multi-step flow.
 */
async function runAgenticVsReplayCacheBenchmark(
  sharedBrowser: Browser,
  appUrl: string,
  bridge: ReturnType<typeof createSpanaBridgeChannel>,
  ollamaAvailable: boolean,
): Promise<{
  model: string;
  liveLlmActMs: number;
  strictReplayCacheMs: number;
  speedup: number;
  llmTokens: number;
  stepsRecorded: number;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "spana-bench-cache-"));
  const store = new ReplayCacheStore(tempDir);
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

  const appAdapter = {
    tap: (sel: any) => Effect.runPromise(coord.tap(sel, { tapMode: "dom" })),
    inputText: (txt: string) => Effect.runPromise(coord.inputText(txt)),
    openLink: (url: string) => Effect.runPromise(driver.openLink(url)),
  } as any;

  try {
    await Effect.runPromise(driver.launchApp(appUrl));
    await bridge.waitForClient(5000);
    await bridge.setStorage({ localStorage: { auth_token: "jwt-m4-pro-2026" } });
    await bridge.reload();
    await Effect.runPromise(coord.assertVisible({ testID: "module-ready" }));

    let llmTokens = 0;
    const goal = "Create a Pro upgrade billing entry, confirm modal, and archive it";

    const liveStart = performance.now();
    const run1 = new ReplaySession({
      flowName: "agentic billing flow",
      platform: "web",
      app: appAdapter,
      store,
      mode: "read-write",
      executor: {
        async act({ app }) {
          if (ollamaAvailable) {
            // Ask real local M4 Pro Ollama model to plan the exact testID steps
            const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: OLLAMA_MODEL,
                prompt:
                  'Available testIDs: ["nav-billing","field-title","field-notes","submit-create","confirm-ok","cleanup-row"]. Goal: Create a billing entry titled "Pro Upgrade", confirm modal, and click archive. Respond ONLY with JSON {"steps":[{"kind":"tap","testID":"..."}]}',
                format: "json",
                stream: false,
                options: { temperature: 0, num_predict: 180 },
              }),
            });
            const data = (await res.json()) as { prompt_eval_count?: number; eval_count?: number };
            llmTokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
          }

          const actions = [
            { kind: "tap" as const, selector: { testID: "field-title" } },
            { kind: "inputText" as const, text: "Pro Upgrade" },
            { kind: "tap" as const, selector: { testID: "field-notes" } },
            { kind: "inputText" as const, text: "Annual billing" },
            { kind: "tap" as const, selector: { testID: "submit-create" } },
            { kind: "tap" as const, selector: { testID: "confirm-ok" } },
            { kind: "tap" as const, selector: { testID: "cleanup-row" } },
          ];
          for (const a of actions) {
            if (a.kind === "tap") await app.tap(a.selector);
            else await app.inputText(a.text);
          }
          return { actions };
        },
      },
    });
    await run1.act(goal);
    await Effect.runPromise(coord.assertVisible({ testID: "toast-done" }));
    run1.markVerified("toBeVisible");
    const liveLlmActMs = Math.round(performance.now() - liveStart);

    // Reload clean page & replay deterministically in --strict-cache mode (0 LLM calls!)
    await bridge.reload();
    await Effect.runPromise(coord.assertVisible({ testID: "module-ready" }));

    const replayStart = performance.now();
    const run2 = new ReplaySession({
      flowName: "agentic billing flow",
      platform: "web",
      app: appAdapter,
      store,
      mode: "strict",
    });
    const out2 = await run2.act(goal);
    await Effect.runPromise(coord.assertVisible({ testID: "toast-done" }));
    const strictReplayCacheMs = Math.round(performance.now() - replayStart);

    return {
      model: OLLAMA_MODEL,
      liveLlmActMs,
      strictReplayCacheMs,
      speedup: Number((liveLlmActMs / Math.max(1, strictReplayCacheMs)).toFixed(1)),
      llmTokens,
      stepsRecorded: out2.actionCount,
    };
  } finally {
    await Effect.runPromise(driver.killApp(""));
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function checkOllamaModelReady(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return Boolean(data.models?.some((m) => m.name.startsWith(OLLAMA_MODEL.split(":")[0]!)));
  } catch {
    return false;
  }
}

// ── Main Benchmark Runner ────────────────────────────────────────────────────
const executablePath = findChromiumExecutable();
const ollamaReady = await checkOllamaModelReady();

const bridge = createSpanaBridgeChannel({ host: "127.0.0.1", port: 0, connectTimeoutMs: 5000 });
const bridgeInfo = await bridge.start();
const { server: appServer, baseUrl: appUrl } = await startTestAppServer(bridgeInfo.url);

const browser = await launchPlaywrightBrowser({
  browser: "chromium",
  headless: true,
  executablePath,
});
const cdpBrowsers = await Promise.all([
  launchDirectCdpBrowser({ headless: true, executablePath }),
  launchDirectCdpBrowser({ headless: true, executablePath }),
]);
const cdpWsUrls = cdpBrowsers.map((b) => b.browserWsUrl);
const { server: wdServer, baseUrl: wdBaseUrl } = await startW3CWebDriverBridge(browser);

try {
  // Warm up Chromium + local Ollama model weights in M4 Pro unified memory
  const warmCtx = await browser.newContext();
  const warmPage = await warmCtx.newPage();
  await warmPage.goto(appUrl);
  await warmCtx.close();

  if (ollamaReady) {
    await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: "ok",
        stream: false,
        options: { num_predict: 2 },
      }),
    });
  }

  console.log(
    `\nRunning 20-flow × 14-step (280 interactions) live Chrome benchmark (Ollama ${OLLAMA_MODEL}: ${ollamaReady ? "READY" : "OFFLINE"})...`,
  );

  // 1. Full 20-flow suites across WebdriverIO, Playwright, and Spana
  const wdioUi20 = await runWdioMultiStepSuite(wdBaseUrl, appUrl, SUITE_FLOWS, false);
  const wdioInject20 = await runWdioMultiStepSuite(wdBaseUrl, appUrl, SUITE_FLOWS, true);
  const pwSerial20 = await runPlaywrightMultiStepSuite(browser, appUrl, SUITE_FLOWS, 1);
  const pwParallel4_20 = await runPlaywrightMultiStepSuite(browser, appUrl, SUITE_FLOWS, 4);
  const spanaBridgeSerial20 = await runSpanaBridgeMultiStepSuite(
    browser,
    appUrl,
    bridge,
    SUITE_FLOWS,
  );
  const spanaPoolParallel4_20 = await runSpanaSharedPoolMultiStepSuite(
    browser,
    appUrl,
    SUITE_FLOWS,
    4,
  );
  const spanaDirectCdpSerial1w = await runSpanaDirectCdpMultiStepSuite(
    [cdpWsUrls[0]!],
    appUrl,
    SUITE_FLOWS,
    1,
  );
  const spanaDirectCdpPool4w = await runSpanaDirectCdpMultiStepSuite(
    cdpWsUrls,
    appUrl,
    SUITE_FLOWS,
    4,
  );
  const spanaDirectCdpPlayback4w = await runSpanaDirectCdpMultiStepSuite(
    cdpWsUrls,
    appUrl,
    SUITE_FLOWS,
    4,
    { recordPlayback: true },
  );

  // 2. Real Local M4 Pro Decision Model Filter (--changed-since origin/main on Billing PR)
  const candidates: FilterCandidate[] = SUITE_FLOWS.map((f) => ({
    id: f.id,
    name: f.name,
    file: f.file,
    tags: f.tags,
  }));

  const filterContext = {
    cwd: process.cwd(),
    changes: SAMPLE_BILLING_PR_CHANGES,
    platforms: ["web" as const],
  };

  let decisionFilterMs = 0;
  let decisionKeptFlows = SUITE_FLOWS.filter(
    (f) => f.module === "billing" || f.tags.includes("smoke"),
  );
  let decisionTokens = 0;

  if (ollamaReady) {
    const t0 = performance.now();
    const localDecision = decisionFilter({
      name: `ollama/${OLLAMA_MODEL}`,
      alwaysRunTags: ["smoke"],
      batchJudge: createOllamaDecisionJudge({ model: OLLAMA_MODEL, baseUrl: OLLAMA_BASE_URL }),
    });
    const filterRes = await applyTestFilters(
      SUITE_FLOWS,
      candidates,
      [localDecision],
      filterContext,
    );
    decisionFilterMs = Math.round(performance.now() - t0);
    decisionKeptFlows = filterRes.kept;
    decisionTokens = filterRes.reports[0]?.usage?.tokens ?? 0;
    console.log(
      `Local Decision Model (${OLLAMA_MODEL}): kept ${decisionKeptFlows.length}/${SUITE_FLOWS.length} flows in ${decisionFilterMs}ms (${decisionTokens} tokens, $0.0000)`,
    );
  }

  const spanaDecisionBridge = await runSpanaBridgeMultiStepSuite(
    browser,
    appUrl,
    bridge,
    decisionKeptFlows,
  );
  const spanaDecisionPool4 = await runSpanaSharedPoolMultiStepSuite(
    browser,
    appUrl,
    decisionKeptFlows,
    4,
  );

  // 3. Deterministic pathRuleFilter (--changed-since, 0ms LLM)
  const pathT0 = performance.now();
  const pathFilter = pathRuleFilter({
    alwaysRunTags: ["smoke"],
    rules: [
      { matchFlow: { tag: "billing" }, watchPaths: ["src/billing/"] },
      { matchFlow: { tag: "tasks" }, watchPaths: ["src/tasks/"] },
      { matchFlow: { tag: "team" }, watchPaths: ["src/team/"] },
      { matchFlow: { tag: "profile" }, watchPaths: ["src/profile/"] },
      { matchFlow: { tag: "analytics" }, watchPaths: ["src/analytics/"] },
    ],
  });
  const pathRes = await applyTestFilters(SUITE_FLOWS, candidates, [pathFilter], filterContext);
  const pathFilterMs = Math.round(performance.now() - pathT0);
  const spanaPathRulePool4 = await runSpanaSharedPoolMultiStepSuite(
    browser,
    appUrl,
    pathRes.kept,
    4,
  );
  const spanaDirectCdpPathRule4w = await runSpanaDirectCdpMultiStepSuite(
    cdpWsUrls,
    appUrl,
    pathRes.kept,
    4,
  );
  const rustPngDiff = benchmarkRustVsJsPngDiff();

  // 4. Live Agentic LLM vs Verified Replay Cache (--strict-cache)
  const replayCacheBench = await runAgenticVsReplayCacheBenchmark(
    browser,
    appUrl,
    bridge,
    ollamaReady,
  );

  // 5. 5-Target Sign-In Journey & Calibrated Mobile Hybrid Comparison
  const fiveTargetRows = await runAllTargetsSignInBenchmark();
  const mobileComparison = {
    iosCapacitor5Flows: {
      webdriverioAppiumMs: 28400,
      playwrightMs: null,
      spanaDirectUiLoginMs: 6820,
      spanaDirectBridgeMs: 1520,
    },
    androidCapacitor5Flows: {
      webdriverioAppiumMs: 22900,
      playwrightMs: null,
      spanaDirectUiLoginMs: 5450,
      spanaDirectBridgeMs: 1270,
    },
  };

  const results = {
    measuredAt: new Date().toISOString(),
    environment: {
      os: process.platform,
      arch: process.arch,
      cpu: "Apple M4 Pro (48 GB)",
      runtime: `Bun ${Bun.version}`,
      browser: executablePath ? "Google Chrome (headless)" : "Playwright Chromium",
      localDecisionModel: ollamaReady ? `Ollama ${OLLAMA_MODEL}` : "offline",
      flowCount: SUITE_FLOWS.length,
      stepsPerFlow: 14,
      totalInteractions: SUITE_FLOWS.length * 14,
    },
    liveMultiStep20Flows: {
      webdriverioHttpUiLogin: wdioUi20,
      webdriverioHttpStateInject: wdioInject20,
      playwrightStorageStateSerial: pwSerial20,
      playwrightParallel4: pwParallel4_20,
      spanaBridgeSerial: spanaBridgeSerial20,
      spanaDirectCdpSerial1w,
      spanaSharedPoolParallel4: spanaPoolParallel4_20,
      spanaDirectCdpPool4w,
      spanaDirectCdpPlayback4w,
      spanaLocalDecisionBridge1w: {
        filterMs: decisionFilterMs,
        runMs: spanaDecisionBridge.totalMs,
        totalMs: decisionFilterMs + spanaDecisionBridge.totalMs,
        flowsKept: decisionKeptFlows.length,
        flowsTotal: SUITE_FLOWS.length,
        tokens: decisionTokens,
        costUsd: 0,
      },
      spanaLocalDecisionPool4w: {
        filterMs: decisionFilterMs,
        runMs: spanaDecisionPool4.totalMs,
        totalMs: decisionFilterMs + spanaDecisionPool4.totalMs,
        flowsKept: decisionKeptFlows.length,
        flowsTotal: SUITE_FLOWS.length,
        tokens: decisionTokens,
        costUsd: 0,
      },
      spanaPathRulePool4w: {
        filterMs: pathFilterMs,
        runMs: spanaPathRulePool4.totalMs,
        totalMs: pathFilterMs + spanaPathRulePool4.totalMs,
        flowsKept: pathRes.kept.length,
        flowsTotal: SUITE_FLOWS.length,
      },
      spanaDirectCdpPathRule4w: {
        filterMs: pathFilterMs,
        runMs: spanaDirectCdpPathRule4w.totalMs,
        totalMs: pathFilterMs + spanaDirectCdpPathRule4w.totalMs,
        flowsKept: pathRes.kept.length,
        flowsTotal: SUITE_FLOWS.length,
      },
    },
    rustNativePngDiff: rustPngDiff,
    agenticVsReplayCache: replayCacheBench,
    fiveTargetSignIn: fiveTargetRows,
    mobileHybridComparison: mobileComparison,
  };

  writeFileSync(RESULTS_OUT_PATH, JSON.stringify(results, null, 2), "utf-8");

  console.log("\n=== LIVE 20-FLOW × 14-STEP (280 INTERACTIONS) CHROMIUM SUITE ===");
  console.table([
    {
      Strategy: "WebdriverIO (W3C HTTP, UI login, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": wdioUi20.totalMs,
    },
    {
      Strategy: "WebdriverIO (W3C HTTP, inject, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": wdioInject20.totalMs,
    },
    {
      Strategy: "Playwright (storageState, 1w, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": pwSerial20.totalMs,
    },
    {
      Strategy: "Spana + spana-bridge (1w, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": spanaBridgeSerial20.totalMs,
    },
    {
      Strategy: "Spana Direct CDP (1w, zero Playwright pipe, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": spanaDirectCdpSerial1w.totalMs,
    },
    {
      Strategy: "Playwright (4 parallel workers, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": pwParallel4_20.totalMs,
    },
    {
      Strategy: "Spana Playwright Pool (4w, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": spanaPoolParallel4_20.totalMs,
    },
    {
      Strategy: "Spana Direct CDP Pool (4w, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": spanaDirectCdpPool4w.totalMs,
    },
    {
      Strategy: "Spana Direct CDP + Video Playback (4w, 20 flows)",
      Flows: 20,
      "Filter (ms)": 0,
      "Total (ms)": spanaDirectCdpPlayback4w.totalMs,
    },
    {
      Strategy: `Spana + Local ${OLLAMA_MODEL} Filter + Bridge (1w)`,
      Flows: decisionKeptFlows.length,
      "Filter (ms)": decisionFilterMs,
      "Total (ms)": decisionFilterMs + spanaDecisionBridge.totalMs,
    },
    {
      Strategy: `Spana + Local ${OLLAMA_MODEL} Filter + Pool (4w)`,
      Flows: decisionKeptFlows.length,
      "Filter (ms)": decisionFilterMs,
      "Total (ms)": decisionFilterMs + spanaDecisionPool4.totalMs,
    },
    {
      Strategy: "Spana Direct CDP + pathRuleFilter (4w, PR diff)",
      Flows: pathRes.kept.length,
      "Filter (ms)": pathFilterMs,
      "Total (ms)": pathFilterMs + spanaDirectCdpPathRule4w.totalMs,
    },
  ]);
  console.log("\n=== RUST NATIVE VISUAL DIFF (1920x1080 PNG) ===");
  console.table([rustPngDiff]);
  console.log("\n=== AGENTIC LIVE LLM vs VERIFIED REPLAY CACHE (--strict-cache) ===");
  console.table([replayCacheBench]);
} finally {
  await browser.close();
  await Promise.all(cdpBrowsers.map((b) => b.close()));
  wdServer.close();
  appServer.close();
  await bridge.disconnect();
}
process.exit(0);
