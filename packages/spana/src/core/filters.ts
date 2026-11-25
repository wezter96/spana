import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
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

export interface DecisionBatchJudgeResult {
  /** Map of candidate `id` -> probability `[0, 1]` that the PR changes affect it. */
  probabilities: Record<string, number>;
  reasons?: Record<string, string>;
  usage?: FilterUsage;
}

export type DecisionBatchJudge = (input: {
  candidates: FilterCandidate[];
  changes: GitChanges;
}) => Promise<DecisionBatchJudgeResult> | DecisionBatchJudgeResult;

export interface DecisionFilterOptions {
  /** Optional custom name (default: "decision") */
  name?: string;
  /**
   * Per-flow model judge function returning an impact probability in `[0, 1]`.
   * Provide either `judge` or `batchJudge` (batched evaluates all flows in 1 LLM call).
   */
  judge?: DecisionModelJudge;
  /**
   * Batched model judge evaluating all candidate flows in a single model call
   * (dramatically faster for local Ollama/MLX models and cloud decision models).
   */
  batchJudge?: DecisionBatchJudge;
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

      // Filter down to flows eligible for model judgment (safety rules always keep the rest)
      const eligible: FilterCandidate[] = [];
      for (const candidate of flows) {
        if (changedSet.has(normalizePath(candidate.file))) continue;
        if (candidate.tags.some((t) => alwaysRunTags.has(t))) continue;
        if (candidate.source && Buffer.byteLength(candidate.source, "utf-8") > maxFileBytes) {
          continue;
        }
        eligible.push(candidate);
      }

      if (eligible.length === 0) {
        return { exclude };
      }

      // Fast path: evaluate all eligible flows in ONE batched model call
      if (options.batchJudge) {
        try {
          const batch = await options.batchJudge({ candidates: eligible, changes });
          calls += batch.usage?.calls ?? 1;
          tokens += batch.usage?.tokens ?? 0;
          costUsd += batch.usage?.costUsd ?? 0;
          for (const candidate of eligible) {
            const prob = batch.probabilities[candidate.id];
            if (typeof prob === "number" && !Number.isNaN(prob) && prob >= 0 && prob < threshold) {
              const pct = Math.round(prob * 100);
              exclude[candidate.id] =
                batch.reasons?.[candidate.id] ??
                `rated ${pct}% likely affected (< ${Math.round(threshold * 100)}%)`;
            }
          }
        } catch {
          // Fail open on batch judge error
          return { exclude: {}, note: "decision model error — failed open" };
        }
        return {
          exclude,
          usage: calls > 0 ? { calls, tokens, costUsd } : undefined,
        };
      }

      if (!options.judge) {
        return { exclude: {}, note: "no judge configured — failed open" };
      }

