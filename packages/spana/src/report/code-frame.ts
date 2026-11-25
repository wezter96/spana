import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface CodeLocation {
  file: string;
  line: number;
  column: number;
}

export interface ExtractedCodeFrame {
  location: CodeLocation;
  frame: string;
}

interface ParsedStackFrame {
  file: string;
  line: number;
  column: number;
}

const INTERNAL_FRAME_PATTERNS = [
  /node_modules\//,
  /^node:/,
  /^bun:/,
  /^internal\//,
  /\/packages\/spana\/(?:src|dist)\/(?!.*\.test\.[jt]sx?$)/,
  /\/spana-test\/dist\//,
];

function normalizeStackFile(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return trimmed.replace(/^file:\/\//, "");
    }
  }
  return trimmed;
}

function parseStackFrames(stack: string): ParsedStackFrame[] {
  const frames: ParsedStackFrame[] = [];
  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("at ")) continue;
    // Matches both "at fn (/path/file.ts:12:5)" and "at /path/file.ts:12:5"
    const match = line.match(/\((.+):(\d+):(\d+)\)$/) ?? line.match(/^at\s+(.+):(\d+):(\d+)$/);
    if (!match) continue;
    const file = normalizeStackFile(match[1]!);
    const lineNum = Number.parseInt(match[2]!, 10);
    const colNum = Number.parseInt(match[3]!, 10);
    if (!file || !Number.isFinite(lineNum) || lineNum < 1) continue;
    frames.push({
      file,
      line: lineNum,
      column: Number.isFinite(colNum) && colNum > 0 ? colNum : 1,
    });
  }
  return frames;
}

function isInternalFrame(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return INTERNAL_FRAME_PATTERNS.some((re) => re.test(normalized));
}

export function formatCodeFrame(
  source: string,
  line: number,
  column: number,
  contextLines = 3,
): string {
  const lines = source.split(/\r?\n/);
  if (line < 1 || line > lines.length) return "";
  const startLine = Math.max(1, line - contextLines);
  const endLine = Math.min(lines.length, line + contextLines);
  const gutterWidth = String(endLine).length;
  const out: string[] = [];

  for (let current = startLine; current <= endLine; current++) {
    const marker = current === line ? ">" : " ";
    const num = String(current).padStart(gutterWidth, " ");
    const content = lines[current - 1] ?? "";
    out.push(`${marker} ${num} | ${content}`);
    if (current === line) {
      const caretOffset = Math.max(0, Math.min(column - 1, content.length));
      out.push(`  ${" ".repeat(gutterWidth)} | ${" ".repeat(caretOffset)}^`);
    }
  }
  return out.join("\n");
}

/**
 * Extract the most relevant user-code location and annotated source snippet
 * from an Error stack trace (Playwright-style code frame for failure triage).
 */
export function extractCodeFrame(
  stack: string | undefined,
  preferredFile?: string,
  contextLines = 3,
): ExtractedCodeFrame | undefined {
  if (!stack) return undefined;
  const frames = parseStackFrames(stack);
  if (frames.length === 0) return undefined;

  const normalizedPreferred = preferredFile ? normalizeStackFile(preferredFile) : undefined;

  // 1. Prefer exact match to the failing flow file
  let chosen = normalizedPreferred
    ? frames.find(
        (f) =>
          (f.file === normalizedPreferred || f.file.endsWith(normalizedPreferred)) &&
          existsSync(f.file),
      )
    : undefined;

  // 2. Next prefer any .flow.ts / .flow.js frame that exists on disk
  if (!chosen) {
    chosen = frames.find((f) => /\.flow\.[cm]?[jt]sx?$/.test(f.file) && existsSync(f.file));
  }

  // 3. Otherwise pick the first non-internal frame that exists on disk
  if (!chosen) {
    chosen = frames.find((f) => !isInternalFrame(f.file) && existsSync(f.file));
  }

  if (!chosen) return undefined;

  try {
    const source = readFileSync(chosen.file, "utf8");
    const frame = formatCodeFrame(source, chosen.line, chosen.column, contextLines);
    if (!frame) return undefined;
    return {
      location: { file: chosen.file, line: chosen.line, column: chosen.column },
      frame,
    };
  } catch {
    return undefined;
  }
}
