import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

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

  const expectedPng = PNG.sync.read(Buffer.from(expected));
  const actualPng = PNG.sync.read(Buffer.from(actual));

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
 * Crop a screenshot PNG to element bounds using sharp.
 */
export async function cropToElement(
  screenshot: Buffer | Uint8Array,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(screenshot))
    .extract({
      left: Math.round(bounds.x),
      top: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })
    .png()
    .toBuffer();
}

/**
 * Paint solid gray rectangles over regions to mask dynamic content.
 * Returns the original image (as PNG buffer) if regions is empty.
 */
export async function applyMask(
  screenshot: Buffer | Uint8Array,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  if (regions.length === 0) {
    return sharp(Buffer.from(screenshot)).png().toBuffer();
  }

  const overlays = await Promise.all(
    regions.map(async (region) => {
      const w = Math.round(region.width);
      const h = Math.round(region.height);
      // Create a gray rectangle as a raw buffer (RGBA)
      const grayPixel = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        grayPixel[i * 4] = 128; // R
        grayPixel[i * 4 + 1] = 128; // G
        grayPixel[i * 4 + 2] = 128; // B
        grayPixel[i * 4 + 3] = 255; // A (fully opaque)
      }
      const overlayBuffer = await sharp(grayPixel, {
        raw: { width: w, height: h, channels: 4 },
      })
        .png()
        .toBuffer();

      return {
        input: overlayBuffer,
        left: Math.round(region.x),
        top: Math.round(region.y),
      };
    }),
  );

  return sharp(Buffer.from(screenshot)).composite(overlays).png().toBuffer();
}
