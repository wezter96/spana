import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import {
  launchDirectCdpBrowser,
  makeLightweightCdpDriver,
  type DirectCdpBrowserHandle,
} from "./cdp-browser.js";
import { CdpWebSocketMultiplexer, type MinimalWebSocket } from "../channels/cdp-client.js";
import { createCoordinator } from "../smart/coordinator.js";
import { parseWebHierarchy } from "./playwright-parser.js";
import { buildWebRuntimePool } from "../runtime/local.js";
import { runTestCommand } from "../index.js";

describe("v0.14 Direct CDP performance & DX pillars", () => {
  let server: Server;
  let baseUrl = "";
  let browserHandle: DirectCdpBrowserHandle;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/worker") {
        const id = url.searchParams.get("id") ?? "0";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html><body>
            <h1 data-testid="worker-title">Worker ${id}</h1>
            <button data-testid="inc-btn" onclick="window.__c=(window.__c||0)+1;document.querySelector('[data-testid=count]').textContent=String(window.__c);localStorage.setItem('w','${id}')">Inc</button>
            <span data-testid="count">0</span>
          </body></html>`);
        return;
      }

      if (url.pathname === "/moving-target") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html><body style="margin:0;padding:0">
            <button id="decoy" data-testid="decoy" style="position:fixed;left:20px;top:20px;width:160px;height:40px;"
              onclick="window.__decoyHits=(window.__decoyHits||0)+1">Decoy</button>
            <button id="target" data-testid="moving-btn" style="position:fixed;left:20px;top:20px;width:160px;height:40px;z-index:2;"
              onclick="window.__targetHits=(window.__targetHits||0)+1;this.textContent='Clicked!'">MoveMe</button>
            <script>
              window.__targetHits = 0;
              window.__decoyHits = 0;
              window.__shiftOnce = () => {
                // Shift target away right on next mousemove (just before mousePressed lands)
                const onMove = () => {
                  window.removeEventListener('mousemove', onMove, true);
                  const t = document.getElementById('target');
                  t.style.left = '260px';
                  t.style.top = '20px';
                };
                window.addEventListener('mousemove', onMove, true);
              };
            </script>
          </body></html>`);
        return;
      }

      if (url.pathname === "/isolation") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
          <html><body>
            <div data-testid="val"></div>
            <script>
              const existing = localStorage.getItem("leak") || "clean";
              document.querySelector('[data-testid=val]').textContent = existing;
              localStorage.setItem("leak", "dirty");
            </script>
          </body></html>`);
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body><h1 data-testid="home">Home</h1></body></html>`);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    browserHandle = await launchDirectCdpBrowser({ headless: true });
  });

  afterAll(async () => {
    await browserHandle?.close().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  test("1. CdpWebSocketMultiplexer shares ONE real WebSocket across 4 concurrent Chromium workers with zero cross-talk", async () => {
    let realSocketsOpened = 0;
    const mux = new CdpWebSocketMultiplexer(browserHandle.browserWsUrl, (wsUrl) => {
      realSocketsOpened += 1;
      return new WebSocket(wsUrl) as unknown as MinimalWebSocket;
    });

    const workers = await Promise.all(
      [1, 2, 3, 4].map((id) =>
        Effect.runPromise(
          makeLightweightCdpDriver({
            cdpUrl: browserHandle.browserWsUrl,
            baseUrl,
            useBrowserContexts: true,
            useInjectedRuntime: true,
            createWebSocket: () => mux.createVirtualSocket(),
          }),
        ).then((driver) => ({ id, driver })),
      ),
    );

    try {
      expect(realSocketsOpened).toBe(1);
      expect(mux.activeVirtualSockets).toBe(4);
      expect(mux.underlyingSocketOpen).toBe(true);

      await Promise.all(
        workers.map(async ({ id, driver }) => {
          const coord = createCoordinator(driver, {
            parse: parseWebHierarchy,
            platform: "web",
            defaults: { actionStableFrames: 0 },
          });
          await Effect.runPromise(driver.launchApp(`${baseUrl}/worker?id=${id}`));
          await Effect.runPromise(coord.assertText({ testID: "worker-title" }, `Worker ${id}`));
          await Effect.runPromise(coord.tap({ testID: "inc-btn" }));
          await Effect.runPromise(coord.assertText({ testID: "count" }, "1"));
          const stored = await Effect.runPromise(
            driver.evaluate<string>("localStorage.getItem('w')"),
          );
          expect(stored).toBe(String(id));
        }),
      );
    } finally {
      await Promise.all(workers.map(({ driver }) => Effect.runPromise(driver.killApp(""))));
    }

    expect(mux.activeVirtualSockets).toBe(0);
    expect(mux.underlyingSocketOpen).toBe(false);
  });

  test("2. Inline moving-target tap guard: 0 pre-tap evals on steady click & deterministically suppresses+retries moving target", async () => {
    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        useInjectedRuntime: true,
      }),
    );

    try {
      expect(driver.domChannel?.supportsInlineTapGuard?.()).toBe(true);
      const coord = createCoordinator(driver, {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { actionStableFrames: 0 },
      });

      await Effect.runPromise(driver.launchApp(`${baseUrl}/moving-target`));

      // Arm a mid-click shift on mousemove so the first tap lands where the decoy sits!
      await Effect.runPromise(driver.evaluate("window.__shiftOnce()"));
      await Effect.runPromise(coord.tap({ testID: "moving-btn" }, { timeout: 5000 }));

      const state = await Effect.runPromise(
        driver.evaluate<{ targetHits: number; decoyHits: number }>(
          "({ targetHits: window.__targetHits, decoyHits: window.__decoyHits })",
        ),
      );
      expect(state.decoyHits).toBe(0);
      expect(state.targetHits).toBe(1);

      // Verify zero pre-tap evaluate() calls are issued on a steady tap (only waitForSelector + tapAtCoordinate + checkTapGuard)
      let preTapEvalCount = 0;
      const origEval = driver.domChannel!.evaluate.bind(driver.domChannel!);
      driver.domChannel!.evaluate = ((...args: any[]) => {
        preTapEvalCount += 1;
        return origEval(...(args as [any, ...any[]]));
      }) as any;

      await Effect.runPromise(coord.tap({ testID: "moving-btn" }, { timeout: 3000 }));
      expect(preTapEvalCount).toBe(0);
      const targetHitsAfter = await Effect.runPromise(
        driver.evaluate<number>("window.__targetHits"),
      );
      expect(targetHitsAfter).toBe(2);
    } finally {
      await Effect.runPromise(driver.killApp(""));
    }
  });

  test("3. Direct CDP defaults to hot-cache isolation and maxContextsPerBrowser=4, while fresh remains opt-in", async () => {
    // Default (omitted contextIsolation) -> hot-cache keeps same sessionId while wiping localStorage
    const hotDriver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: true,
      }),
    );

    try {
      await Effect.runPromise(hotDriver.beginFlow!("f1"));
      const sid1 = (hotDriver.getRawPage!() as { sessionId?: string }).sessionId;
      await Effect.runPromise(hotDriver.launchApp(`${baseUrl}/isolation`));
      const firstVal = await Effect.runPromise(
        hotDriver.evaluate<string>("document.querySelector('[data-testid=val]').textContent"),
      );
      expect(firstVal).toBe("clean");

      await Effect.runPromise(hotDriver.beginFlow!("f2"));
      const sid2 = (hotDriver.getRawPage!() as { sessionId?: string }).sessionId;
      expect(sid2).toBe(sid1); // hot-cache reuses the warm context
      await Effect.runPromise(hotDriver.launchApp(`${baseUrl}/isolation`));
      const secondVal = await Effect.runPromise(
        hotDriver.evaluate<string>("document.querySelector('[data-testid=val]').textContent"),
      );
      expect(secondVal).toBe("clean"); // localStorage wiped between flows!
    } finally {
      await Effect.runPromise(hotDriver.killApp(""));
    }

    // Explicit contextIsolation: "fresh" swaps to a new sessionId
    const freshDriver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: browserHandle.browserWsUrl,
        baseUrl,
        useBrowserContexts: true,
        freshContextPerFlow: true,
        contextIsolation: "fresh",
      }),
    );

    try {
      await Effect.runPromise(freshDriver.beginFlow!("f1"));
      const sid1 = (freshDriver.getRawPage!() as { sessionId?: string }).sessionId;
      await Effect.runPromise(freshDriver.beginFlow!("f2"));
      const sid2 = (freshDriver.getRawPage!() as { sessionId?: string }).sessionId;
      expect(sid2).not.toBe(sid1);
    } finally {
      await Effect.runPromise(freshDriver.killApp(""));
    }

    // buildWebRuntimePool with 4 workers on Direct CDP runs cleanly in parallel with default maxContextsPerBrowser=4
    const pool = await buildWebRuntimePool(
      {
        apps: { web: { url: baseUrl } },
        execution: { web: { engine: "cdp", cdpUrl: browserHandle.browserWsUrl } },
      },
      4,
    );
    try {
      expect(pool).toHaveLength(4);
      await Promise.all(
        pool.map(async (item, idx) => {
          await Effect.runPromise(
            item.runtime.driver.launchApp(`${baseUrl}/worker?id=${idx + 10}`),
          );
          const title = await Effect.runPromise(
            item.runtime.driver.evaluate<string>(
              "document.querySelector('[data-testid=worker-title]').textContent",
            ),
          );
          expect(title).toBe(`Worker ${idx + 10}`);
        }),
      );
    } finally {
      await Promise.all(pool.map((item) => item.runtime.cleanup()));
    }
  });

  test("4. Programmatic in-process runTestCommand({ cwd, ... }) executes flows cleanly without subprocess spawn", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "spana-v014-prog-"));
    try {
      const spanaEntry = join(import.meta.dir, "..", "index.ts");
      writeFileSync(
        join(tmpDir, "spana.config.ts"),
        `export default {
  flowDir: "./flows",
  platforms: ["web"],
  apps: { web: { url: ${JSON.stringify(baseUrl)} } },
  execution: {
    web: {
      engine: "cdp",
      cdpUrl: ${JSON.stringify(browserHandle.browserWsUrl)},
      freshContextPerFlow: true,
    },
  },
  defaults: { actionStableFrames: 0 },
};\n`,
      );
      writeFileSync(
        join(tmpDir, "flows.ts"),
        "", // placeholder removed below
      );
      rmSync(join(tmpDir, "flows.ts"));
      const flowsDir = join(tmpDir, "flows");
      await Bun.write(
        join(flowsDir, "smoke.flow.ts"),
        `import { flow } from ${JSON.stringify(spanaEntry)};
export default flow("Programmatic smoke", async ({ app, expect }) => {
  await app.openLink("/worker?id=99");
  await expect({ testID: "worker-title" }).toHaveText("Worker 99");
  await app.tap({ testID: "inc-btn" });
  await expect({ testID: "count" }).toHaveText("1");
});\n`,
      );

      const ok = await runTestCommand({
        platforms: ["web"],
        cwd: tmpDir,
        quiet: true,
      });
      expect(ok).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
