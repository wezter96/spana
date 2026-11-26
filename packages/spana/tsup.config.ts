import { defineConfig } from "tsup";
import { readFileSync, writeFileSync } from "node:fs";

const shared = [
  "effect",
  "playwright-core",
  "@cucumber/gherkin",
  "@cucumber/messages",
  "@cucumber/cucumber-expressions",
];

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "gherkin/steps": "src/gherkin/steps.ts",
    "agent/index": "src/agent/index.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm"],
  dts: {
    entry: {
      index: "src/index.ts",
      "gherkin/steps": "src/gherkin/steps.ts",
      "agent/index": "src/agent/index.ts",
    },
  },
  sourcemap: true,
  clean: true,
  splitting: true,
  shims: true,
  external: shared,
  async onSuccess() {
    // Add shebang to CLI entry
    const cliPath = "dist/cli.js";
    const content = readFileSync(cliPath, "utf-8");
    if (!content.startsWith("#!")) {
      writeFileSync(cliPath, `#!/usr/bin/env node\n${content}`);
    }
  },
});
