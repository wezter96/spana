import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { CdpDomChannel, type MinimalWebSocket } from "../channels/cdp-client.js";
import { makeLightweightCdpDriver } from "./cdp-browser.js";
import { resolveWebEngine } from "../runtime/local.js";
import type { ProvConfig } from "../schemas/config.js";

class MockCdpWebSocket implements MinimalWebSocket {
  readyState = 1;
  private listeners = new Map<string, Set<(ev: any) => void>>();
  public sent: Array<{ id?: number; method: string; params?: any; sessionId?: string }> = [];

  constructor(
    private handler: (
      msg: { id: number; method: string; params?: any; sessionId?: string },
      ws: MockCdpWebSocket,
    ) => any,
  ) {
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
    for (const l of this.listeners.get(type) ?? []) {
      l(event);
    }
  }

  emitCdpEvent(method: string, params: any, sessionId?: string): void {
    this.emit("message", {
      data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }),
    });
  }

  send(raw: string): void {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    const result = this.handler(msg, this);
    setImmediate(() => {
      this.emit("message", {
        data: JSON.stringify({ id: msg.id, result: result ?? {} }),
      });
    });
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }
}

describe("Direct CDP Cross-Origin Iframe (OOPIF) & engine: auto", () => {
  it("queries and offsets elements inside attached OOPIF child sessions", async () => {
    let wsRef!: MockCdpWebSocket;

    const channel = new CdpDomChannel({
      endpointUrl: "http://127.0.0.1:9222",
      webSocketUrl: "ws://127.0.0.1:9222/devtools/page/main",
      createWebSocket: () => {
        wsRef = new MockCdpWebSocket((msg) => {
          if (msg.method === "Runtime.evaluate") {
            // Main frame returns empty matches; OOPIF child session returns the button at (20, 30)
            if (msg.sessionId === "child-oopif-1") {
              return {
                result: {
                  value: [
                    {
                      tag: "button",
                      text: "Pay Now",
                      testId: "stripe-pay",
                      rect: { x: 20, y: 30, width: 120, height: 40 },
                      visible: true,
                      enabled: true,
                    },
                  ],
                },
              };
            }
            return { result: { value: [] } };
          }
          return {};
        });
        return wsRef;
      },
    });

    await channel.connect();
    channel.addChildSession("child-oopif-1", {
      targetId: "frame-stripe-1",
      url: "https://js.stripe.com/v3/card",
    });
    // Iframe sits at (100, 200) inside the top-level viewport
    channel.setFrameOffsetResolver(async (child) =>
      child.targetId === "frame-stripe-1" ? { x: 100, y: 200 } : { x: 0, y: 0 },
    );

    const matches = await channel.query({ testID: "stripe-pay" });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("Pay Now");
    // Viewport coordinates are translated by the iframe offset!
    expect(matches[0]!.rect).toEqual({ x: 120, y: 230, width: 120, height: 40 });

    // Remove child session and verify it's no longer probed
    channel.removeChildSession("child-oopif-1");
    expect(channel.getChildSessions()).toHaveLength(0);
    const afterDetach = await channel.query({ testID: "stripe-pay" });
    expect(afterDetach).toHaveLength(0);

    await channel.disconnect();
  });

  it("tracks Target.attachedToTarget / detachedFromTarget and resolves DOM.getFrameOwner box offset in cdp-browser", async () => {
    let wsRef!: MockCdpWebSocket;

    const driver = await Effect.runPromise(
      makeLightweightCdpDriver({
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
        useBrowserContexts: true,
        createWebSocket: () => {
          wsRef = new MockCdpWebSocket((msg) => {
            if (msg.method === "Target.createBrowserContext") {
              return { browserContextId: "ctx-1" };
            }
            if (msg.method === "Target.createTarget") {
              return { targetId: "page-1" };
            }
            if (msg.method === "Target.attachToTarget") {
              return { sessionId: "sess-main" };
            }
            if (msg.method === "DOM.getFrameOwner") {
              return { backendNodeId: 77 };
            }
            if (msg.method === "DOM.getBoxModel") {
              // Content quad: [x1, y1, x2, y2, ...] -> top-left at (150, 250)
              return { model: { content: [150, 250, 550, 250, 550, 450, 150, 450] } };
            }
            if (msg.method === "Runtime.evaluate") {
              const expr = String(msg.params?.expression ?? "");
              if (msg.sessionId === "sess-oopif") {
                if (expr.includes("valueSetter") || expr.includes("dispatchEvent")) {
                  return { result: { value: true } };
                }
                return {
                  result: {
                    value: [
                      {
                        tag: "input",
                        text: "",
                        testId: "card-number",
                        rect: { x: 10, y: 15, width: 200, height: 32 },
                        visible: true,
                        enabled: true,
                      },
                    ],
                  },
                };
              }
              if (expr.includes("valueSetter") || expr.includes("dispatchEvent")) {
                return { result: { value: false } };
              }
              return { result: { value: [] } };
            }
            return {};
          });
          return wsRef;
        },
      }),
    );

    // Verify Target.setAutoAttach was requested during session configuration
    expect(
      wsRef.sent.some(
        (m) =>
          m.method === "Target.setAutoAttach" &&
          m.params?.autoAttach === true &&
          m.params?.flatten === true,
      ),
    ).toBe(true);

    // Simulate Chromium attaching a cross-origin iframe target
    wsRef.emitCdpEvent("Target.attachedToTarget", {
      sessionId: "sess-oopif",
      targetInfo: {
        targetId: "frame-oopif-42",
        type: "iframe",
        url: "https://checkout.example.com/card-input",
      },
    });

    const cdp = driver.domChannel as CdpDomChannel;
    expect(cdp.getChildSessions()).toHaveLength(1);

    // Query falls back into OOPIF child session and translates rect by (150, 250) from DOM.getBoxModel
    const matches = await cdp.query({ testID: "card-number" });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.rect).toEqual({ x: 160, y: 265, width: 200, height: 32 });

    // fillDom falls back into OOPIF child session seamlessly
    const filled = await cdp.fillDom({ testID: "card-number" }, "4242");
    expect(filled).toBe(true);

    // Detaching removes the child session
    wsRef.emitCdpEvent("Target.detachedFromTarget", { sessionId: "sess-oopif" });
    expect(cdp.getChildSessions()).toHaveLength(0);

    await cdp.disconnect();
  });

  it("resolveWebEngine routes engine: 'auto' to direct CDP for Chromium and falls back to Playwright when needed", () => {
    const autoChromium: ProvConfig = {
      execution: { web: { engine: "auto", browser: "chromium" } },
    };
    expect(resolveWebEngine(autoChromium)).toBe("cdp");

    const autoDefaultBrowser: ProvConfig = {
      execution: { web: { engine: "auto" } },
    };
    expect(resolveWebEngine(autoDefaultBrowser)).toBe("cdp");

    const autoFirefox: ProvConfig = {
      execution: { web: { engine: "auto", browser: "firefox" } },
    };
    expect(resolveWebEngine(autoFirefox)).toBe("playwright");

    const autoWithHar: ProvConfig = {
      execution: { web: { engine: "auto", browser: "chromium" } },
      artifacts: { har: true },
    };
    expect(resolveWebEngine(autoWithHar)).toBe("playwright");

    const autoWithWsEndpoint: ProvConfig = {
      execution: { web: { engine: "auto", wsEndpoint: "ws://remote:3000" } },
    };
    expect(resolveWebEngine(autoWithWsEndpoint)).toBe("playwright");

    const explicitCdp: ProvConfig = {
      execution: { web: { engine: "cdp" } },
    };
    expect(resolveWebEngine(explicitCdp)).toBe("cdp");

    const defaultOmitted: ProvConfig = {};
    expect(resolveWebEngine(defaultOmitted)).toBe("playwright");
  });
});
