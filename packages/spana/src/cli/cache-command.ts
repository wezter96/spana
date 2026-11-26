import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReplayCacheEntry } from "../core/replay-cache.js";

export interface CacheInspectEntry {
  key: string;
  filePath: string;
  flowName: string;
  platform: string;
  goal: string;
  actionCount: number;
  recordedAt: string;
  verifiedBy: string;
}

export interface CacheInspectResult {
  cacheDir: string;
  exists: boolean;
  entryCount: number;
  entries: CacheInspectEntry[];
}

export interface CacheClearResult {
  cacheDir: string;
  removedCount: number;
  removedKeys: string[];
}

/** Inspect all verified replay cache recordings in `cacheDir` (default: `.spana/cache`). */
export function inspectReplayCache(cacheDir = ".spana/cache"): CacheInspectResult {
  const resolved = resolve(cacheDir);
  if (!existsSync(resolved)) {
    return { cacheDir: resolved, exists: false, entryCount: 0, entries: [] };
  }

  const files = readdirSync(resolved)
    .filter((f) => f.endsWith(".json"))
    .toSorted();

  const entries: CacheInspectEntry[] = [];
  for (const file of files) {
    const fullPath = join(resolved, file);
    try {
      const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as Partial<ReplayCacheEntry>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.actions)) continue;
      entries.push({
        key: parsed.key ?? file.replace(/\.json$/, ""),
        filePath: fullPath,
        flowName: parsed.flowName ?? "(unknown)",
        platform: parsed.platform ?? "(unknown)",
        goal: parsed.goal ?? "",
        actionCount: parsed.actions.length,
        recordedAt: parsed.recordedAt ?? "",
        verifiedBy: parsed.verifiedBy ?? "",
      });
    } catch {
      // Ignore malformed cache entries during inspection
    }
  }

  return {
    cacheDir: resolved,
    exists: true,
    entryCount: entries.length,
    entries,
  };
}

/** Clear all (or matching) replay cache entries from `cacheDir`. */
export function clearReplayCache(
  cacheDir = ".spana/cache",
  opts?: { match?: string },
): CacheClearResult {
  const inspected = inspectReplayCache(cacheDir);
  const removedKeys: string[] = [];

  for (const entry of inspected.entries) {
    if (opts?.match) {
      const needle = opts.match.toLowerCase();
      const hit =
        entry.key.toLowerCase().includes(needle) ||
        entry.flowName.toLowerCase().includes(needle) ||
        entry.goal.toLowerCase().includes(needle);
      if (!hit) continue;
    }
    rmSync(entry.filePath, { force: true });
    removedKeys.push(entry.key);
  }

  return {
    cacheDir: inspected.cacheDir,
    removedCount: removedKeys.length,
    removedKeys,
  };
}

export function formatCacheInspectTable(result: CacheInspectResult): string {
  if (result.entryCount === 0) {
    return `No verified replay cache entries in ${result.cacheDir}.`;
  }
  const lines = [`Verified replay cache (${result.entryCount} entries in ${result.cacheDir}):`, ""];
  for (const e of result.entries) {
    lines.push(
      `  • [${e.platform}] ${e.flowName} — "${e.goal}" (${e.actionCount} actions, key=${e.key})`,
    );
  }
  return lines.join("\n");
}
