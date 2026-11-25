import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativePngCompareResult {
  match: boolean;
  sizeMismatch: boolean;
  diffPixelCount: number;
  diffPixelRatio: number;
  diffImage?: Buffer;
}

export interface NativeXmlRawNode {
  tagName: string;
  attrs: Record<string, string>;
  children: NativeXmlRawNode[];
}

interface LoadedNativeLib {
  comparePng: (
    expected: Buffer | Uint8Array,
    actual: Buffer | Uint8Array,
    threshold: number,
    maxDiffRatio: number,
    layoutTolerant: boolean,
  ) => NativePngCompareResult | null;
  tokenizeXml: (xml: string, wrapperTag: string) => NativeXmlRawNode[] | null;
  libraryPath: string;
}

let loadAttempted = false;
let cachedLib: LoadedNativeLib | null = null;

function libFileName(): string {
  if (process.platform === "darwin") return "libspana_native.dylib";
  if (process.platform === "win32") return "spana_native.dll";
  return "libspana_native.so";
}

function findNativeLibraryPath(): string | null {
  const envOverride = process.env["SPANA_NATIVE_LIB"];
  if (envOverride && existsSync(envOverride)) return envOverride;

  const file = libFileName();
  const platformArch = `${process.platform}-${process.arch}`;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Prebuilt platform-arch binaries bundled in npm package (packages/spana/native/<platform>-<arch>/)
    resolve(here, "../../native", platformArch, file),
    resolve(here, "../native", platformArch, file),
    // Flat bundled path
    resolve(here, "../../native", file),
    resolve(here, "../native", file),
    // Monorepo cargo release / debug output
    resolve(here, "../../../spana-native/target/release", file),
    resolve(here, "../../../../packages/spana-native/target/release", file),
    resolve(process.cwd(), "packages/spana-native/target/release", file),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadNativeAccelerator(): LoadedNativeLib | null {
  if (loadAttempted) return cachedLib;
  loadAttempted = true;

  if (process.env["SPANA_DISABLE_NATIVE"] === "1") {
    return null;
  }

  // Uses Bun's zero-overhead native FFI when running under Bun; Node.js falls back cleanly to JS
  if (typeof (globalThis as Record<string, unknown>)["Bun"] === "undefined") {
    return null;
  }

  const libPath = findNativeLibraryPath();
  if (!libPath) return null;

  try {
    // Dynamic createRequire so bundlers targeting Node never fail on `bun:ffi`
    const req = createRequire(import.meta.url);
    const ffiModuleName = ["bun", "ffi"].join(":");
    const ffi = req(ffiModuleName) as {
      dlopen: (path: string, symbols: Record<string, unknown>) => { symbols: Record<string, any> };
      FFIType: Record<string, string>;
      ptr: (buf: Uint8Array) => number;
      toArrayBuffer: (p: number, offset: number, length: number) => ArrayBuffer;
    };

    const lib = ffi.dlopen(libPath, {
      spana_compare_png: {
        args: [
          ffi.FFIType.ptr,
          ffi.FFIType.u64,
          ffi.FFIType.ptr,
          ffi.FFIType.u64,
          ffi.FFIType.f64,
          ffi.FFIType.f64,
          ffi.FFIType.i32,
          ffi.FFIType.ptr,
        ],
        returns: ffi.FFIType.void,
      },
      spana_tokenize_xml: {
        args: [ffi.FFIType.ptr, ffi.FFIType.u64, ffi.FFIType.ptr, ffi.FFIType.u64, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
      spana_free_buffer: {
        args: [ffi.FFIType.ptr, ffi.FFIType.u64],
        returns: ffi.FFIType.void,
      },
    });

    const { spana_compare_png, spana_tokenize_xml, spana_free_buffer } = lib.symbols;

    // Struct layout of NativeCompareResult (repr(C) on 64-bit):
    //   offset 0:  matched (i32)
    //   offset 4:  size_mismatch (i32)
    //   offset 8:  diff_pixel_count (u32)
    //   offset 12: [4 bytes padding]
    //   offset 16: diff_pixel_ratio (f64)
    //   offset 24: diff_png_ptr (*mut u8 / u64)
    //   offset 32: diff_png_len (usize / u64)
    // Total = 40 bytes
    const resultScratch = new ArrayBuffer(40);
    const resultView = new DataView(resultScratch);
    const resultBytes = new Uint8Array(resultScratch);

    // Struct layout of NativeBuffer (repr(C) on 64-bit):
    //   offset 0: ptr (*mut u8 / u64)
    //   offset 8: len (usize / u64)
    const bufScratch = new ArrayBuffer(16);
    const bufView = new DataView(bufScratch);
    const bufBytes = new Uint8Array(bufScratch);

    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    cachedLib = {
      libraryPath: libPath,

      comparePng: (expected, actual, threshold, maxDiffRatio, layoutTolerant) => {
        const expArr = expected instanceof Uint8Array ? expected : new Uint8Array(expected);
        const actArr = actual instanceof Uint8Array ? actual : new Uint8Array(actual);
        if (expArr.byteLength === 0 || actArr.byteLength === 0) return null;

        spana_compare_png(
          ffi.ptr(expArr),
          expArr.byteLength,
          ffi.ptr(actArr),
          actArr.byteLength,
          threshold,
          maxDiffRatio,
          layoutTolerant ? 1 : 0,
          ffi.ptr(resultBytes),
        );

        const matched = resultView.getInt32(0, true);
        if (matched < 0) return null;
        const sizeMismatch = resultView.getInt32(4, true) !== 0;
        const diffPixelCount = resultView.getUint32(8, true);
        const diffPixelRatio = resultView.getFloat64(16, true);
        const diffPtr = Number(resultView.getBigUint64(24, true));
        const diffLen = Number(resultView.getBigUint64(32, true));

        let diffImage: Buffer | undefined;
        if (diffPtr !== 0 && diffLen > 0) {
          try {
            const view = new Uint8Array(ffi.toArrayBuffer(diffPtr, 0, diffLen));
            diffImage = Buffer.from(view);
          } finally {
            spana_free_buffer(diffPtr, diffLen);
          }
        }

        return {
          match: matched === 1,
          sizeMismatch,
          diffPixelCount,
          diffPixelRatio,
          ...(diffImage ? { diffImage } : {}),
        };
      },

      tokenizeXml: (xml, wrapperTag) => {
        const xmlBytes = textEncoder.encode(xml);
        if (xmlBytes.byteLength === 0) return [];
        const wrapBytes = textEncoder.encode(wrapperTag);
        const rc = spana_tokenize_xml(
          ffi.ptr(xmlBytes),
          xmlBytes.byteLength,
          wrapBytes.byteLength > 0 ? ffi.ptr(wrapBytes) : 0,
          wrapBytes.byteLength,
          ffi.ptr(bufBytes),
        );
        if (rc !== 0) return null;

        const outPtr = Number(bufView.getBigUint64(0, true));
        const outLen = Number(bufView.getBigUint64(8, true));
        if (outPtr === 0 || outLen === 0) return [];

        try {
          const slice = new Uint8Array(ffi.toArrayBuffer(outPtr, 0, outLen));
          const jsonStr = textDecoder.decode(slice);
          return JSON.parse(jsonStr) as NativeXmlRawNode[];
        } finally {
          spana_free_buffer(outPtr, outLen);
        }
      },
    };

    return cachedLib;
  } catch {
    return null;
  }
}

/** Check whether Spana's native Rust accelerator (`libspana_native`) is loaded and active. */
export function isNativeAcceleratorActive(): boolean {
  return loadNativeAccelerator() !== null;
}

/** Return the loaded native Rust library path, or `null` when running in pure-JS fallback mode. */
export function getNativeAcceleratorPath(): string | null {
  return loadNativeAccelerator()?.libraryPath ?? null;
}

/** Accelerated Rust PNG diff (returns `null` if unavailable so caller falls back cleanly to JS). */
export function comparePngNative(
  expected: Buffer | Uint8Array,
  actual: Buffer | Uint8Array,
  threshold: number,
  maxDiffRatio: number,
  layoutTolerant: boolean,
): NativePngCompareResult | null {
  const lib = loadNativeAccelerator();
  if (!lib) return null;
  try {
    return lib.comparePng(expected, actual, threshold, maxDiffRatio, layoutTolerant);
  } catch {
    return null;
  }
}

/** Accelerated Rust XML hierarchy tokenizer (returns `null` if unavailable so caller falls back to JS). */
export function tokenizeXmlNative(xml: string, wrapperTag: string): NativeXmlRawNode[] | null {
  const lib = loadNativeAccelerator();
  if (!lib) return null;
  try {
    return lib.tokenizeXml(xml, wrapperTag);
  } catch {
    return null;
  }
}
