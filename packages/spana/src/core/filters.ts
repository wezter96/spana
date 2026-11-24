import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { FlowDefinition } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";

/** A file changed between `baseRef` and `HEAD` (or working tree). */
export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "C" | string;
}

/** Git diff snapshot provided to test filters when `--changed-since <ref>` is active. */
export interface GitChanges {
  baseRef: string;
  mergeBase?: string;
  files: string[];
  entries: ChangedFile[];
  /** Unified diff text (truncated when exceeding `maxDiffBytes`). */
  diff: string;
  /** Full byte length of the raw diff before truncation. */
  diffBytes: number;
  /** True when the diff exceeded the configured safety cap. */
  truncated: boolean;
}

/** Descriptor for a candidate flow passed into a `TestFilter`. */
export interface FilterCandidate {
  id: string;
  name: string;
  file: string;
  tags: string[];
  platforms?: Platform[];
  source?: string;
}

/** Context supplied to every `TestFilter.filter()` invocation. */
export interface FilterContext {
  cwd: string;
  changes: GitChanges;
  configPath?: string;
  platforms: Platform[];
}

export interface FilterUsage {
  calls?: number;
  tokens?: number;
  costUsd?: number;
}

export interface FilterDecisionOutput {
  /** Map of candidate `id` -> human-readable skip reason. Any ID not present is kept. */
  exclude: Record<string, string>;
  /** Optional summary note displayed next to the filter output. */
  note?: string;
  /** Optional model/API usage metrics for summary logging. */
  usage?: FilterUsage;
}

/**
 * Pluggable CI test filter inspired by `e2e-inc/e2e`'s Filters API.
 * Compose deterministic path/tag rules or plug in a decision model / LLM.
 */
export interface TestFilter {
  name: string;
  filter(
    flows: FilterCandidate[],
    context: FilterContext,
  ): Promise<FilterDecisionOutput> | FilterDecisionOutput;
}

export interface AppliedFilterReport {
  filterName: string;
  total: number;
  kept: number;
  excluded: number;
  note?: string;
  usage?: FilterUsage;
  failedOpen?: boolean;
}

export interface ApplyFiltersResult<T> {
  kept: T[];
  excluded: Array<{ item: T; candidate: FilterCandidate; filterName: string; reason: string }>;
  reports: AppliedFilterReport[];
}

const DEFAULT_LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const DEFAULT_MAX_DIFF_BYTES = 60 * 1024; // 60 kB fail-open safety ceiling

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isConfigOrLockfile(filePath: string, configPath?: string): boolean {
  const norm = normalizePath(filePath);
  const name = basename(norm);
  if (DEFAULT_LOCKFILES.has(name)) return true;
  if (/^spana\.config(\.[^.]+)?\.(ts|mts|js|mjs|cjs)$/.test(name)) return true;
  if (configPath && normalizePath(configPath).endsWith(norm)) return true;
  return false;
}

/**
 * Collect changed files and unified diff relative to `baseRef` using `git merge-base`.
 * Fails cleanly if git is unavailable or `baseRef` does not exist (shallow checkout).
 */
export function collectGitChanges(
  baseRef: string,
  cwd: string = process.cwd(),
  maxDiffBytes: number = DEFAULT_MAX_DIFF_BYTES,
  runGit?: (args: string[], workdir: string) => string,
): GitChanges {
  const execGit =
    runGit ??
    ((args: string[], workdir: string) =>
      execFileSync("git", args, {
        cwd: workdir,
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }));

  let mergeBase: string | undefined;
  try {
    mergeBase = execGit(["merge-base", baseRef, "HEAD"], cwd).trim() || undefined;
  } catch {
    mergeBase = undefined;
  }

  const diffRange = mergeBase ? `${mergeBase}...HEAD` : baseRef;
  const nameStatusRaw = execGit(["diff", "--name-status", diffRange], cwd);
  const entries: ChangedFile[] = [];
  const files: string[] = [];

  for (const line of nameStatusRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t+/);
    const status = parts[0]?.[0] ?? "M";
    // For renames (R100 old new), include the destination path
    const filePath = normalizePath(parts[parts.length - 1] ?? "");
    if (!filePath) continue;
    entries.push({ path: filePath, status });
    files.push(filePath);
  }

  const rawDiff = execGit(["diff", "--unified=3", diffRange], cwd);
  const diffBytes = Buffer.byteLength(rawDiff, "utf-8");
  const truncated = diffBytes > maxDiffBytes;
  const diff = truncated ? rawDiff.slice(0, maxDiffBytes) : rawDiff;

  return {
    baseRef,
    mergeBase,
    files,
    entries,
    diff,
    diffBytes,
    truncated,
  };
}

