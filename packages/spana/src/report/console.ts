import type { Platform } from "../schemas/selector.js";
import type { FlowResult, Reporter, ScenarioStepResult } from "./types.js";

export interface ConsoleReporterOptions {
  /** Only show failures and the final summary. */
  quiet?: boolean;
}

function printResultAttachments(result: FlowResult): void {
  for (const attachment of result.attachments ?? []) {
    console.log(`    ↳ ${attachment.name}: ${attachment.path}`);
  }

  for (const [index, step] of (result.steps ?? []).entries()) {
    for (const attachment of step.attachments ?? []) {
      console.log(`    ↳ step ${index + 1} ${step.command}: ${attachment.path}`);
    }
  }
}

function printScenarioSteps(steps: ScenarioStepResult[]): void {
  for (const step of steps) {
    const icon = step.status === "passed" ? "✓" : step.status === "failed" ? "✗" : "○";
    const duration = step.durationMs > 0 ? ` (${step.durationMs}ms)` : "";
    console.log(`      ${icon} ${step.keyword} ${step.text}${duration}`);
    if (step.error) {
      console.log(`        ${step.error}`);
    }
  }
}

function workerPrefix(workerName?: string): string {
  return workerName ? `[${workerName}] ` : "";
}

const driverNames: Record<Platform, string> = {
  web: "Playwright",
  android: "UiAutomator2",
  ios: "WebDriverAgent",
};

export function createConsoleReporter(options?: ConsoleReporterOptions): Reporter {
  const quiet = options?.quiet ?? false;
  let completed = 0;
  let total = 0;
  let currentPlatform: Platform | undefined;

  function progressPrefix(): string {
    return total > 0 ? `[${completed}/${total}]` : "";
  }

  return {
    onFlowStart(name, platform, workerName) {
      if (quiet) return;

      // Print platform header when switching to a new platform
      if (platform !== currentPlatform) {
        currentPlatform = platform;
        console.log(`\n  ${platform} (${driverNames[platform]})`);
      }

      if (process.stderr.isTTY) {
        process.stderr.write(`  ▸ ${workerPrefix(workerName)}${progressPrefix()} ${name}...\r`);
      }
    },

    onFlowPass(result) {
      completed++;
      if (quiet) return;

      // Clear progress line
      if (process.stderr.isTTY) {
        process.stderr.write("\x1b[2K");
      }

      const duration = `(${result.durationMs}ms)`;
      const flakyTag = result.flaky ? ` [flaky, passed on attempt ${result.attempts}]` : "";
      console.log(
        `  ✓ ${workerPrefix(result.workerName)}${progressPrefix()} ${result.name} ${duration}${flakyTag}`,
      );
      if (result.scenarioSteps) printScenarioSteps(result.scenarioSteps);
      printResultAttachments(result);
    },

    onFlowFail(result) {
      completed++;

      // Clear progress line
      if (process.stderr.isTTY) {
        process.stderr.write("\x1b[2K");
      }

      // Always show failures, even in quiet mode
      const duration = `(${result.durationMs}ms)`;
      console.log(
        `  ✗ ${workerPrefix(result.workerName)}${progressPrefix()} [${result.platform}] ${result.name} ${duration}`,
      );
      if (result.scenarioSteps) printScenarioSteps(result.scenarioSteps);
      printResultAttachments(result);
    },

    onRunComplete(summary) {
      console.log("");

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
          .map((r) => (r.flaky ? "~" : r.status === "passed" ? "✓" : "✗"))
          .join("");
        const label = `${platform} (${driverNames[platform]})`;
        const duration = Math.max(...results.map((r) => r.durationMs));
        console.log(
          `${label.padEnd(25)} ${symbols}  ${passed}/${totalCount} passed (${(duration / 1000).toFixed(1)}s)`,
        );
      }

      // Failures detail with suggestions
      const failures = summary.results.filter((r) => r.status === "failed");
      if (failures.length > 0) {
        console.log("\n--- Failures ---");
        for (const f of failures) {
          const deviceLabel = f.workerName ? `${f.platform} on ${f.workerName}` : f.platform;
          console.log(`✗ [${deviceLabel}] ${f.name}`);
          if (f.error) {
            console.log(`  ${f.error.message}`);
            if (f.error.suggestion) {
              for (const line of f.error.suggestion.split("\n")) {
                console.log(`  💡 ${line}`);
              }
            }
          }
        }
      }

      // Flaky detail
      const flakyResults = summary.results.filter((r) => r.flaky);
      if (flakyResults.length > 0) {
        console.log("\n--- Flaky ---");
        for (const f of flakyResults) {
          console.log(`~ [${f.platform}] ${f.name} (passed on attempt ${f.attempts})`);
        }
      }

      // Worker stats
      if (summary.workerStats && summary.workerStats.size > 0) {
        console.log("\nWorker Stats:");
        for (const [id, stats] of summary.workerStats) {
          console.log(`  [${id}]  ${stats.flowCount} flows  ${(stats.totalMs / 1000).toFixed(1)}s`);
        }
      }

      if (summary.bailedOut) {
        console.log(
          `\nBailed out after ${summary.failed} failure(s)${
            summary.bailLimit ? ` (limit: ${summary.bailLimit})` : ""
          }.`,
        );
      }

      // Final summary
      const flakyStr = summary.flaky > 0 ? `, ${summary.flaky} flaky` : "";
      console.log(
        `\n${summary.passed}/${summary.total} passed, ${summary.failed} failed${flakyStr} (${(summary.durationMs / 1000).toFixed(1)}s)`,
      );
    },

    // Allow callers to set total for progress tracking
    set flowCount(n: number) {
      total = n;
    },
  };
}
