import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Reporter, FlowResult, RunSummary, StepResult, ScenarioStepResult } from "./types.js";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toBase64DataUri(filePath: string): string | null {
  try {
    const data = readFileSync(filePath);
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
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

function renderWebDiagnostics(result: FlowResult): string {
  const diagnostics = (result.attachments ?? [])
    .map((attachment) => {
      const title =
        attachment.name.endsWith("console-logs")
          ? "Console logs"
          : attachment.name.endsWith("js-errors")
            ? "JavaScript errors"
            : null;
      if (!title) return "";

      const raw = readTextFile(attachment.path);
      if (!raw) return "";

      let content = raw;
      try {
        content = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        // Keep the original text when it is not valid JSON.
      }

      return `<div class="diagnostic-card"><h3>${escapeHtml(title)}</h3><pre>${escapeHtml(content)}</pre></div>`;
    })
    .filter(Boolean)
    .join("\n");

  if (!diagnostics) return "";

  return `<div class="diagnostics"><h3>Web diagnostics</h3><div class="diagnostic-grid">${diagnostics}</div></div>`;
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

function renderPlatform(result: FlowResult): string {
  const scenarioStepsHtml = result.scenarioSteps
    ? `<div class="steps">${result.scenarioSteps.map(renderScenarioStep).join("\n")}</div>`
    : "";
  const driverStepsHtml =
    (result.steps ?? []).length > 0
      ? `<div class="steps">${(result.steps ?? []).map(renderStep).join("\n")}</div>`
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
  ${scenarioStepsHtml}
  ${driverStepsHtml}
  ${renderScreenshots(result.steps ?? [])}
  ${renderWebDiagnostics(result)}
  ${result.status === "failed" && result.error ? `<div class="error-msg"><strong>Error:</strong> ${escapeHtml(result.error.message)}</div>` : ""}
</div>`;
}

function buildHTML(summary: RunSummary): string {
  const timestamp = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
  const flowNames = [...new Set(summary.results.map((r) => r.name))];
  const title = flowNames.length === 1 ? flowNames[0]! : `${summary.total} flows`;

  const finalScreenshots = summary.results.map(renderFinalScreenshot).filter(Boolean).join("\n");

  const platforms = summary.results.map(renderPlatform).join("\n");

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
.flow-name{font-size:.95rem;color:#a3a3a3;margin-bottom:1.5rem;padding:.75rem 1rem;background:#171717;border:1px solid #262626;border-radius:.5rem;font-family:'SF Mono',Menlo,monospace;overflow-wrap:break-word;word-break:break-word}
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

</body>
</html>`;
}

export function createHtmlReporter(outputDir: string = "./spana-output"): Reporter {
  return {
    onRunComplete(summary) {
      const html = buildHTML(summary);
      mkdirSync(outputDir, { recursive: true });
      const outputPath = join(outputDir, "report.html");
      writeFileSync(outputPath, html, "utf-8");
      console.log(`HTML report written to ${outputPath}`);
    },
  };
}
