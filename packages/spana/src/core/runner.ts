import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FlowDefinition, FlowConfig } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";

export interface DiscoverOptions {
  tags?: string[];
  grep?: string;
  platforms?: Platform[];
  /** Glob patterns for step definition files (relative to flowDir). */
  stepFiles?: string[];
}

export interface ShardOptions {
  current: number;
  total: number;
}

export async function loadFlowFile(filePath: string): Promise<FlowDefinition> {
  const absolutePath = resolve(filePath);
  const mod = await import(absolutePath);

  if (!mod.default) {
    throw new Error(`No default export found in ${filePath}`);
  }

  const flowDef = mod.default as FlowDefinition;
  if (!flowDef.name || typeof flowDef.fn !== "function") {
    throw new Error(`Invalid flow definition in ${filePath}`);
  }

  // Merge exported settings if present
  if (mod.settings) {
    Object.assign(flowDef.config, mod.settings as FlowConfig);
  }

  return flowDef;
}

/**
 * Load a test source file and return one or more FlowDefinitions.
 * Handles both native .flow.ts/.test.ts files and .feature files.
 */
export async function loadTestSource(filePath: string): Promise<FlowDefinition[]> {
  const absolutePath = resolve(filePath);

  if (absolutePath.endsWith(".feature")) {
    return loadFeatureFile(absolutePath);
  }

  const flow = await loadFlowFile(absolutePath);
  return [flow];
}

async function loadFeatureFile(filePath: string): Promise<FlowDefinition[]> {
  let compileFeature: typeof import("../gherkin/compiler.js").compileFeature;
  try {
    const mod = await import("../gherkin/compiler.js");
    compileFeature = mod.compileFeature;
  } catch {
    throw new Error(
      `Cannot load .feature files: install @cucumber/gherkin, @cucumber/messages, and @cucumber/cucumber-expressions as dependencies.`,
    );
  }

  const source = await readFile(filePath, "utf-8");
  return compileFeature(source, filePath);
}

/**
 * Load step definition files so their Given/When/Then registrations
 * are available before feature compilation.
 */
export async function loadStepFiles(paths: string[]): Promise<void> {
  for (const p of paths) {
    await import(resolve(p));
  }
}

export async function discoverFlows(pathOrDir: string): Promise<string[]> {
  const absolute = resolve(pathOrDir);
  const stats = await stat(absolute);

  if (!stats.isDirectory()) {
    return [absolute];
  }

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.name.endsWith(".flow.ts") ||
        entry.name.endsWith(".test.ts") ||
        entry.name.endsWith(".feature")
      ) {
        results.push(fullPath);
      }
    }
  }

  await walk(absolute);
  return results.toSorted();
}

/**
 * Discover step definition files within a directory.
 * Looks for files in steps/ directories or matching *.steps.ts pattern.
 */
export async function discoverStepFiles(pathOrDir: string): Promise<string[]> {
  const absolute = resolve(pathOrDir);
  const stats = await stat(absolute).catch(() => null);
  if (!stats?.isDirectory()) return [];

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith(".steps.ts") || dir.includes("/steps")) {
        if (entry.name.endsWith(".ts")) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(absolute);
  return results.toSorted();
}

export function filterFlows(flows: FlowDefinition[], opts: DiscoverOptions): FlowDefinition[] {
  return flows.filter((flow) => {
    if (opts.tags && opts.tags.length > 0) {
      const flowTags = flow.config.tags ?? [];
      if (!opts.tags.some((t) => flowTags.includes(t))) return false;
    }
    if (opts.grep) {
      if (!flow.name.toLowerCase().includes(opts.grep.toLowerCase())) return false;
    }
    if (opts.platforms && opts.platforms.length > 0) {
      const flowPlatforms = flow.config.platforms;
      if (flowPlatforms && !opts.platforms.some((p) => flowPlatforms.includes(p))) return false;
    }
    // Evaluate when conditions
    if (flow.config.when) {
      const when = flow.config.when;

      if (when.platform) {
        const allowedPlatforms = Array.isArray(when.platform) ? when.platform : [when.platform];
        if (opts.platforms && opts.platforms.length > 0) {
          if (!opts.platforms.some((p) => allowedPlatforms.includes(p))) return false;
        }
      }

      if (when.env && !process.env[when.env]) {
        return false;
      }
    }
    return true;
  });
}

export function applyShard<T>(items: T[], shard?: ShardOptions): T[] {
  if (!shard || shard.total === 1 || items.length === 0) {
    return items;
  }

  const itemsPerShard = Math.max(Math.ceil(items.length / shard.total), 1);
  const start = (shard.current - 1) * itemsPerShard;
  const end =
    shard.current === shard.total ? items.length : Math.min(start + itemsPerShard, items.length);

  return items.slice(start, end);
}
