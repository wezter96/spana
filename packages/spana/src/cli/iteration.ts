import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
