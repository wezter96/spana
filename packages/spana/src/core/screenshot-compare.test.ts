import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import sharp from "sharp";
import { applyMask, compareScreenshots, cropToElement } from "./screenshot-compare.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePng(
  width: number,
  height: number,
  fillColor: { r: number; g: number; b: number; a?: number },
): Buffer {
  const png = new PNG({ width, height });
  const { r, g, b, a = 255 } = fillColor;
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = a;
  }
  return PNG.sync.write(png);
}

function isValidPng(buf: Buffer): boolean {
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

// ---------------------------------------------------------------------------
// compareScreenshots
// ---------------------------------------------------------------------------

describe("compareScreenshots", () => {
  it("identical images → match", () => {
    const img = makePng(10, 10, { r: 100, g: 150, b: 200 });
    const result = compareScreenshots(img, img);
    expect(result.match).toBe(true);
    expect(result.diffPixelCount).toBe(0);
    expect(result.diffPixelRatio).toBe(0);
    expect(result.diffImage).toBeUndefined();
    expect(result.sizeMismatch).toBeUndefined();
  });

  it("completely different images → mismatch with diff image", () => {
    const red = makePng(10, 10, { r: 255, g: 0, b: 0 });
    const blue = makePng(10, 10, { r: 0, g: 0, b: 255 });
    const result = compareScreenshots(red, blue);
    expect(result.match).toBe(false);
    expect(result.diffPixelCount).toBeGreaterThan(0);
    expect(result.diffPixelRatio).toBeGreaterThan(0);
    expect(result.diffImage).toBeDefined();
    expect(isValidPng(result.diffImage!)).toBe(true);
  });

  it("size mismatch → sizeMismatch flag, no diff image", () => {
    const small = makePng(10, 10, { r: 255, g: 0, b: 0 });
    const large = makePng(20, 20, { r: 255, g: 0, b: 0 });
    const result = compareScreenshots(small, large);
    expect(result.match).toBe(false);
    expect(result.sizeMismatch).toBe(true);
    expect(result.diffImage).toBeUndefined();
  });

  it("threshold controls sensitivity: strict detects difference, loose ignores it", () => {
    // Build two images that differ by one clearly-different pixel but only 1% of total.
    // Use a 10x10 (100px) image so 1 diff pixel = 1% ratio.
    const width = 10;
    const height = 10;
    const base = makePng(width, height, { r: 0, g: 0, b: 0 });

    // Create a version with one fully-red pixel in a uniform black image.
    // At strict threshold (0.0) this is caught; to suppress it we raise
    // maxDiffPixelRatio high enough that even detected pixels pass.
    const modified = PNG.sync.read(Buffer.from(base));
    modified.data[0] = 255; // R
    modified.data[1] = 0; // G
    modified.data[2] = 0; // B
    const tweaked = PNG.sync.write(modified);

    // With a zero threshold every difference is reported, so we get a diff
    const strictResult = compareScreenshots(base, tweaked, {
      threshold: 0.0,
      maxDiffPixelRatio: 0.0, // 0% tolerance → must fail
    });
    expect(strictResult.match).toBe(false);

    // With a very high pixel-ratio tolerance the single differing pixel passes
    const looseResult = compareScreenshots(base, tweaked, {
      threshold: 0.0,
      maxDiffPixelRatio: 0.5, // 50% tolerance → must pass
    });
    expect(looseResult.match).toBe(true);
  });

  it("maxDiffPixelRatio controls pass/fail at a given diff level", () => {
    // 5×5 image, 1 pixel fully red vs black (the rest match)
    const base = makePng(10, 10, { r: 0, g: 0, b: 0 });
    const one = PNG.sync.read(base);
    one.data[0] = 255; // change one pixel's R
    one.data[1] = 0;
    one.data[2] = 0;
    const withOneDiff = PNG.sync.write(one);

    // 1 pixel out of 100 = 1 % ratio
    const strict = compareScreenshots(base, withOneDiff, {
      maxDiffPixelRatio: 0.005, // 0.5% → fail
    });
    expect(strict.match).toBe(false);

    const lenient = compareScreenshots(base, withOneDiff, {
      maxDiffPixelRatio: 0.02, // 2% → pass
    });
    expect(lenient.match).toBe(true);
  });

  it("diff image is a valid PNG on mismatch", () => {
    const a = makePng(8, 8, { r: 255, g: 0, b: 0 });
    const b = makePng(8, 8, { r: 0, g: 255, b: 0 });
    const result = compareScreenshots(a, b);
    expect(result.diffImage).toBeDefined();
    expect(isValidPng(result.diffImage!)).toBe(true);
    // Decode to confirm it has the right dimensions
    const diffPng = PNG.sync.read(result.diffImage!);
    expect(diffPng.width).toBe(8);
    expect(diffPng.height).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// cropToElement
// ---------------------------------------------------------------------------

describe("cropToElement", () => {
  it("produces correct dimensions after crop", async () => {
    const base = makePng(100, 80, { r: 50, g: 100, b: 150 });
    const cropped = await cropToElement(base, {
      x: 10,
      y: 20,
      width: 40,
      height: 30,
    });
    const meta = await sharp(cropped).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(30);
  });

  it("full image crop preserves dimensions", async () => {
    const base = makePng(50, 50, { r: 200, g: 200, b: 200 });
    const cropped = await cropToElement(base, {
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    });
    const meta = await sharp(cropped).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// applyMask
// ---------------------------------------------------------------------------

describe("applyMask", () => {
  it("empty regions returns original image unchanged (same dimensions)", async () => {
    const base = makePng(20, 20, { r: 255, g: 0, b: 0 });
    const result = await applyMask(base, []);
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(20);
  });

  it("empty regions pixel data is unchanged", async () => {
    const base = makePng(20, 20, { r: 255, g: 0, b: 0 });
    const result = await applyMask(base, []);
    const cmpResult = compareScreenshots(base, result);
    expect(cmpResult.match).toBe(true);
  });

  it("mask region is painted gray", async () => {
    const base = makePng(20, 20, { r: 255, g: 0, b: 0 });
    const result = await applyMask(base, [{ x: 0, y: 0, width: 10, height: 10 }]);
    // The result should differ from the original (gray patch applied)
    const cmpResult = compareScreenshots(base, result);
    expect(cmpResult.match).toBe(false);
    // Dimensions should be preserved
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(20);
  });

  it("multiple mask regions all painted", async () => {
    const base = makePng(40, 40, { r: 0, g: 200, b: 50 });
    const result = await applyMask(base, [
      { x: 0, y: 0, width: 5, height: 5 },
      { x: 30, y: 30, width: 5, height: 5 },
    ]);
    const cmpResult = compareScreenshots(base, result);
    expect(cmpResult.match).toBe(false);
    expect(cmpResult.diffPixelCount).toBeGreaterThanOrEqual(2); // at least 2 regions changed
  });
});
