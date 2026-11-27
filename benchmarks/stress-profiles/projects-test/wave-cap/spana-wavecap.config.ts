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
    },
  },
  projects: [
    { name: "wave-p1", flowDir: "./flows", grep: "wave-p1" },
    { name: "wave-p2", flowDir: "./flows", grep: "wave-p2" },
    { name: "wave-p3", flowDir: "./flows", grep: "wave-p3" },
    { name: "wave-p4", flowDir: "./flows", grep: "wave-p4" },
    { name: "wave-p5", flowDir: "./flows", grep: "wave-p5" },
  ],
  defaults: {
    waitTimeout: 10_000,
    retries: 0,
  },
  artifacts: {
    outputDir: "./.stress-wavecap-output",
  },
});
