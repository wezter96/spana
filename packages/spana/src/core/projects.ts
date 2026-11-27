import type { FlowDefinition } from "../api/flow.js";
import type {
  BrowserName,
  HttpCredentialsConfig,
  WebDeviceConfig,
  WebExecutionConfig,
  WebViewportConfig,
} from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";

export interface ProjectConfig {
  /** Unique project identifier (e.g. `"setup"`, `"chromium"`, `"mobile-safari"`, `"api"`). */
  name: string;
  /** Optional target platform override for this project. */
  platform?: Platform;
  /** Optional browser override when running on `"web"`. */
  browser?: BrowserName;
  /** Optional base URL override for web flows in this project. */
  baseUrl?: string;
  /** Optional storageState JSON file path loaded by flows in this project. */
  storageState?: string;
  /** Optional flow directory override relative to config file. */
  flowDir?: string;
  /** Only include flow files matching any of these substrings/globs/RegExps. */
  testMatch?: Array<string | RegExp>;
  /** Exclude flow files matching any of these substrings/globs/RegExps. */
  testIgnore?: Array<string | RegExp>;
  /** Only include flows carrying at least one of these tags. */
  tags?: string[];
  /** Optional substring filter against flow names. */
  grep?: string;
  /** Project names that must complete successfully before this project starts. */
  dependencies?: string[];
  /** Optional project name to run after this project completes (teardown). */
  teardown?: string;
  /** Per-project retry override. */
  retries?: number;
  /** Optional web execution overrides (e.g. headless, engine, colorScheme, viewport, userAgent, mobile/touch, httpCredentials). */
  use?: Partial<WebExecutionConfig> & {
    viewport?: WebViewportConfig;
    locale?: string;
    timezoneId?: string;
    userAgent?: string;
    deviceScaleFactor?: number;
    mobile?: boolean;
    isMobile?: boolean;
    hasTouch?: boolean;
    httpCredentials?: HttpCredentialsConfig;
    device?: WebDeviceConfig;
  };
}

export interface ProjectExecutionPlan {
  /** Projects grouped into topological waves; projects in the same wave can run in parallel. */
  waves: ProjectConfig[][];
  /** Flat execution order respecting all `dependencies`. */
  ordered: ProjectConfig[];
  /** Teardown projects paired with the projects that declared them. */
  teardowns: ProjectConfig[];
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**/", "\0GLOBSTAR_SLASH\0")
    .replaceAll("**", "\0GLOBSTAR\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", ".")
    .replaceAll("\0GLOBSTAR_SLASH\0", "(?:.*/)?")
    .replaceAll("\0GLOBSTAR\0", ".*");
  return new RegExp(`(?:^|/)${escaped}$`, "i");
}

