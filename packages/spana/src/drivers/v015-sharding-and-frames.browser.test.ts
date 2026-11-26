import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";
import { createCoordinator } from "../smart/coordinator.js";
import { parseWebHierarchy } from "./playwright-parser.js";
import { inFrame } from "../schemas/selector.js";
import { applyShard } from "../core/runner.js";
import { readDurationHintsFile, writeDurationHintsFile } from "../cli/iteration.js";
import { runTestCommand } from "../index.js";

describe("v0.15 portable CI timings, cached inFrame isolated worlds & configurable fillVerifyMs", () => {
  let server: Server;
  let hostPort = 0;
  let browserHandle: DirectCdpBrowserHandle;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      // Parent page on host.app.localhost embedding a same-site cross-origin iframe on frame.app.localhost
      if (url.pathname === "/parent") {
        const framePath = url.searchParams.get("frame") ?? "/frame-a";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html><body style="margin:0;padding:16px;">
            <h1 data-testid="parent-title">Parent</h1>
            <iframe
              title="Preview Canvas"
              src="http://frame.app.localhost:${hostPort}${framePath}"
              style="width:420px;height:260px;border:1px solid #999;"
            ></iframe>
          </body></html>`);
        return;
      }

      if (url.pathname === "/frame-a") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html><body>
            <h2 data-testid="frame-heading">Frame A</h2>
            <input data-testid="frame-input" placeholder="Type here" />
            <button data-testid="frame-btn" onclick="document.querySelector('[data-testid=frame-out]').textContent='Clicked:' + document.querySelector('[data-testid=frame-input]').value">Apply</button>
            <div data-testid="frame-out">idle</div>
            <a data-testid="nav-b" href="/frame-b">Go B</a>
          </body></html>`);
        return;
      }

      if (url.pathname === "/frame-b") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html><body>
            <h2 data-testid="frame-heading">Frame B</h2>
          </body></html>`);
        return;
      }

      if (url.pathname === "/fast-form") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html><body>
            <input data-testid="f1" />
            <input data-testid="f2" />
            <input data-testid="f3" />
          </body></html>`);
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><h1 data-testid="ok">OK</h1></body></html>`);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    hostPort = typeof addr === "object" && addr ? addr.port : 0;
    browserHandle = await launchDirectCdpBrowser({ headless: true });
  });

  afterAll(async () => {
    await browserHandle?.close().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  test("1. Same-site cross-origin inFrame() caches isolated world & __spanaRt, and invalidates cleanly on iframe navigation", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle.browserWsUrl,
        baseUrl: `http://host.app.localhost:${hostPort}`,
        useBrowserContexts: true,
        useInjectedRuntime: true,
      }),
    );

    try {
      const cdpChannel = driver.domChannel as unknown as {
        sendCommand: (...args: any[]) => Promise<any>;
      };
      let createWorldCalls = 0;
      const origSend = cdpChannel.sendCommand.bind(cdpChannel);
      cdpChannel.sendCommand = (method: string, ...rest: any[]) => {
        if (method === "Page.createIsolatedWorld") createWorldCalls += 1;
        return origSend(method, ...rest);
      };

      const coord = createCoordinator(driver, {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { actionStableFrames: 0 },
      });

      await Effect.runPromise(driver.launchApp(`http://host.app.localhost:${hostPort}/parent`));
      await Effect.runPromise(
        coord.assertVisible(inFrame("Preview Canvas", { testID: "frame-heading" })),
      );
      await Effect.runPromise(
        coord.assertText(inFrame("Preview Canvas", { testID: "frame-heading" }), "Frame A"),
      );
      await Effect.runPromise(
        coord.fill(inFrame("Preview Canvas", { testID: "frame-input" }), "Hello"),
      );
      await Effect.runPromise(coord.tap(inFrame("Preview Canvas", { testID: "frame-btn" })));
      await Effect.runPromise(
        coord.assertText(inFrame("Preview Canvas", { testID: "frame-out" }), "Clicked:Hello"),
      );

      // All 5 iframe actions reused ONE cached isolated world!
      expect(createWorldCalls).toBe(1);

      // Navigate inside the iframe -> world cache must invalidate and seamlessly recover
      await Effect.runPromise(coord.tap(inFrame("Preview Canvas", { testID: "nav-b" })));
      await Effect.runPromise(
        coord.assertText(inFrame("Preview Canvas", { testID: "frame-heading" }), "Frame B"),
      );
      expect(createWorldCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });

  test("2. Portable timings manifest (file & shard-directory merge) drives LPT balanced --shard", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spana-v015-timings-"));
    try {
      const shardDir = join(tmpDir, "shard-timings");
      mkdirSync(shardDir, { recursive: true });
      await writeDurationHintsFile(join(shardDir, "shard-1.json"), [
        { name: "slow-a", platform: "web", status: "passed", durationMs: 20_000 },
        { name: "fast-1", platform: "web", status: "passed", durationMs: 1_000 },
      ]);
      await writeDurationHintsFile(join(shardDir, "shard-2.json"), [
        { name: "slow-b", platform: "web", status: "passed", durationMs: 18_000 },
        { name: "med-1", platform: "web", status: "passed", durationMs: 6_000 },
        { name: "med-2", platform: "web", status: "passed", durationMs: 5_000 },
      ]);

      const merged = await readDurationHintsFile(shardDir);
      expect(merged).toEqual({
        "fast-1": 1000,
        "med-1": 6000,
        "med-2": 5000,
        "slow-a": 20000,
        "slow-b": 18000,
      });

      const items = Object.keys(merged).map((name) => ({ name }));
      const s1 = applyShard(
        items,
        { current: 1, total: 2 },
        { durationHintsMs: merged, getName: (x) => x.name },
      );
      const s2 = applyShard(
        items,
        { current: 2, total: 2 },
        { durationHintsMs: merged, getName: (x) => x.name },
      );
      const sum = (xs: Array<{ name: string }>) => xs.reduce((acc, x) => acc + merged[x.name]!, 0);

      // Slowest two flows must land on different shards; total difference <= 2s out of 50s!
      expect(new Set([...s1.map((x) => x.name), ...s2.map((x) => x.name)]).size).toBe(5);
      expect(Math.abs(sum(s1) - sum(s2))).toBeLessThanOrEqual(2000);

      // End-to-end runTestCommand --write-timings & --timings with --shard
      const spanaEntry = join(import.meta.dir, "..", "index.ts");
      writeFileSync(
        join(tmpDir, "spana.config.ts"),
        `export default {
  flowDir: "./flows",
  platforms: ["web"],
  apps: { web: { url: ${JSON.stringify(`http://127.0.0.1:${hostPort}`)} } },
  execution: { web: { engine: "cdp", cdpUrl: ${JSON.stringify(browserHandle.browserWsUrl)}, freshContextPerFlow: true } },
  defaults: { actionStableFrames: 0, fillVerifyMs: 0 },
};\n`,
      );
      await Bun.write(
        join(tmpDir, "flows", "a.flow.ts"),
        `import { flow } from ${JSON.stringify(spanaEntry)};
export default flow("Flow Alpha", async ({ app, expect }) => {
  await app.openLink("/fast-form");
  await app.fill({ testID: "f1" }, "one");
  await expect({ testID: "f1" }).toHaveValue("one");
});\n`,
      );
      await Bun.write(
        join(tmpDir, "flows", "b.flow.ts"),
        `import { flow } from ${JSON.stringify(spanaEntry)};
export default flow("Flow Beta", async ({ app, expect }) => {
  await app.openLink("/fast-form");
  await app.fill({ testID: "f2" }, "two");
  await expect({ testID: "f2" }).toHaveValue("two");
});\n`,
      );

      const timingsOut = join(tmpDir, "timings.json");
      const okWrite = await runTestCommand({
        platforms: ["web"],
        cwd: tmpDir,
        quiet: true,
        writeTimingsFile: timingsOut,
      });
      expect(okWrite).toBe(true);
      const recorded = await readDurationHintsFile(timingsOut);
      expect(recorded["Flow Alpha"]).toBeGreaterThan(0);
      expect(recorded["Flow Beta"]).toBeGreaterThan(0);

      const okShard = await runTestCommand({
        platforms: ["web"],
        cwd: tmpDir,
        quiet: true,
        timingsFile: timingsOut,
        shard: { current: 1, total: 2 },
      });
      expect(okShard).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("3. defaults.fillVerifyMs: 0 fills synchronously without the 12ms remount timer", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle.browserWsUrl,
        baseUrl: `http://127.0.0.1:${hostPort}`,
        useBrowserContexts: true,
        useInjectedRuntime: true,
      }),
    );

    try {
      const coord = createCoordinator(driver, {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { actionStableFrames: 0, fillVerifyMs: 0 },
      });
      await Effect.runPromise(driver.launchApp(`http://127.0.0.1:${hostPort}/fast-form`));
      await Effect.runPromise(coord.fill({ testID: "f1" }, "alpha"));
      await Effect.runPromise(coord.fill({ testID: "f2" }, "beta"));
      await Effect.runPromise(coord.fill({ testID: "f3" }, "gamma"));
      await Effect.runPromise(coord.assertValue({ testID: "f1" }, "alpha"));
      await Effect.runPromise(coord.assertValue({ testID: "f2" }, "beta"));
      await Effect.runPromise(coord.assertValue({ testID: "f3" }, "gamma"));
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });
});
