import { defineConfig } from "./src/schemas/config.js";

export default defineConfig({
  apps: {
    web: { url: "http://127.0.0.1:8081" },
    android: { packageName: "com.wezter96.spana.testapp" },
    ios: { bundleId: "com.wezter96.spana.testapp" },
  },
  defaults: {
    waitTimeout: 5_000,
    pollInterval: 200,
  },
  artifacts: {
    outputDir: "./spana-output",
    captureOnFailure: true,
    captureOnSuccess: false,
    captureSteps: false,
    screenshot: true,
    uiHierarchy: true,
  },
  platforms: ["web", "android", "ios"],
  flowDir: "./flows/framework-app",
  reporters: ["console", "junit", "html"],
});
