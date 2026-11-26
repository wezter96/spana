/**
 * WebAssembly (WASM) runtime utilities, GPU/WebGPU launch flags, trap classification,
 * byte-budget parsing, and in-page instrumentation scripts for Spana.
 */

export type WebGpuMode = "auto" | "swiftshader" | "hardware" | "disabled";

export interface WasmSemanticNode {
  testID?: string;
  id?: string;
  role?: string;
  label?: string;
  text?: string;
  value?: string;
  bounds: { x: number; y: number; width: number; height: number };
  visible?: boolean;
  enabled?: boolean;
  clickable?: boolean;
  focused?: boolean;
  checked?: boolean;
  editable?: boolean;
  attributes?: Record<string, string>;
  /** Optional CSS selector of the host `<canvas>` element when bounds are canvas-local. */
  canvasSelector?: string;
}

export interface WasmModuleMetric {
  id: number;
  name?: string;
  sizeBytes?: number;
  compileMs?: number;
  instantiateMs?: number;
  memoryBytes?: number;
  memoryPages?: number;
  instantiatedAt: number;
}

export interface WasmTrap {
  name: string;
  message: string;
  source: "main" | "worker" | "wasm";
  workerUrl?: string;
  stack?: string;
  timestamp: number;
}

export interface CrossOriginIsolationReport {
  crossOriginIsolated: boolean;
  sharedArrayBufferAvailable: boolean;
  coopHeader?: string;
  coepHeader?: string;
  hint?: string;
}

export interface WasmMetrics {
  moduleCount: number;
  pendingCount: number;
  wasmMemoryBytes: number;
  wasmMemoryPages: number;
  peakWasmMemoryBytes: number;
  jsHeapUsedBytes?: number;
  jsHeapTotalBytes?: number;
  fps?: number;
  crossOriginIsolated: boolean;
  sharedArrayBufferAvailable: boolean;
  traps: WasmTrap[];
  modules: WasmModuleMetric[];
}

/**
 * Resolve Chromium GPU / WebGL2 / WebGPU CLI flags cleanly for headless and headed runs.
 * - `"disabled"`: passes `--disable-gpu` in headless mode (fastest for pure DOM suites).
 * - `"swiftshader"`: enables deterministic software WebGL2/WebGPU via ANGLE SwiftShader
 *   (pixel-consistent across macOS/Linux CI without a physical GPU).
 * - `"hardware"`: omits `--disable-gpu` so Chromium uses the host GPU.
 * - `"auto"` (default): uses `"swiftshader"` when `webgpu: true` in headless mode,
 *   `"hardware"` when headed, and `"disabled"` in plain headless DOM mode.
 */
export function resolveChromiumGpuArgs(options: {
  headless?: boolean;
  gpu?: WebGpuMode;
  webgpu?: boolean;
}): string[] {
  const headless = options.headless !== false;
  const webgpu = Boolean(options.webgpu);
  const requested = options.gpu ?? "auto";
  const effective: Exclude<WebGpuMode, "auto"> =
    requested === "auto"
      ? webgpu
        ? headless
          ? "swiftshader"
          : "hardware"
        : headless
          ? "disabled"
          : "hardware"
      : requested;

  const args: string[] = [];
  if (effective === "disabled") {
    if (headless) args.push("--disable-gpu");
    return args;
  }

  if (effective === "swiftshader") {
    args.push("--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
    if (webgpu) {
      args.push("--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer");
    }
    return args;
  }

  // hardware
  if (webgpu) {
    args.push("--enable-unsafe-webgpu");
  }
  return args;
}

/**
 * Parse a human-friendly byte limit (e.g. `64 * 1024 * 1024`, `"64MB"`, `"128MiB"`, `"512KB"`)
 * into an exact integer byte count.
 */
export function parseByteSize(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Invalid byte size: ${input}`);
    }
    return Math.round(input);
  }
  const trimmed = input.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid byte size "${input}". Expected a number of bytes or a string like "64MB", "128MiB", or "512KB".`,
    );
  }
  const value = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    gb: 1000 * 1000 * 1000,
    gib: 1024 * 1024 * 1024,
  };
  return Math.round(value * (multipliers[unit] ?? 1));
}

export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB (${bytes.toLocaleString("en-US")} B)`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB (${bytes.toLocaleString("en-US")} B)`;
  }
  return `${bytes} B`;
}

