import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlowResult, Reporter, RunSummary } from "./types.js";

export interface GitHubPrReporterOptions {
  /** Directory where `github-pr-summary.md` is written (default: `./spana-output`). */
  outputDir?: string;
  /** Optional filter summary lines (from `--changed-since` filters) to include in the comment. */
  filterSummaries?: string[];
  /** Write to `process.env.GITHUB_STEP_SUMMARY` automatically when present (default: true). */
  writeStepSummary?: boolean;
}

/**
 * Format a concise Markdown summary suitable for GitHub Actions Job Summaries
 * and Pull Request comments (inspired by `@e2e-dev/github`).
 */
export function formatGitHubPrMarkdown(
  summary: RunSummary,
  filterSummaries: string[] = [],
): string {
  const icon = summary.failed === 0 ? "✅" : "❌";
  const statusText = summary.failed === 0 ? "All flows passed" : `${summary.failed} flow(s) failed`;
  const durationSec = (summary.durationMs / 1000).toFixed(2);

  const lines: string[] = [
    `## ${icon} Spana E2E — ${statusText}`,
    "",
    `| Passed | Failed | Skipped | Duration |`,
    `| ---: | ---: | ---: | ---: |`,
    `| ${summary.passed} | ${summary.failed} | ${summary.skipped} | ${durationSec}s |`,
  ];

  if (filterSummaries.length > 0) {
    lines.push("", "**CI Filter Savings:**");
    for (const note of filterSummaries) {
      lines.push(`- \`${note}\``);
    }
  }

  // Group by platform
  const byPlatform = new Map<string, FlowResult[]>();
  for (const r of summary.results) {
    const arr = byPlatform.get(r.platform) ?? [];
    arr.push(r);
    byPlatform.set(r.platform, arr);
  }

  if (byPlatform.size > 0) {
    lines.push(
      "",
      "### Platform Breakdown",
      "",
      "| Platform | Passed | Failed | Skipped |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const [platform, results] of byPlatform) {
      const p = results.filter((r) => r.status === "passed").length;
      const f = results.filter((r) => r.status === "failed").length;
      const s = results.filter((r) => r.status === "skipped").length;
      lines.push(`| \`${platform}\` | ${p} | ${f} | ${s} |`);
    }
  }

  const failures = summary.results.filter((r) => r.status === "failed");
  if (failures.length > 0) {
    lines.push("", "### Failures");
    for (const f of failures) {
      lines.push(
        "",
        `<details>`,
        `<summary>❌ <code>${f.platform}</code> — ${f.name} (${f.durationMs}ms)</summary>`,
        "",
        "```text",
        f.error?.message ?? "Unknown failure",
        "```",
        ...(f.error?.suggestion ? ["", `**Suggestion:** ${f.error.suggestion}`] : []),
        `</details>`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Built-in `"github"` reporter: writes `github-pr-summary.md` to the artifact
 * output directory and appends to `$GITHUB_STEP_SUMMARY` in GitHub Actions.
 */
export function createGitHubPrReporter(options: GitHubPrReporterOptions = {}): Reporter {
  const outputDir = options.outputDir ?? "./spana-output";
  const filterSummaries = options.filterSummaries ?? [];
  const writeStepSummary = options.writeStepSummary ?? true;

  return {
    onRunComplete(summary: RunSummary) {
      const markdown = formatGitHubPrMarkdown(summary, filterSummaries);
      const outPath = join(outputDir, "github-pr-summary.md");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, markdown, "utf-8");

      const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (writeStepSummary && stepSummaryPath) {
        try {
          appendFileSync(stepSummaryPath, `\n${markdown}\n`, "utf-8");
        } catch {
          // Best-effort in GitHub Actions
        }
      }
    },
  };
}
