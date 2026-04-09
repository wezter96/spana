# Visual Regression Assertions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `toMatchScreenshot()` assertions with baseline management, pixel diffing, configurable thresholds/masks, and diff artifact integration into HTML/Allure reports.

**Architecture:** `baseline-manager.ts` handles baseline path resolution and read/write. `screenshot-compare.ts` wraps pixelmatch for comparison with cropping and masking support. New assertion in `expect.ts` + `coordinator.ts` uses these modules. Reporters extended to render diff triptychs. CLI gets `--update-baselines` flag.

**Tech Stack:** pixelmatch (pixel comparison), pngjs (PNG encode/decode), sharp (image cropping/masking)

---

### Task 1: Add Dependencies

**Files:**

- Modify: `packages/spana/package.json`

- [ ] **Step 1: Install pixelmatch, pngjs, and sharp**

Run:

```bash
cd packages/spana && bun add pixelmatch pngjs sharp && bun add -d @types/pngjs
```

- [ ] **Step 2: Verify installation**

Run: `cd packages/spana && bun run -e "require('pixelmatch'); require('pngjs'); require('sharp'); console.log('OK')"`
Expected: "OK"

- [ ] **Step 3: Commit**

```bash
git add packages/spana/package.json bun.lock
git commit -m "chore: add pixelmatch, pngjs, and sharp for visual regression"
```

---

### Task 2: Baseline Manager

**Files:**

- Create: `packages/spana/src/core/baseline-manager.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/core/baseline-manager.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveBaselinePath,
  readBaseline,
  writeBaseline,
  baselineExists,
} from "./baseline-manager.js";

const tmpDir = join(import.meta.dir, "__test-baselines__");

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveBaselinePath", () => {
  it("resolves path for a flow file and screenshot name", () => {
    const path = resolveBaselinePath(
      "/project/flows/login.flow.ts",
      "login-flow",
      "web",
      "dashboard",
    );
    expect(path).toBe("/project/flows/__baselines__/login-flow-web/dashboard.png");
  });

  it("handles nested flow directories", () => {
    const path = resolveBaselinePath(
      "/project/flows/auth/login.flow.ts",
      "login-flow",
      "android",
      "header",
    );
    expect(path).toBe("/project/flows/auth/__baselines__/login-flow-android/header.png");
  });
});

describe("readBaseline / writeBaseline / baselineExists", () => {
  it("returns null when baseline does not exist", () => {
    const result = readBaseline(join(tmpDir, "nonexistent.png"));
    expect(result).toBeNull();
  });

  it("returns false for baselineExists when missing", () => {
    expect(baselineExists(join(tmpDir, "nope.png"))).toBe(false);
  });

  it("writes and reads a baseline", () => {
    const filePath = join(tmpDir, "__baselines__", "test-web", "shot.png");
    const data = Buffer.from([137, 80, 78, 71]); // PNG magic bytes
    writeBaseline(filePath, data);
    expect(baselineExists(filePath)).toBe(true);
    const read = readBaseline(filePath);
    expect(read).toEqual(data);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/core/baseline-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/spana/src/core/baseline-manager.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveBaselinePath(
  flowFilePath: string,
  flowName: string,
  platform: string,
  screenshotName: string,
): string {
  const flowDir = dirname(flowFilePath);
  const safeName = flowName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return join(flowDir, "__baselines__", `${safeName}-${platform}`, `${screenshotName}.png`);
}

export function baselineExists(baselinePath: string): boolean {
  return existsSync(baselinePath);
}

export function readBaseline(baselinePath: string): Buffer | null {
  if (!existsSync(baselinePath)) return null;
  return readFileSync(baselinePath);
}

export function writeBaseline(baselinePath: string, data: Buffer | Uint8Array): void {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, data);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/core/baseline-manager.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/core/baseline-manager.ts packages/spana/src/core/baseline-manager.test.ts
git commit -m "feat: add baseline manager for visual regression"
```

---

### Task 3: Screenshot Comparator

**Files:**