/** Build filter candidates from loaded Spana flows (including source file content when readable). */
export function buildFilterCandidates(
  loaded: Array<{ sourcePath: string; flow: FlowDefinition }>,
  cwd: string = process.cwd(),
): FilterCandidate[] {
  const sourceCache = new Map<string, string | undefined>();
  return loaded.map((entry, idx) => {
    const rel = normalizePath(relative(cwd, resolve(cwd, entry.sourcePath)));
    if (!sourceCache.has(entry.sourcePath)) {
      let src: string | undefined;
      if (existsSync(entry.sourcePath)) {
        try {
          src = readFileSync(entry.sourcePath, "utf-8");
        } catch {
          src = undefined;
        }
      }
      sourceCache.set(entry.sourcePath, src);
    }
    return {
      id: `${rel}::${entry.flow.name}#${idx}`,
      name: entry.flow.name,
      file: rel,
      tags: entry.flow.config.tags ?? [],
      platforms: entry.flow.config.platforms,
      source: sourceCache.get(entry.sourcePath),
    };
  });
}

// ── Built-in Decision-Model Filter ──────────────────────────────────────────

export interface DecisionJudgeInput {
  candidate: FilterCandidate;
  changes: GitChanges;
}

export interface DecisionJudgeResult {
  /** Probability [0..1] that the PR changes can affect this flow. */
  probability: number;
  reason?: string;
  usage?: FilterUsage;
}

export type DecisionModelJudge = (
  input: DecisionJudgeInput,
) => Promise<DecisionJudgeResult> | DecisionJudgeResult;

export interface DecisionFilterOptions {
  /** Optional custom name (default: "decision") */
  name?: string;
  /**
   * Model judge function returning an impact probability in `[0, 1]`.
   * Compatible with AI SDK decision models (e.g. Typesafe AI Jev), OpenAI,
   * Anthropic, or any local classifier.
   */
  judge: DecisionModelJudge;
  /**
   * Skip a flow only when `probability < threshold`.
   * Default: `0.20` (fail-open safety bias — runs anything >= 20% likely affected).
   */
  threshold?: number;
  /** Max diff size in bytes before failing open and running everything. Default: 60 kB. */
  maxDiffBytes?: number;
  /** Max single flow file size in bytes before failing open for that flow. Default: 32 kB. */
  maxFileBytes?: number;
  /** Tags that are NEVER excluded (e.g. `["smoke"]`). */
  alwaysRunTags?: string[];
  /** Path prefixes that force the entire suite to run (e.g. `["infra/", "db/migrations/"]`). */
  runAllOnPaths?: string[];
}

/**
 * Create a fail-open decision-model filter for `--changed-since`:
 *
 * Safety invariants (never skip important tests):
 * 1. Changed flow files always run.
 * 2. Config or lockfile changes run the entire suite.
 * 3. Diffs over `maxDiffBytes` (default 60 kB) run the entire suite.
 * 4. Flows tagged in `alwaysRunTags` always run.
 * 5. Any judge error or invalid probability fails open (flow runs).
 * 6. A flow is excluded only when `probability < threshold` (default 0.20).
 */
