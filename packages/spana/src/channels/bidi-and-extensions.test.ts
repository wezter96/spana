import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BidiDomChannel,
  deserializeBidiRemoteValue,
  type BidiWebSocketLike,
} from "./bidi-client.js";
import {
  applyExtensionChromeArgs,
  getLoadedExtensions,
  resolveBrowserExtensions,
  runOAuthPopupFlow,
} from "../drivers/browser-extensions.js";
import type { PromiseApp } from "../api/app.js";

function createMockBidiSocket(
  responder: (msg: {
    id: number;
    method: string;
    params: Record<string, unknown>;
  }) => Record<string, unknown>,
): BidiWebSocketLike {
  const listeners = new Map<string, Array<(ev: any) => void>>();
  return {
    readyState: 1,
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    send(raw) {
      const req = JSON.parse(raw);
      const reply = responder(req);
      queueMicrotask(() => {
        for (const fn of listeners.get("message") ?? []) {
          fn({ data: JSON.stringify(reply) });
        }
      });
    },
    close() {},
  };
}

describe("WebDriver BiDi client & Browser Extensions / OAuth helpers", () => {
  it("deserializes W3C BiDi RemoteValues and runs BidiDomChannel queries", async () => {
    expect(
      deserializeBidiRemoteValue({
        type: "object",
        value: [
          ["url", { type: "string", value: "https://example.org" }],
          ["count", { type: "number", value: 3 }],
          ["items", { type: "array", value: [{ type: "boolean", value: true }, { type: "null" }] }],
        ],
      }),
    ).toEqual({ url: "https://example.org", count: 3, items: [true, null] });

    const channel = new BidiDomChannel({
      webSocketUrl: "ws://127.0.0.1:9222/session/test",
      createWebSocket: () =>
        createMockBidiSocket((req) => {
          if (req.method === "browsingContext.getTree") {
            return { id: req.id, type: "success", result: { contexts: [{ context: "ctx-1" }] } };
          }
          if (req.method === "script.evaluate") {
            return {
              id: req.id,
              type: "success",
              result: {
                type: "success",
                result: {
                  type: "object",
                  value: [
                    ["url", { type: "string", value: "https://firefox.test/" }],
                    ["title", { type: "string", value: "BiDi Home" }],
                  ],
                },
              },
            };
          }
          return { id: req.id, type: "success", result: {} };
        }),
    });

    await channel.connect();
    expect(channel.kind).toBe("bidi");
    expect(channel.isConnected()).toBe(true);
    const info = await channel.getTargetInfo();
    expect(info).toEqual({
      id: "ctx-1",
      url: "https://firefox.test/",
      title: "BiDi Home",
      type: "page",
    });
    await channel.disconnect();
  });

  it("validates unpacked browser extensions, builds Chrome args, and discovers extension IDs", async () => {
    const extDir = mkdtempSync(join(tmpdir(), "spana-ext-"));
    try {
      writeFileSync(
        join(extDir, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Spana Demo Ext",
          version: "1.2.3",
          action: { default_popup: "popup.html" },
        }),
        "utf8",
      );

      const resolved = resolveBrowserExtensions([extDir]);
      expect(resolved[0]?.name).toBe("Spana Demo Ext");
      expect(resolved[0]?.defaultPopup).toBe("popup.html");

      const args = applyExtensionChromeArgs(["--headless=new", "--disable-extensions"], resolved);
      expect(args).not.toContain("--disable-extensions");
      expect(args.some((a) => a.startsWith("--load-extension="))).toBe(true);
      expect(args.some((a) => a.startsWith("--disable-extensions-except="))).toBe(true);

      const loaded = await getLoadedExtensions({
        send: async () =>
          ({
            targetInfos: [
              {
                targetId: "t1",
                type: "service_worker",
                url: "chrome-extension://abcdefghijklmnop/bg.js",
                title: "Spana Demo Ext",
              },
              { targetId: "t2", type: "page", url: "https://example.com/" },
            ],
          }) as never,
      });
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.extensionId).toBe("abcdefghijklmnop");
    } finally {
      rmSync(extDir, { recursive: true, force: true });
    }
  });

  it("runOAuthPopupFlow switches to the new popup tab and returns cleanly to opener", async () => {
    const tabs = ["tab-1"];
    let activeTab = 0;
    const events: string[] = [];
    const mockApp = {
      getTabIds: async () => [...tabs],
      switchToTab: async (idx: number) => {
        activeTab = idx;
        events.push(`switch:${idx}`);
      },
      tap: async () => {
        events.push(`tap-on-tab-${activeTab}`);
      },
    } as unknown as PromiseApp;

    const result = await runOAuthPopupFlow(mockApp, {
      pollIntervalMs: 10,
      trigger: async () => {
        tabs.push("tab-2");
      },
      inPopup: async (app) => {
        await app.tap({ testID: "approve" });
      },
    });

    expect(result.popupTabId).toBe("tab-2");
    expect(events).toEqual(["switch:1", "tap-on-tab-1", "switch:0"]);
    expect(activeTab).toBe(0);
  });
});
