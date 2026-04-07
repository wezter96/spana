import { z } from "zod";
import { resolve } from "node:path";
import { publicProcedure } from "../procedures.js";
import {
  discoverFlows,
  loadTestSource,
  filterFlows,
  discoverStepFiles,
  loadStepFiles,
} from "../../core/runner.js";
import type { FlowResult, RunSummary } from "../../report/types.js";
import type { Platform } from "../../schemas/selector.js";
import type { FlowDefinition } from "../../api/flow.js";
import type { ChildProcess } from "node:child_process";

// Convert attachment paths to serve via /artifacts/ endpoint
// Paths can be relative (spana-output/X/file.png) or absolute (/tmp/.../spana-output/X/file.png)
const mapAttachments = (atts?: any[]) =>
  atts
    ?.filter((a: any) => a.contentType === "image/png")
    .map((a: any) => {
      // Extract the part after the output directory name
      const match = a.path.match(/spana-output\/(.+)$/);
      const relativePath = match ? match[1] : a.path;
      return {
        name: a.name,
        contentType: a.contentType,
        path: a.path,
        url: `/artifacts/${relativePath}`,
      };
    }) ?? [];

// ---------------------------------------------------------------------------
// Active child process tracking (for cleanup on shutdown)
// ---------------------------------------------------------------------------

const activeChildren = new Set<ChildProcess>();

export function killActiveChildren() {
  for (const child of activeChildren) {
    child.kill("SIGTERM");
  }
  activeChildren.clear();
}

// ---------------------------------------------------------------------------
// In-memory run tracking
// ---------------------------------------------------------------------------

interface ActiveRun {
  id: string;
  status: "running" | "completed";
  results: FlowResult[];
  summary?: RunSummary;
}

const activeRuns = new Map<string, ActiveRun>();

