import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { comparePngNative } from "./native-accel.js";

export type ScreenshotCompareMode = "pixel" | "layout-tolerant";

export interface CompareOptions {
  /** Per-pixel sensitivity 0-1, default 0.2 */
  threshold?: number;
  /** Max fraction of differing pixels allowed, default 0.01 */
  maxDiffPixelRatio?: number;
  /**
   * Comparison mode:
   * - `"pixel"` (default): standard pixel-by-pixel diff.
   * - `"layout-tolerant"`: ignores anti-aliased edge/font subpixel noise (`includeAA: false`)
   *   and downsamples into 4×4 structural luminance blocks so minor cross-OS font rendering
   *   shifts don't flake while real layout/content changes fail deterministically.
   */
  mode?: ScreenshotCompareMode;
}

export interface CompareResult {
  match: boolean;
  diffPixelCount: number;
  diffPixelRatio: number;
  /** PNG buffer of diff visualization (only on mismatch) */
  diffImage?: Buffer;
  sizeMismatch?: boolean;
  mode?: ScreenshotCompareMode;
}

function computeBlockLuminanceDiffRatio(
  expectedData: Buffer,
  actualData: Buffer,
  width: number,
  height: number,
  blockSize = 4,
  luminanceDeltaThreshold = 18,
): number {
  const blocksX = Math.max(1, Math.floor(width / blockSize));
  const blocksY = Math.max(1, Math.floor(height / blockSize));
  let diffBlocks = 0;
  const totalBlocks = blocksX * blocksY;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let sumExp = 0;
      let sumAct = 0;
      let count = 0;
      const startY = by * blockSize;
      const startX = bx * blockSize;
      const endY = Math.min(height, startY + blockSize);
      const endX = Math.min(width, startX + blockSize);

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const idx = (y * width + x) * 4;
          sumExp +=
            0.299 * expectedData[idx]! +
            0.587 * expectedData[idx + 1]! +
            0.114 * expectedData[idx + 2]!;
          sumAct +=
            0.299 * actualData[idx]! + 0.587 * actualData[idx + 1]! + 0.114 * actualData[idx + 2]!;
          count++;
        }
      }
      if (count > 0 && Math.abs(sumExp / count - sumAct / count) > luminanceDeltaThreshold) {
        diffBlocks++;
      }
    }
  }
  return totalBlocks === 0 ? 0 : diffBlocks / totalBlocks;
}

/**
 * Compare two PNG buffers pixel-by-pixel (or with font/anti-aliasing tolerance
 * when `mode: "layout-tolerant"` is enabled).
 * Returns sizeMismatch if dimensions differ.
 */
export function compareScreenshots(
  expected: Buffer | Uint8Array,
  actual: Buffer | Uint8Array,
  options?: CompareOptions,
): CompareResult {
  const mode: ScreenshotCompareMode = options?.mode ?? "pixel";
  const threshold = options?.threshold ?? (mode === "layout-tolerant" ? 0.28 : 0.2);
  const maxDiffPixelRatio = options?.maxDiffPixelRatio ?? 0.01;

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);

  // Instant byte-identical fast path — avoids PNG decoding & pixelmatch altogether
  if (Buffer.compare(expectedBuf, actualBuf) === 0) {
    return { match: true, diffPixelCount: 0, diffPixelRatio: 0, mode };
  }

  // Native Rust SIMD/LLVM PNG decode + YIQ diff + 4x4 block luminance (10–25x faster than pngjs + pixelmatch)
  const native = comparePngNative(
    expectedBuf,
    actualBuf,
    threshold,
    maxDiffPixelRatio,
    mode === "layout-tolerant",
  );
  if (native) {
    return {
      match: native.match,
      diffPixelCount: native.diffPixelCount,
      diffPixelRatio: native.diffPixelRatio,
      ...(native.sizeMismatch ? { sizeMismatch: true } : {}),
      ...(native.diffImage ? { diffImage: native.diffImage } : {}),
      mode,
    };
  }

  const expectedPng = PNG.sync.read(expectedBuf);
  const actualPng = PNG.sync.read(actualBuf);

  if (expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height) {
    return {
      match: false,
      diffPixelCount: 0,
      diffPixelRatio: 1,
      sizeMismatch: true,
      mode,
    };
  }

  const { width, height } = expectedPng;
  const totalPixels = width * height;

  const diffPng = new PNG({ width, height });
  const diffPixelCount = pixelmatch(expectedPng.data, actualPng.data, diffPng.data, width, height, {
    threshold,
    ...(mode === "layout-tolerant" ? { includeAA: false } : {}),
  });

  const pixelRatio = totalPixels === 0 ? 0 : diffPixelCount / totalPixels;
  const diffPixelRatio =
    mode === "layout-tolerant"
      ? Math.min(
          pixelRatio,
          computeBlockLuminanceDiffRatio(expectedPng.data, actualPng.data, width, height),
        )
      : pixelRatio;
  const match = diffPixelRatio <= maxDiffPixelRatio;

  if (match) {
    return { match: true, diffPixelCount, diffPixelRatio, mode };
  }

  const diffImage = PNG.sync.write(diffPng);
  return { match: false, diffPixelCount, diffPixelRatio, diffImage, mode };
}

