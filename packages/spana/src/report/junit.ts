import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Reporter, FlowResult, RunSummary } from "./types.js";

function escapeXml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildJUnitXML(summary: RunSummary): string {
  const timestamp = new Date().toISOString();
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="spana" tests="${summary.total}" failures="${summary.failed}" time="${(summary.durationMs / 1000).toFixed(3)}" timestamp="${timestamp}">`,
  );

  // Group by platform
  const byPlatform = new Map<string, FlowResult[]>();
  for (const r of summary.results) {
    const list = byPlatform.get(r.platform) ?? [];
    list.push(r);
    byPlatform.set(r.platform, list);
  }

  for (const [platform, results] of byPlatform) {
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

    lines.push(
      `  <testsuite name="${escapeXml(platform)}" tests="${results.length}" failures="${failed}" skipped="${skipped}" time="${(totalTime / 1000).toFixed(3)}">`,
    );

    for (const result of results) {
      const time = (result.durationMs / 1000).toFixed(3);
      lines.push(
        `    <testcase name="${escapeXml(result.name)}" classname="spana.${escapeXml(platform)}" time="${time}">`,
      );

      const props: Array<{ name: string; value: string }> = [];
      for (const tag of result.tags ?? []) {
        props.push({ name: "tag", value: tag });
      }
      for (const ann of result.annotations ?? []) {
        props.push({ name: ann.type, value: ann.description ?? "" });
      }
      if (props.length > 0) {
        lines.push(`      <properties>`);
        for (const prop of props) {
          lines.push(
            `        <property name="${escapeXml(prop.name)}" value="${escapeXml(prop.value)}"/>`,
          );
        }
        lines.push(`      </properties>`);
      }

      if (result.status === "failed" && result.error) {
        lines.push(`      <failure message="${escapeXml(result.error.message)}">`);
        if (result.error.stack) {
          lines.push(escapeXml(result.error.stack));
        }
        lines.push(`      </failure>`);
      } else if (result.status === "skipped") {
        const reason = result.skipReason ?? result.modifier;
        lines.push(reason ? `      <skipped message="${escapeXml(reason)}"/>` : `      <skipped/>`);
      }

      const systemOut = buildSystemOut(result);
      if (systemOut) {
        lines.push(`      <system-out>${escapeXml(systemOut)}</system-out>`);
      }

      lines.push(`    </testcase>`);
    }

    lines.push(`  </testsuite>`);
  }

  lines.push(`</testsuites>`);
  return lines.join("\n");
}

function buildSystemOut(result: FlowResult): string | undefined {
  const lines: string[] = [];

  // Scenario-level steps (Gherkin Given/When/Then)
  if (result.scenarioSteps) {
    for (const step of result.scenarioSteps) {
      const duration = step.durationMs > 0 ? ` (${step.durationMs}ms)` : "";
      lines.push(`${step.keyword} ${step.text} [${step.status}]${duration}`);
      if (step.error) {
        lines.push(`  error: ${step.error}`);
      }
    }
  }

  for (const attachment of result.attachments ?? []) {
    lines.push(`attachment ${attachment.name} (${attachment.contentType}): ${attachment.path}`);
  }

  // Driver-level steps
  for (const [index, step] of (result.steps ?? []).entries()) {
    const prefix = `step ${index + 1} ${step.command} [${step.status}]`;
    if (step.selector !== undefined) {
      lines.push(`${prefix} selector=${JSON.stringify(step.selector)}`);
    }
    if (step.error) {
      lines.push(`${prefix} error=${step.error}`);
    }
    for (const attachment of step.attachments ?? []) {
      lines.push(
        `${prefix} attachment ${attachment.name} (${attachment.contentType}): ${attachment.path}`,
      );
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function createJUnitReporter(outputDirOrFile: string = "./spana-output"): Reporter {
  return {
    onRunComplete(summary) {
      const xml = buildJUnitXML(summary);
      const isFile = outputDirOrFile.endsWith(".xml");
      const outputPath = isFile ? outputDirOrFile : join(outputDirOrFile, "junit-report.xml");
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, xml, "utf-8");
      console.log(`JUnit report written to ${outputPath}`);
    },
  };
}
