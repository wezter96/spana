import { describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  buildDomWaitForSelectorScript,
  buildInjectedCallScript,
  SPANA_INJECTED_RUNTIME_SCRIPT,
  SPANA_RUNTIME_MISSING_SENTINEL,
} from "../channels/dom-channel.js";
import { CdpDomChannel, type MinimalWebSocket } from "../channels/cdp-client.js";
import { launchDirectCdpBrowser, makeLightweightCdpDriver } from "../drivers/cdp-browser.js";
import { flow } from "../api/flow.js";
import { executeFlow } from "./engine.js";
import {
  attachNetworkReplayCache,
  buildNetworkCacheKey,
  NetworkReplayCache,
} from "./network-cache.js";

function hasLocalChrome(): boolean {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.some((p) => existsSync(p));
}

function startStaticServer(html: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

class InjectedRuntimeMockWs implements MinimalWebSocket {
  readyState = 1;
  private listeners = new Map<string, Set<(ev: any) => void>>();
  public expressions: string[] = [];
  private installed = false;

  constructor() {
    setImmediate(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: any): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw);
    let result: any = {};
    if (msg.method === "Runtime.evaluate") {
      const expr = String(msg.params?.expression ?? "");
      this.expressions.push(expr);
      if (expr === SPANA_INJECTED_RUNTIME_SCRIPT) {
        this.installed = true;
        result = { result: { value: true } };
      } else if (!this.installed) {
        result = { result: { value: SPANA_RUNTIME_MISSING_SENTINEL } };
      } else {
        result = {
          result: {
            value: [
              {
                id: "save-btn",
                tag: "button",
                text: "Save",
                rect: { x: 10, y: 10, width: 80, height: 32 },
                scrollX: 0,
                scrollY: 0,
                devicePixelRatio: 1,
                viewportWidth: 1280,
                viewportHeight: 720,
                visible: true,
                enabled: true,
                clickable: true,
              },
            ],
          },
        };
      }
    }
    setImmediate(() => {
      this.emit("message", { data: JSON.stringify({ id: msg.id, result }) });
    });
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }
}

