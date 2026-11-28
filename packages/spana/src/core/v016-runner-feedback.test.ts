import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { flow } from "../api/flow.js";
import { buildOrderedWorkUnits, orderFlowsLongestFirst, runParallel } from "./parallel.js";
import { orchestrate } from "./orchestrator.js";
import { createRemoteWorkUnitClaimer, startSharedFlowQueueServer } from "./worker-pool.js";
import { createJsonReporter } from "../report/json.js";
import { resolveSpanaCliEntrypoint, runTestCommandWithResult } from "../cli/test-command.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { Element } from "../schemas/element.js";

function makeStubDriver(overrides: Partial<RawDriverService> = {}): RawDriverService {
  const root: Element = {
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    children: [],
  };
  return {
    dumpHierarchy: () => Effect.succeed(JSON.stringify(root)),
    tapAtCoordinate: () => Effect.void,
    doubleTapAtCoordinate: () => Effect.void,
    longPressAtCoordinate: () => Effect.void,
    swipe: () => Effect.void,
    inputText: () => Effect.void,
    pressKey: () => Effect.void,
    hideKeyboard: () => Effect.void,
    takeScreenshot: () => Effect.succeed(new Uint8Array()),
    getDeviceInfo: () =>
      Effect.succeed({
        platform: "web",
        deviceId: "stub",
        name: "Stub",
        isEmulator: true,
        screenWidth: 1280,
        screenHeight: 720,
        driverType: "cdp" as any,
      }),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
    evaluate: () => Effect.succeed(undefined as never),
    ...overrides,
  };
}

