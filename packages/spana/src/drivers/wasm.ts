import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { DriverError } from "../errors.js";
import type { Element } from "../schemas/element.js";
import type { BrowserConsoleLog, BrowserJSError, RawDriverService } from "./raw-driver.js";
import { defineDriverAdapter, type DriverAdapter } from "./adapter-registry.js";
import { isWasmTrapError, type WasmMetrics, type WasmTrap } from "./wasm-utils.js";

const execFileAsync = promisify(execFile);

export type WasmRuntimeMode = "in-process" | "wasi" | "wasmtime";
export type WasmImports = Record<string, Record<string, unknown>>;
export type WasmExports = Record<string, unknown>;

export interface WasmDriverOptions {
  /** Path to a compiled `.wasm` binary (or pass raw `wasmBytes`). */
  modulePath?: string;
  /** Raw `.wasm` bytes for in-memory testing without touching disk. */
  wasmBytes?: Uint8Array;
  /** Execution runtime: `"in-process"` (default WebAssembly.instantiate), `"wasi"` (`node:wasi`), or `"wasmtime"` CLI. */
  runtime?: WasmRuntimeMode;
  /** Custom WebAssembly import object for `"in-process"` instantiation. */
  imports?: WasmImports;
  /** CLI arguments passed to WASI / wasmtime modules. */
  args?: string[];
  /** Environment variables passed to WASI / wasmtime modules. */
  env?: Record<string, string>;
  /** Preopened host directories mapped into WASI (`{ "/sandbox": "./tmp" }`). */
  preopens?: Record<string, string>;
  /** Optional export function name invoked on `launchApp` (default: `_start` for WASI). */
  entryExport?: string;
  /**
   * Optional state/UI tree projection for headless WASM apps.
   * When provided (or when the module exports `spana_tree_json`), Spana's `{ testID }`
   * and `expect(...)` selectors work directly against the WASM module's logical tree.
   */
  treeProvider?: (exports: WasmExports, memory?: WebAssembly.Memory) => Element | Promise<Element>;
  /** Explicit path to `wasmtime` binary when `runtime: "wasmtime"`. Default: `"wasmtime"`. */
  wasmtimeBinary?: string;
}

export interface WasmEvalContext {
  exports: WasmExports;
  memory?: WebAssembly.Memory;
  /** Helper to read a UTF-8 string from linear memory. */
  readUtf8(ptr: number, byteLength: number): string;
  /** Helper to write a UTF-8 string into linear memory. */
  writeUtf8(ptr: number, text: string): number;
}

function emptyRoot(): Element {
  return {
    id: "wasm-root",
    elementType: "WasmModule",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    enabled: true,
    visible: true,
    clickable: false,
    children: [],
  };
}

function findPrimaryMemory(exports: WasmExports | null): WebAssembly.Memory | undefined {
  if (!exports) return undefined;
  if (exports.memory instanceof WebAssembly.Memory) return exports.memory;
  for (const val of Object.values(exports)) {
    if (val instanceof WebAssembly.Memory) return val;
  }
  return undefined;
}

/**
 * Create a headless WebAssembly / WASI `RawDriverService`.
 *
 * Works seamlessly with Spana's `executeFlow`, `app.evaluate`, `expect.noWasmTraps()`,
 * `expect.wasmMemoryBelow()`, `app.getWasmMetrics()`, `app.getConsoleLogs()`, and
 * `DriverAdapterRegistry` — with zero browser required.
 */
