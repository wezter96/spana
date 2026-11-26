import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DataSnapshotOptions {
  /** Directory storing snapshot files (default: `.spana/snapshots`). */
  snapshotsDir?: string;
  /** Create or overwrite the snapshot baseline instead of failing on mismatch. */
  updateBaselines?: boolean;
  /** File extension override (auto-selects `.json` for non-string values and `.txt` for strings). */
  extension?: string;
}

export interface DataSnapshotResult {
  matched: boolean;
  created: boolean;
  updated: boolean;
  snapshotPath: string;
  expected?: string;
  actual: string;
  diff?: string;
}

function sanitizeSnapshotName(name: string): string {
  return (
    name
      .trim()
      .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
      .replaceAll(/-+/g, "-")
      .replaceAll(/^-|-$/g, "") || "snapshot"
  );
}

function serializeSnapshotValue(value: unknown): { text: string; defaultExt: string } {
  if (typeof value === "string") {
    return { text: value.replaceAll("\r\n", "\n"), defaultExt: ".txt" };
  }
  return { text: `${JSON.stringify(value, null, 2)}\n`, defaultExt: ".json" };
}

function buildUnifiedLineDiff(expected: string, actual: string): string {
  const expLines = expected.split("\n");
  const actLines = actual.split("\n");
  const max = Math.max(expLines.length, actLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const e = expLines[i];
    const a = actLines[i];
    if (e === a) {
      if (out.length < 40) out.push(`  ${e ?? ""}`);
    } else {
      if (e !== undefined) out.push(`- ${e}`);
      if (a !== undefined) out.push(`+ ${a}`);
    }
    if (out.length >= 60) {
      out.push("... (diff truncated)");
      break;
    }
  }
  return out.join("\n");
}

/**
 * Compare an arbitrary string or JSON-serializable object against a disk snapshot baseline.
 */
export function matchDataSnapshot(
  actualValue: unknown,
  name: string,
  options: DataSnapshotOptions = {},
): DataSnapshotResult {
  const { text: actual, defaultExt } = serializeSnapshotValue(actualValue);
  const ext = options.extension ?? (name.includes(".") ? "" : defaultExt);
  const dir = resolve(options.snapshotsDir ?? ".spana/snapshots");
  const snapshotPath = join(dir, `${sanitizeSnapshotName(name)}${ext}`);
  const update = Boolean(options.updateBaselines);

  if (!existsSync(snapshotPath)) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, actual, "utf8");
    return {
      matched: true,
      created: true,
      updated: false,
      snapshotPath,
      actual,
    };
  }

  const expected = readFileSync(snapshotPath, "utf8").replaceAll("\r\n", "\n");
  if (expected === actual) {
    return {
      matched: true,
      created: false,
      updated: false,
      snapshotPath,
      expected,
      actual,
    };
  }

  if (update) {
    writeFileSync(snapshotPath, actual, "utf8");
    return {
      matched: true,
      created: false,
      updated: true,
      snapshotPath,
      expected,
      actual,
    };
  }

  return {
    matched: false,
    created: false,
    updated: false,
    snapshotPath,
    expected,
    actual,
    diff: buildUnifiedLineDiff(expected, actual),
  };
}

/**
 * Assert that `actualValue` matches the persisted snapshot `name` (throws with line diff on mismatch).
 */
export function assertDataSnapshot(
  actualValue: unknown,
  name: string,
  options: DataSnapshotOptions = {},
): DataSnapshotResult {
  const result = matchDataSnapshot(actualValue, name, options);
  if (!result.matched) {
    throw new Error(
      `Snapshot "${name}" mismatch (${result.snapshotPath}). Re-run with --update-baselines to update.\n\n${result.diff ?? ""}`,
    );
  }
  return result;
}