export function decisionFilter(options: DecisionFilterOptions): TestFilter {
  const filterName = options.name ?? "decision";
  const threshold = options.threshold ?? 0.2;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const maxFileBytes = options.maxFileBytes ?? 32 * 1024;
  const alwaysRunTags = new Set(options.alwaysRunTags ?? []);
  const runAllOnPaths = (options.runAllOnPaths ?? []).map(normalizePath);

  return {
    name: filterName,
    async filter(flows, context): Promise<FilterDecisionOutput> {
      const { changes, configPath } = context;

      if (changes.files.length === 0) {
        return { exclude: {}, note: "no git changes detected" };
      }

      if (changes.files.some((f) => isConfigOrLockfile(f, configPath))) {
        return { exclude: {}, note: "config or lockfile changed — running all flows" };
      }

      const matchedGlobalPath = changes.files.find((f) =>
        runAllOnPaths.some((prefix) => normalizePath(f).startsWith(prefix)),
      );
      if (matchedGlobalPath) {
        return {
          exclude: {},
          note: `global path changed (${matchedGlobalPath}) — running all flows`,
        };
      }

      if (changes.truncated || changes.diffBytes > maxDiffBytes) {
        return {
          exclude: {},
          note: `diff exceeds ${Math.round(maxDiffBytes / 1024)}kB cap — failing open`,
        };
      }

      const changedSet = new Set(changes.files.map(normalizePath));
      const exclude: Record<string, string> = {};
      let calls = 0;
      let tokens = 0;
      let costUsd = 0;

      for (const candidate of flows) {
        // Safety rule: never skip a modified flow file
        if (changedSet.has(normalizePath(candidate.file))) continue;

        // Safety rule: never skip always-run tags (e.g. smoke)
        if (candidate.tags.some((t) => alwaysRunTags.has(t))) continue;

        // Safety rule: fail open if flow file is too large to send cleanly
        if (candidate.source && Buffer.byteLength(candidate.source, "utf-8") > maxFileBytes) {
          continue;
        }

        try {
          const verdict = await options.judge({ candidate, changes });
          calls += verdict.usage?.calls ?? 1;
          tokens += verdict.usage?.tokens ?? 0;
          costUsd += verdict.usage?.costUsd ?? 0;

          if (
            typeof verdict.probability === "number" &&
            !Number.isNaN(verdict.probability) &&
            verdict.probability >= 0 &&
            verdict.probability < threshold
          ) {
            const pct = Math.round(verdict.probability * 100);
            exclude[candidate.id] =
              verdict.reason ?? `rated ${pct}% likely affected (< ${Math.round(threshold * 100)}%)`;
          }
        } catch {
          // Fail open on any model/network error
          continue;
        }
      }

      return {
        exclude,
        usage: calls > 0 ? { calls, tokens, costUsd } : undefined,
      };
    },
  };
}

// ── Built-in Deterministic Path-Rule Filter ─────────────────────────────────

export interface PathRule {
  /** Flow tag or path prefix this rule owns. */
  matchFlow: { tag?: string; filePrefix?: string };
  /** Source path prefixes that can affect matching flows. */
  watchPaths: string[];
}

export interface PathRuleFilterOptions {
  name?: string;
  rules: PathRule[];
  alwaysRunTags?: string[];
  runAllOnPaths?: string[];
}

/**
 * 100% deterministic zero-LLM filter mapping repo path prefixes to flow tags/files.
 * Flows not matched by any rule fail open and run automatically.
 */
