import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { FlowResult } from "../report/types.js";

const SCHEMA_VERSION = 1;

interface LastRunFlowRecord {
  name: string;
  platform: string;
  passed: boolean;
  durationMs?: number;
  sourcePath?: string;
}

export interface LastRunState {
  schemaVersion: number;
  flowDir: string;
  platforms: string[];
  failedFlowNames: string[];
  failedSourcePaths: string[];
  flows: LastRunFlowRecord[];
}

export function buildLastRunState(options: {
  flowDir: string;
  platforms: string[];
  results: FlowResult[];
  sourcePathsByFlowName: Map<string, string | undefined>;
}): LastRunState {
  const { flowDir, platforms, results, sourcePathsByFlowName } = options;
  const failedFlowNames: string[] = [];
  const failedSourcePaths: string[] = [];
  const flows: LastRunFlowRecord[] = [];

  for (const result of results) {
    const passed = result.status === "passed";
    const sourcePath = sourcePathsByFlowName.get(result.name);
    flows.push({
      name: result.name,
      platform: result.platform,
      passed,
      durationMs: result.durationMs,
      sourcePath,
    });
    if (!passed) {
      if (!failedFlowNames.includes(result.name)) failedFlowNames.push(result.name);
      if (sourcePath && !failedSourcePaths.includes(sourcePath)) failedSourcePaths.push(sourcePath);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    flowDir,
    platforms,
    failedFlowNames,
    failedSourcePaths,
    flows,
  };
}

export async function readLastRunState(filePath: string): Promise<LastRunState | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed as LastRunState;
  } catch {
    return null;
  }
}

/**
 * Extract per-flow duration hints (max observed ms across platforms) from the
 * previous run's `last-run.json` so `--parallel` schedules the slowest flows first.
 */
export function extractDurationHints(state: LastRunState | null): Record<string, number> {
  const hints: Record<string, number> = {};
  if (!state?.flows) return hints;
  for (const entry of state.flows) {
    if (typeof entry.durationMs === "number" && entry.durationMs > 0) {
      hints[entry.name] = Math.max(hints[entry.name] ?? 0, entry.durationMs);
    }
  }
  return hints;
}

export async function writeLastRunState(filePath: string, state: LastRunState): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

function mergeParsedDurationHints(raw: unknown, out: Record<string, number>): void {
  if (!raw || typeof raw !== "object") return;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj["flows"])) {
    for (const entry of obj["flows"]) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>)["name"] === "string" &&
        typeof (entry as Record<string, unknown>)["durationMs"] === "number"
      ) {
        const name = (entry as Record<string, unknown>)["name"] as string;
        const durationMs = (entry as Record<string, unknown>)["durationMs"] as number;
        if (durationMs > 0) out[name] = Math.max(out[name] ?? 0, Math.round(durationMs));
      }
    }
    return;
  }
  const mapSource =
    obj["durations"] && typeof obj["durations"] === "object" && !Array.isArray(obj["durations"])
      ? (obj["durations"] as Record<string, unknown>)
      : obj;
  for (const [name, val] of Object.entries(mapSource)) {
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      out[name] = Math.max(out[name] ?? 0, Math.round(val));
    }
  }
}

/**
 * Read portable per-flow duration hints from either:
 * - a JSON map `{ [flowName]: durationMs }` (e.g. a committed/cached `spana-timings.json`),
 * - a Spana `last-run.json` file, or
 * - a directory of shard timing JSON files (merged taking max duration per flow).
 */
export async function readDurationHintsFile(filePath: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      const entries = (await readdir(filePath)).filter((f) => f.endsWith(".json")).toSorted();
      for (const name of entries) {
        try {
          const raw = await readFile(join(filePath, name), "utf8");
          mergeParsedDurationHints(JSON.parse(raw), out);
        } catch {
          // ignore unreadable or malformed shard file
        }
      }
      return out;
    }
    const raw = await readFile(filePath, "utf8");
    mergeParsedDurationHints(JSON.parse(raw), out);
  } catch {
    // missing or unreadable timings file — fail open with empty hints
  }
  return out;
}

/**
 * Write a portable, deterministic (sorted-key) `{ [flowName]: durationMs }` timings
 * manifest suitable for cross-machine `--shard` balancing in CI.
 * Merges with any existing hints in `filePath` so multi-shard runs accumulate cleanly.
 */
export async function writeDurationHintsFile(
  filePath: string,
  results: FlowResult[],
  existingHints?: Record<string, number>,
): Promise<Record<string, number>> {
  const merged: Record<string, number> = {
    ...(existingHints ?? (await readDurationHintsFile(filePath))),
  };
  for (const r of results) {
    if (typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs > 0) {
      merged[r.name] = Math.round(r.durationMs);
    }
  }
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(merged).toSorted()) {
    sorted[key] = merged[key]!;
  }
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  return sorted;
}

export function getGitChangedFiles(cwd: string): string[] {
  const tracked = execFileSync("git", ["diff", "--name-only"], { cwd, encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
  });
  return [...parseGitPathList(cwd, tracked), ...parseGitPathList(cwd, untracked)];
}

function parseGitPathList(cwd: string, output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => resolve(cwd, line));
}

interface ChangedFlowSelection {
  mode: "all" | "targeted" | "none";
  reason: string;
  flowPaths: string[];
}

export function selectChangedFlowPaths(options: {
  flowPaths: string[];
  changedFiles: string[];
  stepPaths: string[];
  configPath?: string;
}): ChangedFlowSelection {
  const { flowPaths, changedFiles, stepPaths, configPath } = options;
  const changedSet = new Set(changedFiles);

  // If config changed, run all
  if (configPath && changedSet.has(resolve(configPath))) {
    return { mode: "all", reason: "Config changed — running all flows.", flowPaths };
  }

  // If step definitions changed, run all .feature flows
  const stepChanged = stepPaths.some((s) => changedSet.has(s));
  if (stepChanged) {
    const featureFlows = flowPaths.filter((p) => p.endsWith(".feature"));
    if (featureFlows.length > 0) {
      return {
        mode: "targeted",
        reason: `Step definitions changed — running ${featureFlows.length} feature flow(s).`,
        flowPaths: featureFlows,
      };
    }
  }

  // Check for changed flow files
  const changedFlows = flowPaths.filter((p) => changedSet.has(p));
  if (changedFlows.length > 0) {
    return {
      mode: "targeted",
      reason: `Running ${changedFlows.length} changed flow(s).`,
      flowPaths: changedFlows,
    };
  }

  return { mode: "none", reason: "No changed flow files detected.", flowPaths: [] };
}

export function createLastRunStatePath(outputDir: string): string {
  return join(outputDir, ".spana", "last-run.json");
}
