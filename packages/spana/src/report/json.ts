import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Reporter } from "./types.js";

export function createJsonReporter(outputPath?: string): Reporter {
  return {
    onFlowPass(result) {
      if (!outputPath) {
        console.log(JSON.stringify({ event: "flowPass", ...result }));
      }
    },

    onFlowFail(result) {
      if (!outputPath) {
        console.log(JSON.stringify({ event: "flowFail", ...result }));
      }
    },

    onFlowSkip(result) {
      if (!outputPath) {
        console.log(JSON.stringify({ event: "flowSkip", ...result }));
      }
    },

    onRunComplete(summary) {
      if (outputPath) {
        mkdirSync(dirname(outputPath), { recursive: true });
        const serializable = {
          ...summary,
          workerStats: summary.workerStats
            ? Object.fromEntries(summary.workerStats.entries())
            : undefined,
        };
        writeFileSync(outputPath, JSON.stringify(serializable, null, 2), "utf-8");
        console.log(`JSON report written to ${outputPath}`);
        return;
      }
      console.log(JSON.stringify({ event: "runComplete", ...summary }));
    },
  };
}