export function createWasmDriver(
  options: WasmDriverOptions,
): Effect.Effect<RawDriverService, DriverError> {
  return Effect.sync(() => {
    const runtime: WasmRuntimeMode = options.runtime ?? "in-process";
    let instance: WebAssembly.Instance | null = null;
    let compiledModule: WebAssembly.Module | null = null;
    let lastBytes: Uint8Array | null = null;
    let peakMemoryBytes = 0;
    let instantiateMs = 0;
    let moduleCount = 0;
    const consoleLogs: BrowserConsoleLog[] = [];
    const jsErrors: BrowserJSError[] = [];
    const wasmTraps: WasmTrap[] = [];

    const recordError = (err: unknown) => {
      const name = err instanceof Error ? err.name : "Error";
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      jsErrors.push({ name, message, stack });
      if (isWasmTrapError({ name, message, stack }) || err instanceof WebAssembly.RuntimeError) {
        wasmTraps.push({
          name,
          message,
          source: "wasm",
          stack,
          timestamp: Date.now(),
        });
      }
    };

    const readMemoryBytes = (): number => {
      const mem = findPrimaryMemory(instance?.exports ?? null);
      const bytes = mem ? mem.buffer.byteLength : 0;
      if (bytes > peakMemoryBytes) peakMemoryBytes = bytes;
      return bytes;
    };

    const loadBytes = async (bundleId?: string): Promise<Uint8Array> => {
      if (options.wasmBytes) return options.wasmBytes;
      const targetPath =
        options.modulePath || (bundleId && bundleId.endsWith(".wasm") ? bundleId : undefined);
      if (!targetPath) {
        throw new Error("WASM driver requires `modulePath` or `wasmBytes`.");
      }
      const buf = await readFile(targetPath);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    };

    const instantiateNow = async (bundleId?: string) => {
      const t0 = performance.now();
      const bytes = await loadBytes(bundleId);
      lastBytes = bytes;

      if (runtime === "wasmtime") {
        const binary = options.wasmtimeBinary ?? "wasmtime";
        const cliArgs: string[] = [];
        for (const [guest, host] of Object.entries(options.preopens ?? {})) {
          cliArgs.push("--dir", `${host}::${guest}`);
        }
        for (const [k, v] of Object.entries(options.env ?? {})) {
          cliArgs.push("--env", `${k}=${v}`);
        }
        if (!options.modulePath) {
          throw new Error('WASM runtime "wasmtime" requires `modulePath` on disk.');
        }
        cliArgs.push(options.modulePath, ...(options.args ?? []));
        try {
          const { stdout, stderr } = await execFileAsync(binary, cliArgs, { encoding: "utf8" });
          if (stdout.trim()) consoleLogs.push({ type: "log", text: stdout.trim() });
          if (stderr.trim()) consoleLogs.push({ type: "error", text: stderr.trim() });
          moduleCount += 1;
          instantiateMs = Math.round(performance.now() - t0);
        } catch (err: any) {
          if (err?.stdout) consoleLogs.push({ type: "log", text: String(err.stdout).trim() });
          if (err?.stderr) consoleLogs.push({ type: "error", text: String(err.stderr).trim() });
          recordError(err);
          throw err;
        }
        return;
      }

      if (runtime === "wasi") {
        const { WASI } = await import("node:wasi");
        const wasi = new WASI({
          version: "preview1",
          args: [options.modulePath ?? "module.wasm", ...(options.args ?? [])],
          env: options.env ?? {},
          preopens: options.preopens ?? {},
        });
        const mod = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
        compiledModule = mod;
        const imports: WasmImports = {
          ...(wasi.getImportObject() as WasmImports),
          ...options.imports,
        };
        const inst = await WebAssembly.instantiate(mod, imports as any);
        instance = inst;
        moduleCount += 1;
        readMemoryBytes();
        instantiateMs = Math.round(performance.now() - t0);
        try {
          if (typeof inst.exports._start === "function") {
            wasi.start(inst);
          } else if (typeof inst.exports._initialize === "function") {
            wasi.initialize(inst);
          }
        } catch (err) {
          recordError(err);
          throw err;
        }
        readMemoryBytes();
        return;
      }

      // Default: in-process WebAssembly.instantiate
      try {
        const mod = await WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
        compiledModule = mod;
        const inst = await WebAssembly.instantiate(mod, (options.imports ?? {}) as any);
        instance = inst;
        moduleCount += 1;
        readMemoryBytes();
        instantiateMs = Math.round(performance.now() - t0);
        if (options.entryExport && typeof inst.exports[options.entryExport] === "function") {
          (inst.exports[options.entryExport] as () => unknown)();
          readMemoryBytes();
        }
      } catch (err) {
        recordError(err);
        throw err;
      }
    };

    const buildEvalContext = (): WasmEvalContext => {
      const exports = instance?.exports ?? {};
      const memory = findPrimaryMemory(exports);
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      return {
        exports,
        memory,
        readUtf8(ptr: number, byteLength: number): string {
          if (!memory) throw new Error("WASM module does not export linear memory");
          return decoder.decode(new Uint8Array(memory.buffer, ptr, byteLength));
        },
        writeUtf8(ptr: number, text: string): number {
          if (!memory) throw new Error("WASM module does not export linear memory");
          const encoded = encoder.encode(text);
          new Uint8Array(memory.buffer, ptr, encoded.byteLength).set(encoded);
          return encoded.byteLength;
        },
      };
    };

    const getMetrics = (): WasmMetrics => {
      const bytes = readMemoryBytes();
      return {
        moduleCount,
        pendingCount: 0,
        wasmMemoryBytes: bytes,
        wasmMemoryPages: Math.round(bytes / 65536),
        peakWasmMemoryBytes: peakMemoryBytes,
        crossOriginIsolated: true,
        sharedArrayBufferAvailable: typeof SharedArrayBuffer !== "undefined",
        traps: [...wasmTraps],
        modules:
          moduleCount > 0
            ? [
                {
                  id: 1,
                  name: options.modulePath,
                  sizeBytes: lastBytes?.byteLength,
                  instantiateMs,
                  memoryBytes: bytes,
                  memoryPages: Math.round(bytes / 65536),
                  instantiatedAt: Date.now(),
                },
              ]
            : [],
      };
    };

    const service: RawDriverService = {
      beginFlow: () =>
        Effect.sync(() => {
          consoleLogs.length = 0;
          jsErrors.length = 0;
          wasmTraps.length = 0;
        }),

      launchApp: (bundleId) =>
        Effect.tryPromise({
          try: () => instantiateNow(bundleId),
          catch: (e) => new DriverError({ message: `WASM launchApp failed: ${e}` }),
        }),

      stopApp: () =>
        Effect.sync(() => {
          instance = null;
        }),

      killApp: () =>
        Effect.sync(() => {
          instance = null;
          compiledModule = null;
        }),

      clearAppState: (bundleId) =>
        Effect.tryPromise({
          try: async () => {
            instance = null;
            consoleLogs.length = 0;
            jsErrors.length = 0;
            wasmTraps.length = 0;
            if (lastBytes || options.modulePath || options.wasmBytes) {
              await instantiateNow(bundleId);
            }
          },
          catch: (e) => new DriverError({ message: `WASM clearAppState failed: ${e}` }),
        }),

      dumpHierarchy: () =>
        Effect.tryPromise({
          try: async () => {
            if (!instance) return JSON.stringify(emptyRoot());
            const mem = findPrimaryMemory(instance.exports);
            if (options.treeProvider) {
              const tree = await options.treeProvider(instance.exports, mem);
              return JSON.stringify(tree);
            }
            return JSON.stringify({
              ...emptyRoot(),
              text: options.modulePath ?? "wasm-module",
              attributes: {
                exports: Object.keys(instance.exports).join(","),
                wasmMemoryBytes: String(readMemoryBytes()),
              },
            });
          },
          catch: (e) => new DriverError({ message: `WASM dumpHierarchy failed: ${e}` }),
        }),

      evaluate: <T = unknown>(script: string | ((...args: any[]) => T), ...args: any[]) =>
        Effect.tryPromise({
          try: async () => {
            if (!instance && (options.modulePath || options.wasmBytes)) {
              await instantiateNow();
            }
            const ctx = buildEvalContext();
            try {
              const res =
                typeof script === "function"
                  ? await script(ctx, ...args)
                  : await new Function("wasm", "exports", "memory", `return (${script})`)(
                      ctx,
                      ctx.exports,
                      ctx.memory,
                    );
              readMemoryBytes();
              return res as T;
            } catch (err) {
              recordError(err);
              throw err;
            }
          },
          catch: (e) =>
            new DriverError({
              message: `WASM evaluate failed: ${e instanceof Error ? e.message : String(e)}`,
            }),
        }),

      getWasmMetrics: () => Effect.sync(() => getMetrics()),
      getWasmTraps: () => Effect.sync(() => [...wasmTraps]),
      getConsoleLogs: () => Effect.sync(() => [...consoleLogs]),
      getJSErrors: () => Effect.sync(() => [...jsErrors]),

      tapAtCoordinate: () => Effect.void,
      doubleTapAtCoordinate: () => Effect.void,
      longPressAtCoordinate: () => Effect.void,
      swipe: () => Effect.void,
      inputText: () => Effect.void,
      pressKey: () => Effect.void,
      hideKeyboard: () => Effect.void,
      takeScreenshot: () => Effect.sync(() => new Uint8Array()),
      getDeviceInfo: () =>
        Effect.sync(() => ({
          deviceId: options.modulePath ?? "wasm-in-process",
          name: `Spana WASM (${runtime}${compiledModule ? ", loaded" : ""})`,
          platform: "web" as const,
          isEmulator: false,
          screenWidth: 1280,
          screenHeight: 720,
          driverType: "wasm" as const,
        })),
      openLink: () => Effect.void,
      back: () => Effect.void,
    };

    return service;
  });
}