- Create: `packages/spana/src/core/screenshot-compare.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/spana/src/core/screenshot-compare.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { PNG } from "pngjs";
import { compareScreenshots, type CompareResult } from "./screenshot-compare.js";

function createPng(
  width: number,
  height: number,
  fillColor: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      png.data[idx] = fillColor[0]!;
      png.data[idx + 1] = fillColor[1]!;
      png.data[idx + 2] = fillColor[2]!;
      png.data[idx + 3] = fillColor[3]!;
    }
  }
  return PNG.sync.write(png);
}

describe("compareScreenshots", () => {
  it("returns match for identical images", () => {
    const img = createPng(100, 100, [255, 0, 0, 255]);
    const result = compareScreenshots(img, img);
    expect(result.match).toBe(true);
    expect(result.diffPixelCount).toBe(0);
    expect(result.diffPixelRatio).toBe(0);
  });

  it("returns mismatch for completely different images", () => {
    const red = createPng(100, 100, [255, 0, 0, 255]);
    const blue = createPng(100, 100, [0, 0, 255, 255]);
    const result = compareScreenshots(red, blue, { maxDiffPixelRatio: 0.01 });
    expect(result.match).toBe(false);
    expect(result.diffPixelRatio).toBeGreaterThan(0.01);
    expect(result.diffImage).toBeDefined();
  });

  it("respects threshold for similar colors", () => {
    const a = createPng(10, 10, [100, 100, 100, 255]);
    const b = createPng(10, 10, [102, 100, 100, 255]); // very slight diff
    const strict = compareScreenshots(a, b, { threshold: 0.0 });
    const loose = compareScreenshots(a, b, { threshold: 0.5 });
    expect(strict.match).toBe(false);
    expect(loose.match).toBe(true);
  });

  it("generates a diff image on mismatch", () => {
    const red = createPng(50, 50, [255, 0, 0, 255]);
    const green = createPng(50, 50, [0, 255, 0, 255]);
    const result = compareScreenshots(red, green, { maxDiffPixelRatio: 0.01 });
    expect(result.match).toBe(false);
    expect(result.diffImage).toBeInstanceOf(Buffer);
    // Verify it's a valid PNG
    const parsed = PNG.sync.read(result.diffImage!);
    expect(parsed.width).toBe(50);
    expect(parsed.height).toBe(50);
  });

  it("handles size mismatch as failure", () => {
    const small = createPng(50, 50, [255, 0, 0, 255]);
    const large = createPng(100, 100, [255, 0, 0, 255]);
    const result = compareScreenshots(small, large);
    expect(result.match).toBe(false);
    expect(result.sizeMismatch).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/spana && bun test src/core/screenshot-compare.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/spana/src/core/screenshot-compare.ts`:

