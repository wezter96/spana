import { defineConfig } from "../../../../packages/spana/dist/index.js";

const primaryPort = Number(process.env.STRESS_PORT || 4410);

export default defineConfig({
  flowDir: "./flows",
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
      contextIsolation: "hot-cache",
      warmBrowser: false,
      maxContextsPerBrowser: 4,
    },
  },
  projects: [
    { name: "small-1", flowDir: "./flows", grep: "small-1" },
    { name: "small-2", flowDir: "./flows", grep: "small-2" },
    { name: "small-3", flowDir: "./flows", grep: "small-3" },
    { name: "small-4", flowDir: "./flows", grep: "small-4" },
    { name: "large-20", flowDir: "./flows", grep: "large-20-" },
  ],
  defaults: {
    waitTimeout: 10_000,
    retries: 0,
  },
  artifacts: {
    outputDir: "./.stress-wave-unbalanced-output",
  },
});
