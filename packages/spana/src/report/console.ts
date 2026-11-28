import type { Platform } from "../schemas/selector.js";
import { analyzeStepQuality } from "./selector-guardrails.js";
import type { FlowResult, Reporter, ScenarioStepResult } from "./types.js";

export interface ConsoleReporterOptions {
  /** Only show failures and the final summary. */
  quiet?: boolean;
  /** Resolved web browser engine label for accurate platform header reporting. */
  webEngine?: "playwright" | "cdp" | "lightpanda";
  /** Output writer (defaults to console.log). */
  write?: (line: string) => void;
}

function printResultAttachments(result: FlowResult, write: (line: string) => void): void {
  for (const attachment of result.attachments ?? []) {
    write(`    ↳ ${attachment.name}: ${attachment.path}`);
  }

  for (const [index, step] of (result.steps ?? []).entries()) {
    for (const attachment of step.attachments ?? []) {
      write(`    ↳ step ${index + 1} ${step.command}: ${attachment.path}`);
    }
  }
}

function printScenarioSteps(steps: ScenarioStepResult[], write: (line: string) => void): void {
  for (const step of steps) {
    const icon = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : "○";
    const duration = step.durationMs > 0 ? ` (${step.durationMs}ms)` : "";
    write(`      ${icon} ${step.keyword} ${step.text}${duration}`);
    if (step.error) {
      write(`        ${step.error}`);
    }
  }
}

function printSelectorWarnings(result: FlowResult, write: (line: string) => void): void {
  if (!result.steps || result.steps.length === 0) return;
  const warnings = analyzeStepQuality(result.steps);
  if (warnings.length === 0) return;
  write("    Selector warnings:");
  for (const w of warnings) {
    write(`      ! ${w.message}`);
  }
}

function workerPrefix(workerName?: string): string {
  return workerName ? `[${workerName}] ` : "";
}

const driverNames: Record<Platform, string> = {
  web: "Playwright",
  android: "UiAutomator2",
  ios: "WebDriverAgent",
  electron: "Electron",
  electrobun: "Electrobun",
};

function getDriverLabel(
  platform: Platform,
  webEngine?: "playwright" | "cdp" | "lightpanda",
): string {
  if (platform === "web") {
    if (webEngine === "cdp") return "Direct CDP";
    if (webEngine === "lightpanda") return "Lightpanda";
    return "Playwright";
  }
  return driverNames[platform];
}

function printA11yViolations(result: FlowResult, write: (line: string) => void): void {
  for (const step of result.steps ?? []) {
    if (step.status === "failed" && step.command.includes("AccessibilityAudit") && step.error) {
      write(`    Accessibility violations (${step.command}):`);
      for (const line of step.error.split("\n")) {
        write(`      ${line}`);
      }
    }
  }
}