describe("v0.16.0 runner, scheduling, reporting & packaging regressions", () => {
  test("1.10: packages/spana/package.json moves effect to peerDependencies and drops sharp & appium optional deps", () => {
    const pkgPath = join(import.meta.dir, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(pkg.version).toMatch(/^0\.(1[6-9]|[2-9]\d)\.\d+/);
    expect(pkg.dependencies?.effect).toBeUndefined();
    expect(pkg.peerDependencies?.effect).toBeDefined();
    expect(pkg.optionalDependencies?.sharp).toBeUndefined();
    expect(pkg.optionalDependencies?.["appium-uiautomator2-server"]).toBeUndefined();
    expect(pkg.optionalDependencies?.["appium-webdriveragent"]).toBeUndefined();
  });

  test("2.5: buildOrderedWorkUnits & orderFlowsLongestFirst preserve serialGroup order with timings and --processes queue", async () => {
    const f1 = flow("serial-1", { serialGroup: "checkout" }, async () => {});
    const f2 = flow("serial-2", { serialGroup: "checkout" }, async () => {});
    const f3 = flow("serial-3", { serialGroup: "checkout" }, async () => {});
    const soloFast = flow("solo-fast", async () => {});
    const soloSlow = flow("solo-slow", async () => {});

    // Intentionally invert hints inside serial group (f3 slowest, f1 fastest)
    const hints = {
      "serial-1": 100,
      "serial-2": 200,
      "serial-3": 500, // total serial unit = 800
      "solo-fast": 50,
      "solo-slow": 1200,
    };

    const units = buildOrderedWorkUnits([f1, f2, f3, soloFast, soloSlow], hints);
    expect(units.map((u) => u.map((f) => f.name))).toEqual([
      ["solo-slow"],
      ["serial-1", "serial-2", "serial-3"],
      ["solo-fast"],
    ]);

    const flat = orderFlowsLongestFirst([f1, f2, f3, soloFast, soloSlow], hints);
    expect(flat.map((f) => f.name)).toEqual([
      "solo-slow",
      "serial-1",
      "serial-2",
      "serial-3",
      "solo-fast",
    ]);

    // Verify shared queue server delivers indivisible units to remote claimer
    const server = await startSharedFlowQueueServer(units.map((u) => u.map((f) => f.name)));
    try {
      const claim = createRemoteWorkUnitClaimer(server.url);
      expect(await claim()).toEqual(["solo-slow"]);
      expect(await claim()).toEqual(["serial-1", "serial-2", "serial-3"]);
      expect(await claim()).toEqual(["solo-fast"]);
      expect(await claim()).toBeNull();
    } finally {
      await server.close();
    }
  });

  test("1.20: parallelIndex includes SPANA_WORKER_INDEX_OFFSET across processes", async () => {
    const prev = process.env.SPANA_WORKER_INDEX_OFFSET;
    process.env.SPANA_WORKER_INDEX_OFFSET = "4";
    try {
      const seen: Array<{ workerIndex: number; parallelIndex: number }> = [];
      const flows = [
        flow("w-1", async ({ workerIndex, parallelIndex }) => {
          seen.push({ workerIndex, parallelIndex });
        }),
        flow("w-2", async ({ workerIndex, parallelIndex }) => {
          seen.push({ workerIndex, parallelIndex });
        }),
      ];
      const baseEngine = {
        appId: "http://localhost:3000",
        platform: "web" as const,
        coordinatorConfig: {
          parse: (r: string) => JSON.parse(r) as Element,
          platform: "web" as const,
        },
        autoLaunch: false,
      };
      await runParallel({
        workers: [
          { id: "w0", name: "w0", driver: makeStubDriver(), engineConfig: baseEngine },
          { id: "w1", name: "w1", driver: makeStubDriver(), engineConfig: baseEngine },
        ],
        flows,
      });
      expect(seen.length).toBe(2);
      for (const item of seen) {
        expect(item.parallelIndex).toBeGreaterThanOrEqual(4);
        expect(item.parallelIndex).toBe(item.workerIndex);
      }
    } finally {
      if (prev === undefined) delete process.env.SPANA_WORKER_INDEX_OFFSET;
      else process.env.SPANA_WORKER_INDEX_OFFSET = prev;
    }
  });

  test("1.21: JSON reporter emits flowSkip event on skipped flows", () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-skip-evt-"));
    try {
      const outPath = join(dir, "events.json");
      const reporter = createJsonReporter(outPath, { write: () => {} });
      const events: string[] = [];
      const stdoutReporter = createJsonReporter(undefined, {
        write: (line) => {
          events.push(line);
        },
      });
      stdoutReporter.onFlowSkip?.({
        name: "skipped-flow",
        platform: "web",
        status: "skipped",
        skipReason: "feature flag off",
        durationMs: 0,
      });
      expect(events.length).toBe(1);
      const parsed = JSON.parse(events[0]!) as { event: string; name: string; status: string };
      expect(parsed.event).toBe("flowSkip");
      expect(parsed.name).toBe("skipped-flow");
      expect(parsed.status).toBe("skipped");

      reporter.onFlowSkip?.({
        name: "skipped-flow",
        platform: "web",
        status: "skipped",
        durationMs: 0,
      });
      reporter.onRunComplete({
        total: 1,
        passed: 0,
        failed: 0,
        skipped: 1,
        flaky: 0,
        durationMs: 1,
        results: [{ name: "skipped-flow", platform: "web", status: "skipped", durationMs: 0 }],
        platforms: ["web"],
      });
      const written = JSON.parse(readFileSync(outPath, "utf8")) as { skipped: number };
      expect(written.skipped).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("3.11: beforeAll and afterAll hooks receive a usable app & expect instance", async () => {
    let beforeHasApp = false;
    let afterHasApp = false;
    let beforeEvaluated = false;

    const driver = makeStubDriver({
      evaluate: () => {
        beforeEvaluated = true;
        return Effect.succeed("ok" as never);
      },
    });

    const res = await orchestrate(
      [flow("simple-pass", async () => {})],
      [
        {
          platform: "web",
          driver,
          engineConfig: {
            appId: "http://localhost:3000",
            platform: "web",
            coordinatorConfig: { parse: (r) => JSON.parse(r) as Element, platform: "web" },
            autoLaunch: false,
            hooks: {
              beforeAll: async (ctx: any) => {
                beforeHasApp = Boolean(
                  ctx.app &&
                  typeof ctx.app.evaluate === "function" &&
                  typeof ctx.expect === "function",
                );
                await ctx.app.evaluate("1");
              },
              afterAll: async (ctx: any) => {
                afterHasApp = Boolean(ctx.app && typeof ctx.app.openLink === "function");
              },
            },
          },
        },
      ],
    );

    expect(res.passed).toBe(1);
    expect(beforeHasApp).toBe(true);
    expect(beforeEvaluated).toBe(true);
    expect(afterHasApp).toBe(true);
  });

  test("1.23: resolveSpanaCliEntrypoint resolves Spana CLI and runTestCommandWithResult returns structured results", async () => {
    const entry = resolveSpanaCliEntrypoint();
    expect(entry).toBeDefined();
    expect(entry).toMatch(/(cli\/index\.ts|cli\.js)$/);

    const dir = mkdtempSync(join(tmpdir(), "spana-prog-runner-"));
    try {
      writeFileSync(
        join(dir, "spana.config.ts"),
        `export default { platforms: ["web"], apps: { web: { url: "about:blank" } }, execution: { web: { engine: "cdp", headless: true } } };`,
      );
      writeFileSync(
        join(dir, "sample.flow.ts"),
        `import { flow } from "${join(import.meta.dir, "../index.ts")}";
         export default [
           flow("pass-1", { autoLaunch: false }, async () => {}),
           flow.skip("skip-1", async () => {}),
         ];`,
      );
      const summary = await runTestCommandWithResult({
        platforms: ["web"],
        configPath: join(dir, "spana.config.ts"),
        flowPath: join(dir, "sample.flow.ts"),
        reporter: "json",
        cwd: dir,
      });
      expect(summary.success).toBe(true);
      expect(summary.passed).toBe(1);
      expect(summary.skipped).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.total).toBe(2);
      expect(summary.results.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
