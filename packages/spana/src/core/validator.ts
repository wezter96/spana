import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { discoverFlows, discoverStepFiles, loadStepFiles, loadTestSource } from "./runner.js";

export interface ValidationError {
  file: string;
  error: string;
}

export async function validateFlowFile(filePath: string): Promise<ValidationError | null> {
  try {
    const absolutePath = resolve(filePath);
    const mod = await import(absolutePath);
    if (!mod.default) {
      return { file: filePath, error: "No default export found" };
    }
    const def = mod.default;
    if (!def.name || typeof def.fn !== "function") {
      return { file: filePath, error: "Invalid flow definition: missing name or fn" };
    }
    return null;
  } catch (e) {
    return {
      file: filePath,
      error: `Failed to import: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function validateFlows(paths: string[]): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  for (const path of paths) {
    const err = await validateFlowFile(path);
    if (err) errors.push(err);
  }
  return errors;
}

const VALID_PLATFORMS = new Set(["web", "android", "ios"]);

export async function validateProject(flowDir: string): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  // Check flow directory exists and has flows
  let paths: string[];
  try {
    paths = await discoverFlows(flowDir);
  } catch {
    errors.push({ file: flowDir, error: "Flow directory does not exist" });
    return errors;
  }

  if (paths.length === 0) {
    errors.push({ file: flowDir, error: "No flow files found" });
    return errors;
  }

  const hasFeatureFiles = paths.some((path) => path.endsWith(".feature"));
  if (hasFeatureFiles) {
    const flowDirStats = await stat(resolve(flowDir)).catch(() => null);
    const stepSearchDir = flowDirStats?.isDirectory() ? flowDir : dirname(flowDir);
    const stepPaths = await discoverStepFiles(stepSearchDir);
    if (stepPaths.length > 0) {
      try {
        await loadStepFiles(stepPaths);
      } catch (e) {
        errors.push({
          file: flowDir,
          error: `Failed to load step definitions: ${e instanceof Error ? e.message : String(e)}`,
        });
        return errors;
      }
    }
  }

  // Load flows and check for duplicates + invalid platforms
  const flowNames = new Map<string, string>(); // name -> file

  for (const p of paths) {
    try {
      const defs = await loadTestSource(p);
      for (const def of defs) {
        if (!def?.name || typeof def.fn !== "function") {
          errors.push({ file: p, error: "Invalid flow definition: missing name or fn" });
          continue;
        }

        const existing = flowNames.get(def.name);
        if (existing) {
          errors.push({
            file: p,
            error: `Duplicate flow name "${def.name}" (also in ${existing})`,
          });
        } else {
          flowNames.set(def.name, p);
        }

        if (def.config?.platforms) {
          for (const plat of def.config.platforms) {
            if (!VALID_PLATFORMS.has(plat)) {
              errors.push({
                file: p,
                error: `Invalid platform "${plat}" - must be web, android, or ios`,
              });
            }
          }
        }
      }
    } catch (e) {
      errors.push({
        file: p,
        error: `Failed to load: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return errors;
}
