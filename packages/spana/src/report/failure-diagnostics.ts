import { readFileSync } from "node:fs";
import type { Element } from "../schemas/element.js";
import type { Attachment } from "./types.js";

export interface DiagnosticSection {
  title: string;
  body: string;
  path: string;
}

export interface DiagnosticSectionOptions {
  verbose?: boolean;
}

function clipText(value: string, maxLines: number, maxChars: number): string {
  const normalized = value.replaceAll("\r\n", "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  let clipped = lines.slice(0, maxLines).join("\n");
  if (clipped.length > maxChars) {
    clipped = clipped.slice(0, maxChars).trimEnd();
  }

  if (clipped.length === normalized.length && lines.length <= maxLines) {
    return clipped;
  }

  return `${clipped}\n... truncated`;
}

function shorten(value: string, max = 48): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function readAttachmentText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function describeElement(element: Element): string {
  const identity: string[] = [];
  if (element.id) identity.push(`testID="${shorten(element.id)}"`);
  if (element.text) identity.push(`text="${shorten(element.text)}"`);
  if (element.accessibilityLabel) {
    identity.push(`label="${shorten(element.accessibilityLabel)}"`);
  }
  if (element.resourceId) identity.push(`resourceId="${shorten(element.resourceId)}"`);
  if (element.elementType) identity.push(`type="${shorten(element.elementType)}"`);
  if (identity.length === 0) identity.push("element");

  const state: string[] = [];
  if (element.visible === false) state.push("hidden");
  if (element.enabled === false) state.push("disabled");
  if (element.clickable) state.push("clickable");
  if (element.focused) state.push("focused");
  state.push(
    `bounds=${Math.round(element.bounds.x)},${Math.round(element.bounds.y)} ${Math.round(element.bounds.width)}x${Math.round(element.bounds.height)}`,
  );

  return `${identity.join(" ")} [${state.join(", ")}]`;
}

function summarizeHierarchy(root: Element): string {
  const lines: string[] = [];
  const limit = 24;
  let visited = 0;

  const walk = (element: Element, depth: number) => {
    visited += 1;
    if (lines.length < limit) {
      lines.push(`${"  ".repeat(Math.min(depth, 6))}- ${describeElement(element)}`);
    }
    for (const child of element.children ?? []) {
      walk(child, depth + 1);
    }
  };

  walk(root, 0);

  if (visited > limit) {
    lines.push(`... truncated ${visited - limit} more element(s)`);
  }

  return lines.join("\n");
}

function formatHierarchy(raw: string, verbose: boolean): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Element | unknown[];
      if (Array.isArray(parsed)) {
        return verbose
          ? JSON.stringify(parsed, null, 2)
          : clipText(JSON.stringify(parsed, null, 2), 60, 6000);
      }
      return verbose ? JSON.stringify(parsed, null, 2) : summarizeHierarchy(parsed);
    } catch {
      // Fall back to the raw text below when the snapshot is not valid JSON.
    }
  }

  return clipText(raw, verbose ? 240 : 60, verbose ? 24_000 : 6_000);
}

function formatConsoleLogs(raw: string, verbose: boolean): string {
  try {
    const logs = JSON.parse(raw) as Array<{
      type?: string;
      text?: string;
      location?: { url?: string; lineNumber?: number; columnNumber?: number };
    }>;
    if (verbose) {
      return JSON.stringify(logs, null, 2);
    }

    const preview = logs.slice(0, 8).map((entry, index) => {
      const location = entry.location?.url
        ? ` @ ${entry.location.url}${
            entry.location.lineNumber !== undefined ? `:${entry.location.lineNumber}` : ""
          }${entry.location.columnNumber !== undefined ? `:${entry.location.columnNumber}` : ""}`
        : "";
      return `${index + 1}. [${entry.type ?? "log"}] ${entry.text ?? ""}${location}`;
    });

    const remainder =
      logs.length > preview.length
        ? [`... truncated ${logs.length - preview.length} more log(s)`]
        : [];

    return [`Entries: ${logs.length}`, ...preview, ...remainder].join("\n");
  } catch {
    return clipText(raw, verbose ? 120 : 40, verbose ? 16_000 : 4_000);
  }
}