const WASM_TRAP_RE =
  /(WebAssembly\.(RuntimeError|CompileError|LinkError)|wasm-function\[|memory access out of bounds|table index is out of bounds|integer divide by zero|integer overflow|unreachable executed|indirect call type mismatch|out of bounds memory access|null function or function signature mismatch)/i;

/** Detect whether an error name/message/stack represents a WebAssembly trap or link/compile error. */
export function isWasmTrapError(err: { name?: string; message?: string; stack?: string }): boolean {
  const combined = `${err.name ?? ""} ${err.message ?? ""} ${err.stack ?? ""}`;
  return WASM_TRAP_RE.test(combined);
}

/**
 * Lightweight, zero-overhead in-page WebAssembly instrumentation hook installed once per document.
 * Tracks `WebAssembly.instantiate` / `instantiateStreaming` / `compile` / `compileStreaming`,
 * live `WebAssembly.Memory` instances (via WeakRef so GC is never impeded), and WASM traps.
 */
export const SPANA_WASM_HOOK_SCRIPT = `(function() {
  if (typeof globalThis === "undefined" || globalThis.__spanaWasm) return;
  var state = {
    moduleCount: 0,
    pendingCount: 0,
    peakWasmMemoryBytes: 0,
    modules: [],
    memories: [],
    traps: []
  };
  var nextId = 1;
  var WASM_RE = /(WebAssembly\\.(RuntimeError|CompileError|LinkError)|wasm-function\\[|memory access out of bounds|table index is out of bounds|integer divide by zero|unreachable|indirect call type mismatch|out of bounds memory access)/i;

  function trackMemory(mem) {
    if (!mem || typeof mem !== "object" || !(mem.buffer instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && mem.buffer instanceof SharedArrayBuffer))) {
      return;
    }
    var already = false;
    var alive = [];
    for (var i = 0; i < state.memories.length; i++) {
      var ref = state.memories[i];
      var cur = typeof ref.deref === "function" ? ref.deref() : ref;
      if (!cur) continue;
      if (cur === mem) already = true;
      alive.push(ref);
    }
    if (!already) {
      alive.push(typeof WeakRef !== "undefined" ? new WeakRef(mem) : mem);
    }
    state.memories = alive;
    computeMemoryBytes();
  }

  function computeMemoryBytes() {
    var total = 0;
    var alive = [];
    for (var i = 0; i < state.memories.length; i++) {
      var ref = state.memories[i];
      var cur = typeof ref.deref === "function" ? ref.deref() : ref;
      if (!cur) continue;
      alive.push(ref);
      try {
        total += cur.buffer ? cur.buffer.byteLength : 0;
      } catch (e) {}
    }
    state.memories = alive;
    if (total > state.peakWasmMemoryBytes) state.peakWasmMemoryBytes = total;
    return total;
  }

  function trackExports(instance) {
    if (!instance || !instance.exports) return { bytes: 0, pages: 0 };
    var bytes = 0;
    try {
      var keys = Object.keys(instance.exports);
      for (var i = 0; i < keys.length; i++) {
        var val = instance.exports[keys[i]];
        if (typeof WebAssembly !== "undefined" && typeof WebAssembly.Memory === "function" && val instanceof WebAssembly.Memory) {
          trackMemory(val);
          try { bytes += val.buffer.byteLength; } catch (e) {}
        }
      }
    } catch (e) {}
    return { bytes: bytes, pages: Math.round(bytes / 65536) };
  }

  function recordTrap(name, message, stack) {
    var combined = String(name || "") + " " + String(message || "") + " " + String(stack || "");
    if (!WASM_RE.test(combined)) return;
    state.traps.push({
      name: String(name || "WebAssembly.RuntimeError"),
      message: String(message || "WebAssembly trap"),
      source: typeof window === "undefined" ? "worker" : "main",
      stack: stack ? String(stack) : undefined,
      timestamp: Date.now()
    });
    if (state.traps.length > 100) state.traps.shift();
  }

  function getSizeBytes(src) {
    if (!src) return undefined;
    if (typeof src.byteLength === "number") return src.byteLength;
    return undefined;
  }

  if (typeof WebAssembly !== "undefined") {
    var origInstantiate = WebAssembly.instantiate;
    if (typeof origInstantiate === "function") {
      WebAssembly.instantiate = function(source, importObject) {
        state.pendingCount += 1;
        var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
        var sizeBytes = getSizeBytes(source);
        return Promise.resolve(origInstantiate.apply(WebAssembly, arguments)).then(
          function(res) {
            state.pendingCount = Math.max(0, state.pendingCount - 1);
            state.moduleCount += 1;
            var inst = res && res.instance ? res.instance : res;
            var memInfo = trackExports(inst);
            var elapsed = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
            state.modules.push({
              id: nextId++,
              sizeBytes: sizeBytes,
              instantiateMs: elapsed,
              memoryBytes: memInfo.bytes || undefined,
              memoryPages: memInfo.pages || undefined,
              instantiatedAt: Date.now()
            });
            return res;
          },
          function(err) {
            state.pendingCount = Math.max(0, state.pendingCount - 1);
            recordTrap(err && err.name, err && err.message ? err.message : String(err), err && err.stack);
            throw err;
          }
        );
      };
    }

    var origInstantiateStreaming = WebAssembly.instantiateStreaming;
    if (typeof origInstantiateStreaming === "function") {
      WebAssembly.instantiateStreaming = function(source, importObject) {
        state.pendingCount += 1;
        var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
        return Promise.resolve(origInstantiateStreaming.apply(WebAssembly, arguments)).then(
          function(res) {
            state.pendingCount = Math.max(0, state.pendingCount - 1);
            state.moduleCount += 1;
            var inst = res && res.instance ? res.instance : res;
            var memInfo = trackExports(inst);
            var elapsed = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
            state.modules.push({
              id: nextId++,
              instantiateMs: elapsed,
              memoryBytes: memInfo.bytes || undefined,
              memoryPages: memInfo.pages || undefined,
              instantiatedAt: Date.now()
            });
            return res;
          },
          function(err) {
            state.pendingCount = Math.max(0, state.pendingCount - 1);
            recordTrap(err && err.name, err && err.message ? err.message : String(err), err && err.stack);
            throw err;
          }
        );
      };
    }

    var OrigMemory = WebAssembly.Memory;
    if (typeof OrigMemory === "function") {
      try {
        var WrappedMemory = new Proxy(OrigMemory, {
          construct: function(target, args, newTarget) {
            var mem = Reflect.construct(target, args, newTarget);
            trackMemory(mem);
            return mem;
          }
        });
        WebAssembly.Memory = WrappedMemory;
      } catch (e) {}
    }

    var OrigInstance = WebAssembly.Instance;
    if (typeof OrigInstance === "function") {
      try {
        var WrappedInstance = new Proxy(OrigInstance, {
          construct: function(target, args, newTarget) {
            var t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
            var inst = Reflect.construct(target, args, newTarget);
            state.moduleCount += 1;
            var memInfo = trackExports(inst);
            state.modules.push({
              id: nextId++,
              instantiateMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0),
              memoryBytes: memInfo.bytes || undefined,
              memoryPages: memInfo.pages || undefined,
              instantiatedAt: Date.now()
            });
            return inst;
          }
        });
        WebAssembly.Instance = WrappedInstance;
      } catch (e) {}
    }
  }

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("error", function(ev) {
      var err = ev && ev.error;
      recordTrap(err && err.name, (err && err.message) || (ev && ev.message), err && err.stack);
    });
    globalThis.addEventListener("unhandledrejection", function(ev) {
      var reason = ev && ev.reason;
      recordTrap(reason && reason.name, reason && reason.message ? reason.message : String(reason), reason && reason.stack);
    });
  }

  globalThis.__spanaWasm = {
    trackMemory: trackMemory,
    recordTrap: recordTrap,
    getMetrics: function() {
      var bytes = computeMemoryBytes();
      var perfMem = typeof performance !== "undefined" && performance.memory ? performance.memory : null;
      return {
        moduleCount: state.moduleCount,
        pendingCount: state.pendingCount,
        wasmMemoryBytes: bytes,
        wasmMemoryPages: Math.round(bytes / 65536),
        peakWasmMemoryBytes: state.peakWasmMemoryBytes,
        jsHeapUsedBytes: perfMem ? perfMem.usedJSHeapSize : undefined,
        jsHeapTotalBytes: perfMem ? perfMem.totalJSHeapSize : undefined,
        crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
        sharedArrayBufferAvailable: typeof SharedArrayBuffer !== "undefined",
        traps: state.traps.slice(),
        modules: state.modules.slice()
      };
    },
    isReady: function(minModules) {
      var req = typeof minModules === "number" ? minModules : 1;
      var explicit = globalThis.__SPANA_WASM_READY__;
      if (typeof explicit === "function") {
        try { if (!explicit()) return false; } catch (e) { return false; }
      } else if (explicit === false) {
        return false;
      }
      return state.pendingCount === 0 && (state.moduleCount >= req || explicit === true);
    }
  };
})();`;