/**
 * Pluggable `DriverAdapter` for headless WebAssembly / WASI testing.
 * Register via `registerDriverAdapter(createWasmDriverAdapter({ modulePath: "./app.wasm" }))`
 * or run directly with `executeFlow(flow, await Effect.runPromise(createWasmDriver(...)))`.
 */
export function createWasmDriverAdapter(
  defaults: Partial<WasmDriverOptions> = {},
): DriverAdapter<WasmDriverOptions> {
  return defineDriverAdapter<WasmDriverOptions>({
    name: "wasm",
    platforms: ["wasm", "web"],
    engines: ["wasm", "wasi", "wasmtime"],
    description: "Headless WebAssembly & WASI driver adapter (in-process, node:wasi, or wasmtime)",
    async create(ctx) {
      const merged: WasmDriverOptions = {
        ...defaults,
        ...ctx.options,
        modulePath:
          ctx.options?.modulePath ??
          defaults.modulePath ??
          (ctx.appId.endsWith(".wasm") ? ctx.resolvePath(ctx.appId) : undefined),
      };
      const driver = await Effect.runPromise(createWasmDriver(merged));
      return {
        driver,
        parseHierarchy: (raw) => JSON.parse(raw) as Element,
        cleanup: async () => {
          await Effect.runPromise(driver.killApp(ctx.appId)).catch(() => {});
        },
        metadata: { runtime: merged.runtime ?? "in-process", modulePath: merged.modulePath },
      };
    },
  });
}