```typescript
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface CompareOptions {
  threshold?: number; // 0-1, default 0.2
  maxDiffPixelRatio?: number; // 0-1, default 0.01
}

export interface CompareResult {
  match: boolean;
  diffPixelCount: number;
  diffPixelRatio: number;
  diffImage?: Buffer; // PNG buffer of diff visualization
  sizeMismatch?: boolean;
}

export function compareScreenshots(
  expected: Buffer | Uint8Array,
  actual: Buffer | Uint8Array,
  options: CompareOptions = {},
): CompareResult {
  const threshold = options.threshold ?? 0.2;
  const maxDiffPixelRatio = options.maxDiffPixelRatio ?? 0.01;

  const expectedPng = PNG.sync.read(Buffer.from(expected));
  const actualPng = PNG.sync.read(Buffer.from(actual));

  if (expectedPng.width !== actualPng.width || expectedPng.height !== actualPng.height) {
    return {
      match: false,
      diffPixelCount: -1,
      diffPixelRatio: 1,
      sizeMismatch: true,
    };
  }

  const { width, height } = expectedPng;
  const diffPng = new PNG({ width, height });

  const diffPixelCount = pixelmatch(expectedPng.data, actualPng.data, diffPng.data, width, height, {
    threshold,
  });

  const totalPixels = width * height;
  const diffPixelRatio = totalPixels > 0 ? diffPixelCount / totalPixels : 0;
  const match = diffPixelRatio <= maxDiffPixelRatio;

  return {
    match,
    diffPixelCount,
    diffPixelRatio,
    diffImage: match ? undefined : PNG.sync.write(diffPng),
  };
}

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

export async function applyMask(
  screenshot: Buffer | Uint8Array,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): Promise<Buffer> {
  if (regions.length === 0) return Buffer.from(screenshot);

  const sharp = (await import("sharp")).default;
  const overlays = regions.map((r) => ({
    input: Buffer.from(
      // Create a solid gray PNG of the right size
      PNG.sync.write(
        (() => {
          const png = new PNG({
            width: Math.round(r.width),
            height: Math.round(r.height),
          });
          for (let i = 0; i < png.data.length; i += 4) {
            png.data[i] = 128;
            png.data[i + 1] = 128;
            png.data[i + 2] = 128;
            png.data[i + 3] = 255;
          }
          return png;
        })(),
      ),
    ),
    left: Math.round(r.x),
    top: Math.round(r.y),
  }));

  return sharp(Buffer.from(screenshot)).composite(overlays).png().toBuffer();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/spana && bun test src/core/screenshot-compare.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/core/screenshot-compare.ts packages/spana/src/core/screenshot-compare.test.ts
git commit -m "feat: add screenshot comparator with pixelmatch"
```

---

### Task 4: Coordinator — assertScreenshot Method

**Files:**

- Modify: `packages/spana/src/smart/coordinator.ts`

- [ ] **Step 1: Add assertScreenshot to coordinator**

Add the following to the return object of `createCoordinator()` (after the existing assertion methods, around line 484):

```typescript
assertScreenshot: (
  selector: ExtendedSelector | undefined,
  name: string,
  flowFilePath: string,
  flowName: string,
  platform: string,
  options: {
    threshold?: number;
    maxDiffPixelRatio?: number;
    mask?: Array<{ x: number; y: number; width: number; height: number }>;
    updateBaselines?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { resolveBaselinePath, readBaseline, writeBaseline, baselineExists } =
      yield* Effect.promise(() => import("../core/baseline-manager.js"));
    const { compareScreenshots, cropToElement, applyMask } =
      yield* Effect.promise(() => import("../core/screenshot-compare.js"));

    // Take screenshot
    let screenshot = yield* driver.takeScreenshot();

    // Crop to element if selector provided
    if (selector) {
      const raw = yield* driver.dumpHierarchy();
      const root = config.parse(raw);
      const el = findElementExtended(root, selector);
      if (el) {
        screenshot = new Uint8Array(
          yield* Effect.promise(() => cropToElement(Buffer.from(screenshot), el.bounds)),
        );
      }
    }

    const baselinePath = resolveBaselinePath(flowFilePath, flowName, platform, name);

    // Update mode: overwrite baseline
    if (options.updateBaselines) {
      writeBaseline(baselinePath, screenshot);
      return;
    }

    // First run: create baseline
    if (!baselineExists(baselinePath)) {
      writeBaseline(baselinePath, screenshot);
      return;
    }

    // Compare
    let actual = Buffer.from(screenshot);
    let expected = readBaseline(baselinePath)!;

    // Apply masks if provided
    if (options.mask && options.mask.length > 0) {
      actual = yield* Effect.promise(() => applyMask(actual, options.mask!));
      expected = yield* Effect.promise(() => applyMask(expected, options.mask!));
    }

    const result = compareScreenshots(expected, actual, {
      threshold: options.threshold,
      maxDiffPixelRatio: options.maxDiffPixelRatio,
    });

    if (!result.match) {
      // Write diff artifacts
      const { writeFileSync, mkdirSync } = yield* Effect.promise(() => import("node:fs"));
      const { dirname, join } = yield* Effect.promise(() => import("node:path"));
      const artifactDir = join(
        config.outputDir ?? "./spana-output",
        `${flowName}-${platform}`,
      );
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, `${name}-expected.png`), expected);
      writeFileSync(join(artifactDir, `${name}-actual.png`), actual);
      if (result.diffImage) {
        writeFileSync(join(artifactDir, `${name}-diff.png`), result.diffImage);
      }

      const msg = result.sizeMismatch
        ? `Screenshot "${name}" size mismatch: expected and actual have different dimensions`
        : `Screenshot "${name}" differs by ${(result.diffPixelRatio * 100).toFixed(2)}% (${result.diffPixelCount} pixels)`;

      yield* Effect.fail(
        new DriverError({
          message: msg,
          cause: undefined,
        }),
      );
    }
  }),
```