export function createConsoleReporter(options?: ConsoleReporterOptions): Reporter {
  const quiet = options?.quiet ?? false;
  const webEngine = options?.webEngine;
  const write = options?.write ?? ((line: string) => console.log(line));
  let completed = 0;
  let total = 0;
  let currentPlatform: Platform | undefined;
  const platformDone = new Map<Platform, number>();
  const platformFirstStart = new Map<Platform, number>();
  const platformLastEnd = new Map<Platform, number>();
  let platformTotals: Partial<Record<Platform, number>> | undefined;

  function progressPrefix(platform?: Platform): string {
    if (platformTotals && platform) {
      const done = platformDone.get(platform) ?? 0;
      const ptotal = platformTotals[platform] ?? 0;
      if (ptotal > 0) {
        const pct = Math.round((done / ptotal) * 100);
        return `${platform} [${done}/${ptotal} ${pct}%]`;
      }
    }
    return total > 0 ? `[${completed}/${total}]` : "";
  }

  return {
    onFlowStart(name, platform, workerName) {
      if (!platformFirstStart.has(platform)) {
        platformFirstStart.set(platform, Date.now());
      }
      if (quiet) return;

      // Print platform header when switching to a new platform
      if (platform !== currentPlatform) {
        currentPlatform = platform;
        write(`\n  ${platform} (${getDriverLabel(platform, webEngine)})`);
      }

      if (process.stderr.isTTY) {
        process.stderr.write(
          `  ▸ ${workerPrefix(workerName)}${progressPrefix(platform)} ${name}...\r`,
        );
      }
    },

    onFlowPass(result) {
      completed++;
      platformDone.set(result.platform, (platformDone.get(result.platform) ?? 0) + 1);
      platformLastEnd.set(result.platform, Date.now());
      if (quiet) return;

      // Clear progress line
      if (process.stderr.isTTY) {
        process.stderr.write("\x1b[2K");
      }

      const duration = `(${result.durationMs}ms)`;
      const flakyTag = result.flaky ? ` [flaky, passed on attempt ${result.attempts}]` : "";
      write(
        `  ✓ ${workerPrefix(result.workerName)}${progressPrefix(result.platform)} ${result.name} ${duration}${flakyTag}`,
      );
      if (result.scenarioSteps) printScenarioSteps(result.scenarioSteps, write);
      printResultAttachments(result, write);
      printSelectorWarnings(result, write);
    },

    onFlowFail(result) {
      completed++;
      platformDone.set(result.platform, (platformDone.get(result.platform) ?? 0) + 1);
      platformLastEnd.set(result.platform, Date.now());

      // Clear progress line
      if (process.stderr.isTTY) {
        process.stderr.write("\x1b[2K");
      }

      // Always show failures, even in quiet mode
      const duration = `(${result.durationMs}ms)`;
      write(
        `  ✗ ${workerPrefix(result.workerName)}${progressPrefix(result.platform)} [${result.platform}] ${result.name} ${duration}`,
      );
      if (result.scenarioSteps) printScenarioSteps(result.scenarioSteps, write);
      printResultAttachments(result, write);
      printA11yViolations(result, write);
    },

    onFlowSkip(result) {
      completed++;
      platformDone.set(result.platform, (platformDone.get(result.platform) ?? 0) + 1);
      platformLastEnd.set(result.platform, Date.now());
      if (quiet) return;

      if (process.stderr.isTTY) {
        process.stderr.write("\x1b[2K");
      }

      const reason = result.skipReason ? `: ${result.skipReason}` : "";
      const tag = result.modifier ? `(${result.modifier}${reason})` : `(skipped${reason})`;
      write(
        `  – ${workerPrefix(result.workerName)}${progressPrefix(result.platform)} ${result.name} ${tag}`,
      );
    },

    onRunComplete(summary) {
      write("");

      // Group results by platform
      const byPlatform = new Map<Platform, FlowResult[]>();
      for (const r of summary.results) {
        const list = byPlatform.get(r.platform) ?? [];
        list.push(r);
        byPlatform.set(r.platform, list);
      }

      for (const [platform, results] of byPlatform) {
        const passed = results.filter((r) => r.status === "passed").length;
        const totalCount = results.length;
        const symbols = results
          .map((r) =>
            r.flaky ? "~" : r.status === "passed" ? "✓" : r.status === "skipped" ? "–" : "✗",
          )
          .join("");
        const label = `${platform} (${getDriverLabel(platform, webEngine)})`;
        // Report true elapsed platform wall time (never just max single-flow duration)
        const trackedElapsed =
          platformFirstStart.has(platform) && platformLastEnd.has(platform)
            ? Math.max(0, platformLastEnd.get(platform)! - platformFirstStart.get(platform)!)
            : undefined;
        const duration =
          byPlatform.size === 1 && summary.durationMs > 0
            ? summary.durationMs
            : (summary.platformDurations?.[platform] ??
              trackedElapsed ??
              results.reduce((sum, r) => sum + r.durationMs, 0));
        write(
          `${label.padEnd(25)} ${symbols}  ${passed}/${totalCount} passed (${(duration / 1000).toFixed(1)}s)`,
        );
      }

      for (const result of summary.results.filter((r) => r.status === "skipped" && r.modifier)) {
        write(
          `  – [${result.platform}] ${result.name} (${result.modifier}${result.skipReason ? `: ${result.skipReason}` : ""})`,
        );
      }

      // Failures detail with suggestions
      const failures = summary.results.filter((r) => r.status === "failed");
      if (failures.length > 0) {
        write("\n--- Failures ---");
        for (const f of failures) {
          const deviceLabel = f.workerName ? `${f.platform} on ${f.workerName}` : f.platform;
          write(`✗ [${deviceLabel}] ${f.name}`);
          if (f.error) {
            write(`  Category: ${f.error.category}`);
            write(`  ${f.error.message}`);
            if (f.error.location) {
              write(
                `  At: ${f.error.location.file}:${f.error.location.line}:${f.error.location.column}`,
              );
            }
            if (f.error.codeFrame) {
              for (const line of f.error.codeFrame.split("\n")) {
                write(`  ${line}`);
              }
            }
            if (f.error.suggestion) {
              for (const line of f.error.suggestion.split("\n")) {
                write(`  💡 ${line}`);
              }
            }
          }
        }
      }

      // Flaky detail
      const flakyResults = summary.results.filter((r) => r.flaky);
      if (flakyResults.length > 0) {
        write("\n--- Flaky ---");
        for (const f of flakyResults) {
          write(`~ [${f.platform}] ${f.name} (passed on attempt ${f.attempts})`);
        }
      }

      // Worker stats
      if (summary.workerStats && summary.workerStats.size > 0) {
        write("\nWorker Stats:");
        for (const [id, stats] of summary.workerStats) {
          write(`  [${id}]  ${stats.flowCount} flows  ${(stats.totalMs / 1000).toFixed(1)}s`);
        }
      }

      if (summary.bailedOut) {
        write(
          `\nBailed out after ${summary.failed} failure(s)${
            summary.bailLimit ? ` (limit: ${summary.bailLimit})` : ""
          }.`,
        );
      }

      // Final summary
      const skippedStr = summary.skipped > 0 ? `, ${summary.skipped} skipped` : "";
      const flakyStr = summary.flaky > 0 ? `, ${summary.flaky} flaky` : "";
      write(
        `\n${summary.passed}/${summary.total} passed, ${summary.failed} failed${skippedStr}${flakyStr} (${(summary.durationMs / 1000).toFixed(1)}s)`,
      );
    },

    // Allow callers to set total for progress tracking
    set flowCount(n: number) {
      total = n;
    },

    set platformFlowCounts(counts: Partial<Record<Platform, number>>) {
      platformTotals = counts;
    },
  };
}
