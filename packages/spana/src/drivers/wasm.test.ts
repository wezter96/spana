import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Effect } from "effect";
import { flow } from "../api/flow.js";
import { executeFlow } from "../core/engine.js";
import {
  formatByteSize,
  isWasmTrapError,
  parseByteSize,
  resolveChromiumGpuArgs,
} from "./wasm-utils.js";
import { createWasmDriver, createWasmDriverAdapter } from "./wasm.js";
import { registerDriverAdapter, resolveDriverAdapter } from "./adapter-registry.js";
import { launchDirectCdpBrowser, makeLightweightCdpDriver } from "./cdp-browser.js";
import { parseWebHierarchy } from "./playwright-parser.js";

/**
 * Valid minimal WebAssembly binary (67 bytes) exporting:
 *   - `memory`: 1 page (64 KiB)
 *   - `add(i32, i32) -> i32`: returns a + b
 *   - `trap() -> void`: executes `unreachable` (triggers real WebAssembly.RuntimeError)
 */
const REAL_WASM_BYTES = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // magic \0asm
  0x01,
  0x00,
  0x00,
  0x00, // version 1
  // Type section (id=1): 2 types -> (i32,i32)->i32 and ()->()
  0x01,
  0x0a,
  0x02,
  0x60,
  0x02,
  0x7f,
  0x7f,
  0x01,
  0x7f,
  0x60,
  0x00,
  0x00,
  // Function section (id=3): func 0 -> type 0, func 1 -> type 1
  0x03,
  0x03,
  0x02,
  0x00,
  0x01,
  // Memory section (id=5): 1 memory, min 1 page (64 KiB)
  0x05,
  0x03,
  0x01,
  0x00,
  0x01,
  // Export section (id=7): "memory" (mem 0), "add" (func 0), "trap" (func 1)
  0x07,
  0x17,
  0x03,
  0x06,
  0x6d,
  0x65,
  0x6d,
  0x6f,
  0x72,
  0x79,
  0x02,
  0x00,
  0x03,
  0x61,
  0x64,
  0x64,
  0x00,
  0x00,
  0x04,
  0x74,
  0x72,
  0x61,
  0x70,
  0x00,
  0x01,
  // Code section (id=10):
  //   body 0 (add): local.get 0, local.get 1, i32.add, end
  //   body 1 (trap): unreachable, end
  0x0a,
  0x0d,
  0x02,
  0x07,
  0x00,
  0x20,
  0x00,
  0x20,
  0x01,
  0x6a,
  0x0b,
  0x03,
  0x00,
  0x00,
  0x0b,
]);

describe("WASM utilities (Pillar 1 & 4)", () => {
  test("resolveChromiumGpuArgs produces deterministic flags across modes", () => {
    expect(resolveChromiumGpuArgs({ headless: true })).toEqual(["--disable-gpu"]);
    expect(resolveChromiumGpuArgs({ headless: false })).toEqual([]);
    expect(resolveChromiumGpuArgs({ headless: true, gpu: "swiftshader" })).toEqual([
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ]);
    expect(resolveChromiumGpuArgs({ headless: true, webgpu: true })).toEqual([
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,UseSkiaRenderer",
    ]);
    expect(resolveChromiumGpuArgs({ headless: true, gpu: "hardware", webgpu: true })).toEqual([
      "--enable-unsafe-webgpu",
    ]);
  });

  test("parseByteSize and formatByteSize handle numeric and unit strings", () => {
    expect(parseByteSize(65536)).toBe(65536);
    expect(parseByteSize("64KiB")).toBe(65536);
    expect(parseByteSize("1MB")).toBe(1_000_000);
    expect(parseByteSize("2.5MiB")).toBe(Math.round(2.5 * 1024 * 1024));
    expect(formatByteSize(65536)).toContain("64.0 KiB");
    expect(() => parseByteSize("not-a-size")).toThrow();
  });

  test("isWasmTrapError identifies WebAssembly runtime/compile/link traps", () => {
    expect(isWasmTrapError({ name: "RuntimeError", message: "unreachable executed" })).toBe(true);
    expect(isWasmTrapError({ message: "memory access out of bounds" })).toBe(true);
    expect(isWasmTrapError({ name: "WebAssembly.CompileError", message: "bad magic" })).toBe(true);
    expect(isWasmTrapError({ name: "TypeError", message: "undefined is not a function" })).toBe(
      false,
    );
  });
});

