import vararPlugin from "@varar/vitest";
import { VararResultsReporter } from "@varar/vitest/reporter";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [vararPlugin()],
  test: {
    globalSetup: ["./global-setup.ts"],
    testTimeout: 30_000,
    reporters: ["default", new VararResultsReporter()],
  },
});