Add the necessary imports at the top of `coordinator.ts`:

```typescript
import { findElementExtended } from "./element-matcher.js";
```

(if not already imported)

- [ ] **Step 2: Add `outputDir` to CoordinatorConfig**

Around line 69 in coordinator.ts, add to `CoordinatorConfig`:

```typescript
outputDir?: string;
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/spana && bun build src/smart/coordinator.ts --no-bundle --outdir /tmp/check-coord 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/smart/coordinator.ts
git commit -m "feat: add assertScreenshot to coordinator for visual regression"
```

---

### Task 5: Expect API — toMatchScreenshot

**Files:**

- Modify: `packages/spana/src/api/expect.ts`

- [ ] **Step 1: Add toMatchScreenshot to PromiseExpectation interface**

In `expect.ts`, add to the `PromiseExpectation` interface (around line 17):

```typescript
toMatchScreenshot(
  name: string,
  options?: {
    threshold?: number;
    maxDiffPixelRatio?: number;
    mask?: Selector[];
  },
): Promise<void>;
```

- [ ] **Step 2: Add implementation in createPromiseExpect**

In the return object of `createPromiseExpect`, add:

```typescript
toMatchScreenshot: (name, options) =>
  runStep(
    `expect.toMatchScreenshot("${name}")`,
    () =>
      run(
        coordinator.assertScreenshot(
          selector,
          name,
          flowContext.flowFilePath,
          flowContext.flowName,
          flowContext.platform,
          {
            threshold: options?.threshold,
            maxDiffPixelRatio: options?.maxDiffPixelRatio,
            mask: options?.mask
              ? options.mask.map((sel) => {
                  // Resolve selectors to bounds — this will need element lookup
                  // For now, pass empty array; full mask support requires hierarchy lookup
                  return { x: 0, y: 0, width: 0, height: 0 };
                })
              : undefined,
            updateBaselines: flowContext.updateBaselines ?? false,
          },
        ),
      ),
    { captureScreenshot: false },
  ),
```

- [ ] **Step 3: Add flowContext parameter to createPromiseExpect**

The function needs `flowFilePath`, `flowName`, `platform`, and `updateBaselines` context. Add a `flowContext` parameter:

```typescript
interface FlowContext {
  flowFilePath: string;
  flowName: string;
  platform: string;
  updateBaselines?: boolean;
}

export function createPromiseExpect(
  driver: RawDriverService,
  config: CoordinatorConfig,
  recorder?: StepRecorder,
  flowContext?: FlowContext,
): (selector: ExtendedSelector) => PromiseExpectation;
```

Default `flowContext` to `{ flowFilePath: "", flowName: "unknown", platform: "web" }` if not provided for backward compatibility.

- [ ] **Step 4: Verify the build compiles**

Run: `cd packages/spana && bun build src/api/expect.ts --no-bundle --outdir /tmp/check-expect 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/api/expect.ts
git commit -m "feat: add toMatchScreenshot assertion to expect API"
```

---

### Task 6: CLI — --update-baselines Flag

**Files:**

- Modify: `packages/spana/src/cli/test-command.ts`

- [ ] **Step 1: Add the flag to TestCommandOptions**

In `test-command.ts`, add to `TestCommandOptions` (around line 63):

