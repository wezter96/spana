import { resolve } from "node:path";

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
    return { file: filePath, error: `Failed to import: ${e instanceof Error ? e.message : String(e)}` };
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