describe("Headless WASM driver & DriverAdapter (Pillar 4 & 5)", () => {
  test("runs real compiled .wasm binary through executeFlow, tracks memory & catches traps", async () => {
    let lastSum = 0;
    const driver = await Effect.runPromise(
      createWasmDriver({
        wasmBytes: REAL_WASM_BYTES,
        treeProvider: () => ({
          id: "wasm-root",
          elementType: "WasmModule",
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
          enabled: true,
          visible: true,
          clickable: false,
          children: [
            {
              id: "wasm-sum",
              text: `Sum=${lastSum}`,
              bounds: { x: 10, y: 10, width: 100, height: 30 },
              enabled: true,
              visible: true,
              clickable: false,
            },
          ],
        }),
      }),
    );

    const f = flow("headless wasm module flow", async ({ app, expect: ex }) => {
      await app.launch();
      await app.waitForWasmReady({ minModules: 1 });
      const sum = await app.evaluate((ctx: any) => ctx.exports.add(20, 22));
      lastSum = sum as number;
      expect(sum).toBe(42);
      await ex({ testID: "wasm-sum" }).toHaveText("Sum=42");

      const metrics = await app.getWasmMetrics();
      expect(metrics.moduleCount).toBe(1);
      expect(metrics.wasmMemoryBytes).toBe(65536);
      expect(metrics.wasmMemoryPages).toBe(1);

      await ex.noWasmTraps();
      await ex.wasmMemoryBelow("128KiB");

      // Trigger a real WebAssembly unreachable trap and verify it is captured
      let threw = false;
      try {
        await app.evaluate((ctx: any) => ctx.exports.trap());
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      const traps = await app.getWasmTraps();
      expect(traps.length).toBeGreaterThanOrEqual(1);
      expect(traps[0]!.source).toBe("wasm");
    });

    const result = await executeFlow(f, driver, {
      appId: "inline.wasm",
      platform: "web",
      coordinatorConfig: {
        parse: (raw) => JSON.parse(raw),
        platform: "web",
      },
      autoLaunch: false,
      flowTimeout: 10_000,
    });
    expect(result.status).toBe("passed");
  });

  test("createWasmDriverAdapter registers cleanly in DriverAdapterRegistry", async () => {
    const adapter = createWasmDriverAdapter({ wasmBytes: REAL_WASM_BYTES });
    const unregister = registerDriverAdapter(adapter);
    try {
      const resolved = resolveDriverAdapter("wasm", "wasm");
      expect(resolved?.name).toBe("wasm");
      const handle = await resolved!.create({
        platform: "wasm",
        engine: "wasm",
        appId: "inline.wasm",
        config: {},
        resolvePath: (p) => p,
      });
      const sum = await Effect.runPromise(
        handle.driver.evaluate!((ctx: any) => ctx.exports.add(10, 5)),
      );
      expect(sum).toBe(15);
      await handle.cleanup();
    } finally {
      unregister();
    }
  });
});

describe("Live Chromium Direct CDP WASM, Canvas Semantic Tree, Worker Traps & COOP/COEP (Pillars 1-4)", () => {
  test("executes real WASM + WebGL SwiftShader + Canvas semantic tree + Worker trap + COOP/COEP + OPFS hot-cache", async () => {
    const wasmB64 = Buffer.from(REAL_WASM_BYTES).toString("base64");
    const html = `<!doctype html><html><head><title>Spana WASM Test</title></head>
<body style="margin:0;background:#0f172a;color:#fff;font-family:sans-serif">
  <canvas id="app-canvas" width="400" height="240" style="display:block;margin:20px;border:1px solid #334155"></canvas>
  <div data-testid="status">booting</div>
  <flt-semantics-placeholder style="display:block;width:1px;height:1px"></flt-semantics-placeholder>
  <script>
    const canvas = document.getElementById("app-canvas");
    const ctx2d = canvas.getContext("2d");
    const state = { clicks: 0, wheelDelta: 0, dragEndX: 0, flutterEnabled: false, sum: 0 };
    window.__state = state;
    function draw() {
      ctx2d.fillStyle = "#0ea5e9";
      ctx2d.fillRect(0, 0, 400, 240);
      ctx2d.fillStyle = "#10b981";
      ctx2d.fillRect(40, 50, 140, 48);
      ctx2d.fillStyle = "#fff";
      ctx2d.fillText("Save Canvas (" + state.clicks + ")", 55, 80);
    }
    draw();
    canvas.addEventListener("click", (e) => {
      const r = canvas.getBoundingClientRect();
      const lx = e.clientX - r.left;
      const ly = e.clientY - r.top;
      if (lx >= 40 && lx <= 180 && ly >= 50 && ly <= 98) {
        state.clicks += 1;
        draw();
      }
      state.lastClick = { lx: Math.round(lx), ly: Math.round(ly) };
    });
    canvas.addEventListener("wheel", (e) => {
      state.wheelDelta += Math.round(e.deltaY);
    });
    canvas.addEventListener("mouseup", (e) => {
      state.dragEndX = Math.round(e.clientX);
    });
    document.querySelector("flt-semantics-placeholder").addEventListener("click", () => {
      state.flutterEnabled = true;
    });

    // Expose Canvas WASM Semantic Tree (Pillar 2)
    window.__SPANA_WASM_TREE__ = () => [
      {
        testID: "canvas-save",
        role: "button",
        text: "Save Canvas (" + state.clicks + ")",
        label: "Save Canvas",
        canvasSelector: "#app-canvas",
        bounds: { x: 40, y: 50, width: 140, height: 48 }
      }
    ];

    // Instantiate real WebAssembly binary on main thread
    const raw = Uint8Array.from(atob("${wasmB64}"), (c) => c.charCodeAt(0));
    WebAssembly.instantiate(raw).then(({ instance }) => {
      window.__wasmInst = instance;
      state.sum = instance.exports.add(19, 23);
      document.querySelector('[data-testid="status"]').textContent = "ready:" + state.sum;
    });

    window.triggerWorkerWasmTrap = () => {
      const workerCode = \`
        const raw = Uint8Array.from(atob("${wasmB64}"), (c) => c.charCodeAt(0));
        WebAssembly.instantiate(raw).then(({ instance }) => {
          console.log("worker-wasm-ready");
          instance.exports.trap();
        });
      \`;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      return new Worker(URL.createObjectURL(blob));
    };
  </script>
</body></html>`;

    const srv: Server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      });
      res.end(html);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    let browser: Awaited<ReturnType<typeof launchDirectCdpBrowser>> | undefined;
    try {
      browser = await launchDirectCdpBrowser({
        headless: true,
        gpu: "swiftshader",
      });
      const driver = await Effect.runPromise(
        makeLightweightCdpDriver({
          cdpUrl: browser.browserWsUrl,
          baseUrl,
          engineLabel: "cdp",
          useBrowserContexts: true,
          freshContextPerFlow: true,
          contextIsolation: "hot-cache",
        }),
      );

      try {
        // Flow 1: WASM ready, COOP/COEP, canvas semantic tree tap, low-level input, canvas stable, memory/FPS, OPFS write
        const flow1 = flow("wasm canvas & metrics flow", async ({ app, expect: ex }) => {
          await app.openLink(baseUrl);
          await app.waitForWasmReady({ minModules: 1, timeout: 10_000 });
          await ex({ testID: "status" }).toHaveText("ready:42");

          // Verify COOP/COEP cross-origin isolation (SharedArrayBuffer ready)
          const iso = await app.checkCrossOriginIsolation();
          expect(iso.crossOriginIsolated).toBe(true);
          expect(iso.sharedArrayBufferAvailable).toBe(true);

          // Verify WebGL works under SwiftShader headless
          const hasWebgl = await app.evaluate<boolean>(
            `(() => { const c = document.createElement("canvas"); return Boolean(c.getContext("webgl2") || c.getContext("webgl")); })()`,
          );
          expect(hasWebgl).toBe(true);

          // Pillar 2: Query & tap canvas button via semantic tree!
          await ex({ testID: "canvas-save" }).toBeVisible();
          await ex({ role: "button", name: "Save Canvas" }).toHaveText("Save Canvas (0)");
          await app.tap({ testID: "canvas-save" });
          await ex({ testID: "canvas-save" }).toHaveText("Save Canvas (1)");

          // Low-level canvas inputs: wheel, dragXY, tapOffset, nextFrame, waitForCanvasStable, Flutter semantics
          await app.mouse.wheel(0, 120, { x: 100, y: 100 });
          await app.dragXY(60, 160, 220, 160, { steps: 5 });
          const afterDragX = await app.evaluate<number>("window.__state.dragEndX");
          expect(afterDragX).toBe(220);

          await app.tapOffset({ css: "#app-canvas" }, 10, 10);
          await app.clock.nextFrame(2);
          await app.waitForCanvasStable({ css: "#app-canvas" }, { quietMs: 100, timeout: 4000 });
          expect(await app.enableFlutterSemantics()).toBe(true);

          const st = await app.evaluate<any>("window.__state");
          expect(st.wheelDelta).toBe(120);
          expect(st.lastClick).toEqual({ lx: 10, ly: 10 });
          expect(st.flutterEnabled).toBe(true);

          // Pillar 4: WASM memory, trap & FPS assertions
          const metrics = await app.getWasmMetrics({ sampleFpsMs: 120 });
          expect(metrics.moduleCount).toBeGreaterThanOrEqual(1);
          expect(metrics.wasmMemoryBytes).toBe(65536);
          await ex.noWasmTraps();
          await ex.wasmMemoryBelow("1MiB");
          await ex.minFps(5, { durationMs: 150 });

          // Write an OPFS file so Flow 2 verifies hot-cache wipes OPFS cleanly
          await app.evaluate(
            `(async () => {
              const root = await navigator.storage.getDirectory();
              const fh = await root.getFileHandle("spana-opfs-test.db", { create: true });
              const w = await fh.createWritable();
              await w.write("wasm-sqlite-data");
              await w.close();
            })()`,
          );

          // Pillar 3: Trigger a real WASM trap inside a Web Worker and verify CDP captures it!
          await app.evaluate("window.triggerWorkerWasmTrap()");
          await ex
            .poll(async () => (await app.getWasmTraps()).length, { timeout: 5000 })
            .toBeGreaterThanOrEqual(1);
          const traps = await app.getWasmTraps();
          expect(traps.some((t) => t.source === "worker")).toBe(true);

          let trapAssertFailed = false;
          try {
            await ex.noWasmTraps();
          } catch {
            trapAssertFailed = true;
          }
          expect(trapAssertFailed).toBe(true);
        });

        const res1 = await executeFlow(flow1, driver, {
          appId: baseUrl,
          platform: "web",
          coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
          autoLaunch: false,
          flowTimeout: 25_000,
        });
        if (res1.status !== "passed") {
          throw new Error(`flow1 failed: ${res1.error?.message}`);
        }
        expect(res1.status).toBe("passed");

        // Flow 2: Verify hot-cache reset wiped OPFS & cleared previous traps cleanly
        const flow2 = flow("wasm hot-cache opfs isolation flow", async ({ app, expect: ex }) => {
          await app.openLink(baseUrl);
          await app.waitForWasmReady({ minModules: 1, timeout: 10_000 });
          await ex.noWasmTraps();
          const hasLeftoverOpfs = await app.evaluate<boolean>(
            `(async () => {
              const root = await navigator.storage.getDirectory();
              try {
                await root.getFileHandle("spana-opfs-test.db");
                return true;
              } catch {
                return false;
              }
            })()`,
          );
          expect(hasLeftoverOpfs).toBe(false);
        });

        const res2 = await executeFlow(flow2, driver, {
          appId: baseUrl,
          platform: "web",
          coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
          autoLaunch: false,
          flowTimeout: 20_000,
        });
        if (res2.status !== "passed") {
          throw new Error(`flow2 failed: ${res2.error?.message}`);
        }
        expect(res2.status).toBe("passed");
      } finally {
        await Effect.runPromise(driver.killApp(baseUrl)).catch(() => {});
      }
    } finally {
      await browser?.close();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
