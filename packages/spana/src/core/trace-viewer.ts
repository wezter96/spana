import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserConsoleLog, BrowserHAR, BrowserJSError } from "../drivers/raw-driver.js";
import type { StepResult } from "../report/types.js";
import type { LiveNetworkEvent } from "../diagnostics/live-inspector.js";

export interface RichTraceStep {
  index: number;
  command: string;
  status: "passed" | "failed";
  startedAtMs: number;
  durationMs: number;
  selector?: unknown;
  error?: string;
  /** Data URI (`data:image/png;base64,...`) or relative path to step screenshot. */
  screenshotDataUrl?: string;
  /** Optional DOM HTML snapshot captured at or near this step. */
  domSnapshot?: string;
  /** Optional ARIA accessibility tree snapshot. */
  ariaSnapshot?: string;
}

export interface RichFlowTrace {
  schemaVersion: 1;
  flowName: string;
  platform: string;
  status: "passed" | "failed";
  startedAt: string;
  durationMs: number;
  viewport?: { width: number; height: number };
  steps: RichTraceStep[];
  consoleLogs: BrowserConsoleLog[];
  jsErrors: BrowserJSError[];
  network: Array<{
    url: string;
    method: string;
    status?: number;
    durationMs?: number;
    failed?: boolean;
    errorText?: string;
    resourceType?: string;
  }>;
  domSnapshot?: string;
  ariaSnapshot?: string;
  error?: { message: string; stack?: string };
}

export interface BuildRichTraceInput {
  flowName: string;
  platform: string;
  status: "passed" | "failed";
  startedAt?: string;
  durationMs: number;
  viewport?: { width: number; height: number };
  steps: StepResult[];
  consoleLogs?: BrowserConsoleLog[];
  jsErrors?: BrowserJSError[];
  har?: BrowserHAR;
  liveNetwork?: LiveNetworkEvent[];
  domSnapshot?: string;
  ariaSnapshot?: string;
  error?: { message: string; stack?: string };
  /** Embed step screenshots as base64 data URLs so `trace-viewer.html` is 100% standalone. Default: true. */
  inlineScreenshots?: boolean;
}