      for (const candidate of eligible) {
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

export interface OllamaDecisionJudgeOptions {
  /** Ollama model tag, e.g. `"qwen2.5:1.5b"` or `"qwen2.5:0.5b"`. */
  model: string;
  /** Ollama HTTP endpoint (default: `"http://127.0.0.1:11434"`). */
  baseUrl?: string;
  /** Request timeout in ms (default: 15000). */
  timeoutMs?: number;
  /** Optional custom fetch implementation for testing. */
  fetchFn?: typeof fetch;
}

/**
 * Built-in local batched decision judge for Ollama (Apple Silicon / local GPU).
 * Evaluates all candidate flows against a PR diff in ONE structured JSON call
 * with `temperature: 0` and zero cloud token cost ($0.0000).
 */
export function createOllamaDecisionJudge(options: OllamaDecisionJudgeOptions): DecisionBatchJudge {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchFn = options.fetchFn ?? fetch;

  return async ({ candidates, changes }): Promise<DecisionBatchJudgeResult> => {
    const flowList = candidates
      .map((c, i) => `${i}: file="${c.file}", name="${c.name}", tags=[${c.tags.join(",")}]`)
      .join("\n");

    const prompt = [
      "You are a conservative CI test-impact classifier. Err on the side of RUNNING tests (high recall).",
      "For each E2E flow below, output a probability from 0.0 to 1.0 that the git diff could affect it.",
      "Rules:",
      "- If a flow's file path, name, or tags share the same feature/module/domain as ANY changed file, rate it 0.9.",
      "- If unsure or possibly connected via shared UI/state/API, rate it 0.5.",
      "- Rate 0.05 ONLY if the flow is clearly in a completely unrelated module.",
      `Changed files: ${changes.files.join(", ")}`,
      `Diff:\n${changes.diff.slice(0, 3000)}`,
      `Flows:\n${flowList}`,
      'Output compact single-line JSON mapping each index string to a number, e.g. {"0":0.9,"1":0.05}',
    ].join("\n");

    const res = await fetchFn(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        prompt,
        format: "json",
        stream: false,
        options: { temperature: 0, num_predict: 256 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}`);
    }

    const payload = (await res.json()) as {
      response?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const rawJson = (payload.response ?? "{}").trim();
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const probabilities: Record<string, number> = {};

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i]!;
      const val = parsed[String(i)] ?? parsed[cand.id] ?? parsed[cand.name];
      if (typeof val === "number" && !Number.isNaN(val)) {
        probabilities[cand.id] = Math.max(0, Math.min(1, val));
      } else {
        // Missing index -> fail open (1.0)
        probabilities[cand.id] = 1;
      }
    }

    return {
      probabilities,
      usage: {
        calls: 1,
        tokens: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0),
        costUsd: 0,
      },
    };
  };
}

export interface LogprobDecisionJudgeOptions {
  /** Model identifier (e.g. `"hf.co/apus-ailab/APUS-OpenJev-v1-9B-GGUF:Q8_0"`, `"jevk5-4b-v0.3:q8_0"`, `"decider4b-v2:bf16"`, `"plumb-4b"`). */
  model: string;
  /** Protocol backend: `"openai"` (vLLM / SGLang / llama-server / OpenRouter / Typesafe AI) or `"ollama"`. */
  provider: "openai" | "ollama";
  /** Base URL (default: `http://127.0.0.1:8000/v1` for openai, `http://127.0.0.1:11434` for ollama). */
  baseUrl?: string;
  /** Optional Bearer API key for hosted OpenAI-compatible endpoints. */
  apiKey?: string;
  /** Request timeout per flow judgment in ms (default: 15000). */
  timeoutMs?: number;
  /** Injectable fetch for unit tests. */
  fetchFn?: typeof fetch;
}

/**
 * Compute calibrated binary YES probability from OpenAI-style `top_logprobs`
 * on a 1-token decision model response (`max_tokens: 1`, `logprobs: true`).
 * Returns `null` when neither YES nor NO tokens appeared in top_logprobs.
 */
export function probabilityFromTopLogprobs(
  topLogprobs: Array<{ token: string; logprob: number }>,
): number | null {
  let yesProb = 0;
  let noProb = 0;

  for (const entry of topLogprobs) {
    const norm = entry.token.trim().toLowerCase();
    const p = Math.exp(entry.logprob);
    if (norm === "yes" || norm === "y" || norm === "true" || norm === "1") {
      yesProb += p;
    } else if (norm === "no" || norm === "n" || norm === "false" || norm === "0") {
      noProb += p;
    }
  }

  const total = yesProb + noProb;
  if (total <= 0) return null;
  return Math.max(0, Math.min(1, yesProb / total));
}

/**
 * Native 1-Token Logprob Decision Judge for System-1 decision models
 * (OpenJev, JevK5, Decider-4B, Plumb-4B, Winnow-12B, Typesafe AI Jev).
 *
 * Places the shared git diff prefix at the start of every prompt so vLLM,
 * SGLang, and llama.cpp automatically reuse the KV cache across all flows in a PR,
 * generating only **1 single token** (`YES` / `NO`) with exact calibrated probabilities.
 */
export function createLogprobDecisionJudge(
  options: LogprobDecisionJudgeOptions,
): DecisionModelJudge {
  const baseUrl = (
    options.baseUrl ??
    (options.provider === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:8000/v1")
  ).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchFn = options.fetchFn ?? fetch;

  return async ({ candidate, changes }): Promise<DecisionJudgeResult> => {
    // Shared prefix FIRST to maximize automatic KV-cache prefix hits across flows
    const prompt = [
      "You are a binary CI test-impact classifier. Answer strictly YES or NO.",
      `Changed files: ${changes.files.join(", ")}`,
      `Git diff:\n${changes.diff.slice(0, 3500)}`,
      `Question: Could this change affect or break the E2E flow below?`,
      `Flow file: ${candidate.file}`,
      `Flow name: ${candidate.name}`,
      `Flow tags: ${candidate.tags.join(", ") || "(none)"}`,
      "Answer (YES or NO):",
    ].join("\n");

    if (options.provider === "ollama") {
      const res = await fetchFn(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          prompt,
          stream: false,
          logprobs: true,
          top_logprobs: 10,
          options: { temperature: 0, num_predict: 1 },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
      const data = (await res.json()) as {
        response?: string;
        prompt_eval_count?: number;
        eval_count?: number;
        logprobs?: Array<{ top_logprobs?: Array<{ token: string; logprob: number }> }>;
      };

      const top = data.logprobs?.[0]?.top_logprobs;
      let probability = top ? probabilityFromTopLogprobs(top) : null;
      if (probability === null) {
        const tok = (data.response ?? "").trim().toLowerCase();
        if (tok.startsWith("n") || tok === "0" || tok === "false") probability = 0.05;
        else probability = 0.95; // fail open on ambiguous token
      }

      return {
        probability,
        usage: {
          calls: 1,
          tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
          costUsd: 0,
        },
      };
    }

    // OpenAI-compatible 1-token logprob endpoint (vLLM / SGLang / llama-server / Typesafe AI / OpenRouter)
    const res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: 1,
        logprobs: true,
        top_logprobs: 10,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Decision endpoint returned HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string };
        logprobs?: {
          content?: Array<{ top_logprobs?: Array<{ token: string; logprob: number }> }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const top = data.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
    let probability = top ? probabilityFromTopLogprobs(top) : null;
    if (probability === null) {
      const tok = (data.choices?.[0]?.message?.content ?? "").trim().toLowerCase();
      if (tok.startsWith("n") || tok === "0" || tok === "false") probability = 0.05;
      else probability = 0.95;
    }

    return {
      probability,
      usage: {
        calls: 1,
        tokens: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
        costUsd: 0,
      },
    };
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

// ── Built-in Deterministic Import-Graph Impact Filter (Zero AI) ─────────────

export interface DeterministicImpactFilterOptions {
  name?: string;
  /** Additional path-to-flow rules combined with automatic static import-graph tracing. */
  pathMappings?: PathRule[];
  /** Flow tags that are NEVER skipped (e.g. `["smoke"]`). */
  alwaysRunTags?: string[];
  /** Path prefixes that force the entire suite to run (e.g. `["src/shared/", "db/"]`). */
  runAllOnPaths?: string[];
  /**
   * When true (default), if a changed file is NOT imported by any flow and does not
   * match any `pathMappings`, fail open and run all flows so unmapped app changes are
   * never silently missed. Set to `false` for strict import-graph-only selection.
   */
  failOpenOnUnmappedChange?: boolean;
  /** Max recursive import depth to trace from each flow file. Default: 12. */
  maxDepth?: number;
}

const IMPORT_SPECIFIER_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']|require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.mjs",
];

function resolveLocalImport(fromFileAbs: string, specifier: string): string | null {
  const baseDir = dirname(fromFileAbs);
  const rawTarget = resolve(baseDir, specifier);
  // Handle TS ESM `.js` -> `.ts` / `.tsx` extension rewriting
  const withoutJs = rawTarget.replace(/\.m?js$/, "");
  const candidates =
    rawTarget !== withoutJs
      ? [withoutJs + ".ts", withoutJs + ".tsx", withoutJs + ".mts", rawTarget]
      : [rawTarget];

  for (const base of candidates) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const full = ext ? base + ext : base;
      try {
        if (existsSync(full) && statSync(full).isFile()) {
          return full;
        }
      } catch {
        // ignore unreadable paths
      }
    }
  }
  return null;
}

function collectTransitiveImports(
  entryAbs: string,
  cwd: string,
  maxDepth: number,
  fileCache: Map<string, string[]>,
): Set<string> {
  const visited = new Set<string>();
  const queue: Array<{ abs: string; depth: number }> = [{ abs: entryAbs, depth: 0 }];

  while (queue.length > 0) {
    const { abs, depth } = queue.shift()!;
    const normRel = normalizePath(relative(cwd, abs));
    if (visited.has(normRel)) continue;
    visited.add(normRel);
    if (depth >= maxDepth) continue;

    let specs = fileCache.get(abs);
    if (!specs) {
      specs = [];
      try {
        if (existsSync(abs) && statSync(abs).isFile()) {
          const content = readFileSync(abs, "utf-8");
          IMPORT_SPECIFIER_RE.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = IMPORT_SPECIFIER_RE.exec(content)) !== null) {
            const spec = match[1] ?? match[2] ?? match[3];
            if (spec) specs.push(spec);
          }
        }
      } catch {
        // ignore unreadable
      }
      fileCache.set(abs, specs);
    }

    for (const spec of specs) {
      const resolved = resolveLocalImport(abs, spec);
      if (resolved) {
        queue.push({ abs: resolved, depth: depth + 1 });
      }
    }
  }

  return visited;
}

/**
 * 100% deterministic, zero-AI test impact filter for `--changed-since`.
 *
 * Recursively traces static ESM/CJS imports (`import`, `export ... from`, `require`)
 * from every `.flow.ts` file and combines them with optional `pathMappings`.
 * Fails open on config/lockfile changes, `runAllOnPaths`, and (by default) any
 * changed file not covered by any import graph or path mapping.
 */
export function deterministicImpactFilter(
  options: DeterministicImpactFilterOptions = {},
): TestFilter {
  const filterName = options.name ?? "deterministic-impact";
  const alwaysRunTags = new Set(options.alwaysRunTags ?? []);
  const runAllOnPaths = (options.runAllOnPaths ?? []).map(normalizePath);
  const pathMappings = options.pathMappings ?? [];
  const failOpenOnUnmapped = options.failOpenOnUnmappedChange ?? true;
  const maxDepth = options.maxDepth ?? 12;

  return {
    name: filterName,
    filter(flows, context): FilterDecisionOutput {
      const { changes, configPath, cwd } = context;

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
      const fileCache = new Map<string, string[]>();

      // Build transitive import graph for every candidate flow
      const flowDeps = new Map<string, Set<string>>();
      const allKnownFiles = new Set<string>();
      for (const candidate of flows) {
        const entryAbs = resolve(cwd, candidate.file);
        const deps = collectTransitiveImports(entryAbs, cwd, maxDepth, fileCache);
        deps.add(normalizePath(candidate.file));
        flowDeps.set(candidate.id, deps);
        for (const d of deps) allKnownFiles.add(d);
      }

      const allWatchedPrefixes = pathMappings.flatMap((r) => r.watchPaths.map(normalizePath));

      if (failOpenOnUnmapped) {
        const unmapped = changedFiles.find(
          (cf) =>
            !allKnownFiles.has(cf) && !allWatchedPrefixes.some((prefix) => cf.startsWith(prefix)),
        );
        if (unmapped) {
          return {
            exclude: {},
            note: `unmapped file changed (${unmapped}) — failing open and running all flows`,
          };
        }
      }

      const exclude: Record<string, string> = {};
      for (const candidate of flows) {
        if (changedSet.has(normalizePath(candidate.file))) continue;
        if (candidate.tags.some((t) => alwaysRunTags.has(t))) continue;

        const deps = flowDeps.get(candidate.id);
        const touchedByImport = deps ? changedFiles.some((cf) => deps.has(cf)) : false;
        if (touchedByImport) continue;

        const matchedRules = pathMappings.filter((rule) => {
          const tagOk = rule.matchFlow.tag ? candidate.tags.includes(rule.matchFlow.tag) : true;
          const fileOk = rule.matchFlow.filePrefix
            ? normalizePath(candidate.file).startsWith(normalizePath(rule.matchFlow.filePrefix))
            : true;
          return (rule.matchFlow.tag || rule.matchFlow.filePrefix) && tagOk && fileOk;
        });
        const touchedByRule = matchedRules.some((rule) =>
          changedFiles.some((cf) =>
            rule.watchPaths.some((prefix) => cf.startsWith(normalizePath(prefix))),
          ),
        );
        if (touchedByRule) continue;

        exclude[candidate.id] = "unaffected by changed imports or path mappings";
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
