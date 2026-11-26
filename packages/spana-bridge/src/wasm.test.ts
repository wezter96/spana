import { describe, expect, test } from "bun:test";
import { initSpanaBridge } from "./client.js";
import { enableFlutterSemantics, registerWasmSemanticTree, setWasmReady } from "./wasm.js";

describe("spana-bridge WASM semantic tree & Flutter semantics helpers", () => {
  test("registerWasmSemanticTree feeds spana-bridge query() and enableFlutterSemantics clicks placeholder", () => {
    const fakeWin: Record<string, any> = {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
    };
    let flutterClicked = false;
    const fakeDoc: any = {
      querySelectorAll: () => [],
      querySelector: (sel: string) => {
        if (sel === "#gl-canvas") {
          return { getBoundingClientRect: () => ({ left: 100, top: 50, width: 600, height: 400 }) };
        }
        if (sel === "flt-semantics-placeholder") {
          return {
            click: () => {
              flutterClicked = true;
            },
          };
        }
        return null;
      },
    };

    const unregister = registerWasmSemanticTree(
      () => [
        {
          testID: "wasm-play",
          role: "button",
          text: "Start Game",
          bounds: { x: 20, y: 30, width: 120, height: 44 },
        },
      ],
      { canvasSelector: "#gl-canvas", win: fakeWin },
    );
    setWasmReady(true, fakeWin);
    expect(fakeWin.__SPANA_WASM_READY__).toBe(true);

    const bridge = initSpanaBridge({
      reconnectDelayMs: 0,
      WebSocketImpl: class FakeWS {
        addEventListener() {}
        close() {}
      } as any,
      env: { window: fakeWin, document: fakeDoc },
    });

    const hits = bridge.query({ testID: "wasm-play" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rect).toEqual({ x: 120, y: 80, width: 120, height: 44 });
    expect(hits[0]!.role).toBe("button");
    expect(hits[0]!.text).toBe("Start Game");

    const byRoleHits = bridge.query({ role: "button", name: "Start Game" });
    expect(byRoleHits).toHaveLength(1);

    expect(enableFlutterSemantics(fakeDoc)).toBe(true);
    expect(flutterClicked).toBe(true);

    unregister();
    expect(bridge.query({ testID: "wasm-play" })).toHaveLength(0);
    bridge.destroy();
  });
});
