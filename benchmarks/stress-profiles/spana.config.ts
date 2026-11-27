import { defineConfig } from "../../packages/spana/dist/index.js";

const primaryPort = Number(process.env.STRESS_PORT || 4410);
const isolation = (process.env.STRESS_ISOLATION as "fresh" | "hot-cache" | undefined) || "fresh";
const engine = (process.env.STRESS_ENGINE as "cdp" | "playwright" | undefined) || "cdp";

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
      engine,
      headless: true,
      contextIsolation: isolation,
      warmBrowser: false,
      viewport: { width: 1280, height: 800 },
    },
  },
  defaults: {
    waitTimeout: 10_000,
    retries: 0,
  },
  artifacts: {
    outputDir: "./.stress-output",
    screenshot: true,
  },
});
