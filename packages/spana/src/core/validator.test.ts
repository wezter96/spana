import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalRegistry } from "../gherkin/registry.js";
import { validateFlowFile, validateFlows, validateProject } from "./validator.js";

const tempDir = mkdtempSync(join(tmpdir(), "spana-validator-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

afterEach(() => {
  globalRegistry.clear();
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

describe("validateProject", () => {
  test("warns when flow directory has no flow files", async () => {
    const emptyDir = join(tempDir, "empty-flows");
    mkdirSync(emptyDir, { recursive: true });

    const errors = await validateProject(emptyDir);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe("No flow files found");
  });

  test("warns when flow directory does not exist", async () => {
    const errors = await validateProject(join(tempDir, "nonexistent-dir"));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe("Flow directory does not exist");
  });

  test("detects duplicate flow names", async () => {
    const dupeDir = join(tempDir, "dupes");
    mkdirSync(dupeDir, { recursive: true });
    writeFileSync(
      join(dupeDir, "a.flow.ts"),
      'export default { name: "login", config: {}, fn: async () => {} };',
    );
    writeFileSync(
      join(dupeDir, "b.flow.ts"),
      'export default { name: "login", config: {}, fn: async () => {} };',
    );

    const errors = await validateProject(dupeDir);
    const dupeErrors = errors.filter((e) => e.error.includes("Duplicate flow name"));

    expect(dupeErrors).toHaveLength(1);
    expect(dupeErrors[0]!.error).toContain('Duplicate flow name "login"');
  });

  test("detects invalid platform values", async () => {
    const platDir = join(tempDir, "bad-platform");
    mkdirSync(platDir, { recursive: true });
    writeFileSync(
      join(platDir, "plat.flow.ts"),
      'export default { name: "plat-test", config: { platforms: ["web", "windows"] }, fn: async () => {} };',
    );

    const errors = await validateProject(platDir);
    const platErrors = errors.filter((e) => e.error.includes("Invalid platform"));

    expect(platErrors).toHaveLength(1);
    expect(platErrors[0]!.error).toContain('Invalid platform "windows"');
  });

  test("returns no errors for valid flows", async () => {
    const goodDir = join(tempDir, "good-flows");
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(
      join(goodDir, "one.flow.ts"),
      'export default { name: "one", config: { platforms: ["web", "ios"] }, fn: async () => {} };',
    );
    writeFileSync(
      join(goodDir, "two.flow.ts"),
      'export default { name: "two", config: { platforms: ["android"] }, fn: async () => {} };',
    );

    const errors = await validateProject(goodDir);

    expect(errors).toHaveLength(0);
  });

  test("accepts feature files when matching step definitions are present", async () => {
    const featureDir = join(tempDir, "feature-flows");
    const stepsDir = join(featureDir, "steps");
    mkdirSync(stepsDir, { recursive: true });

    const stepsImportPath = join(process.cwd(), "packages/spana/src/gherkin/steps.js");
    writeFileSync(
      join(stepsDir, "demo.steps.ts"),
      `
        import { Given, When, Then } from "${stepsImportPath}";

        Given("the demo app is ready", async () => {});
        When("I open the showcase screen", async () => {});
        Then("I see the showcase content", async () => {});
      `,
    );

    writeFileSync(
      join(featureDir, "demo.feature"),
      `
        Feature: Demo validation

          Scenario: Showcase path compiles
            Given the demo app is ready
            When I open the showcase screen
            Then I see the showcase content
      `,
    );

    const errors = await validateProject(featureDir);

    expect(errors).toHaveLength(0);
  });
});
