import { defineConfig } from "../../../packages/spana/dist/index.js";

const primaryPort = Number(process.env.STRESS_PORT || 4410);

export default defineConfig({
  flowDir: "./app",
  platforms: ["web"],
  apps: {
    web: {
      url: `http://127.0.0.1:${primaryPort}`,
    },
  },
  execution: {
    web: {
      engine: "cdp",
      headless: true,
      contextIsolation: "fresh",
      warmBrowser: false,
    },
  },
  projects: [
    {
      name: "setup",
      flowDir: "./setup",
      testMatch: ["auth.setup"],
    },
    {
      name: "authed-app",
      flowDir: "./app",
      dependencies: ["setup"],
      storageState: "./.auth-state.json",
    },
  ],
  defaults: {
    waitTimeout: 10_000,
    retries: 0,
  },
  artifacts: {
    outputDir: "./.stress-projects-output",
  },
});
