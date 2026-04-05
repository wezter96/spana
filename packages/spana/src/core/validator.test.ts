import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFlowFile, validateFlows } from "./validator.js";

const tempDir = mkdtempSync(join(tmpdir(), "spana-validator-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTempModule(fileName: string, content: string) {
  const path = join(tempDir, fileName);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("validator", () => {
  test("accepts a valid flow module", async () => {
    const filePath = writeTempModule(
      "valid.flow.ts",
      'export default { name: "valid", config: {}, fn: async () => {} };',
    );

    await expect(validateFlowFile(filePath)).resolves.toBeNull();
  });

  test("reports modules without a default export", async () => {
    const filePath = writeTempModule("missing-default.flow.ts", "export const nope = true;");

    await expect(validateFlowFile(filePath)).resolves.toEqual({
      file: filePath,
      error: "No default export found",
    });
  });

  test("reports invalid default exports and collects errors across files", async () => {
    const invalidPath = writeTempModule(
      "invalid.flow.ts",
      'export default { name: "invalid", config: {} };',
    );
    const missingPath = join(tempDir, "does-not-exist.flow.ts");

    const errors = await validateFlows([invalidPath, missingPath]);

    expect(errors[0]).toEqual({
      file: invalidPath,
      error: "Invalid flow definition: missing name or fn",
    });
    expect(errors[1]?.file).toBe(missingPath);
    expect(errors[1]?.error).toContain("Failed to import");
  });
});
