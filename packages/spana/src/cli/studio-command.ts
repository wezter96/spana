import type { ProvConfig } from "../schemas/config.js";

export interface StudioCliOptions {
  port: number;
  open: boolean;
  config: ProvConfig;
}

export async function runStudioCommand(options: StudioCliOptions) {
  const { startStudio } = await import("../studio/server.js");

  const staticDir = new URL("../../studio-dist", import.meta.url).pathname;
  const { existsSync } = await import("node:fs");

  await startStudio({
    port: options.port,
    open: options.open,
    config: options.config,
    staticDir: existsSync(staticDir) ? staticDir : undefined,
  });

  // Keep process alive
  await new Promise(() => {});
}
