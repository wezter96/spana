import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHealthyWarmDaemon, listWarmDaemons, registerWarmDaemon } from "./daemon-manager.js";

describe("daemon-manager", () => {
  test("probes /json/version for chromium warm daemons and prunes unreachable entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-daemon-test-"));
    const stateFile = join(dir, "daemons.json");
    const probedUrls: string[] = [];

    try {
      registerWarmDaemon(
        {
          kind: "chromium",
          deviceId: "default",
          host: "127.0.0.1",
          port: 9322,
          pid: 12345,
          startedAt: new Date().toISOString(),
        },
        stateFile,
      );

      const healthy = await getHealthyWarmDaemon("chromium", "default", {
        stateFile,
        fetchFn: (async (url: string | URL) => {
          probedUrls.push(String(url));
          return new Response(JSON.stringify({ Browser: "Chrome/130" }), { status: 200 });
        }) as unknown as typeof fetch,
      });

      expect(healthy?.port).toBe(9322);
      expect(probedUrls).toEqual(["http://127.0.0.1:9322/json/version"]);

      const dead = await getHealthyWarmDaemon("chromium", "default", {
        stateFile,
        fetchFn: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      });
      expect(dead).toBeNull();
      expect(listWarmDaemons(stateFile)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
