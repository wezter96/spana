import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultReadJsonReport, writeWorkerProcessReport } from "./worker-pool.js";
import { createFailureBundle } from "../report/failure-bundle.js";
import { provConfigSchema } from "../schemas/config.js";
import {
  getHealthyWarmDaemon,
  isPidAlive,
  reapIdleWarmDaemons,
  registerWarmDaemon,
} from "../runtime/daemon-manager.js";
import { byRole, filterSelector, isComposableDomSelector, or } from "../schemas/selector.js";
import { formatSelector } from "../smart/element-matcher.js";
import type { TestResult } from "./engine.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const dirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("0.9.0 pilot fixes unit coverage", () => {
  test("#2: provConfigSchema accepts defaults.actionStableFrames", () => {
    expect(
      provConfigSchema.parse({ defaults: { actionStableFrames: 2 } }).defaults?.actionStableFrames,
    ).toBe(2);
    expect(
      provConfigSchema.parse({ defaults: { actionStableFrames: 0 } }).defaults?.actionStableFrames,
    ).toBe(0);
    expect(() => provConfigSchema.parse({ defaults: { actionStableFrames: -1 } })).toThrow();
  });

  test("#6: writeWorkerProcessReport persists results to SPANA_WORKER_REPORT_PATH", async () => {
    const dir = makeTmpDir("spana-worker-report-");
    const reportPath = join(dir, "nested", "shard-1.json");
    const fakeResults: TestResult[] = [
      {
        name: "checkout",
        platform: "web",
        status: "passed",
        durationMs: 120,
        steps: [],
      },
    ];

    expect(await writeWorkerProcessReport(fakeResults, {})).toBeNull();
    const written = await writeWorkerProcessReport(fakeResults, {
      SPANA_WORKER_REPORT_PATH: reportPath,
    });
    expect(written).toBe(reportPath);

    const parsed = await defaultReadJsonReport(reportPath);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe("checkout");
  });

  test("#7: registerWarmDaemon kills previous PID on scope overwrite and idle TTL reaps expired daemons", async () => {
    const dir = makeTmpDir("spana-daemon-v09-");
    const stateFile = join(dir, "daemons.json");

    // Spawn a harmless dummy sleeper process to simulate an existing daemon for scope-a
    // oxlint-disable-next-line landmines/no-cold-start-in-test -- spawn() is not awaited; the test only needs a live PID for registerWarmDaemon to kill
    const oldChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      stdio: "ignore",
    });
    const oldPid = oldChild.pid!;
    expect(isPidAlive(oldPid)).toBe(true);

    try {
      registerWarmDaemon(
        {
          kind: "chromium",
          deviceId: "scope-a",
          host: "127.0.0.1",
          port: 49101,
          pid: oldPid,
          startedAt: new Date(Date.now() - 10_000).toISOString(),
        },
        stateFile,
      );

      // Re-register same scope with a new PID — old PID must be terminated immediately
      registerWarmDaemon(
        {
          kind: "chromium",
          deviceId: "scope-a",
          host: "127.0.0.1",
          port: 49102,
          pid: 99999999,
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        stateFile,
      );

      // SIGTERM is async; poll until the old daemon is gone instead of guessing how long it takes.
      await waitUntil(() => !isPidAlive(oldPid));
      expect(isPidAlive(oldPid)).toBe(false);

      // Idle TTL reaping: expired record returns null from getHealthyWarmDaemon
      const expired = await getHealthyWarmDaemon("chromium", "scope-a", {
        stateFile,
        idleTtlMs: 5_000,
        fetchFn: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      });
      expect(expired).toBeNull();

      // reapIdleWarmDaemons reaps old records and keeps fresh ones
      const now = Date.now();
      registerWarmDaemon(
        {
          kind: "chromium",
          deviceId: "stale-scope",
          host: "127.0.0.1",
          port: 49103,
          startedAt: new Date(now - 120_000).toISOString(),
          lastUsedAt: new Date(now - 120_000).toISOString(),
        },
        stateFile,
      );
      registerWarmDaemon(
        {
          kind: "chromium",
          deviceId: "fresh-scope",
          host: "127.0.0.1",
          port: 49104,
          startedAt: new Date(now - 1_000).toISOString(),
          lastUsedAt: new Date(now - 1_000).toISOString(),
        },
        stateFile,
      );
      const reaped = reapIdleWarmDaemons({ stateFile, idleTtlMs: 30_000, nowMs: now });
      expect(reaped).toBe(1);
    } finally {
      try {
        process.kill(-oldPid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  });

  test("#10: failure bundle includes full steps history and POSIX-quoted reproCommand", () => {
    const bundle = createFailureBundle(
      "it's a tricky flow",
      "web",
      [
        { command: "openLink", selector: { url: "/a" }, status: "passed", durationMs: 40 },
        { command: "tap", selector: { testID: "btn" }, status: "passed", durationMs: 25 },
        {
          command: "expect.toBeVisible",
          selector: { testID: "done" },
          status: "failed",
          durationMs: 500,
          error: "missing",
        },
      ],
      { message: "missing", category: "element-not-found" },
      "/tmp/nonexistent-art-dir",
      undefined,
      "flows/my dir/it's test.flow.ts",
    );

    expect(bundle.steps).toHaveLength(3);
    expect(bundle.steps?.[0]?.status).toBe("passed");
    expect(bundle.steps?.[2]?.status).toBe("failed");
    expect(bundle.steps?.[2]?.error).toBe("missing");
    expect(bundle.reproCommand).toBe(
      `spana test 'flows/my dir/it'\\''s test.flow.ts' --platform web --grep 'it'\\''s a tricky flow'`,
    );
  });

  test("#11: selector composition helpers (or, has/hasNot, role level)", () => {
    const selOr = or({ testID: "a" }, byRole("heading", { level: 2, name: "Hi" }));
    expect(isComposableDomSelector(selOr)).toBe(true);
    expect(formatSelector(selOr)).toContain("or(");
    expect(formatSelector(selOr)).toContain("level: 2");

    const filtered = filterSelector(
      { text: "Row" },
      { has: { testID: "ok" }, hasNot: { testID: "bad" } },
    );
    expect(isComposableDomSelector(filtered)).toBe(true);
    expect(formatSelector(filtered)).toContain('has(testID: "ok")');
    expect(formatSelector(filtered)).toContain('hasNot(testID: "bad")');
  });
});