describe("Performance optimizations: 0-rAF static click, window.__spanaRt, hot-cache & NetworkReplayCache", () => {
  it("builds compact ~80-byte calls when window.__spanaRt is enabled (~100x smaller than full script)", async () => {
    const compactCall = buildInjectedCallScript(
      "waitForSelector",
      { testID: "btn" },
      { forAction: true },
    );
    const fullScript = buildDomWaitForSelectorScript({ testID: "btn" }, { forAction: true });
    expect(compactCall.length).toBeLessThan(160);
    expect(fullScript.length).toBeGreaterThan(compactCall.length * 40);
    expect(fullScript).toContain("hasActiveAnimation");

    let ws!: InjectedRuntimeMockWs;
    const channel = new CdpDomChannel({
      endpointUrl: "http://127.0.0.1:9222",
      webSocketUrl: "ws://127.0.0.1:9222/devtools/page/rt",
      createWebSocket: () => {
        ws = new InjectedRuntimeMockWs();
        return ws;
      },
    });
    await channel.connect();
    channel.enableInjectedRuntime(true);

    // First call auto-installs SPANA_INJECTED_RUNTIME_SCRIPT once on sentinel miss
    const first = await channel.query({ testID: "save-btn" });
    expect(first).toHaveLength(1);
    expect(ws.expressions).toHaveLength(3); // probe -> install -> retry

    // Second call sends ONLY a single tiny ~70-byte expression!
    const second = await channel.query({ testID: "save-btn" });
    expect(second).toHaveLength(1);
    expect(ws.expressions).toHaveLength(4);
    expect(ws.expressions[3]!.length).toBeLessThan(120);

    await channel.disconnect();
  });

  it("NetworkReplayCache records live responses once and replays in <1ms with zero network calls", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spana-netcache-"));
    try {
      let liveFetches = 0;
      const fakeFetch = (async (url: string) => {
        liveFetches += 1;
        return new Response(JSON.stringify({ url, items: [1, 2, 3] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      expect(buildNetworkCacheKey("GET", "https://api.example.com/v1/users")).toContain("get-");

      const cache = new NetworkReplayCache({ cacheDir: tmp });
      const first = await cache.resolve("https://api.example.com/v1/users", {
        mode: "auto",
        fetchFn: fakeFetch,
      });
      expect(first.source).toBe("network");
      expect(liveFetches).toBe(1);

      const second = await cache.resolve("https://api.example.com/v1/users", {
        mode: "replay",
        fetchFn: fakeFetch,
      });
      expect(second.source).toBe("cache");
      expect(liveFetches).toBe(1);
      expect(JSON.parse(second.entry.body).items).toEqual([1, 2, 3]);

      const mockedRoutes: Array<{ matcher: any; body?: string }> = [];
      const attached = await attachNetworkReplayCache(
        {
          mockNetwork: async (matcher, resp) => {
            mockedRoutes.push({ matcher, body: resp.body });
          },
        },
        {
          cacheDir: tmp,
          mode: "replay",
          routes: [{ url: "https://api.example.com/v1/users", matcher: "**/v1/users" }],
        },
      );
      expect(attached).toEqual({ cacheHits: 1, networkFetches: 0, totalRoutes: 1 });
      expect(mockedRoutes).toHaveLength(1);
      expect(mockedRoutes[0]!.matcher).toBe("**/v1/users");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  const itWithChrome = hasLocalChrome() ? it : it.skip;

  itWithChrome(
    "live Chrome verifies window.__spanaRt pre-injection + hot-cache isolation wipes storage between flows",
    async () => {
      const appHtml = `<!doctype html><html><body>
        <button data-testid="set-btn" onclick="localStorage.setItem('leak','dirty'); document.querySelector('[data-testid=state]').textContent = localStorage.getItem('leak') || 'clean'">Set</button>
        <p data-testid="state"></p>
        <script>
          document.querySelector('[data-testid=state]').textContent = localStorage.getItem('leak') || 'clean';
        </script>
      </body></html>`;
      const { server, port } = await startStaticServer(appHtml);
      const browser = await launchDirectCdpBrowser({ headless: true });
      const driver = await Effect.runPromise(
        makeLightweightCdpDriver({
          cdpUrl: browser.browserWsUrl,
          baseUrl: `http://127.0.0.1:${port}`,
          useBrowserContexts: true,
          freshContextPerFlow: true,
          contextIsolation: "hot-cache",
        }),
      );

      try {
        const f1 = flow("hot-cache flow 1", async ({ app, expect: spanaExpect }) => {
          await app.openLink(`http://127.0.0.1:${port}/`);
          const hasRt = await app.evaluate<boolean>("Boolean(window.__spanaRt)");
          expect(hasRt).toBe(true);
          await spanaExpect({ testID: "state" }).toHaveText("clean");
          await app.tap({ testID: "set-btn" });
          await spanaExpect({ testID: "state" }).toHaveText("dirty");
        });

        const f2 = flow("hot-cache flow 2", async ({ app, expect: spanaExpect }) => {
          await app.openLink(`http://127.0.0.1:${port}/`);
          // Hot-cache reset MUST wipe localStorage from flow 1!
          await spanaExpect({ testID: "state" }).toHaveText("clean");
        });

        const cfg = {
          appId: `http://127.0.0.1:${port}`,
          platform: "web" as const,
          autoLaunch: false,
          coordinatorConfig: {
            parse: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 } }),
          },
        };

        const r1 = await executeFlow(f1, driver, cfg);
        const r2 = await executeFlow(f2, driver, cfg);
        expect(r1.status).toBe("passed");
        expect(r2.status).toBe("passed");
      } finally {
        await driver.domChannel?.disconnect();
        await browser.close();
        await closeServer(server);
      }
    },
    30_000,
  );
});
