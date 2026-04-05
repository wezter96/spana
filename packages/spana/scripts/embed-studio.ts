// packages/spana/scripts/embed-studio.ts
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const studioDistSrc = resolve(import.meta.dirname, "../../../apps/studio/dist");
const studioDistDest = resolve(import.meta.dirname, "../studio-dist");

if (!existsSync(studioDistSrc)) {
  console.log("⚠ apps/studio/dist not found — skipping studio embed. Build apps/studio first.");
  process.exit(0);
}

if (existsSync(studioDistDest)) {
  rmSync(studioDistDest, { recursive: true });
}

cpSync(studioDistSrc, studioDistDest, { recursive: true });
console.log("✓ Studio frontend embedded into packages/spana/studio-dist/");