export function pathRuleFilter(options: PathRuleFilterOptions): TestFilter {
  const filterName = options.name ?? "path-rules";
  const alwaysRunTags = new Set(options.alwaysRunTags ?? []);
  const runAllOnPaths = (options.runAllOnPaths ?? []).map(normalizePath);

  return {
    name: filterName,
    filter(flows, context): FilterDecisionOutput {
      const { changes, configPath } = context;

      if (changes.files.length === 0) {
        return { exclude: {}, note: "no git changes detected" };
      }

      if (changes.files.some((f) => isConfigOrLockfile(f, configPath))) {
        return { exclude: {}, note: "config or lockfile changed — running all flows" };
      }

      const matchedGlobal = changes.files.find((f) =>
        runAllOnPaths.some((prefix) => normalizePath(f).startsWith(prefix)),
      );
      if (matchedGlobal) {
        return { exclude: {}, note: `global path changed (${matchedGlobal}) — running all flows` };
      }

      const changedFiles = changes.files.map(normalizePath);
      const changedSet = new Set(changedFiles);
      const exclude: Record<string, string> = {};

      for (const candidate of flows) {
        if (changedSet.has(normalizePath(candidate.file))) continue;
        if (candidate.tags.some((t) => alwaysRunTags.has(t))) continue;

        const matchedRules = options.rules.filter((rule) => {
          const tagOk = rule.matchFlow.tag ? candidate.tags.includes(rule.matchFlow.tag) : true;
          const fileOk = rule.matchFlow.filePrefix
            ? normalizePath(candidate.file).startsWith(normalizePath(rule.matchFlow.filePrefix))
            : true;
          return (rule.matchFlow.tag || rule.matchFlow.filePrefix) && tagOk && fileOk;
        });

        // No rule owns this flow -> fail open (keep it)
        if (matchedRules.length === 0) continue;

        const watchedPrefixes = matchedRules.flatMap((r) => r.watchPaths.map(normalizePath));
        const affected = changedFiles.some((cf) =>
          watchedPrefixes.some((prefix) => cf.startsWith(prefix)),
        );

        if (!affected) {
          exclude[candidate.id] = `no changed files matched [${watchedPrefixes.join(", ")}]`;
        }
      }

      return { exclude };
    },
  };
}

/**
 * Run a chain of `TestFilter`s sequentially over candidate flows.
 * Any filter that throws fails open (keeps all remaining flows) and logs a note.
 */
export async function applyTestFilters<T>(
  items: T[],
  candidates: FilterCandidate[],
  filters: TestFilter[],
  context: FilterContext,
): Promise<ApplyFiltersResult<T>> {
  let remainingIndices = items.map((_, i) => i);
  const excluded: ApplyFiltersResult<T>["excluded"] = [];
  const reports: AppliedFilterReport[] = [];

  for (const filter of filters) {
    const activeCandidates = remainingIndices.map((idx) => candidates[idx]!);
    const totalBefore = activeCandidates.length;

    try {
      const output = await filter.filter(activeCandidates, context);
      const excludeMap = output.exclude ?? {};
      const nextRemaining: number[] = [];
      let excludedCount = 0;

      for (const idx of remainingIndices) {
        const cand = candidates[idx]!;
        const reason = excludeMap[cand.id];
        if (reason !== undefined) {
          excludedCount += 1;
          excluded.push({
            item: items[idx]!,
            candidate: cand,
            filterName: filter.name,
            reason,
          });
        } else {
          nextRemaining.push(idx);
        }
      }

      remainingIndices = nextRemaining;
      reports.push({
        filterName: filter.name,
        total: totalBefore,
        kept: remainingIndices.length,
        excluded: excludedCount,
        note: output.note,
        usage: output.usage,
      });
    } catch (err) {
      reports.push({
        filterName: filter.name,
        total: totalBefore,
        kept: totalBefore,
        excluded: 0,
        failedOpen: true,
        note: `filter error (${err instanceof Error ? err.message : String(err)}) — failed open`,
      });
    }
  }

  return {
    kept: remainingIndices.map((idx) => items[idx]!),
    excluded,
    reports,
  };
}

/** Format a concise, `e2e`-style CI summary line for each applied filter. */
export function formatFilterSummary(reports: AppliedFilterReport[]): string[] {
  return reports.map((r) => {
    const parts: string[] = [];
    if (r.usage?.calls) {
      parts.push(`${r.usage.calls} call${r.usage.calls === 1 ? "" : "s"}`);
    }
    if (r.usage?.tokens) {
      const tok =
        r.usage.tokens >= 1000 ? `${(r.usage.tokens / 1000).toFixed(1)}k` : String(r.usage.tokens);
      parts.push(`${tok} tokens`);
    }
    if (r.usage?.costUsd !== undefined && r.usage.costUsd > 0) {
      parts.push(`$${r.usage.costUsd.toFixed(4)}`);
    }
    if (r.note) {
      parts.push(r.note);
    }
    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return `${r.filterName} kept ${r.kept} of ${r.total} flows, left out ${r.excluded}${detail}`;
  });
}