/**
 * Crop a screenshot PNG to element bounds using pure-JS pngjs (zero native addon dependency).
 */
export async function cropToElement(
  screenshot: Buffer | Uint8Array,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  const src = PNG.sync.read(Buffer.from(screenshot));
  const left = Math.max(0, Math.min(src.width - 1, Math.round(bounds.x)));
  const top = Math.max(0, Math.min(src.height - 1, Math.round(bounds.y)));
  const width = Math.max(1, Math.min(src.width - left, Math.round(bounds.width)));
  const height = Math.max(1, Math.min(src.height - top, Math.round(bounds.height)));

  const out = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    const srcStart = ((top + row) * src.width + left) * 4;
    const dstStart = row * width * 4;
    src.data.copy(out.data, dstStart, srcStart, srcStart + width * 4);
  }
  return PNG.sync.write(out);
}

/**
 * Parse a CSS color string (`#RGB`, `#RRGGBB`, `#RRGGBBAA`, `rgb(r, g, b)`, `rgba(r, g, b, a)`)
 * into an `[r, g, b, a]` tuple. Falls back to solid neutral gray (`[128, 128, 128, 255]`).
 */
export function parseMaskColor(color?: string): [number, number, number, number] {
  if (!color || typeof color !== "string") return [128, 128, 128, 255];
  const trimmed = color.trim();
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (hex3) {
    const h = hex3[1]!;
    return [
      Number.parseInt(h[0]! + h[0]!, 16),
      Number.parseInt(h[1]! + h[1]!, 16),
      Number.parseInt(h[2]! + h[2]!, 16),
      255,
    ];
  }
  const hex6 = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(trimmed);
  if (hex6) {
    const rgb = hex6[1]!;
    const alpha = hex6[2] ? Number.parseInt(hex6[2], 16) : 255;
    return [
      Number.parseInt(rgb.slice(0, 2), 16),
      Number.parseInt(rgb.slice(2, 4), 16),
      Number.parseInt(rgb.slice(4, 6), 16),
      alpha,
    ];
  }
  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
    const a = rgbMatch[4] !== undefined ? clamp(Number.parseFloat(rgbMatch[4]) * 255) : 255;
    return [
      clamp(Number.parseInt(rgbMatch[1]!, 10)),
      clamp(Number.parseInt(rgbMatch[2]!, 10)),
      clamp(Number.parseInt(rgbMatch[3]!, 10)),
      a,
    ];
  }
  return [128, 128, 128, 255];
}

/**
 * Paint solid colored rectangles over regions to mask dynamic content (default: gray `#808080`).
 * Returns the original image (as PNG buffer) if regions is empty.
 */
export async function applyMask(
  screenshot: Buffer | Uint8Array,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
  maskColor?: string,
): Promise<Buffer> {
  const buf = Buffer.from(screenshot);
  if (regions.length === 0) {
    return buf;
  }

  const [r, g, b, a] = parseMaskColor(maskColor);
  const png = PNG.sync.read(buf);
  for (const region of regions) {
    const startX = Math.max(0, Math.round(region.x));
    const startY = Math.max(0, Math.round(region.y));
    const endX = Math.min(png.width, Math.round(region.x + region.width));
    const endY = Math.min(png.height, Math.round(region.y + region.height));
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * png.width + x) * 4;
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = a;
      }
    }
  }
  return PNG.sync.write(png);
}
