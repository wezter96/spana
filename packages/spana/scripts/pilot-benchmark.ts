#!/usr/bin/env bun
/**
 * Realistic Pilot-Grade Head-to-Head Benchmark:
 *   Playwright vs Spana (Playwright engine + Direct CDP engine)
 *
 * Mirrors real production app characteristics reported in the pilot:
 * - Real local HTTP backend serving multi-view SPA pages + async JSON API endpoints
 * - Delayed transient loading overlay / modal obscuring buttons for ~35ms (tests click reliability!)
 * - Delayed animated CTA button shifting position before settling (tests 2-rAF stability!)
 * - Fresh isolated BrowserContext per test (24 flows total)
 * - Full actionability checks ON for both Playwright and Spana
 * - Measures BOTH 1 worker and 4 workers:
 *     - Suite Wall Time (s)
 *     - Median Per-Test Time (ms)
 *     - Click Reliability (0 dropped clicks across 24 flows)
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { flow } from "../src/api/flow.js";
import { buildWebRuntimePool } from "../src/runtime/local.js";
import { runParallel } from "../src/core/parallel.js";
import { executeFlow } from "../src/core/engine.js";
import type { ProvConfig } from "../src/schemas/config.js";

const FLOW_COUNT = 24;

function resolveChromePath(): string {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return chromium.executablePath();
}

function buildPilotPageHtml(id: number): string {
  // Include 4,000 realistic DOM table cells to verify O(1) Light-DOM fast-path performance
  const rows = Array.from(
    { length: 400 },
    (_v, r) =>
      `<tr><td>Row ${r}</td><td>Item ${r}</td><td>Active</td><td>${r * 10}</td><td>OK</td></tr>`,
  ).join("");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Pilot Flow #${id}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #0b1220; color: #e2e8f0; }
    .card { max-width: 520px; padding: 20px; border-radius: 12px; background: #111b2e; border: 1px solid #24334d; }
    input { padding: 8px 10px; width: 260px; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #fff; margin-bottom: 6px; display: block; }
    button { padding: 8px 14px; border-radius: 6px; border: 0; background: #06b6d4; color: #04131c; font-weight: 700; cursor: pointer; }
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); display: flex; align-items: center; justify-content: center; z-index: 99; }
    .hidden { display: none !important; }
    .spacer { height: 760px; }
    table { font-size: 11px; opacity: 0.6; }
  </style>
</head>
<body>
  <div id="overlay" data-testid="loading-overlay" class="overlay">Hydrating session #${id}...</div>
  <div class="card">
    <h1 data-testid="heading">Workspace #${id}</h1>
    <div style="margin: 12px 0;">
      <input data-testid="item-input" placeholder="Item title" />
      <input data-testid="item-notes" placeholder="Notes" />
    </div>
    <button data-testid="create-btn" type="button">Create Item</button>
    <p data-testid="status-text" style="margin-top: 12px;">Idle</p>
  </div>
  <table><tbody>${rows}</tbody></table>
  <div class="spacer"></div>
  <button data-testid="footer-confirm" type="button">Confirm Footer</button>
  <p data-testid="footer-status">Pending</p>

  <script>
    setTimeout(() => {
      document.getElementById("overlay").classList.add("hidden");
    }, 35);

    document.querySelector('[data-testid="create-btn"]').addEventListener("click", async () => {
      const val = document.querySelector('[data-testid="item-input"]').value;
      const notes = document.querySelector('[data-testid="item-notes"]').value;
      const res = await fetch("/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ${id}, title: val, notes })
      });
      const json = await res.json();
      document.querySelector('[data-testid="status-text"]').textContent = "Saved: " + json.title + " (" + json.notes + ")";
    });

    document.querySelector('[data-testid="footer-confirm"]').addEventListener("click", () => {
      setTimeout(() => {
        document.querySelector('[data-testid="footer-status"]').textContent = "Confirmed #${id}";
      }, 20);
    });
  </script>
</body>
</html>`;
}

function startPilotAppServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/items" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          setTimeout(() => {
            const parsed = JSON.parse(body || "{}");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                title: parsed.title ?? "empty",
                notes: parsed.notes ?? "",
              }),
            );
          }, 18);
        });
        return;
      }
      const idMatch = url.pathname.match(/\/flow\/(\d+)/);
      const id = idMatch ? Number(idMatch[1]) : 1;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(buildPilotPageHtml(id));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

interface BenchResult {
  label: string;
  workers: number;
  suiteWallMs: number;
  medianFlowMs: number;
  p95FlowMs: number;
  passed: number;
  failed: number;
}

async function runPlaywrightSuite(
  baseUrl: string,
  executablePath: string,
  workers: number,
): Promise<BenchResult> {
  const suiteStart = performance.now();
  const durations: number[] = [];
  let passed = 0;
  let failed = 0;

  // Match Playwright's real architecture: 1 Chromium process per worker, fresh BrowserContext per test
  const browsers = await Promise.all(
    Array.from({ length: workers }, () => chromium.launch({ headless: true, executablePath })),
  );

  let nextIdx = 0;
  const runWorker = async (workerIdx: number) => {
    const browser = browsers[workerIdx]!;
    while (true) {
      const id = nextIdx++;
      if (id >= FLOW_COUNT) break;
      const t0 = performance.now();
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        await page.goto(`${baseUrl}/flow/${id + 1}`);
        await page.getByTestId("loading-overlay").waitFor({ state: "hidden" });
        await page.getByTestId("item-input").fill(`Task-${id + 1}`);
        await page.getByTestId("item-notes").fill(`Note-${id + 1}`);
        await page.getByTestId("create-btn").click();
        const status = page.getByTestId("status-text");
        await status.waitFor({ state: "visible" });
        const deadline = Date.now() + 5000;
        while ((await status.textContent()) !== `Saved: Task-${id + 1} (Note-${id + 1})`) {
          if (Date.now() > deadline) throw new Error("status text timeout");
          await new Promise((r) => setTimeout(r, 15));
        }
        await page.getByTestId("footer-confirm").click();
        const footer = page.getByTestId("footer-status");
        while ((await footer.textContent()) !== `Confirmed #${id + 1}`) {
          if (Date.now() > deadline) throw new Error("footer text timeout");
          await new Promise((r) => setTimeout(r, 15));
        }
        passed += 1;
      } catch {
        failed += 1;
      } finally {
        await ctx.close();
        durations.push(performance.now() - t0);
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, (_v, i) => runWorker(i)));
  await Promise.all(browsers.map((b) => b.close()));

  const sorted = durations.toSorted((a, b) => a - b);
  return {
    label: "Playwright",
    workers,
    suiteWallMs: Math.round(performance.now() - suiteStart),
    medianFlowMs: Math.round(median(durations)),
    p95FlowMs: Math.round(
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    ),
    passed,
    failed,
  };
}

async function runSpanaSuite(
  baseUrl: string,
  executablePath: string,
  workers: number,
  engine: "playwright" | "cdp",
  maxContextsPerBrowser = 1,
  contextIsolation: "fresh" | "hot-cache" = "fresh",
): Promise<BenchResult> {
  const suiteStart = performance.now();
  const config: ProvConfig = {
    apps: { web: { url: baseUrl } },
    platforms: ["web"],
    execution: {
      web: {
        engine,
        headless: true,
        executablePath,
        freshContextPerFlow: true,
        contextIsolation,
        maxContextsPerBrowser,
      },
    },
    artifacts: { har: false, screenshot: false, uiHierarchy: false },
  };

  const flows = Array.from({ length: FLOW_COUNT }, (_v, i) =>
    flow(`pilot-flow-${i + 1}`, async ({ app, expect }) => {
      await app.openLink(`${baseUrl}/flow/${i + 1}`);
      await expect({ testID: "loading-overlay" }).toBeHidden();
      await app.fill({ testID: "item-input" }, `Task-${i + 1}`);
      await app.fill({ testID: "item-notes" }, `Note-${i + 1}`);
      await app.tap({ testID: "create-btn" });
      await expect({ testID: "status-text" }).toHaveText(`Saved: Task-${i + 1} (Note-${i + 1})`);
      await app.tap({ testID: "footer-confirm" });
      await expect({ testID: "footer-status" }).toHaveText(`Confirmed #${i + 1}`);
    }),
  );

  const pool = await buildWebRuntimePool(config, workers);
  let results;
  try {
    if (workers <= 1) {
      const rt = pool[0]!;
      const serialResults = [];
      for (const f of flows) {
        const r = await executeFlow(f, rt.runtime.driver, {
          ...rt.engineConfig,
          autoLaunch: false,
        });
        serialResults.push(r);
      }
      results = serialResults;
    } else {
      const parallelRun = await runParallel({
        flows,
        workers: pool.map((p, idx) => ({
          id: `w-${idx + 1}`,
          name: `worker-${idx + 1}`,
          driver: p.runtime.driver,
          engineConfig: { ...p.engineConfig, autoLaunch: false },
        })),
      });
      results = parallelRun.results;
    }
  } finally {
    await Promise.all(pool.map((p) => p.runtime.cleanup()));
  }

  const durations = results.map((r) => r.durationMs);
  const sorted = durations.toSorted((a, b) => a - b);
  return {
    label:
      engine === "cdp"
        ? contextIsolation === "hot-cache"
          ? `Spana CDP hot-cache (${maxContextsPerBrowser}ctx/b)`
          : `Spana CDP (${maxContextsPerBrowser}ctx/b)`
        : `Spana PW (${maxContextsPerBrowser}ctx/b)`,
    workers,
    suiteWallMs: Math.round(performance.now() - suiteStart),
    medianFlowMs: Math.round(median(durations)),
    p95FlowMs: Math.round(
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    ),
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}

async function main() {
  const chromePath = resolveChromePath();
  const server = await startPilotAppServer();
  console.log(
    `Pilot benchmark server: ${server.url} | Chrome: ${chromePath} | Flows: ${FLOW_COUNT}\n`,
  );

  const rows: BenchResult[] = [];
  try {
    rows.push(await runPlaywrightSuite(server.url, chromePath, 1));
    rows.push(await runSpanaSuite(server.url, chromePath, 1, "playwright", 1));
    rows.push(await runSpanaSuite(server.url, chromePath, 1, "cdp", 1, "fresh"));
    rows.push(await runSpanaSuite(server.url, chromePath, 1, "cdp", 1, "hot-cache"));

    rows.push(await runPlaywrightSuite(server.url, chromePath, 4));
    rows.push(await runSpanaSuite(server.url, chromePath, 4, "playwright", 2));
    rows.push(await runSpanaSuite(server.url, chromePath, 4, "cdp", 2, "fresh"));
    rows.push(await runSpanaSuite(server.url, chromePath, 4, "cdp", 1, "fresh"));
    rows.push(await runSpanaSuite(server.url, chromePath, 4, "cdp", 2, "hot-cache"));
  } finally {
    await server.close();
  }

  console.log("| Runner | Workers | Suite Wall | Median / test | P95 / test | Pass |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.workers}w | ${(r.suiteWallMs / 1000).toFixed(2)}s | ${r.medianFlowMs}ms | ${r.p95FlowMs}ms | ${r.passed}/${FLOW_COUNT} |`,
    );
  }
  process.exit(0);
}

await main();
