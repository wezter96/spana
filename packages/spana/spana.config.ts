import { defineConfig } from "./src/schemas/config.js";

export default defineConfig({
  apps: {
    web: { url: "http://127.0.0.1:8081" },
    android: { packageName: "com.anonymous.mybettertapp" },
    ios: { bundleId: "com.anonymous.mybettertapp" },
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
