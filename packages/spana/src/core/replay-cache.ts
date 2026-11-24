import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtendedSelector } from "../schemas/selector.js";
import type { PromiseApp } from "../api/app.js";

/** A deterministic action recorded from an `agent.act(goal)` execution. */
export type RecordedAction =
  | { kind: "tap"; selector: ExtendedSelector }
  | { kind: "doubleTap"; selector: ExtendedSelector }
  | { kind: "longPress"; selector: ExtendedSelector }
  | { kind: "inputText"; text: string }
  | { kind: "pressKey"; key: string }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right" }
  | { kind: "scrollUntilVisible"; selector: ExtendedSelector }
  | { kind: "openLink"; url: string };

export interface ReplayCacheEntry {
  schemaVersion: 1;
  key: string;
  goal: string;
  flowName: string;
  platform: string;
  actions: RecordedAction[];
  recordedAt: string;
  verifiedBy: string;
}

export type ReplayCacheMode = "read-write" | "strict" | "off";

export type CacheWriteStatus = "saved" | "kept" | "unconfirmed" | "evicted" | "skipped";

export interface ReplayStepOutcome {
  goal: string;
  key: string;
  status: "replayed" | "handed-off" | "missed" | "live";
  writeStatus?: CacheWriteStatus;
  actionCount: number;
  error?: string;
}

export interface ReplayCacheSummary {
  replayed: number;
  handedOff: number;
  missed: number;
  saved: number;
  evicted: number;
  unconfirmed: number;
}

/**
 * Pluggable agent executor called ONLY on cache miss or self-healing handoff.
 * Returns the deterministic list of actions it executed to achieve `goal`.
 */
export interface AgentActExecutor {
  act(input: {
    goal: string;
    app: PromiseApp;
    handoffReason?: string;
  }): Promise<{ actions: RecordedAction[] }>;
}

