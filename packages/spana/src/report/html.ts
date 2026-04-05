import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Reporter, FlowResult, RunSummary, StepResult } from "./types.js";

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

function renderPlatform(result: FlowResult): string {
  return `
<div class="platform">
  <div class="platform-header">
    <div class="platform-name">${escapeHtml(result.platform)} <span style="color:#525252;font-weight:400">(${driverName(result.platform)})</span></div>
    <div style="display:flex;align-items:center;gap:1rem;">
      <span class="platform-time">${formatDuration(result.durationMs)}</span>
      ${statusBadge(result.status)}
    </div>
  </div>
  <div class="steps">${(result.steps ?? []).map(renderStep).join("\n")}</div>
  ${renderScreenshots(result.steps ?? [])}
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
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:2rem}
a{color:#3b82f6}
h1{font-size:1.5rem;font-weight:600;margin-bottom:.25rem}
.subtitle{color:#737373;font-size:.875rem;margin-bottom:2rem}
.summary{display:flex;gap:1.5rem;margin-bottom:2rem;flex-wrap:wrap}
.stat{background:#171717;border:1px solid #262626;border-radius:.75rem;padding:1.25rem 1.5rem;min-width:140px}
.stat-value{font-size:1.75rem;font-weight:700}
.stat-label{font-size:.75rem;color:#737373;text-transform:uppercase;letter-spacing:.05em;margin-top:.25rem}
.stat-value.pass{color:#22c55e}.stat-value.fail{color:#ef4444}.stat-value.time{color:#3b82f6}
.platform{background:#171717;border:1px solid #262626;border-radius:.75rem;margin-bottom:1.5rem;overflow:hidden}
.platform-header{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem;border-bottom:1px solid #262626;flex-wrap:wrap;gap:.5rem}
.platform-name{font-weight:600;font-size:1.1rem}
.badge{font-size:.75rem;font-weight:600;padding:.25rem .75rem;border-radius:9999px}
.badge-pass{background:#052e16;color:#22c55e;border:1px solid #14532d}
.badge-fail{background:#450a0a;color:#ef4444;border:1px solid #7f1d1d}
.badge-skip{background:#1c1917;color:#a8a29e;border:1px solid #292524}
.platform-time{color:#737373;font-size:.875rem}
.steps{padding:1.5rem}
.step{display:flex;align-items:flex-start;gap:.75rem;padding:.4rem 0}
.step-num{color:#525252;font-size:.75rem;font-weight:500;min-width:1.5rem;margin-top:2px}
.step-action{font-weight:500;color:#d4d4d4;min-width:140px}
.step-selector{color:#737373;font-size:.8rem;font-family:'SF Mono',Menlo,monospace}
.screenshots{padding:0 1.5rem 1.5rem}
.screenshots h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;color:#525252;margin-bottom:1rem}
.screenshot-grid{display:flex;gap:1rem;overflow-x:auto;padding-bottom:.5rem}
.screenshot-card{flex-shrink:0;text-align:center}
.screenshot-card img{height:280px;border-radius:.5rem;border:1px solid #262626;background:#0a0a0a}
.screenshot-card .label{font-size:.7rem;color:#525252;margin-top:.5rem}
.final-grid{display:flex;gap:1.5rem;flex-wrap:wrap}
.final-card{text-align:center}
.final-card img{height:320px;border-radius:.5rem;border:1px solid #262626}
.final-card .label{font-size:.8rem;color:#737373;margin-top:.5rem;font-weight:500}
.error-msg{padding:1rem 1.5rem;color:#fca5a5;font-family:'SF Mono',Menlo,monospace;font-size:.8rem;border-top:1px solid #262626}
.flow-name{font-size:.95rem;color:#a3a3a3;margin-bottom:1.5rem;padding:.75rem 1rem;background:#171717;border:1px solid #262626;border-radius:.5rem;font-family:'SF Mono',Menlo,monospace}
@media(max-width:768px){body{padding:1rem}.final-card img{height:200px}.screenshot-card img{height:180px}}
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