function formatJSErrors(raw: string, verbose: boolean): string {
  try {
    const errors = JSON.parse(raw) as Array<{ name?: string; message?: string; stack?: string }>;
    if (verbose) {
      return JSON.stringify(errors, null, 2);
    }

    const preview = errors
      .slice(0, 8)
      .map((entry, index) => `${index + 1}. ${entry.name ?? "Error"}: ${entry.message ?? ""}`);
    const remainder =
      errors.length > preview.length
        ? [`... truncated ${errors.length - preview.length} more error(s)`]
        : [];

    return [`Entries: ${errors.length}`, ...preview, ...remainder].join("\n");
  } catch {
    return clipText(raw, verbose ? 120 : 40, verbose ? 16_000 : 4_000);
  }
}

function formatHAR(raw: string, verbose: boolean): string {
  try {
    const har = JSON.parse(raw) as {
      log?: {
        pages?: Array<unknown>;
        entries?: Array<{
          request?: { method?: string; url?: string };
          response?: { status?: number };
          _failureText?: string;
        }>;
      };
    };

    if (verbose) {
      return JSON.stringify(har, null, 2);
    }

    const entries = har.log?.entries ?? [];
    const preview = entries.slice(0, 8).map((entry) => {
      const method = entry.request?.method ?? "GET";
      const url = entry.request?.url ?? "unknown";
      const status =
        entry.response?.status !== undefined
          ? String(entry.response.status)
          : (entry._failureText ?? "failed");
      return `${method} ${status} ${url}`;
    });
    const remainder =
      entries.length > preview.length
        ? [`... truncated ${entries.length - preview.length} more request(s)`]
        : [];

    return [
      `Pages: ${String(har.log?.pages?.length ?? 0)}`,
      `Requests: ${String(entries.length)}`,
      ...(preview.length > 0 ? ["", ...preview] : []),
      ...remainder,
    ].join("\n");
  } catch {
    return clipText(raw, verbose ? 120 : 40, verbose ? 16_000 : 4_000);
  }
}

function diagnosticTitle(name: string): string | null {
  if (name.endsWith("hierarchy")) return "Hierarchy snapshot";
  if (name.endsWith("driver-logs")) return "Driver logs";
  if (name.endsWith("console-logs")) return "Console logs";
  if (name.endsWith("js-errors")) return "JavaScript errors";
  if (name.endsWith("network-har")) return "Network HAR";
  return null;
}

function formatDiagnosticBody(attachment: Attachment, raw: string, verbose: boolean): string {
  if (attachment.name.endsWith("hierarchy")) return formatHierarchy(raw, verbose);
  if (attachment.name.endsWith("driver-logs")) {
    return clipText(raw, verbose ? 240 : 80, verbose ? 24_000 : 8_000);
  }
  if (attachment.name.endsWith("console-logs")) return formatConsoleLogs(raw, verbose);
  if (attachment.name.endsWith("js-errors")) return formatJSErrors(raw, verbose);
  if (attachment.name.endsWith("network-har")) return formatHAR(raw, verbose);
  return clipText(raw, verbose ? 120 : 40, verbose ? 16_000 : 4_000);
}

export function collectDiagnosticSections(
  attachments: Attachment[] | undefined,
  options?: DiagnosticSectionOptions,
): DiagnosticSection[] {
  const verbose = options?.verbose ?? false;

  return (attachments ?? [])
    .map((attachment) => {
      const title = diagnosticTitle(attachment.name);
      if (!title) return null;

      const raw = readAttachmentText(attachment.path);
      if (!raw) return null;

      const body = formatDiagnosticBody(attachment, raw, verbose);
      if (!body) return null;

      return { title, body, path: attachment.path };
    })
    .filter((section): section is DiagnosticSection => section !== null);
}