function matchesPattern(target: string, pattern: string | RegExp): boolean {
  const normalized = target.replaceAll("\\", "/");
  if (pattern instanceof RegExp) return pattern.test(normalized);
  if (pattern.includes("*") || pattern.includes("?")) {
    return globToRegExp(pattern).test(normalized);
  }
  return normalized.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Filter a list of loaded flows according to a `ProjectConfig`'s `testMatch`, `testIgnore`,
 * `tags`, `grep`, and `platform` constraints.
 */
export function filterFlowsForProject(
  flows: FlowDefinition[],
  project: ProjectConfig,
): FlowDefinition[] {
  return flows.filter((flowDef) => {
    const candidatePath = flowDef.sourcePath ?? flowDef.name;
    if (project.testMatch && project.testMatch.length > 0) {
      if (!project.testMatch.some((p) => matchesPattern(candidatePath, p))) {
        return false;
      }
    }
    if (project.testIgnore && project.testIgnore.length > 0) {
      if (project.testIgnore.some((p) => matchesPattern(candidatePath, p))) {
        return false;
      }
    }
    if (project.tags && project.tags.length > 0) {
      const flowTags = flowDef.config.tags ?? [];
      if (!project.tags.some((t) => flowTags.includes(t))) {
        return false;
      }
    }
    if (project.grep) {
      if (!flowDef.name.toLowerCase().includes(project.grep.toLowerCase())) {
        return false;
      }
    }
    if (project.platform && flowDef.config.platforms && flowDef.config.platforms.length > 0) {
      if (!flowDef.config.platforms.includes(project.platform)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Resolve named projects into topological execution waves, expanding `--project` selections
 * to include all transitive `dependencies` and collecting any declared `teardown` projects.
 * Throws a clear error on duplicate project names, missing dependencies, or dependency cycles.
 */
export function resolveProjectExecutionPlan(
  projects: ProjectConfig[],
  selectedNames?: string[],
): ProjectExecutionPlan {
  const byName = new Map<string, ProjectConfig>();
  for (const proj of projects) {
    if (!proj.name || proj.name.trim().length === 0) {
      throw new Error("Project name must be a non-empty string.");
    }
    if (byName.has(proj.name)) {
      throw new Error(`Duplicate project name "${proj.name}" in spana config.`);
    }
    byName.set(proj.name, proj);
  }

  // Validate all references up front
  for (const proj of projects) {
    for (const dep of proj.dependencies ?? []) {
      if (!byName.has(dep)) {
        throw new Error(`Project "${proj.name}" depends on unknown project "${dep}".`);
      }
    }
    if (proj.teardown && !byName.has(proj.teardown)) {
      throw new Error(
        `Project "${proj.name}" references unknown teardown project "${proj.teardown}".`,
      );
    }
  }

  const teardownNames = new Set<string>();
  for (const proj of projects) {
    if (proj.teardown) teardownNames.add(proj.teardown);
  }

  // Determine active projects (expanding transitive dependencies when selectedNames is provided)
  const activeNames = new Set<string>();
  if (selectedNames && selectedNames.length > 0) {
    const queue = [...selectedNames];
    while (queue.length > 0) {
      const name = queue.shift()!;
      const proj = byName.get(name);
      if (!proj) {
        const available = projects.map((p) => p.name).join(", ");
        throw new Error(
          `Unknown --project "${name}". Available projects: ${available || "(none)"}.`,
        );
      }
      if (activeNames.has(name)) continue;
      activeNames.add(name);
      for (const dep of proj.dependencies ?? []) {
        if (!activeNames.has(dep)) queue.push(dep);
      }
    }
  } else {
    for (const proj of projects) {
      // Teardown projects run in the teardown phase rather than the main wave graph
      if (!teardownNames.has(proj.name)) {
        activeNames.add(proj.name);
      }
    }
  }

  // Kahn's algorithm grouped by waves for deterministic topological execution
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of activeNames) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const name of activeNames) {
    const proj = byName.get(name)!;
    for (const dep of proj.dependencies ?? []) {
      if (!activeNames.has(dep)) continue;
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      dependents.get(dep)!.push(name);
    }
  }

  const waves: ProjectConfig[][] = [];
  const ordered: ProjectConfig[] = [];
  let ready = [...activeNames].filter((name) => (inDegree.get(name) ?? 0) === 0);

  while (ready.length > 0) {
    const waveProjects = ready.map((name) => byName.get(name)!);
    waves.push(waveProjects);
    ordered.push(...waveProjects);

    const nextReady: string[] = [];
    for (const name of ready) {
      for (const child of dependents.get(name) ?? []) {
        const remaining = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, remaining);
        if (remaining === 0) {
          nextReady.push(child);
        }
      }
    }
    ready = nextReady;
  }

  if (ordered.length !== activeNames.size) {
    const stuck = [...activeNames].filter((n) => !ordered.some((p) => p.name === n));
    throw new Error(`Circular project dependency detected involving: ${stuck.join(", ")}.`);
  }

  const teardowns: ProjectConfig[] = [];
  const seenTeardowns = new Set<string>();
  for (const proj of ordered) {
    if (proj.teardown && !seenTeardowns.has(proj.teardown)) {
      seenTeardowns.add(proj.teardown);
      teardowns.push(byName.get(proj.teardown)!);
    }
  }

  return { waves, ordered, teardowns };
}