```typescript
updateBaselines?: boolean;
```

- [ ] **Step 2: Add CLI flag parsing**

Find where CLI flags are defined (the command builder/args section) and add:

```typescript
.option("update-baselines", {
  type: "boolean",
  description: "Update visual regression baselines with current screenshots",
  default: false,
})
```

- [ ] **Step 3: Pass the flag through to flow execution context**

Find where `FlowContext` or test execution options are assembled and pass `updateBaselines: opts.updateBaselines` through so it reaches `createPromiseExpect`.

- [ ] **Step 4: Verify the build compiles**

Run: `cd packages/spana && bun build src/cli/test-command.ts --no-bundle --outdir /tmp/check-cli 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add packages/spana/src/cli/test-command.ts
git commit -m "feat: add --update-baselines CLI flag for visual regression"
```

---

### Task 7: HTML Reporter — Diff Triptych

**Files:**

- Modify: `packages/spana/src/report/html.ts`

- [ ] **Step 1: Add diff triptych rendering**

In `html.ts`, add a helper function after `toBase64DataUri` (around line 21):

```typescript
function renderDiffTriptych(flowName: string, platform: string, outputDir: string): string {
  const { existsSync } = require("node:fs");
  const { join, resolve } = require("node:path");

  const artifactDir = join(outputDir, `${flowName}-${platform}`);
  const files = existsSync(artifactDir)
    ? require("node:fs")
        .readdirSync(artifactDir)
        .filter((f: string) => f.endsWith("-diff.png"))
    : [];

  if (files.length === 0) return "";

  return files
    .map((diffFile: string) => {
      const name = diffFile.replace("-diff.png", "");
      const expectedUri = toBase64DataUri(join(artifactDir, `${name}-expected.png`));
      const actualUri = toBase64DataUri(join(artifactDir, `${name}-actual.png`));
      const diffUri = toBase64DataUri(join(artifactDir, diffFile));

      if (!expectedUri || !actualUri || !diffUri) return "";

      return `
        <div style="margin:12px 0">
          <h4 style="color:#f87171;margin:0 0 8px">Visual diff: ${name}</h4>
          <div style="display:flex;gap:8px;overflow-x:auto">
            <div style="text-align:center">
              <div style="color:#a3a3a3;font-size:11px;margin-bottom:4px">Expected</div>
              <img src="${expectedUri}" loading="lazy" style="max-height:280px;border:1px solid #262626;border-radius:4px"/>
            </div>
            <div style="text-align:center">
              <div style="color:#a3a3a3;font-size:11px;margin-bottom:4px">Actual</div>
              <img src="${actualUri}" loading="lazy" style="max-height:280px;border:1px solid #262626;border-radius:4px"/>
            </div>
            <div style="text-align:center">
              <div style="color:#a3a3a3;font-size:11px;margin-bottom:4px">Diff</div>
              <img src="${diffUri}" loading="lazy" style="max-height:280px;border:1px solid #dc2626;border-radius:4px"/>
            </div>
          </div>
        </div>`;
    })
    .join("");
}
```

- [ ] **Step 2: Call renderDiffTriptych in failed flow sections**