function readAttachmentDataUrl(path: string, contentType: string): string | undefined {
  try {
    const bytes = readFileSync(path);
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * Assemble a Playwright-style `RichFlowTrace` combining per-step timings & screenshots,
 * DOM/ARIA snapshots, network waterfall entries, and console/JS errors.
 */
export function buildRichFlowTrace(input: BuildRichTraceInput): RichFlowTrace {
  const inline = input.inlineScreenshots !== false;
  let cursorMs = 0;

  const steps: RichTraceStep[] = input.steps.map((step, index) => {
    const startedAtMs = cursorMs;
    cursorMs += Math.max(0, step.durationMs);
    let screenshotDataUrl: string | undefined;
    const imgAttachment = step.attachments?.find((a) => a.contentType.startsWith("image/"));
    if (imgAttachment) {
      screenshotDataUrl = inline
        ? readAttachmentDataUrl(imgAttachment.path, imgAttachment.contentType)
        : imgAttachment.path;
    }
    return {
      index,
      command: step.command,
      status: step.status,
      startedAtMs,
      durationMs: step.durationMs,
      ...(step.selector !== undefined ? { selector: step.selector } : {}),
      ...(step.error ? { error: step.error } : {}),
      ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
    };
  });

  const network: RichFlowTrace["network"] = [];
  if (input.liveNetwork && input.liveNetwork.length > 0) {
    for (const ev of input.liveNetwork) {
      network.push({
        url: ev.url,
        method: ev.method,
        status: ev.status,
        durationMs: ev.durationMs,
        failed: ev.failed,
        errorText: ev.errorText,
        resourceType: ev.resourceType,
      });
    }
  } else if (input.har?.log?.entries?.length) {
    for (const entry of input.har.log.entries) {
      network.push({
        url: entry.request.url,
        method: entry.request.method,
        status: entry.response.status,
        durationMs: entry.time,
        failed: entry.response.status === 0 || Boolean(entry._failureText),
        errorText: entry._failureText,
        resourceType: entry._resourceType,
      });
    }
  }

  return {
    schemaVersion: 1,
    flowName: input.flowName,
    platform: input.platform,
    status: input.status,
    startedAt: input.startedAt ?? new Date().toISOString(),
    durationMs: input.durationMs,
    ...(input.viewport ? { viewport: input.viewport } : {}),
    steps,
    consoleLogs: input.consoleLogs ?? [],
    jsErrors: input.jsErrors ?? [],
    network,
    ...(input.domSnapshot ? { domSnapshot: input.domSnapshot } : {}),
    ...(input.ariaSnapshot ? { ariaSnapshot: input.ariaSnapshot } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function escapeJsonForHtmlScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Render a self-contained, zero-dependency interactive Playwright-style Trace Viewer HTML page
 * with step timeline scrubber, screenshot inspector, DOM/ARIA snapshots, network waterfall,
 * console logs, and JS error panels.
 */
export function renderTraceViewerHtml(trace: RichFlowTrace): string {
  const payload = escapeJsonForHtmlScript(trace);
  const title = escapeHtml(`${trace.flowName} (${trace.platform}) — Spana Trace Viewer`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3; --muted: #8b949e; --pass: #3fb950; --fail: #f85149; --accent: #58a6ff; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  .badge { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
  .badge.passed { background: rgba(63,185,80,0.18); color: var(--pass); }
  .badge.failed { background: rgba(248,81,73,0.18); color: var(--fail); }
  .meta { color: var(--muted); font-size: 13px; margin-left: auto; }
  main { flex: 1; display: grid; grid-template-columns: 320px 1fr 380px; min-height: 0; }
  .col { border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .col:last-child { border-right: none; }
  .col-title { padding: 8px 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); border-bottom: 1px solid var(--border); background: var(--panel); }
  .scroll { overflow: auto; flex: 1; }
  .step { padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 13px; display: flex; align-items: baseline; gap: 8px; }
  .step:hover { background: rgba(88,166,255,0.08); }
  .step.active { background: rgba(88,166,255,0.18); border-left: 3px solid var(--accent); padding-left: 9px; }
  .step-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .step-dot.passed { background: var(--pass); }
  .step-dot.failed { background: var(--fail); }
  .step-dur { margin-left: auto; color: var(--muted); font-size: 11px; font-family: ui-monospace, monospace; }
  .stage { padding: 16px; display: flex; flex-direction: column; gap: 12px; align-items: center; justify-content: flex-start; }
  .stage img { max-width: 100%; border: 1px solid var(--border); border-radius: 6px; background: #000; }
  .empty { color: var(--muted); font-size: 13px; padding: 24px; text-align: center; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--panel); }
  .tab { padding: 8px 12px; font-size: 12px; border: none; background: transparent; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.active { color: var(--fg); border-bottom-color: var(--accent); }
  pre { margin: 0; padding: 12px; font-size: 12px; font-family: ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
  th { color: var(--muted); font-weight: 600; position: sticky; top: 0; background: var(--panel); }
  .err-box { background: rgba(248,81,73,0.12); border: 1px solid var(--fail); color: #ffb4ae; padding: 10px 12px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; width: 100%; }
</style>
</head>
<body>
<header>
  <strong>Spana Trace Viewer</strong>
  <span class="badge ${trace.status}">${trace.status}</span>
  <span>${escapeHtml(trace.flowName)}</span>
  <span class="meta">${escapeHtml(trace.platform)} · ${trace.durationMs}ms · ${trace.steps.length} steps</span>
</header>
<main>
  <section class="col">
    <div class="col-title">Actions (${trace.steps.length})</div>
    <div id="steps" class="scroll"></div>
  </section>
  <section class="col">
    <div class="col-title">Snapshot &amp; Details</div>
    <div id="stage" class="scroll stage"></div>
  </section>
  <section class="col">
    <div class="tabs">
      <button class="tab active" data-tab="network">Network (${trace.network.length})</button>
      <button class="tab" data-tab="console">Console (${trace.consoleLogs.length})</button>
      <button class="tab" data-tab="errors">Errors (${trace.jsErrors.length})</button>
      <button class="tab" data-tab="dom">DOM / ARIA</button>
    </div>
    <div id="inspector" class="scroll"></div>
  </section>
</main>
<script>
const TRACE = ${payload};
let selectedIdx = TRACE.steps.findIndex((s) => s.status === "failed");
if (selectedIdx < 0) selectedIdx = Math.max(0, TRACE.steps.length - 1);
let activeTab = "network";

function renderSteps() {
  const el = document.getElementById("steps");
  el.innerHTML = "";
  TRACE.steps.forEach((step, i) => {
    const row = document.createElement("div");
    row.className = "step" + (i === selectedIdx ? " active" : "");
    row.innerHTML = '<span class="step-dot ' + step.status + '"></span><span>' + (i + 1) + '. ' + step.command + '</span><span class="step-dur">' + step.durationMs + 'ms</span>';
    row.onclick = () => { selectedIdx = i; renderSteps(); renderStage(); };
    el.appendChild(row);
  });
}

function renderStage() {
  const stage = document.getElementById("stage");
  const step = TRACE.steps[selectedIdx];
  stage.innerHTML = "";
  if (TRACE.error) {
    const err = document.createElement("div");
    err.className = "err-box";
    err.textContent = TRACE.error.message;
    stage.appendChild(err);
  }
  if (!step) {
    stage.innerHTML += '<div class="empty">No recorded steps.</div>';
    return;
  }
  if (step.screenshotDataUrl) {
    const img = document.createElement("img");
    img.src = step.screenshotDataUrl;
    img.alt = step.command;
    stage.appendChild(img);
  } else {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = "No screenshot captured for step: " + step.command;
    stage.appendChild(note);
  }
  const meta = document.createElement("pre");
  meta.style.width = "100%";
  meta.textContent = JSON.stringify({ command: step.command, status: step.status, startedAtMs: step.startedAtMs, durationMs: step.durationMs, selector: step.selector, error: step.error }, null, 2);
  stage.appendChild(meta);
}

function renderInspector() {
  const box = document.getElementById("inspector");
  if (activeTab === "network") {
    if (!TRACE.network.length) { box.innerHTML = '<div class="empty">No network requests captured.</div>'; return; }
    let html = '<table><thead><tr><th>Method</th><th>Status</th><th>Time</th><th>URL</th></tr></thead><tbody>';
    for (const req of TRACE.network) {
      html += '<tr><td>' + req.method + '</td><td>' + (req.failed ? 'ERR' : (req.status ?? '-')) + '</td><td>' + (req.durationMs ?? 0) + 'ms</td><td>' + req.url + '</td></tr>';
    }
    box.innerHTML = html + '</tbody></table>';
  } else if (activeTab === "console") {
    if (!TRACE.consoleLogs.length) { box.innerHTML = '<div class="empty">No console logs.</div>'; return; }
    const pre = document.createElement("pre");
    pre.textContent = TRACE.consoleLogs.map((l) => '[' + l.type + '] ' + l.text).join("\\n");
    box.innerHTML = "";
    box.appendChild(pre);
  } else if (activeTab === "errors") {
    if (!TRACE.jsErrors.length) { box.innerHTML = '<div class="empty">No JS errors.</div>'; return; }
    const pre = document.createElement("pre");
    pre.textContent = TRACE.jsErrors.map((e) => e.name + ': ' + e.message).join("\\n\\n");
    box.innerHTML = "";
    box.appendChild(pre);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = [TRACE.ariaSnapshot ? "=== ARIA SNAPSHOT ===\\n" + TRACE.ariaSnapshot : "", TRACE.domSnapshot ? "=== DOM SNAPSHOT ===\\n" + TRACE.domSnapshot.slice(0, 20000) : ""].filter(Boolean).join("\\n\\n") || "No DOM/ARIA snapshot captured.";
    box.innerHTML = "";
    box.appendChild(pre);
  }
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    renderInspector();
  };
});

renderSteps();
renderStage();
renderInspector();
</script>
</body>
</html>`;
}

/**
 * Write both `trace.json` and interactive `trace-viewer.html` into `outputDir`.
 */
export function writeRichTraceBundle(
  trace: RichFlowTrace,
  outputDir: string,
): { traceJsonPath: string; traceViewerHtmlPath: string } {
  mkdirSync(outputDir, { recursive: true });
  const traceJsonPath = join(outputDir, "trace.json");
  const traceViewerHtmlPath = join(outputDir, "trace-viewer.html");
  writeFileSync(traceJsonPath, JSON.stringify(trace, null, 2), "utf8");
  writeFileSync(traceViewerHtmlPath, renderTraceViewerHtml(trace), "utf8");
  return { traceJsonPath, traceViewerHtmlPath };
}
