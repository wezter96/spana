import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import type { Reporter, FlowResult, RunSummary, StepResult, ScenarioStepResult } from "./types.js";
import type { FlowPlaybackTrace } from "../core/video-recorder.js";
import { collectDiagnosticSections } from "./failure-diagnostics.js";

function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toBase64DataUri(filePath: string): string | null {
  try {
    const data = readFileSync(filePath);
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  return (ms / 1000).toFixed(1) + "s";
}

function driverName(platform: string): string {
  switch (platform) {
    case "web":
      return "Playwright";
    case "android":
      return "UiAutomator2";
    case "ios":
      return "WebDriverAgent";
    default:
      return platform;
  }
}

function statusBadge(status: string): string {
  if (status === "passed") return `<span class="badge badge-pass">PASSED</span>`;
  if (status === "failed") return `<span class="badge badge-fail">FAILED</span>`;
  return `<span class="badge badge-skip">SKIPPED</span>`;
}

function renderStep(step: StepResult, index: number): string {
  const selector = step.selector ? escapeHtml(JSON.stringify(step.selector)) : "";
  return `<div class="step"><span class="step-num">${index + 1}</span><span class="step-action">${escapeHtml(step.command)}</span><span class="step-selector">${selector}</span></div>`;
}

function renderScreenshots(steps: StepResult[]): string {
  const withImages = steps.filter((s) => s.attachments?.some((a) => a.contentType === "image/png"));
  if (withImages.length === 0) return "";

  const cards = withImages
    .map((step, _i) => {
      const img = step.attachments?.find((a) => a.contentType === "image/png");
      if (!img) return "";
      const dataUri = toBase64DataUri(img.path);
      if (!dataUri) return "";
      return `<div class="screenshot-card"><img src="${dataUri}" alt="${escapeHtml(step.command)}" loading="lazy"><div class="label">${escapeHtml(step.command)}</div></div>`;
    })
    .filter(Boolean)
    .join("\n");

  if (!cards) return "";
  return `<div class="screenshots"><h3>Step screenshots</h3><div class="screenshot-grid">${cards}</div></div>`;
}

function renderFinalScreenshot(result: FlowResult): string {
  const img = result.attachments?.find((a) => a.contentType === "image/png");
  if (!img) return "";
  const dataUri = toBase64DataUri(img.path);
  if (!dataUri) return "";
  return `<div class="final-card"><img src="${dataUri}" alt="${escapeHtml(result.platform)} final"><div class="label">${escapeHtml(result.platform)} (${driverName(result.platform)}) &bull; ${formatDuration(result.durationMs)}</div></div>`;
}

function renderDiffTriptych(flowName: string, platform: string, outputDir: string): string {
  let diffFiles: string[];
  const dir = join(outputDir, `${flowName}-${platform}`);
  try {
    diffFiles = readdirSync(dir).filter((f) => f.endsWith("-diff.png"));
  } catch {
    return "";
  }
  if (diffFiles.length === 0) return "";

  const cards = diffFiles
    .map((diffFile) => {
      const base = diffFile.replace(/-diff\.png$/, "");
      const expectedUri = toBase64DataUri(join(dir, `${base}-expected.png`));
      const actualUri = toBase64DataUri(join(dir, `${base}-actual.png`));
      const diffUri = toBase64DataUri(join(dir, diffFile));
      if (!expectedUri && !actualUri && !diffUri) return "";
      const label = escapeHtml(basename(base));
      const imgStyle = `height:220px;max-width:100%;object-fit:contain;border-radius:.375rem;border:1px solid #262626;background:#0a0a0a`;
      const colStyle = `display:flex;flex-direction:column;align-items:center;gap:.5rem;flex:1 1 0;min-width:0`;
      const labelStyle = `font-size:.65rem;color:#525252;text-align:center`;
      const expectedCol = expectedUri
        ? `<div style="${colStyle}"><img src="${expectedUri}" alt="expected" style="${imgStyle}"><div style="${labelStyle}">Expected</div></div>`
        : `<div style="${colStyle}"><div style="height:220px;display:flex;align-items:center;justify-content:center;color:#525252;font-size:.75rem">no file</div><div style="${labelStyle}">Expected</div></div>`;
      const actualCol = actualUri
        ? `<div style="${colStyle}"><img src="${actualUri}" alt="actual" style="${imgStyle}"><div style="${labelStyle}">Actual</div></div>`
        : `<div style="${colStyle}"><div style="height:220px;display:flex;align-items:center;justify-content:center;color:#525252;font-size:.75rem">no file</div><div style="${labelStyle}">Actual</div></div>`;
      const diffCol = diffUri
        ? `<div style="${colStyle}"><img src="${diffUri}" alt="diff" style="${imgStyle}"><div style="${labelStyle}">Diff</div></div>`
        : `<div style="${colStyle}"><div style="height:220px;display:flex;align-items:center;justify-content:center;color:#525252;font-size:.75rem">no file</div><div style="${labelStyle}">Diff</div></div>`;
      return `<div style="margin-bottom:1rem"><div style="font-size:.7rem;color:#737373;margin-bottom:.5rem;font-family:'SF Mono',Menlo,monospace">${label}</div><div style="display:flex;gap:.75rem;overflow-x:auto">${expectedCol}${actualCol}${diffCol}</div></div>`;
    })
    .filter(Boolean)
    .join("\n");

  if (!cards) return "";
  return `<div class="screenshots"><h3>Visual diff</h3>${cards}</div>`;
}

const A11Y_SEVERITY_COLORS: Record<string, string> = {
  critical: "#dc2626",
  serious: "#f97316",
  moderate: "#eab308",
  minor: "#3b82f6",
};

function renderA11yViolations(steps: StepResult[]): string {
  const a11ySteps = steps.filter(
    (s) => s.status === "failed" && s.command.includes("AccessibilityAudit") && s.error,
  );
  if (a11ySteps.length === 0) return "";

  // Parse violations from error text: lines like "  [critical] rule-id (n elements) [WCAG X.X.X]"
  interface ViolationRow {
    rule: string;
    severity: string;
    elements: string;
    wcag: string;
  }
  const rows: ViolationRow[] = [];
  const violationLineRe =
    /^\s+\[(\w+)\]\s+([^\s(]+(?:\s+[^\s([]+)*?)\s+\((\d+)\s+element[s]?\)\s*(?:\[([^\]]+)\])?/;

  for (const step of a11ySteps) {
    for (const line of (step.error ?? "").split("\n")) {
      const m = violationLineRe.exec(line);
      if (m) {
        rows.push({
          severity: m[1] ?? "",
          rule: m[2] ?? "",
          elements: m[3] ?? "",
          wcag: m[4] ?? "",
        });
      }
    }
  }

  if (rows.length === 0) {
    // Fallback: just show the raw error text
    const rawRows = a11ySteps
      .map(
        (s) =>
          `<tr><td colspan="4" style="padding:.5rem 1rem;font-family:'SF Mono',Menlo,monospace;font-size:.72rem;white-space:pre-wrap;color:#fca5a5">${escapeHtml(s.error ?? "")}</td></tr>`,
      )
      .join("");
    return `<div class="diagnostics"><h3>Accessibility violations</h3><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.8rem">${rawRows}</table></div></div>`;
  }

  const headerStyle = `padding:.5rem 1rem;text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#525252;border-bottom:1px solid #262626`;
  const header = `<tr><th style="${headerStyle}">Rule</th><th style="${headerStyle}">Severity</th><th style="${headerStyle}">Elements</th><th style="${headerStyle}">WCAG</th></tr>`;
  const tableRows = rows
    .map((row) => {
      const color = A11Y_SEVERITY_COLORS[row.severity] ?? "#e5e5e5";
      const cellStyle = `padding:.45rem 1rem;border-bottom:1px solid #1a1a1a;color:#d4d4d4;font-size:.78rem`;
      const severityBadge = `<span style="color:${color};font-weight:600">${escapeHtml(row.severity)}</span>`;
      return `<tr><td style="${cellStyle};font-family:'SF Mono',Menlo,monospace">${escapeHtml(row.rule)}</td><td style="${cellStyle}">${severityBadge}</td><td style="${cellStyle};text-align:center">${escapeHtml(row.elements)}</td><td style="${cellStyle};font-size:.72rem;color:#737373">${escapeHtml(row.wcag)}</td></tr>`;
    })
    .join("\n");

  return `<div class="diagnostics"><h3>Accessibility violations</h3><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">${header}${tableRows}</table></div></div>`;
}

function renderDiagnosticSections(result: FlowResult): string {
  const diagnostics = collectDiagnosticSections(result.attachments)
    .map(
      (section) =>
        `<div class="diagnostic-card"><h3>${escapeHtml(section.title)}</h3><pre>${escapeHtml(section.body)}</pre></div>`,
    )
    .join("\n");

  if (!diagnostics) return "";

  return `<div class="diagnostics"><h3>Failure diagnostics</h3><div class="diagnostic-grid">${diagnostics}</div></div>`;
}

function renderScenarioStep(step: ScenarioStepResult): string {
  const icon = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : "○";
  const statusClass =
    step.status === "passed" ? "pass" : step.status === "failed" ? "fail" : "skip";
  const duration =
    step.durationMs > 0 ? `<span class="step-selector">(${step.durationMs}ms)</span>` : "";
  const error = step.error
    ? `<div class="error-msg" style="margin:0.25rem 0 0.5rem 2.25rem;padding:0.5rem;font-size:.75rem">${escapeHtml(step.error)}</div>`
    : "";
  return `<div class="step"><span class="step-num" style="color:${statusClass === "pass" ? "#22c55e" : statusClass === "fail" ? "#ef4444" : "#525252"}">${icon}</span><span class="step-action"><strong>${escapeHtml(step.keyword)}</strong> ${escapeHtml(step.text)}</span>${duration}</div>${error}`;
}

let playbackWidgetCounter = 0;

function renderVideoPlayback(result: FlowResult, outputDir: string): string {
  const playbackAtt = result.attachments?.find(
    (a) => a.name === "playback" || a.path.endsWith("-playback.json"),
  );
  const videoAtt = result.attachments?.find((a) => a.contentType.startsWith("video/"));

  let trace: FlowPlaybackTrace | null = null;
  if (playbackAtt) {
    try {
      trace = JSON.parse(readFileSync(playbackAtt.path, "utf8")) as FlowPlaybackTrace;
    } catch {
      trace = null;
    }
  }

  let videoSection = "";
  const videoPath = videoAtt?.path ?? trace?.videoPath;
  if (videoPath) {
    const mime =
      videoAtt?.contentType ?? (videoPath.endsWith(".webm") ? "video/webm" : "video/mp4");
    let src = relative(outputDir, videoPath).replaceAll("\\", "/");
    try {
      const size = statSync(videoPath).size;
      if (size > 0 && size <= 8 * 1024 * 1024) {
        src = `data:${mime};base64,${readFileSync(videoPath).toString("base64")}`;
      }
    } catch {
      // fall back to relative link
    }
    videoSection = `<div class="playback-video"><video controls playsinline preload="metadata" src="${escapeHtml(src)}"></video></div>`;
  }

  if (!trace || trace.frames.length === 0) {
    if (!videoSection) return "";
    return `<div class="playback"><h3>Video recording</h3>${videoSection}</div>`;
  }

  const widgetId = `spana-pb-${++playbackWidgetCounter}`;
  const safeJson = JSON.stringify({
    frames: trace.frames,
    steps: trace.steps,
    durationMs: trace.durationMs,
    viewport: trace.viewport ?? { width: 1280, height: 720 },
  })
    // Escape every tag-forming char so no run-supplied text can close the <script> block.
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

  const firstFrame = trace.frames[0]!;
  const stepButtons = trace.steps
    .map(
      (s, idx) =>
        `<button type="button" class="pb-step ${s.status === "failed" ? "fail" : ""}" data-step-idx="${idx}"><span class="pb-step-i">${idx + 1}</span><span class="pb-step-cmd">${escapeHtml(s.command)}</span><span class="pb-step-ms">${s.durationMs}ms</span></button>`,
    )
    .join("");

  return `<div class="playback" id="${widgetId}">
  <div class="pb-head">
    <h3>Visual playback (${trace.frames.length} frames)</h3>
    <div class="pb-controls">
      <button type="button" class="pb-btn pb-play" data-action="toggle">Play</button>
      <button type="button" class="pb-btn" data-action="prev">Prev</button>
      <button type="button" class="pb-btn" data-action="next">Next</button>
      <button type="button" class="pb-btn pb-speed" data-action="speed">1x</button>
      <span class="pb-time">0.00s / ${(trace.durationMs / 1000).toFixed(2)}s</span>
    </div>
  </div>
  <div class="pb-body">
    <div class="pb-stage-wrap">
      <div class="pb-stage">
        <img class="pb-img" src="data:${firstFrame.mimeType};base64,${firstFrame.dataBase64}" alt="Playback frame" />
        <div class="pb-ripple" style="display:none"></div>
      </div>
      <input type="range" class="pb-scrubber" min="0" max="${Math.max(0, trace.frames.length - 1)}" value="0" />
    </div>
    ${stepButtons ? `<div class="pb-steps">${stepButtons}</div>` : ""}
  </div>
  ${videoSection}
  <script type="application/json" class="pb-data">${safeJson}</script>
</div>`;
}

function renderPlatform(result: FlowResult, outputDir: string): string {
  const scenarioStepsHtml = result.scenarioSteps
    ? `<div class="steps">${result.scenarioSteps.map(renderScenarioStep).join("\n")}</div>`
    : "";
  const driverStepsHtml =
    (result.steps ?? []).length > 0
      ? `<div class="steps">${(result.steps ?? []).map(renderStep).join("\n")}</div>`
      : "";
  const errorHtml =
    result.status === "failed" && result.error
      ? `<div class="error-msg"><strong>${escapeHtml(result.error.category)}</strong>: ${escapeHtml(result.error.message)}${
          result.error.location
            ? `<div class="error-location" style="margin-top:.35rem;font-family:'SF Mono',Menlo,monospace;font-size:.72rem;color:#a3a3a3">${escapeHtml(result.error.location.file)}:${result.error.location.line}:${result.error.location.column}</div>`
            : ""
        }${
          result.error.codeFrame
            ? `<pre class="error-code-frame" style="margin:.45rem 0;padding:.55rem .75rem;border-radius:.375rem;background:#0a0a0a;border:1px solid #262626;overflow-x:auto;font-family:'SF Mono',Menlo,monospace;font-size:.72rem;line-height:1.45;color:#e5e5e5">${escapeHtml(result.error.codeFrame)}</pre>`
            : ""
        }${
          result.error.suggestion
            ? `<pre class="error-suggestion">${escapeHtml(result.error.suggestion)}</pre>`
            : ""
        }</div>`
      : "";

  return `
<div class="platform">
  <div class="platform-header">
    <div class="platform-name">${escapeHtml(result.platform)} <span style="color:#525252;font-weight:400">(${driverName(result.platform)})</span></div>
    <div style="display:flex;align-items:center;gap:1rem;">
      <span class="platform-time">${formatDuration(result.durationMs)}</span>
      ${statusBadge(result.status)}
    </div>
  </div>
  ${renderVideoPlayback(result, outputDir)}
  ${scenarioStepsHtml}
  ${driverStepsHtml}
  ${renderScreenshots(result.steps ?? [])}
  ${renderDiffTriptych(result.name, result.platform, outputDir)}
  ${renderA11yViolations(result.steps ?? [])}
  ${renderDiagnosticSections(result)}
  ${errorHtml}
</div>`;
}

function buildHTML(summary: RunSummary, outputDir: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
  const flowNames = [...new Set(summary.results.map((r) => r.name))];
  const title = flowNames.length === 1 ? flowNames[0]! : `${summary.total} flows`;

  const finalScreenshots = summary.results.map(renderFinalScreenshot).filter(Boolean).join("\n");

  const platforms = summary.results.map((r) => renderPlatform(r, outputDir)).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>spana &mdash; ${escapeHtml(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:2rem;max-width:100vw;overflow-x:hidden}
a{color:#3b82f6}
h1{font-size:1.5rem;font-weight:600;margin-bottom:.25rem}
.subtitle{color:#737373;font-size:.875rem;margin-bottom:2rem}
.summary{display:flex;gap:1.5rem;margin-bottom:2rem;flex-wrap:wrap}
.stat{background:#171717;border:1px solid #262626;border-radius:.75rem;padding:1.25rem 1.5rem;min-width:140px;flex:1 1 140px}
.stat-value{font-size:1.75rem;font-weight:700}
.stat-label{font-size:.75rem;color:#737373;text-transform:uppercase;letter-spacing:.05em;margin-top:.25rem}
.stat-value.pass{color:#22c55e}.stat-value.fail{color:#ef4444}.stat-value.time{color:#3b82f6}
.platform{background:#171717;border:1px solid #262626;border-radius:.75rem;margin-bottom:1.5rem;overflow:hidden}
.platform-header{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid #262626;flex-wrap:wrap;gap:.5rem}
.platform-name{font-weight:600;font-size:1.1rem;overflow-wrap:break-word;word-break:break-word;min-width:0}
.badge{font-size:.75rem;font-weight:600;padding:.25rem .75rem;border-radius:9999px;white-space:nowrap}
.badge-pass{background:#052e16;color:#22c55e;border:1px solid #14532d}
.badge-fail{background:#450a0a;color:#ef4444;border:1px solid #7f1d1d}
.badge-skip{background:#1c1917;color:#a8a29e;border:1px solid #292524}
.platform-time{color:#737373;font-size:.875rem}
.steps{padding:1rem 1.5rem}
.step{display:flex;align-items:flex-start;gap:.75rem;padding:.4rem 0;flex-wrap:wrap}
.step-num{color:#525252;font-size:.75rem;font-weight:500;min-width:1.5rem;margin-top:2px}
.step-action{font-weight:500;color:#d4d4d4;min-width:100px}
.step-selector{color:#737373;font-size:.8rem;font-family:'SF Mono',Menlo,monospace;overflow-wrap:break-word;word-break:break-all;min-width:0;flex:1 1 100%}
.screenshots{padding:0 1.5rem 1.5rem}
.screenshots h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#525252;margin-bottom:1rem}
.screenshot-grid{display:flex;gap:1rem;overflow-x:auto;padding-bottom:.5rem;-webkit-overflow-scrolling:touch}
.screenshot-card{flex-shrink:0;text-align:center;max-width:80vw}
.screenshot-card img{height:280px;max-width:100%;object-fit:contain;border-radius:.5rem;border:1px solid #262626;background:#0a0a0a}
.screenshot-card .label{font-size:.7rem;color:#525252;margin-top:.5rem}
.diagnostics{padding:0 1.5rem 1.5rem}
.diagnostics h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#525252;margin-bottom:1rem}
.diagnostic-grid{display:grid;gap:1rem}
.diagnostic-card{border:1px solid #262626;border-radius:.5rem;background:#0a0a0a;overflow:hidden}
.diagnostic-card h3{font-size:.8rem;font-weight:600;color:#d4d4d4;padding:.75rem 1rem;border-bottom:1px solid #262626;margin:0;text-transform:none;letter-spacing:0}
.diagnostic-card pre{margin:0;padding:1rem;white-space:pre-wrap;word-break:break-word;font-size:.75rem;line-height:1.5;color:#d4d4d4;font-family:'SF Mono',Menlo,monospace;max-height:320px;overflow:auto}
.final-grid{display:flex;gap:1.5rem;flex-wrap:wrap;justify-content:center}
.final-card{text-align:center;max-width:100%}
.final-card img{height:320px;max-width:100%;object-fit:contain;border-radius:.5rem;border:1px solid #262626}
.final-card .label{font-size:.8rem;color:#737373;margin-top:.5rem;font-weight:500}
.error-msg{padding:1rem 1.5rem;color:#fca5a5;font-family:'SF Mono',Menlo,monospace;font-size:.8rem;border-top:1px solid #262626;overflow-wrap:break-word;word-break:break-word}
.error-suggestion{margin-top:.75rem;padding-top:.75rem;border-top:1px solid #262626;white-space:pre-wrap;font-family:'SF Mono',Menlo,monospace;color:#fecaca}
.flow-name{font-size:.95rem;color:#a3a3a3;margin-bottom:1.5rem;padding:.75rem 1rem;background:#171717;border:1px solid #262626;border-radius:.5rem;font-family:'SF Mono',Menlo,monospace;overflow-wrap:break-word;word-break:break-word}
.playback{padding:1rem 1.5rem;border-bottom:1px solid #262626;background:#111}
.pb-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:.75rem}
.pb-head h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#737373}
.pb-controls{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.pb-btn{background:#1f1f1f;color:#e5e5e5;border:1px solid #333;border-radius:.375rem;padding:.25rem .6rem;font-size:.75rem;cursor:pointer;font-weight:500}
.pb-btn:hover{background:#2b2b2b;border-color:#525252}
.pb-btn.pb-play{background:#0ea5e9;color:#04131c;border-color:#0ea5e9;font-weight:700}
.pb-time{font-family:'SF Mono',Menlo,monospace;font-size:.72rem;color:#a3a3a3;margin-left:.35rem}
.pb-body{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(200px,1fr);gap:1rem;align-items:start}
.pb-stage-wrap{display:flex;flex-direction:column;gap:.5rem}
.pb-stage{position:relative;background:#0a0a0a;border:1px solid #262626;border-radius:.5rem;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:220px}
.pb-img{display:block;max-width:100%;max-height:420px;width:auto;height:auto}
.pb-ripple{position:absolute;width:24px;height:24px;margin-left:-12px;margin-top:-12px;border-radius:9999px;border:2px solid #ef4444;background:rgba(239,68,68,.28);pointer-events:none;box-shadow:0 0 0 6px rgba(239,68,68,.15)}
.pb-scrubber{width:100%;accent-color:#0ea5e9;cursor:pointer}
.pb-steps{display:flex;flex-direction:column;gap:.3rem;max-height:420px;overflow-y:auto}
.pb-step{display:flex;align-items:center;gap:.5rem;text-align:left;background:#171717;border:1px solid #262626;border-radius:.375rem;padding:.4rem .6rem;color:#d4d4d4;font-size:.75rem;cursor:pointer}
.pb-step:hover,.pb-step.active{border-color:#0ea5e9;background:#0c2233}
.pb-step.fail{border-color:#7f1d1d;color:#fca5a5}
.pb-step-i{color:#737373;font-family:'SF Mono',Menlo,monospace;font-size:.7rem;min-width:1.25rem}
.pb-step-cmd{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pb-step-ms{color:#737373;font-family:'SF Mono',Menlo,monospace;font-size:.68rem}
.playback-video{margin-top:.75rem}
.playback-video video{width:100%;max-height:420px;border-radius:.5rem;border:1px solid #262626;background:#000}
@media(max-width:768px){.pb-body{grid-template-columns:1fr}}
@media(max-width:768px){
  body{padding:.75rem}
  h1{font-size:1.25rem}
  .summary{gap:.75rem}
  .stat{padding:.75rem 1rem;min-width:0;flex:1 1 calc(50% - .375rem)}
  .stat-value{font-size:1.25rem}
  .platform-header{padding:.75rem 1rem}
  .platform-name{font-size:1rem}
  .steps{padding:.75rem 1rem}
  .step{gap:.5rem}
  .step-action{min-width:auto;font-size:.875rem}
  .step-selector{font-size:.7rem;flex-basis:100%;padding-left:2.25rem}
  .screenshots{padding:0 1rem 1rem}
  .diagnostics{padding:0 1rem 1rem}
  .screenshot-card img{height:200px}
  .final-card img{height:220px}
  .error-msg{padding:.75rem 1rem;font-size:.7rem}
  .flow-name{font-size:.8rem;padding:.5rem .75rem}
}
@media(max-width:480px){
  .stat{flex:1 1 100%}
  .stat-value{font-size:1.1rem}
  .screenshot-card img{height:160px}
  .final-card img{height:180px}
  .step-action{min-width:auto;font-size:.8rem}
}
</style>
</head>
<body>
<h1>spana test report</h1>
<p class="subtitle">${escapeHtml(timestamp)}</p>

<div class="flow-name">${escapeHtml(title)}</div>

<div class="summary">
  <div class="stat"><div class="stat-value ${summary.failed > 0 ? "fail" : "pass"}">${summary.passed}/${summary.total}</div><div class="stat-label">Passed</div></div>
  <div class="stat"><div class="stat-value time">${formatDuration(summary.durationMs)}</div><div class="stat-label">Total time</div></div>
  <div class="stat"><div class="stat-value" style="color:#e5e5e5">${summary.platforms.length}</div><div class="stat-label">Platforms</div></div>
</div>

${
  finalScreenshots
    ? `
<div style="background:#171717;border:1px solid #262626;border-radius:.75rem;padding:1.5rem;margin-bottom:1.5rem">
  <h3 style="font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#525252;margin-bottom:1rem">Final state</h3>
  <div class="final-grid">${finalScreenshots}</div>
</div>`
    : ""
}

${platforms}

<script>
(function(){
  var speeds = [1, 2, 0.5];
  document.querySelectorAll('.playback[id]').forEach(function(root){
    var dataEl = root.querySelector('.pb-data');
    if (!dataEl) return;
    var data;
    try { data = JSON.parse(dataEl.textContent || '{}'); } catch { return; }
    var frames = data.frames || [];
    var steps = data.steps || [];
    var vp = data.viewport || { width: 1280, height: 720 };
    if (!frames.length) return;

    var img = root.querySelector('.pb-img');
    var ripple = root.querySelector('.pb-ripple');
    var scrubber = root.querySelector('.pb-scrubber');
    var timeEl = root.querySelector('.pb-time');
    var playBtn = root.querySelector('[data-action="toggle"]');
    var speedBtn = root.querySelector('[data-action="speed"]');
    var stepBtns = Array.from(root.querySelectorAll('.pb-step'));

    var idx = 0;
    var playing = false;
    var speedIdx = 0;
    var timer = null;

    function render(nextIdx) {
      idx = Math.max(0, Math.min(frames.length - 1, nextIdx));
      var f = frames[idx];
      if (img) img.src = 'data:' + f.mimeType + ';base64,' + f.dataBase64;
      if (scrubber) scrubber.value = String(idx);
      if (timeEl) timeEl.textContent = (f.timestampMs / 1000).toFixed(2) + 's / ' + ((data.durationMs || 1) / 1000).toFixed(2) + 's';

      var activeStepIdx = -1;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].startedAtMs <= f.timestampMs) activeStepIdx = i;
      }
      stepBtns.forEach(function(b, bi){ b.classList.toggle('active', bi === activeStepIdx); });

      var activeStep = activeStepIdx >= 0 ? steps[activeStepIdx] : null;
      if (ripple && activeStep && activeStep.tapPoint && vp.width > 0 && vp.height > 0) {
        ripple.style.display = 'block';
        ripple.style.left = Math.max(0, Math.min(100, (activeStep.tapPoint.x / vp.width) * 100)) + '%';
        ripple.style.top = Math.max(0, Math.min(100, (activeStep.tapPoint.y / vp.height) * 100)) + '%';
      } else if (ripple) {
        ripple.style.display = 'none';
      }
    }

    function stop() {
      playing = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (playBtn) playBtn.textContent = 'Play';
    }

    function tick() {
      if (!playing) return;
      if (idx >= frames.length - 1) { stop(); return; }
      var cur = frames[idx].timestampMs;
      var nxt = frames[idx + 1].timestampMs;
      var delay = Math.max(40, Math.min(1200, (nxt - cur) / speeds[speedIdx]));
      timer = setTimeout(function(){ render(idx + 1); tick(); }, delay);
    }

    if (playBtn) playBtn.addEventListener('click', function(){
      if (playing) { stop(); return; }
      if (idx >= frames.length - 1) render(0);
      playing = true;
      playBtn.textContent = 'Pause';
      tick();
    });
    var prevBtn = root.querySelector('[data-action="prev"]');
    var nextBtn = root.querySelector('[data-action="next"]');
    if (prevBtn) prevBtn.addEventListener('click', function(){ stop(); render(idx - 1); });
    if (nextBtn) nextBtn.addEventListener('click', function(){ stop(); render(idx + 1); });
    if (speedBtn) speedBtn.addEventListener('click', function(){
      speedIdx = (speedIdx + 1) % speeds.length;
      speedBtn.textContent = speeds[speedIdx] + 'x';
    });
    if (scrubber) scrubber.addEventListener('input', function(){ stop(); render(Number(scrubber.value)); });
    stepBtns.forEach(function(btn){
      btn.addEventListener('click', function(){
        stop();
        var si = Number(btn.getAttribute('data-step-idx'));
        var targetTs = steps[si] ? steps[si].startedAtMs : 0;
        var best = 0;
        for (var j = 0; j < frames.length; j++) {
          if (frames[j].timestampMs <= targetTs + 50) best = j;
        }
        render(best);
      });
    });

    render(0);
  });
})();
</script>

</body>
</html>`;
}

export function createHtmlReporter(outputDir: string = "./spana-output"): Reporter {
  return {
    onRunComplete(summary) {
      const html = buildHTML(summary, outputDir);
      mkdirSync(outputDir, { recursive: true });
      const outputPath = join(outputDir, "report.html");
      writeFileSync(outputPath, html, "utf-8");
      console.log(`HTML report written to ${outputPath}`);
    },
  };
}
