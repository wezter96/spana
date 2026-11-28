import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitFlowCommand } from "./init-flow-command.js";
import { isFlowStubPreset, isInitPreset } from "./scaffolds.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "spana-init-flow-")));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runInitFlowCommand", () => {
  test("creates a smoke flow file with default preset", () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "flows", "login-smoke.flow.ts");

    const result = runInitFlowCommand({
      name: "login smoke",
      outputPath,
      platforms: [],
      force: false,
    });

    expect(result).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain("flow(");
    expect(content).toContain('"login smoke"');
    expect(content).toContain('tags: ["smoke"]');
    expect(content).toContain("toBeVisible");
  });

  test("creates a flow at custom output path", () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "flows", "checkout-flow.flow.ts");

    const result = runInitFlowCommand({
      name: "checkout flow",
      outputPath,
      platforms: ["web", "android"],
      tags: ["e2e", "checkout"],
      force: false,
    });

    expect(result).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain('"checkout flow"');
    expect(content).toContain('"web"');
    expect(content).toContain('"android"');
    expect(content).toContain('"e2e"');
    expect(content).toContain('"checkout"');
  });

  test("refuses to overwrite without --force", () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "flows", "checkout-flow.flow.ts");

    runInitFlowCommand({ name: "checkout flow", outputPath, platforms: [], force: false });
    const result = runInitFlowCommand({
      name: "checkout flow",
      outputPath,
      platforms: [],
      force: false,
    });

    expect(result).toBe(false);
  });

  test("overwrites with --force", () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "flows", "checkout-flow.flow.ts");

    runInitFlowCommand({ name: "first", outputPath, platforms: [], force: false });
    const result = runInitFlowCommand({ name: "second", outputPath, platforms: [], force: true });

    expect(result).toBe(true);
    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain('"second"');
  });

  test("generates blank preset", () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "blank.flow.ts");

    runInitFlowCommand({
      name: "empty test",
      outputPath,
      platforms: [],
      preset: "blank",
      force: false,
    });

    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain("Write your test flow here");
    expect(content).not.toContain("toBeVisible");
  });

  test("generates auth preset", () => {
    const tempDir = createTempDir();
    const outputPath = join(tempDir, "auth.flow.ts");

    runInitFlowCommand({
      name: "login test",
      outputPath,
      platforms: ["web"],
      preset: "auth",
      force: false,
    });

    const content = readFileSync(outputPath, "utf8");
    expect(content).toContain("login-email-input");
    expect(content).toContain("login-password-input");
    expect(content).toContain("login-submit-button");
    expect(content).toContain("home-screen");
  });
});

describe("scaffolds", () => {
  test("isFlowStubPreset validates correctly", () => {
    expect(isFlowStubPreset("blank")).toBe(true);
    expect(isFlowStubPreset("smoke")).toBe(true);
    expect(isFlowStubPreset("auth")).toBe(true);
    expect(isFlowStubPreset("unknown")).toBe(false);
  });

  test("isInitPreset validates correctly", () => {
    expect(isInitPreset("local-web")).toBe(true);
    expect(isInitPreset("browserstack")).toBe(true);
    expect(isInitPreset("unknown")).toBe(false);
  });
});