In the `renderPlatform` or `renderFlow` function (where failure details are shown), add a call to `renderDiffTriptych(result.flowName, result.platform, outputDir)` in the failure details section.

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/spana && bun build src/report/html.ts --no-bundle --outdir /tmp/check-html 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/report/html.ts
git commit -m "feat: add visual diff triptych to HTML reporter"
```

---

### Task 8: Allure Reporter — Diff Attachments

**Files:**

- Modify: `packages/spana/src/report/allure.ts`

- [ ] **Step 1: Extend copyAttachments to include diff artifacts**

In `allure.ts`, modify `copyAttachments` (around line 34) to also look for visual diff files in the artifact directory. After copying step-level attachments, add:

```typescript
// Copy visual diff artifacts if they exist
const { readdirSync } = require("node:fs");
const artifactDir = join(outputDir, "..", "spana-output", `${result.flowName}-${result.platform}`);
try {
  const diffFiles = readdirSync(artifactDir).filter(
    (f: string) =>
      f.endsWith("-expected.png") || f.endsWith("-actual.png") || f.endsWith("-diff.png"),
  );
  for (const file of diffFiles) {
    const filename = `${randomUUID()}-attachment.png`;
    copyFileSync(join(artifactDir, file), join(outputDir, filename));
    attachments.push({
      name: `Visual: ${file}`,
      source: filename,
      type: "image/png",
    });
  }
} catch {
  // Artifact dir may not exist
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd packages/spana && bun build src/report/allure.ts --no-bundle --outdir /tmp/check-allure 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/report/allure.ts
git commit -m "feat: attach visual diff artifacts in Allure reporter"
```

---

### Task 9: Config Schema — visualRegression Defaults

**Files:**

- Modify: `packages/spana/src/schemas/config.ts`

- [ ] **Step 1: Add visualRegression to ProvConfig**

In `config.ts`, add to the `ProvConfig` interface (around line 155):

```typescript
visualRegression?: {
  threshold?: number;
  maxDiffPixelRatio?: number;
  baselinesDir?: string;
};
```

- [ ] **Step 2: Add Zod schema**

Add to the `provConfigSchema` zod object:

```typescript
visualRegression: z
  .object({
    threshold: z.number().min(0).max(1).optional(),
    maxDiffPixelRatio: z.number().min(0).max(1).optional(),
    baselinesDir: z.string().optional(),
  })
  .optional(),
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd packages/spana && bun build src/schemas/config.ts --no-bundle --outdir /tmp/check-config 2>&1 | head -20`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add packages/spana/src/schemas/config.ts
git commit -m "feat: add visualRegression config schema"
```

---

### Task 10: Integration Test — Visual Regression Flow

**Files:**

- Create: `packages/spana/src/core/visual-regression-integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { writeBaseline, resolveBaselinePath, readBaseline } from "./baseline-manager.js";
import { compareScreenshots } from "./screenshot-compare.js";

const tmpDir = join(import.meta.dir, "__test-vr__");

function createPng(
  width: number,
  height: number,
  fillColor: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      png.data[idx] = fillColor[0]!;
      png.data[idx + 1] = fillColor[1]!;
      png.data[idx + 2] = fillColor[2]!;
      png.data[idx + 3] = fillColor[3]!;
    }
  }
  return PNG.sync.write(png);
}

beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("Visual regression integration", () => {
  it("creates baseline on first run, passes on match, fails on diff", () => {
    const baselinePath = join(tmpDir, "__baselines__", "test-web", "home.png");
    const redImage = createPng(100, 100, [255, 0, 0, 255]);
    const blueImage = createPng(100, 100, [0, 0, 255, 255]);

    // First run: baseline doesn't exist → create it
    expect(existsSync(baselinePath)).toBe(false);
    writeBaseline(baselinePath, redImage);
    expect(existsSync(baselinePath)).toBe(true);

    // Second run: same image → passes
    const baseline = readBaseline(baselinePath)!;
    const matchResult = compareScreenshots(baseline, redImage);
    expect(matchResult.match).toBe(true);

    // Third run: different image → fails
    const diffResult = compareScreenshots(baseline, blueImage, {
      maxDiffPixelRatio: 0.01,
    });
    expect(diffResult.match).toBe(false);
    expect(diffResult.diffImage).toBeDefined();
  });

  it("resolves baseline paths correctly", () => {
    const path = resolveBaselinePath(
      join(tmpDir, "flows", "login.flow.ts"),
      "Login flow",
      "web",
      "dashboard",
    );
    expect(path).toContain("__baselines__");
    expect(path).toContain("login-flow-web");
    expect(path).toContain("dashboard.png");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd packages/spana && bun test src/core/visual-regression-integration.test.ts`
Expected: All 2 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/spana/src/core/visual-regression-integration.test.ts
git commit -m "test: add visual regression integration tests"
```
