import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Reporter } from "./types.js";

export interface JsonReporterOptions {
  /** Output writer (defaults to console.log). */
  write?: (line: string) => void;
}

export function createJsonReporter(outputPath?: string, options?: JsonReporterOptions): Reporter {
  const write = options?.write ?? ((line: string) => console.log(line));
  return {
    onFlowPass(result) {
      if (!outputPath) {
        write(JSON.stringify({ event: "flowPass", ...result }));
      }
    },

    onFlowFail(result) {
      if (!outputPath) {
        write(JSON.stringify({ event: "flowFail", ...result }));
      }
    },

    onFlowSkip(result) {
      if (!outputPath) {
        write(JSON.stringify({ event: "flowSkip", ...result }));
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
        write(`JSON report written to ${outputPath}`);
        return;
      }
      write(JSON.stringify({ event: "runComplete", ...summary }));
    },
  };
}
