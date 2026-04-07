import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const tmpDir = resolve(import.meta.dir, "__test-providers__");

describe("custom cloud provider loading", () => {
  test("loads a custom cloud provider from module path", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const providerPath = resolve(tmpDir, "test-provider.ts");
    writeFileSync(
      providerPath,
      `export default {
        name() { return "test-cloud"; },
        createHelper(url, config) { return { prepareCapabilities: async (p, c) => c, cleanup: async () => {} }; },
        extractMeta(sessionId, caps, meta) {},
        async reportResult(url, meta, result) {},
      };`,
    );

    // Dynamically import the module to verify it works
    const mod = await import(providerPath);
    expect(mod.default.name()).toBe("test-cloud");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
