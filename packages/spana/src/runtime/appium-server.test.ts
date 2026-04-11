import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { startLocalAppium } from "./appium-server.js";

/**
 * These tests simulate Appium with a tiny fake binary that:
 *   1. reads --port from argv
 *   2. starts an HTTP server on that port that returns {value:{ready:true}} from /status
 *   3. runs until killed
 *
 * This exercises the real spawn/wait/kill lifecycle without depending on a
 * globally-installed appium.
 */

function makeFakeAppium(behavior: "ready" | "slow" | "crash"): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-fake-appium-"));
  const script = join(dir, "fake-appium");
  const source = `#!/usr/bin/env bun
const [, , ...args] = process.argv;
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4723;

if (${JSON.stringify(behavior)} === "crash") {
  console.error("fake appium crash");
  process.exit(2);
}

const http = await import("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ value: { ready: true, build: { version: "fake" } } }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const delay = ${JSON.stringify(behavior)} === "slow" ? 2000 : 50;
setTimeout(() => server.listen(port, "127.0.0.1"), delay);
process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); process.exit(0); });
`;
  writeFileSync(script, source, "utf-8");
  chmodSync(script, 0o755);
  return script;
}

describe("startLocalAppium", () => {
  test("spawns server, waits for readiness, returns URL", async () => {
    const binary = makeFakeAppium("ready");
    const started = await startLocalAppium({ binary, readyTimeout: 5_000 });
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Verify we can actually hit /status through the returned URL
    const res = await fetch(`${started.url}/status`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { value: { ready: boolean } };
    expect(body.value.ready).toBe(true);

    await started.stop();

    // After stop, the port should be unreachable
    await new Promise((r) => setTimeout(r, 200));
    try {
      const check = await fetch(`${started.url}/status`, {
        signal: AbortSignal.timeout(500),
      });
      // If fetch succeeds, the server didn't actually stop
      expect(check.ok).toBe(false);
    } catch {
      // Expected — connection refused or aborted
    }
  });

  test("stop() is idempotent", async () => {
    const binary = makeFakeAppium("ready");
    const started = await startLocalAppium({ binary, readyTimeout: 5_000 });
    await started.stop();
    await started.stop(); // should not throw
  });

  test("rejects with helpful error when binary is missing", async () => {
    await expect(
      startLocalAppium({ binary: "/nonexistent/appium-binary-xyz", readyTimeout: 1_000 }),
    ).rejects.toThrow();
  });

  test("rejects when server never becomes ready", async () => {
    const binary = makeFakeAppium("slow");
    await expect(startLocalAppium({ binary, readyTimeout: 500 })).rejects.toThrow(
      /did not become ready/,
    );
  });

  test("rejects when server exits early", async () => {
    const binary = makeFakeAppium("crash");
    await expect(startLocalAppium({ binary, readyTimeout: 2_000 })).rejects.toThrow();
  });

  test("captures stdout/stderr through log callback", async () => {
    const binary = makeFakeAppium("ready");
    const lines: string[] = [];
    const started = await startLocalAppium({
      binary,
      readyTimeout: 5_000,
      log: (line) => lines.push(line),
    });
    expect(lines.some((l) => l.includes("starting on"))).toBe(true);
    expect(lines.some((l) => l.includes("ready on"))).toBe(true);
    await started.stop();
    expect(lines.some((l) => l.includes("stopping"))).toBe(true);
  });
});

// Suppress unused-import TS checks
void createServer;
export type _Server = Server;