/** Compute a stable cache key for a `(flowName, platform, goal)` tuple. */
export function buildReplayCacheKey(flowName: string, platform: string, goal: string): string {
  const hash = createHash("sha256")
    .update(`${flowName}\0${platform}\0${goal.trim()}`)
    .digest("hex")
    .slice(0, 16);
  const slug = flowName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "flow"}-${platform}-${hash}`;
}

/** Disk-backed replay cache store (default directory: `.spana/cache`). */
export class ReplayCacheStore {
  readonly cacheDir: string;

  constructor(cacheDir: string = ".spana/cache") {
    this.cacheDir = cacheDir;
  }

  private filePath(key: string): string {
    return join(this.cacheDir, `${key}.json`);
  }

  get(key: string): ReplayCacheEntry | null {
    const p = this.filePath(key);
    if (!existsSync(p)) return null;
    try {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as ReplayCacheEntry;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.actions)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  set(entry: ReplayCacheEntry): void {
    const p = this.filePath(entry.key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(entry, null, 2), "utf-8");
  }

  delete(key: string): boolean {
    const p = this.filePath(key);
    if (!existsSync(p)) return false;
    rmSync(p, { force: true });
    return true;
  }
}

/** Execute a single recorded deterministic action against `PromiseApp`. */
export async function replayRecordedAction(app: PromiseApp, action: RecordedAction): Promise<void> {
  switch (action.kind) {
    case "tap":
      await app.tap(action.selector);
      break;
    case "doubleTap":
      await app.doubleTap(action.selector);
      break;
    case "longPress":
      await app.longPress(action.selector);
      break;
    case "inputText":
      await app.inputText(action.text);
      break;
    case "pressKey":
      await app.pressKey(action.key);
      break;
    case "scroll":
      await app.scroll(action.direction);
      break;
    case "scrollUntilVisible":
      await app.scrollUntilVisible(action.selector);
      break;
    case "openLink":
      await app.openLink(action.url);
      break;
  }
}

export interface ReplaySessionOptions {
  flowName: string;
  platform: string;
  app: PromiseApp;
  store?: ReplayCacheStore;
  mode?: ReplayCacheMode;
  executor?: AgentActExecutor;
}

/**
 * Verified Replay Cache session inspired by `e2e-inc/e2e`:
 *
 * - On cache hit: replays deterministic `{ testID }` / `systemUI()` actions with ZERO LLM calls.
 * - In `strict` mode (`--strict-cache`): fails deterministically if a recording is missing or no longer matches.
 * - In `read-write` mode: hands off to `executor` on miss or mismatch (self-healing), and ONLY commits
 *   new/healed recordings to `.spana/cache/` after `markVerified(verifierName)` is called by a real assertion!
 */
export class ReplaySession {
  private readonly flowName: string;
  private readonly platform: string;
  private readonly app: PromiseApp;
  private readonly store: ReplayCacheStore;
  private readonly mode: ReplayCacheMode;
  private readonly executor?: AgentActExecutor;

  private pendingWrites: Array<{
    entry: ReplayCacheEntry;
    outcomeIndex: number;
    wasExisting: boolean;
  }> = [];
  private replayedKeys: Array<{ key: string; outcomeIndex: number }> = [];
  private outcomes: ReplayStepOutcome[] = [];

  constructor(options: ReplaySessionOptions) {
    this.flowName = options.flowName;
    this.platform = options.platform;
    this.app = options.app;
    this.store = options.store ?? new ReplayCacheStore();
    this.mode = options.mode ?? "read-write";
    this.executor = options.executor;
  }

  /** Execute a natural-language goal using replay cache first, falling back to `executor`. */
  async act(goal: string): Promise<ReplayStepOutcome> {
    const key = buildReplayCacheKey(this.flowName, this.platform, goal);
    const cached = this.mode === "off" ? null : this.store.get(key);

    // 1. Try deterministic replay first (zero LLM calls)
    if (cached && cached.actions.length > 0) {
      try {
        for (const action of cached.actions) {
          await replayRecordedAction(this.app, action);
        }
        const outcome: ReplayStepOutcome = {
          goal,
          key,
          status: "replayed",
          writeStatus: "kept",
          actionCount: cached.actions.length,
        };
        const idx = this.outcomes.push(outcome) - 1;
        this.replayedKeys.push({ key, outcomeIndex: idx });
        return outcome;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (this.mode === "strict") {
          throw new Error(
            `Strict replay cache mismatch for "${goal}" (${key}): ${errMsg}. Re-run locally without --strict-cache to self-heal and update .spana/cache/.`,
            { cause: err },
          );
        }
        // Hand off to executor for self-healing
        return this.runLiveAndQueue(goal, key, true, errMsg);
      }
    }

    // 2. Cache miss
    if (this.mode === "strict") {
      throw new Error(
        `Strict replay cache miss for "${goal}" (${key}). No verified recording found in ${this.store.cacheDir}.`,
      );
    }

    return this.runLiveAndQueue(goal, key, false);
  }

  private async runLiveAndQueue(
    goal: string,
    key: string,
    wasExisting: boolean,
    handoffReason?: string,
  ): Promise<ReplayStepOutcome> {
    if (!this.executor) {
      throw new Error(
        `No agent executor configured for goal "${goal}" and no cached replay exists.`,
      );
    }

    const result = await this.executor.act({
      goal,
      app: this.app,
      handoffReason,
    });

    const outcome: ReplayStepOutcome = {
      goal,
      key,
      status: wasExisting ? "handed-off" : this.mode === "off" ? "live" : "missed",
      writeStatus: this.mode === "off" ? "skipped" : "unconfirmed",
      actionCount: result.actions.length,
    };
    const idx = this.outcomes.push(outcome) - 1;

    if (this.mode === "read-write" && result.actions.length > 0) {
      this.pendingWrites.push({
        wasExisting,
        outcomeIndex: idx,
        entry: {
          schemaVersion: 1,
          key,
          goal,
          flowName: this.flowName,
          platform: this.platform,
          actions: result.actions,
          recordedAt: new Date().toISOString(),
          verifiedBy: "",
        },
      });
    }

    return outcome;
  }

  /**
   * Call when a real post-action assertion (`expect(...).toBeVisible()`, `toHaveText()`, etc.)
   * succeeds. Flushes all preceding pending recordings to disk in `read-write` mode.
   */
  markVerified(verifierName: string): number {
    if (this.mode !== "read-write") return 0;
    let saved = 0;
    for (const pending of this.pendingWrites) {
      pending.entry.verifiedBy = verifierName;
      this.store.set(pending.entry);
      this.outcomes[pending.outcomeIndex]!.writeStatus = "saved";
      saved += 1;
    }
    this.pendingWrites = [];
    return saved;
  }

  /**
   * Call when the flow attempt fails: evicts any replayed recordings involved in the
   * failure (in `read-write` mode) and discards unconfirmed recordings so broken paths
   * are never persisted.
   */
  markFailed(): number {
    let evicted = 0;
    if (this.mode === "read-write") {
      for (const replayed of this.replayedKeys) {
        if (this.store.delete(replayed.key)) {
          this.outcomes[replayed.outcomeIndex]!.writeStatus = "evicted";
          evicted += 1;
        }
      }
      for (const pending of this.pendingWrites) {
        if (pending.wasExisting && this.store.delete(pending.entry.key)) {
          this.outcomes[pending.outcomeIndex]!.writeStatus = "evicted";
          evicted += 1;
        }
      }
    }
    this.pendingWrites = [];
    this.replayedKeys = [];
    return evicted;
  }

  getOutcomes(): ReplayStepOutcome[] {
    return [...this.outcomes];
  }

  getSummary(): ReplayCacheSummary {
    const summary: ReplayCacheSummary = {
      replayed: 0,
      handedOff: 0,
      missed: 0,
      saved: 0,
      evicted: 0,
      unconfirmed: 0,
    };
    for (const o of this.outcomes) {
      if (o.status === "replayed") summary.replayed++;
      else if (o.status === "handed-off") summary.handedOff++;
      else if (o.status === "missed") summary.missed++;

      if (o.writeStatus === "saved") summary.saved++;
      else if (o.writeStatus === "evicted") summary.evicted++;
      else if (o.writeStatus === "unconfirmed") summary.unconfirmed++;
    }
    return summary;
  }
}
