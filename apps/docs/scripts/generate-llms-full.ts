import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(SCRIPT_DIR, "../src/content/docs");
const OUTPUT_PATH = resolve(SCRIPT_DIR, "../public/llms-full.txt");
const SITEMAP_PATH = resolve(SCRIPT_DIR, "../public/sitemap.xml");
const SEARCH_INDEX_PATH = resolve(SCRIPT_DIR, "../public/search-index.json");
const SITE_URL = (process.env.SITE ?? "https://spana.antonwester.se").replace(/\/$/, "");

// Ordered list of doc files to include
const DOC_FILES = [
  "getting-started/introduction.md",
  "getting-started/quick-start.md",
  "getting-started/fastest-path.md",
  "getting-started/configuration.md",
  "compare.mdx",
  "writing-tests/flows.md",
  "writing-tests/selectors.md",
  "writing-tests/assertions.md",
  "writing-tests/platform-specific.md",
  "writing-tests/gherkin.md",
  "writing-tests/varar.md",
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
  "guides/fast-toolchain.mdx",
  "privacy.md",
];

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return content;
  return content.slice(endIndex + 3).trim();
}

function extractFrontmatterField(content: string, key: string): string {
  if (!content.startsWith("---")) return "";
  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return "";
  const frontmatter = content.slice(3, endIndex);
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1]!.trim().replaceAll(/^["']|["']$/g, "") : "";
}

function extractTitle(content: string): string {
  return extractFrontmatterField(content, "title") || "Untitled";
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[`*_~[\]()]/g, "")
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replaceAll(/\s+/g, "-");
}

function cleanMarkdownForSearch(md: string): string {
  return md
    .replaceAll(/^import\s+.*$/gm, "")
    .replaceAll(/^export\s+.*$/gm, "")
    .replaceAll(/```[\w-]*\n?/g, " ")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll(/[#>*`_~|]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

interface SearchSection {
  heading: string;
  anchor: string;
  text: string;
}

interface SearchEntry {
  url: string;
  title: string;
  description: string;
  sections: SearchSection[];
}

function buildSearchEntry(raw: string, url: string): SearchEntry {
  const title = extractTitle(raw);
  const description = extractFrontmatterField(raw, "description");
  const body = stripFrontmatter(raw);
  const lines = body.split("\n");
  const sections: SearchSection[] = [];
  let currentHeading = "";
  let currentAnchor = "";
  let buf: string[] = [];
  let inFence = false;
  const seenAnchors = new Map<string, number>();

  const flush = () => {
    const cleaned = cleanMarkdownForSearch(buf.join("\n"));
    if (cleaned || currentHeading) {
      sections.push({ heading: currentHeading, anchor: currentAnchor, text: cleaned });
    }
    buf = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    const hMatch = !inFence ? /^(#{2,3})\s+(.+)$/.exec(line) : null;
    if (hMatch) {
      flush();
      const headingText = hMatch[2]!.replaceAll(/[`*_~]/g, "").trim();
      const baseSlug = slugifyHeading(headingText);
      const count = seenAnchors.get(baseSlug) ?? 0;
      seenAnchors.set(baseSlug, count + 1);
      currentHeading = headingText;
      currentAnchor = count === 0 ? baseSlug : `${baseSlug}-${count}`;
    } else {
      buf.push(line);
    }
  }
  flush();

  return { url, title, description, sections };
}

const header = `# spana — One test. Every screen. TypeScript E2E testing (Web, iOS, Android, Electron, Electrobun)

> Docs: https://spana.antonwester.se/
> Full documentation for AI/LLM consumption.
> For links-only version, see https://spana.antonwester.se/llms.txt
>
> Generated from source docs — do not edit manually.

`;

const sections: string[] = [header];
const sitemapUrls: string[] = [`${SITE_URL}/`];
const searchEntries: SearchEntry[] = [];

try {
  const homeRaw = readFileSync(join(DOCS_DIR, "index.mdx"), "utf-8");
  searchEntries.push(buildSearchEntry(homeRaw, "/"));
} catch {
  // optional landing page
}

for (const file of DOC_FILES) {
  const filePath = join(DOCS_DIR, file);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const title = extractTitle(raw);
    const body = stripFrontmatter(raw);
    sections.push(`---\n\n## ${title}\n\n${body}\n`);
    const slug = file.replace(/\.(md|mdx)$/, "");
    sitemapUrls.push(`${SITE_URL}/${slug}/`);
    searchEntries.push(buildSearchEntry(raw, `/${slug}/`));
  } catch {
    console.warn(`Warning: Could not read ${file}, skipping.`);
  }
}

writeFileSync(OUTPUT_PATH, sections.join("\n"), "utf-8");
console.log(`Generated ${OUTPUT_PATH} (${DOC_FILES.length} sections)`);

writeFileSync(SEARCH_INDEX_PATH, JSON.stringify(searchEntries), "utf-8");
console.log(`Generated ${SEARCH_INDEX_PATH} (${searchEntries.length} pages)`);

const sitemapXml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...sitemapUrls.map((url) => `  <url><loc>${url}</loc></url>`),
  "</urlset>",
  "",
].join("\n");
writeFileSync(SITEMAP_PATH, sitemapXml, "utf-8");
console.log(`Generated ${SITEMAP_PATH} (${sitemapUrls.length} URLs)`);
