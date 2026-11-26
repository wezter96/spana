import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { allocateFreePort } from "../core/port-allocator.js";
import { isHttpUrlReady, isTcpPortOpen, startWebServer, startWebServers } from "./web-server.js";

describe("webServer auto-boot lifecycle", () => {
  it("spawns a local HTTP server, polls until ready, and shuts it down cleanly", async () => {
    const port = await allocateFreePort(18100);
    const url = `http://127.0.0.1:${port}/health`;
    const script = `const http = require('node:http'); const s = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }); s.listen(${port}, '127.0.0.1');`;

    const running = await startWebServer(
      {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        url,
        timeout: 10_000,
        reuseExistingServer: false,
      },
      { pollIntervalMs: 50 },
    );

    expect(running.reused).toBe(false);
    expect(running.url).toBe(url);
    expect(await isHttpUrlReady(url)).toBe(true);
    expect(await isTcpPortOpen(port)).toBe(true);

    await running.stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(await isTcpPortOpen(port)).toBe(false);
  });

  it("reuses an already-running server when reuseExistingServer is true", async () => {
    const port = await allocateFreePort(18200);
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("existing");
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    try {
      const running = await startWebServer(
        {
          command: "echo should-not-run && exit 1",
          url: `http://127.0.0.1:${port}`,
          reuseExistingServer: true,
        },
        { isCI: false },
      );
      expect(running.reused).toBe(true);
      await running.stop();
      expect(await isTcpPortOpen(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails fast if the server command exits before becoming ready and rolls back earlier servers", async () => {
    const port1 = await allocateFreePort(18300);
    const port2 = await allocateFreePort(18350);
    const script1 = `const http = require('node:http'); http.createServer((_, r) => { r.writeHead(200); r.end('ok'); }).listen(${port1}, '127.0.0.1');`;

    await expect(
      startWebServers(
        [
          {
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script1)}`,
            port: port1,
            reuseExistingServer: false,
          },
          {
            command: `${JSON.stringify(process.execPath)} -e "process.exit(2)"`,
            port: port2,
            reuseExistingServer: false,
          },
        ],
        { pollIntervalMs: 50 },
      ),
    ).rejects.toThrow(/exited before/);

    await new Promise((r) => setTimeout(r, 150));
    expect(await isTcpPortOpen(port1)).toBe(false);
  });
});
