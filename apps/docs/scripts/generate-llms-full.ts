import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const DOCS_DIR = resolve(import.meta.dir, "../src/content/docs");
const OUTPUT_PATH = resolve(import.meta.dir, "../public/llms-full.txt");

// Ordered list of doc files to include
const DOC_FILES = [
  "getting-started/introduction.md",
  "getting-started/quick-start.md",
  "getting-started/configuration.md",
  "writing-tests/flows.md",
  "writing-tests/selectors.md",
  "writing-tests/assertions.md",
  "writing-tests/platform-specific.md",
  "writing-tests/gherkin.md",
  "cli/commands.md",
  "cli/agent-commands.md",
  "cli/init.md",
  "cli/studio.md",
  "reference/reporters.md",
  "reference/custom-reporters.md",
  "reference/agent-api.md",
  "reference/example.md",
  "architecture/overview.md",
  "architecture/drivers.md",
  "guides/device-setup.md",
  "guides/remote-execution.md",
  "guides/cloud-providers.md",
  "guides/ci-integration.md",
  "guides/debugging.md",
];

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return content;
  return content.slice(endIndex + 3).trim();
}

function extractTitle(content: string): string {
  if (!content.startsWith("---")) return "Untitled";
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return "Untitled";
  const frontmatter = content.slice(3, endIndex);
  const match = frontmatter.match(/title:\s*(.+)/);
  return match ? match[1]!.trim().replaceAll(/^["']|["']$/g, "") : "Untitled";
}

const header = `# spana — TypeScript-native E2E testing for React Native + Web

> Full documentation for AI/LLM consumption.
> For links-only version, see llms.txt
>
> Generated from source docs — do not edit manually.

`;

const sections: string[] = [header];

for (const file of DOC_FILES) {
  const filePath = join(DOCS_DIR, file);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const title = extractTitle(raw);
    const body = stripFrontmatter(raw);
    sections.push(`---\n\n## ${title}\n\n${body}\n`);
  } catch {
    console.warn(`Warning: Could not read ${file}, skipping.`);
  }
}

writeFileSync(OUTPUT_PATH, sections.join("\n"), "utf-8");
console.log(`Generated ${OUTPUT_PATH} (${DOC_FILES.length} sections)`);
