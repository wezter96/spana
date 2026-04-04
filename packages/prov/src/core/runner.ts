import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FlowDefinition, FlowConfig } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";

export interface DiscoverOptions {
  tags?: string[];
  grep?: string;
  platforms?: Platform[];
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
      } else if (entry.name.endsWith(".flow.ts") || entry.name.endsWith(".test.ts")) {
        results.push(fullPath);
      }
    }
  }

  await walk(absolute);
  return results.sort();
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
    return true;
  });
}