let runCounter = 0;
function nextRunId(): string {
  runCounter += 1;
  return `run-${Date.now()}-${runCounter}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const platformEnum = z.enum(["web", "android", "ios"]);

async function discoverAndLoad(flowDir: string): Promise<FlowDefinition[]> {
  const dir = resolve(flowDir);

  // Flow files import from the spana source package, which requires bun/tsx to load.
  // Use bun subprocess to discover and serialize flow metadata.
  try {
    const { execSync } = await import("node:child_process");
    const script = `
      import { discoverFlows, loadTestSource } from '${resolve(dir, "../../src/core/runner.ts")}';
      const paths = await discoverFlows('${dir}');
      const flows = [];
      for (const p of paths) {
        try {
          const loaded = await loadTestSource(p);
          flows.push(...loaded.map(f => ({ name: f.name, tags: f.config.tags ?? [], platforms: f.config.platforms ?? [] })));
        } catch {}
      }
      console.log(JSON.stringify(flows));
    `;
    const json = execSync(`bun -e "${script.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 15_000,
      cwd: dir,
    }).trim();
    const metadata = JSON.parse(json) as Array<{
      name: string;
      tags: string[];
      platforms: string[];
    }>;
    // Return as minimal FlowDefinitions (metadata only — enough for listing)
    return metadata.map((m) => ({
      name: m.name,
      fn: async () => {},
      config: { tags: m.tags, platforms: m.platforms as Platform[] },
    }));
  } catch {
    // Fallback: try direct import (works under Bun runtime)
    const flowPaths = await discoverFlows(dir);
    const hasFeature = flowPaths.some((p) => p.endsWith(".feature"));
    if (hasFeature) {
      const stepPaths = await discoverStepFiles(dir);
      if (stepPaths.length > 0) {
        await loadStepFiles(stepPaths);
      }
    }
    const flows: FlowDefinition[] = [];
    for (const p of flowPaths) {
      const loaded = await loadTestSource(p);
      flows.push(...loaded);
    }
    return flows;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const testsRouter = {
  /** Discover flows and return metadata */
  listFlows: publicProcedure
    .input(
      z
        .object({
          flowDir: z.string().optional(),
          tags: z.array(z.string()).optional(),
          platforms: z.array(platformEnum).optional(),
          grep: z.string().optional(),
        })
        .optional(),
    )
    .handler(async ({ input, context }) => {
      const flowDir = input?.flowDir ?? context.config.flowDir ?? "./flows";
      let flows: FlowDefinition[];
      try {
        flows = await discoverAndLoad(flowDir);
      } catch (err) {
        console.error("[studio] Failed to discover flows:", err);
        return { flows: [] };
      }

      if (flows.length === 0) return { flows: [] };

      const filtered = filterFlows(flows, {
        tags: input?.tags,
        grep: input?.grep,
        platforms: input?.platforms as Platform[] | undefined,
      });

      return {
        flows: filtered.map((f) => ({
          name: f.name,
          tags: f.config.tags ?? [],
          platforms: f.config.platforms ?? [],
        })),
      };
    }),

  /** Start a test run in the background, return a run ID */
  run: publicProcedure
    .input(
      z.object({
        platforms: z.array(platformEnum).min(1),
        flowDir: z.string().optional(),
        tags: z.array(z.string()).optional(),
        grep: z.string().optional(),
        captureScreenshots: z.boolean().optional(),
        captureSteps: z.boolean().optional(),
        devices: z
          .array(z.object({ platform: platformEnum, deviceId: z.string().optional() }))
          .optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const runId = nextRunId();
      const run: ActiveRun = { id: runId, status: "running", results: [] };
      activeRuns.set(runId, run);

      // Fire-and-forget: run tests via bun subprocess (Node can't import .ts drivers)
      void (async () => {
        const platforms = input.platforms as Platform[];
        const flowDir = input.flowDir ?? context.config.flowDir ?? "./flows";
        try {
          const { spawn } = await import("node:child_process");

          // Use the same CLI entry point that's currently running
          const cliPath = resolve(process.argv[1]!);

          const args = [
            cliPath,
            "test",
            flowDir,
            "--platform",
            platforms.join(","),
            "--reporter",
            "json",
          ];
          if (input.grep) {
            args.push("--grep", input.grep);
          }
          if (input.tags && input.tags.length > 0) {
            args.push("--tag", input.tags.join(","));
          }
          if (input.devices && input.devices.length > 0) {
            for (const d of input.devices) {
              if (d.deviceId) {
                args.push("--device", d.deviceId);
              }
            }
          }

          // Create temp config with capture overrides if requested
          let tmpConfig: string | undefined;
          if (input.captureScreenshots || input.captureSteps) {
            const { writeFileSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            tmpConfig = resolve(tmpdir(), `spana-studio-${runId}.config.js`);
            const originalConfig = context.config;
            const configObj = {
              ...originalConfig,
              artifacts: {
                ...originalConfig.artifacts,
                captureOnSuccess: input.captureScreenshots ?? false,
                captureOnFailure: true,
                captureSteps: input.captureSteps ?? false,
                screenshot: true,
                uiHierarchy: true,
              },
            };
            writeFileSync(tmpConfig, `export default ${JSON.stringify(configObj)};`);
            args.push("--config", tmpConfig);
          }

          const child = spawn("bun", args, {
            cwd: resolve("."),
            stdio: ["ignore", "pipe", "pipe"],
          });
          activeChildren.add(child);
          child.on("close", () => activeChildren.delete(child));

          child.stderr.on("data", (chunk: Buffer) => {
            const msg = chunk.toString().trim();
            if (msg) console.log("[studio:test]", msg);
          });

          let stdout = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            // Parse streaming JSON events line by line
            const lines = stdout.split("\n");
            stdout = lines.pop() ?? ""; // keep incomplete last line
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);
                if (event.event === "flowPass" || event.event === "flowFail") {
                  run.results.push({
                    name: event.name,
                    platform: event.platform,
                    status: event.status,
                    durationMs: event.durationMs,
                    error: event.error,
                    steps: event.steps?.map((s: any) => ({
                      ...s,
                      attachments: mapAttachments(s.attachments),
                    })),
                    attachments: mapAttachments(event.attachments),
                  });
                }
                if (event.event === "runComplete") {
                  run.summary = {
                    total: event.total,
                    passed: event.passed,
                    failed: event.failed,
                    skipped: event.skipped,
                    flaky: event.flaky ?? 0,
                    durationMs: event.durationMs,
                    results: run.results,
                    platforms,
                  };
                }
              } catch {
                // not JSON, skip
              }
            }
          });

          child.on("close", (code) => {
            if (code !== 0) {
              console.error("[studio:test] Process exited with code", code);
            }
            // Clean up temp config
            if (tmpConfig) {
              try {
                const { unlinkSync } = require("node:fs") as typeof import("node:fs");
                unlinkSync(tmpConfig);
              } catch {}
            }
            run.status = "completed";
            if (!run.summary) {
              run.summary = {
                total: run.results.length,
                passed: run.results.filter((r) => r.status === "passed").length,
                failed: run.results.filter((r) => r.status === "failed").length,
                skipped: run.results.filter((r) => r.status === "skipped").length,
                flaky: 0,
                durationMs: 0,
                results: run.results,
                platforms,
              };
            }
          });
        } catch (err: any) {
          console.error("[studio] Failed to start test run:", err?.message ?? err, err?.stack);
          run.status = "completed";
          run.summary = {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            flaky: 0,
            durationMs: 0,
            results: [],
            platforms,
          };
        }
      })();

      return { runId };
    }),

  /** Poll for run progress */
  status: publicProcedure.input(z.object({ runId: z.string() })).handler(({ input }) => {
    const run = activeRuns.get(input.runId);
    if (!run) {
      return { status: "not_found" as const, results: [] };
    }
    return {
      status: run.status,
      results: run.results,
      summary: run.summary,
    };
  }),

  /** Get final results for a completed run */
  results: publicProcedure.input(z.object({ runId: z.string() })).handler(({ input }) => {
    const run = activeRuns.get(input.runId);
    if (!run || run.status !== "completed") {
      return null;
    }
    return run.summary ?? null;
  }),
};
