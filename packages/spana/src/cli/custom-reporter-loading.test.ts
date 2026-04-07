import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { loadCustomReporter } from "./test-command.js";

const tmpDir = resolve(import.meta.dir, "__test-reporters__");

function setup() {
  mkdirSync(tmpDir, { recursive: true });
}

function cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

describe("custom reporter loading", () => {
  test("loads a reporter object from a module path", async () => {
    setup();
    const reporterPath = resolve(tmpDir, "object-reporter.ts");
    writeFileSync(reporterPath, `export default { onRunComplete(summary) { /* noop */ } };`);

    const reporter = await loadCustomReporter(reporterPath, tmpDir);
    expect(reporter).toBeDefined();
    expect(typeof reporter.onRunComplete).toBe("function");
    cleanup();
  });

  test("loads a reporter factory function from a module path", async () => {
    setup();
    const reporterPath = resolve(tmpDir, "factory-reporter.ts");
    writeFileSync(
      reporterPath,
      `export default function(opts) { return { onRunComplete(summary) {} }; };`,
    );

    const reporter = await loadCustomReporter(reporterPath, tmpDir);
    expect(reporter).toBeDefined();
    expect(typeof reporter.onRunComplete).toBe("function");
    cleanup();
  });

  test("throws on missing module", async () => {
    await expect(loadCustomReporter("./nonexistent-reporter.ts", "/tmp")).rejects.toThrow();
  });

  test("throws on module with no default export", async () => {
    setup();
    const reporterPath = resolve(tmpDir, "bad-reporter.ts");
    writeFileSync(reporterPath, `export const foo = 42;`);

    await expect(loadCustomReporter(reporterPath, tmpDir)).rejects.toThrow(/default export/);
    cleanup();
  });
});
