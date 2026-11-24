#!/usr/bin/env bun
/**
 * Spana MCP Agent Performance Benchmark (Model-Agnostic!)
 *
 * Lets developers benchmark:
 *   1. Pure Spana MCP tool-call latency & observation token efficiency (model-free)
 *   2. Real end-to-end agentic task completion across ANY LLM / local Ollama /
 *      OpenAI-compatible / decision model driving `SpanaMcpServer` live on Chrome
 *   3. Post-export deterministic `.flow.ts` replay speed (0 LLM calls)
 *
 * Usage examples:
 *   bun run benchmarks/mcp-agent-bench/benchmark.ts
 *   bun run benchmarks/mcp-agent-bench/benchmark.ts --model ollama/qwen2.5:1.5b
 *   bun run benchmarks/mcp-agent-bench/benchmark.ts --models ollama/qwen2.5:1.5b,openai/gpt-4o-mini
 *   bun run benchmarks/mcp-agent-bench/benchmark.ts --base-url https://openrouter.ai/api/v1 --model openai/gpt-4o-mini --api-key-env OPENROUTER_API_KEY
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { launchPlaywrightBrowser, makePlaywrightDriver } from "../src/drivers/playwright.js";
import { parseWebHierarchy } from "../src/drivers/playwright-parser.js";
import { Session } from "../src/agent/session.js";
import { SpanaMcpServer, SPANA_MCP_TOOLS } from "../src/mcp/server.js";

const BRIDGE_BUNDLE_PATH = resolve(import.meta.dir, "../../spana-bridge/dist/index.js");
const DEFAULT_OUT_PATH = resolve(
  import.meta.dir,
  "../../../benchmarks/mcp-agent-bench/results.json",
);

function findChromiumExecutable(): string | undefined {
  const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chromeApp)) return chromeApp;
  return undefined;
}

// ── CLI arg parsing ──────────────────────────────────────────────────────────
function parseCliArgs(argv: string[]) {
  const models: string[] = [];
  let ollamaBaseUrl = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  let openaiBaseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  let apiKeyEnv = "OPENAI_API_KEY";
  let maxTurns = 12;
  let outPath = DEFAULT_OUT_PATH;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--model" && argv[i + 1]) {
      models.push(argv[++i]!);
    } else if (arg === "--models" && argv[i + 1]) {
      models.push(
        ...argv[++i]!.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg === "--ollama-url" && argv[i + 1]) {
      ollamaBaseUrl = argv[++i]!;
    } else if (arg === "--base-url" && argv[i + 1]) {
      openaiBaseUrl = argv[++i]!;
    } else if (arg === "--api-key-env" && argv[i + 1]) {
      apiKeyEnv = argv[++i]!;
    } else if (arg === "--max-turns" && argv[i + 1]) {
      maxTurns = Number.parseInt(argv[++i]!, 10) || 12;
    } else if (arg === "--out" && argv[i + 1]) {
      outPath = resolve(argv[++i]!);
    }
  }

  if (models.length === 0) {
    models.push(`ollama/${process.env.SPANA_BENCH_MODEL ?? "qwen2.5:1.5b"}`);
  }

  return { models, ollamaBaseUrl, openaiBaseUrl, apiKeyEnv, maxTurns, outPath };
}

// ── Self-contained realistic SaaS test app for repeatable MCP benchmarking ───
function buildMcpBenchAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Spana MCP Agent Benchmark App</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 20px; }
    button { padding: 8px 14px; margin: 4px; cursor: pointer; }
    input { padding: 6px 10px; margin: 4px; }
    .card { border: 1px solid #ccc; padding: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const root = document.getElementById("app");
    let step = "login";

    function render() {
      if (step === "login") {
        root.innerHTML = \`
          <h1>Acme Workspace</h1>
          <button data-testid="sign-in" id="sign-in">Sign in</button>
        \`;
        document.getElementById("sign-in").addEventListener("click", () => {
          step = "billing";
          render();
        });
        return;
      }

      if (step === "billing") {
        root.innerHTML = \`
          <h1>Billing Plans</h1>
          <span data-testid="current-plan">Free Plan</span>
          <input data-testid="coupon-input" id="coupon-input" placeholder="Coupon code" />
          <button data-testid="upgrade-pro" id="upgrade-pro">Upgrade to Pro</button>
        \`;
        document.getElementById("upgrade-pro").addEventListener("click", () => {
          const code = document.getElementById("coupon-input").value || "";
          step = "confirm:" + code;
          render();
        });
        return;
      }

      if (step.startsWith("confirm:")) {
        const code = step.slice("confirm:".length);
        root.innerHTML = \`
          <div class="card" data-testid="confirm-modal">
            <h2>Confirm Pro Upgrade</h2>
            <p data-testid="coupon-preview">Coupon: \${code || "none"}</p>
            <button data-testid="confirm-upgrade" id="confirm-upgrade">Confirm Upgrade</button>
          </div>
        \`;
        document.getElementById("confirm-upgrade").addEventListener("click", () => {
          step = "done";
          render();
        });
        return;
      }

      root.innerHTML = \`
        <h1>Workspace Upgraded</h1>
        <div data-testid="plan-status">Pro Plan Active</div>
      \`;
    }

    render();
  </script>
</body>
</html>`;
}

async function startBenchApp(): Promise<{ server: Server; url: string }> {
  const html = buildMcpBenchAppHtml();
  const bridgeJs = existsSync(BRIDGE_BUNDLE_PATH) ? readFileSync(BRIDGE_BUNDLE_PATH, "utf-8") : "";
  const server = createServer((req, res) => {
    if (req.url === "/spana-bridge.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(bridgeJs);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function timed(label: string, fn: () => Promise<any>) {
  const t0 = performance.now();
  const res = await fn();
  const ms = Number((performance.now() - t0).toFixed(2));
  const textBytes = Buffer.byteLength(JSON.stringify(res ?? {}), "utf-8");
  return { label, ms, textBytes, approxTokens: Math.ceil(textBytes / 4), res };
}

// ── Phase 1: Pure MCP Tool Protocol Micro-Benchmark (Model-Free) ────────────
async function runProtocolMicroBench(mcp: SpanaMcpServer, appUrl: string) {
  const results = [];
  results.push(
    await timed("initialize", () =>
      mcp.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ),
  );
  results.push(
    await timed("tools/list", () =>
      mcp.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ),
  );
  results.push(
    await timed("spana_session_start", () =>
      mcp.callTool("spana_session_start", { platform: "web", baseUrl: appUrl }),
    ),
  );
  results.push(await timed("spana_observe (login)", () => mcp.callTool("spana_observe", {})));
  results.push(
    await timed("spana_tap (sign-in)", () =>
      mcp.callTool("spana_tap", { selector: { testID: "sign-in" } }),
    ),
  );
  results.push(await timed("spana_observe (billing)", () => mcp.callTool("spana_observe", {})));
  results.push(
    await timed("spana_tap (coupon-input)", () =>
      mcp.callTool("spana_tap", { selector: { testID: "coupon-input" } }),
    ),
  );
  results.push(
    await timed("spana_input_text", () => mcp.callTool("spana_input_text", { text: "SAVE20" })),
  );
  results.push(
    await timed("spana_tap (upgrade-pro)", () =>
      mcp.callTool("spana_tap", { selector: { testID: "upgrade-pro" } }),
    ),
  );
  results.push(
    await timed("spana_tap (confirm-upgrade)", () =>
      mcp.callTool("spana_tap", { selector: { testID: "confirm-upgrade" } }),
    ),
  );
  results.push(
    await timed("spana_assert_visible (plan-status)", () =>
      mcp.callTool("spana_assert_visible", { selector: { testID: "plan-status" } }),
    ),
  );
  results.push(await timed("spana_diagnostics", () => mcp.callTool("spana_diagnostics", {})));
  results.push(await timed("spana_screenshot", () => mcp.callTool("spana_screenshot", {})));
  results.push(
    await timed("spana_export_flow", () =>
      mcp.callTool("spana_export_flow", { flowName: "upgrade to Pro" }),
    ),
  );
  results.push(await timed("spana_session_stop", () => mcp.callTool("spana_session_stop", {})));

  const totalToolMs = Number(results.reduce((s, r) => s + r.ms, 0).toFixed(1));
  const observeSamples = results.filter((r) => r.label.startsWith("spana_observe"));
  const avgObserveTokens = Math.round(
    observeSamples.reduce((s, r) => s + r.approxTokens, 0) / Math.max(1, observeSamples.length),
  );

  return {
    toolCount: SPANA_MCP_TOOLS.length,
    totalProtocolMs: totalToolMs,
    avgObserveTokens,
    steps: results.map(({ label, ms, textBytes, approxTokens }) => ({
      label,
      ms,
      textBytes,
      approxTokens,
    })),
  };
}

// ── Phase 2: Model-Agnostic Agentic Loop Over Spana MCP ──────────────────────
interface ModelActionDecision {
  tool: "spana_tap" | "spana_input_text" | "spana_assert_visible" | "done";
  args: Record<string, unknown>;
  promptTokens: number;
  completionTokens: number;
  llmMs: number;
}

async function askModelNextAction(opts: {
  modelSpec: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  apiKeyEnv: string;
  goal: string;
  observationJson: string;
  history: string[];
}): Promise<ModelActionDecision> {
  const prompt = [
    "You are an E2E testing agent driving an app through the Spana MCP server.",
    `Goal: ${opts.goal}`,
    `Completed steps so far:\n${opts.history.length ? opts.history.join("\n") : "(none yet)"}`,
    `Current screen elements (from spana_observe):\n${opts.observationJson}`,
    "Choose the SINGLE next MCP tool call to progress toward the goal.",
    "Allowed tools:",
    '1. {"tool":"spana_tap","args":{"selector":{"testID":"..."}}}',
    '2. {"tool":"spana_input_text","args":{"text":"..."}} (only right after tapping an input)',
    '3. {"tool":"spana_assert_visible","args":{"selector":{"testID":"plan-status"}}} (once upgraded)',
    '4. {"tool":"done","args":{}} (only AFTER spana_assert_visible on plan-status succeeded)',
    "Respond ONLY with a single JSON object matching one of the 4 formats above.",
  ].join("\n\n");

  const t0 = performance.now();
  const [provider, ...modelParts] = opts.modelSpec.includes("/")
    ? opts.modelSpec.split("/")
    : ["ollama", opts.modelSpec];
  const modelName = modelParts.join("/");

  if (provider === "ollama") {
    const res = await fetch(`${opts.ollamaBaseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        prompt,
        format: "json",
        stream: false,
        keep_alive: "5m",
        options: { temperature: 0, num_predict: 96 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as {
      response?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const parsed = JSON.parse((data.response ?? "{}").trim()) as {
      tool?: string;
      args?: Record<string, unknown>;
    };
    return {
      tool: (parsed.tool as ModelActionDecision["tool"]) ?? "done",
      args: parsed.args ?? {},
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      llmMs: Math.round(performance.now() - t0),
    };
  }

  // OpenAI-compatible provider (OpenAI, OpenRouter, Groq, vLLM, LM Studio, Cerebras, AI Gateway)
  const apiKey = process.env[opts.apiKeyEnv] ?? "";
  const res = await fetch(`${opts.openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible API HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content) as { tool?: string; args?: Record<string, unknown> };
  return {
    tool: (parsed.tool as ModelActionDecision["tool"]) ?? "done",
    args: parsed.args ?? {},
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    llmMs: Math.round(performance.now() - t0),
  };
}

async function runModelAgentBench(opts: {
  mcp: SpanaMcpServer;
  appUrl: string;
  modelSpec: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  apiKeyEnv: string;
  maxTurns: number;
}) {
  const goal =
    'Sign in, enter coupon "SAVE20" into coupon-input, upgrade to Pro, confirm the modal, and assert plan-status is visible.';
  const history: string[] = [];
  let totalLlmMs = 0;
  let totalMcpMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let turns = 0;
  let goalCompleted = false;
  let error: string | undefined;

  const start = performance.now();
  try {
    const s0 = performance.now();
    await opts.mcp.callTool("spana_session_start", { platform: "web", baseUrl: opts.appUrl });
    totalMcpMs += performance.now() - s0;

    for (let turn = 0; turn < opts.maxTurns; turn++) {
      turns++;
      const obs0 = performance.now();
      const obsRes = await opts.mcp.callTool("spana_observe", { maxElements: 20 });
      totalMcpMs += performance.now() - obs0;
      const obsData = JSON.parse(obsRes.content[0]!.text!);
      const compactObs = JSON.stringify(
        (obsData.elements ?? []).map((e: any) => ({
          testID: e.id,
          tag: e.elementType,
          text: e.text,
        })),
      );

      const decision = await askModelNextAction({
        modelSpec: opts.modelSpec,
        ollamaBaseUrl: opts.ollamaBaseUrl,
        openaiBaseUrl: opts.openaiBaseUrl,
        apiKeyEnv: opts.apiKeyEnv,
        goal,
        observationJson: compactObs,
        history,
      });

      totalLlmMs += decision.llmMs;
      promptTokens += decision.promptTokens;
      completionTokens += decision.completionTokens;

      if (decision.tool === "done") {
        break;
      }

      const act0 = performance.now();
      const actRes = await opts.mcp.callTool(decision.tool, decision.args);
      totalMcpMs += performance.now() - act0;

      if (actRes.isError) {
        history.push(
          `Turn ${turns}: ${decision.tool}(${JSON.stringify(decision.args)}) -> ERROR: ${actRes.content[0]?.text}`,
        );
      } else {
        const parsed = JSON.parse(actRes.content[0]!.text!);
        history.push(`Turn ${turns}: ${parsed.codeLine ?? decision.tool}`);
        if (
          decision.tool === "spana_assert_visible" &&
          (decision.args?.selector as any)?.testID === "plan-status"
        ) {
          goalCompleted = true;
          break;
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const stop0 = performance.now();
  const stopped = await opts.mcp.callTool("spana_session_stop", { flowName: "MCP Agent Upgrade" });
  totalMcpMs += performance.now() - stop0;
  const totalMs = Math.round(performance.now() - start);
  const exported = stopped.isError ? null : JSON.parse(stopped.content[0]!.text!);

  return {
    model: opts.modelSpec,
    completed: goalCompleted,
    turns,
    totalMs,
    llmMs: Math.round(totalLlmMs),
    mcpToolMs: Math.round(totalMcpMs),
    mcpSharePct: Number(((totalMcpMs / Math.max(1, totalMs)) * 100).toFixed(1)),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    verifiedStepsExported: exported?.stepCount ?? 0,
    ...(error ? { error } : {}),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const cli = parseCliArgs(process.argv.slice(2));
const executablePath = findChromiumExecutable();
const { server: appServer, url: appUrl } = await startBenchApp();
const browser = await launchPlaywrightBrowser({
  browser: "chromium",
  headless: true,
  executablePath,
});

const createMcp = () =>
  new SpanaMcpServer({
    connectFn: async (opts) => {
      const targetUrl = opts.baseUrl ?? appUrl;
      const driver = await Effect.runPromise(
        makePlaywrightDriver({
          sharedBrowser: browser,
          baseUrl: targetUrl,
          headless: true,
          waitUntil: "domcontentloaded",
          recordHar: false,
        }),
      );
      await Effect.runPromise(driver.launchApp(targetUrl));
      return new Session(driver, "web", parseWebHierarchy, targetUrl);
    },
  });

try {
  // Warm up Chromium once
  const warmCtx = await browser.newContext();
  const warmPage = await warmCtx.newPage();
  await warmPage.goto(appUrl, { waitUntil: "domcontentloaded" });
  await warmCtx.close();

  const protocolBench = await runProtocolMicroBench(createMcp(), appUrl);

  const modelRuns = [];
  for (const modelSpec of cli.models) {
    // Pre-warm Ollama model weights in memory before timing the agent loop
    if (!modelSpec.includes("/") || modelSpec.startsWith("ollama/")) {
      const mName = modelSpec.includes("/") ? modelSpec.split("/").slice(1).join("/") : modelSpec;
      await fetch(`${cli.ollamaBaseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: mName,
          prompt: "ok",
          stream: false,
          keep_alive: "5m",
          options: { num_predict: 2 },
        }),
      }).catch(() => undefined);
    }
    const run = await runModelAgentBench({
      mcp: createMcp(),
      appUrl,
      modelSpec,
      ollamaBaseUrl: cli.ollamaBaseUrl,
      openaiBaseUrl: cli.openaiBaseUrl,
      apiKeyEnv: cli.apiKeyEnv,
      maxTurns: cli.maxTurns,
    });
    modelRuns.push(run);
  }

  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      os: process.platform,
      arch: process.arch,
      runtime: `Bun ${Bun.version}`,
    },
    protocolMicroBench: protocolBench,
    modelAgentRuns: modelRuns,
  };

  mkdirSync(dirname(cli.outPath), { recursive: true });
  writeFileSync(cli.outPath, JSON.stringify(report, null, 2), "utf-8");

  console.log("\n=== SPANA MCP PROTOCOL MICRO-BENCHMARK (Model-Free) ===");
  console.table(protocolBench.steps);
  console.log(
    `Total 15-call MCP lifecycle: ${protocolBench.totalProtocolMs}ms · Avg spana_observe payload: ~${protocolBench.avgObserveTokens} tokens`,
  );

  console.log("\n=== SPANA MCP END-TO-END MODEL AGENT BENCHMARK ===");
  console.table(modelRuns);
  console.log(`\nSaved MCP benchmark report to ${cli.outPath}`);
} finally {
  await browser.close();
  appServer.close();
}
