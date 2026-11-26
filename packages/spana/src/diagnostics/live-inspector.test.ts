import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildComponentTreeScript,
  buildPerformanceProfileScript,
  NetworkEventBuffer,
} from "./live-inspector.js";
import { captureAndroidLogcat, captureIosSimulatorCrashLogs } from "./native-logs.js";
import { SPANA_MCP_TOOLS, SpanaMcpServer } from "../mcp/server.js";

describe("Argent-inspired live diagnostics & profiling", () => {
  it("tracks, bounds, and filters live network events in NetworkEventBuffer", () => {
    const buf = new NetworkEventBuffer(12);
    buf.recordRequest({
      requestId: "1",
      url: "https://api.app/users",
      method: "GET",
      timestamp: 100,
    });
    buf.recordResponse({ requestId: "1", status: 200, statusText: "OK", timestamp: 145 });
    buf.recordRequest({
      requestId: "2",
      url: "https://api.app/checkout",
      method: "POST",
      timestamp: 200,
    });
    buf.recordResponse({ requestId: "2", status: 500, statusText: "Server Error", timestamp: 280 });
    buf.recordRequest({
      requestId: "3",
      url: "https://api.app/offline",
      method: "GET",
      timestamp: 300,
    });
    buf.recordFailure({
      requestId: "3",
      errorText: "net::ERR_INTERNET_DISCONNECTED",
      timestamp: 310,
    });

    expect(buf.size).toBe(3);
    expect(buf.query({ failedOnly: true })).toHaveLength(2);
    expect(buf.query({ method: "post" })[0]?.durationMs).toBe(80);
    expect(buf.query({ urlIncludes: "users" })[0]?.status).toBe(200);
    expect(buf.query({ limit: 1 })).toHaveLength(1);
    buf.clear();
    expect(buf.size).toBe(0);
  });

  it("generates valid JS inspection scripts for component trees and performance profiling", () => {
    const treeScript = buildComponentTreeScript({ maxDepth: 6, maxNodes: 50 });
    const perfScript = buildPerformanceProfileScript();
    expect(treeScript).toContain("__reactFiber$");
    expect(treeScript).toContain("__vue_app__");
    expect(perfScript).toContain("largest-contentful-paint");
    expect(perfScript).toContain("layout-shift");
    // Validate syntactically with Function constructor
    expect(() => new Function(`return ${treeScript}`)).not.toThrow();
    expect(() => new Function(`return ${perfScript}`)).not.toThrow();
  });

  it("captures Android logcat (via mock execFile) and iOS simulator crash logs", async () => {
    const log = await captureAndroidLogcat("emulator-5554", {
      filter: "com.acme",
      execFileFn: async () => ({
        stdout: "01-01 12:00:00 I/Other: ignore\n01-01 12:00:01 E/com.acme: NullPointerException\n",
        stderr: "",
      }),
    });
    expect(log).toContain("NullPointerException");
    expect(log).not.toContain("ignore");

    const dir = mkdtempSync(join(tmpdir(), "spana-ios-crashes-"));
    try {
      writeFileSync(join(dir, "MyApp-2026-11-26.ips"), '{"bug_type":"309"}', "utf8");
      const crashes = captureIosSimulatorCrashLogs({
        bundleOrAppName: "MyApp",
        reportsDir: dir,
        sinceMs: Date.now() - 60_000,
      });
      expect(crashes).toHaveLength(1);
      expect(crashes[0]?.fileName).toBe("MyApp-2026-11-26.ips");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes spana_network_logs, spana_component_tree, and spana_performance_profile via MCP", async () => {
    const names = SPANA_MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("spana_network_logs");
    expect(names).toContain("spana_component_tree");
    expect(names).toContain("spana_performance_profile");

    const server = new SpanaMcpServer({
      connectFn: async () =>
        ({
          platform: "web",
          disconnect: async () => {},
          getHAR: async () => ({
            log: {
              version: "1.2",
              creator: { name: "spana", version: "dev" },
              browser: { name: "Chromium" },
              pages: [],
              entries: [
                {
                  pageref: "tab-1",
                  startedDateTime: new Date().toISOString(),
                  time: 42,
                  request: {
                    method: "GET",
                    url: "https://app.test/api/items",
                    httpVersion: "HTTP/1.1",
                    headers: [],
                    queryString: [],
                    headersSize: 0,
                    bodySize: 0,
                  },
                  response: {
                    status: 503,
                    statusText: "Unavailable",
                    httpVersion: "HTTP/1.1",
                    headers: [],
                    redirectURL: "",
                    headersSize: 0,
                    bodySize: 0,
                    content: { size: 0, mimeType: "application/json" },
                  },
                  cache: {},
                  timings: {
                    blocked: 0,
                    dns: 0,
                    connect: 0,
                    ssl: 0,
                    send: 0,
                    wait: 42,
                    receive: 0,
                  },
                },
              ],
            },
          }),
          evaluate: async (script: string) =>
            script.includes("__reactFiber$")
              ? {
                  detectedFrameworks: ["react"],
                  nodeCount: 2,
                  roots: [{ framework: "react", name: "App", children: [] }],
                }
              : {
                  url: "https://app.test",
                  timestamp: "now",
                  vitals: { fcpMs: 120, cls: 0 },
                  longTaskCount: 0,
                  longTaskTotalMs: 0,
                  resourceCount: 3,
                  slowestResources: [],
                  domNodeCount: 40,
                },
        }) as never,
    });

    await server.callTool("spana_session_start", { platform: "web" });
    const netRes = await server.callTool("spana_network_logs", { failedOnly: true });
    expect(JSON.parse(netRes.content[0]!.text!).count).toBe(1);

    const treeRes = await server.callTool("spana_component_tree", {});
    expect(JSON.parse(treeRes.content[0]!.text!).detectedFrameworks).toEqual(["react"]);

    const perfRes = await server.callTool("spana_performance_profile", {});
    expect(JSON.parse(perfRes.content[0]!.text!).vitals.fcpMs).toBe(120);
  });
});
