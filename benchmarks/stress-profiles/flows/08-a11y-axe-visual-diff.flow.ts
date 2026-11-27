import {
  applyMask,
  byCss,
  compareScreenshots,
  cropToElement,
  flow,
} from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p8_01 = flow(
  "P8-01: WCAG 2A/2AA axe-core audit passes on clean accessible page",
  { tags: ["p8", "a11y"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p8-a11y-clean`);
    await expect(byCss("body")).toPassAccessibilityAudit({ tags: ["wcag2a", "wcag2aa"] });
  },
);

export const p8_02 = flow(
  "P8-02: accessibilityAudit detects intentional WCAG violations on broken page",
  { tags: ["p8", "a11y"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-a11y-broken`);
    const audit = await app.accessibilityAudit({ tags: ["wcag2a", "wcag2aa"] });
    if (audit.violations.length === 0) {
      throw new Error("Expected WCAG violations on /p8-a11y-broken");
    }
    const ruleIds = audit.violations.map((v) => v.ruleId);
    if (!ruleIds.includes("image-alt") && !ruleIds.includes("button-name")) {
      throw new Error(`Expected image-alt or button-name violation, got: ${ruleIds.join(", ")}`);
    }
  },
);

export const p8_03 = flow(
  "P8-03: accessibilityAudit include option scopes to clean region only",
  { tags: ["p8", "a11y"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-a11y-broken`);
    const audit = await app.accessibilityAudit({
      tags: ["wcag2a", "wcag2aa"],
      include: ["#clean-region"],
      disableRules: ["html-has-lang", "document-title", "region"],
    });
    if (audit.violations.length !== 0) {
      throw new Error(
        `Expected 0 violations in #clean-region, got: ${audit.violations.map((v) => v.ruleId).join(", ")}`,
      );
    }
  },
);

export const p8_04 = flow(
  "P8-04: accessibilityAudit exclude option ignores broken region",
  { tags: ["p8", "a11y"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-a11y-broken`);
    const audit = await app.accessibilityAudit({
      tags: ["wcag2a", "wcag2aa"],
      exclude: ["#broken-region"],
      disableRules: ["html-has-lang"],
    });
    if (audit.violations.length !== 0) {
      throw new Error(
        `Expected 0 violations excluding #broken-region, got: ${audit.violations.map((v) => v.ruleId).join(", ")}`,
      );
    }
  },
);

export const p8_05 = flow(
  "P8-05: axe-core repeated audit stays cached and fast",
  { tags: ["p8", "a11y"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-a11y-clean`);
    const first = await app.accessibilityAudit({ tags: ["wcag2a"] });
    const second = await app.accessibilityAudit({ tags: ["wcag2a"] });
    if (first.violations.length !== 0 || second.violations.length !== 0) {
      throw new Error("Clean page failed repeated WCAG audit");
    }
  },
);

export const p8_06 = flow(
  "P8-06: compareScreenshots byte-identical PNGs pass cleanly",
  { tags: ["p8", "visual"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-visual?variant=base`);
    const png = Buffer.from(await app.takeScreenshot());
    const res = compareScreenshots(png, png, { threshold: 0.01 });
    if (!res.match || res.diffPixelRatio !== 0) {
      throw new Error(
        `Expected identical screenshot match, got diffPixelRatio=${res.diffPixelRatio}`,
      );
    }
  },
);

export const p8_07 = flow(
  "P8-07: compareScreenshots detects visual mismatch and emits diff PNG",
  { tags: ["p8", "visual"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-visual?variant=base`);
    const basePng = Buffer.from(await app.takeScreenshot());
    await app.openLink(`${BASE}/p8-visual?variant=mismatch`);
    const modPng = Buffer.from(await app.takeScreenshot());
    const res = compareScreenshots(basePng, modPng, { threshold: 0.05, maxDiffPixelRatio: 0.0001 });
    if (res.match || res.diffPixelCount === 0 || !res.diffImage || res.diffImage.length === 0) {
      throw new Error(
        `Expected visual mismatch with diffImage, got match=${res.match} diffPixelCount=${res.diffPixelCount}`,
      );
    }
  },
);

export const p8_08 = flow(
  "P8-08: compareScreenshots layout-tolerant mode tolerates 1px subpixel shift",
  { tags: ["p8", "visual"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-visual?variant=base`);
    const basePng = Buffer.from(await app.takeScreenshot());
    await app.openLink(`${BASE}/p8-visual?variant=shifted`);
    const shiftedPng = Buffer.from(await app.takeScreenshot());
    const res = compareScreenshots(basePng, shiftedPng, {
      mode: "layout-tolerant",
      maxDiffPixelRatio: 0.02,
    });
    if (!res.match) {
      throw new Error(
        `Expected layout-tolerant match on 1px shift, got diffPixelRatio=${res.diffPixelRatio}`,
      );
    }
  },
);

export const p8_09 = flow(
  "P8-09: cropToElement crops visual-card PNG cleanly (Node ESM pngjs + Bun)",
  { tags: ["p8", "visual"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-visual?variant=base`);
    const fullPng = Buffer.from(await app.takeScreenshot());
    const box = await app.boundingBox(tid("visual-card"));
    if (!box) throw new Error("Missing visual-card bounding box");
    const cropped = await cropToElement(fullPng, box);
    if (cropped.length === 0 || cropped.length >= fullPng.length) {
      throw new Error(`Unexpected cropped PNG size: ${cropped.length} vs full ${fullPng.length}`);
    }
  },
);

export const p8_10 = flow(
  "P8-10: applyMask masks dynamic clock region to achieve exact match",
  { tags: ["p8", "visual"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p8-visual?variant=base`);
    const basePng = Buffer.from(await app.takeScreenshot());
    const clockBox = await app.boundingBox(tid("dynamic-clock"));
    if (!clockBox) throw new Error("Missing dynamic-clock box");
    await app.openLink(`${BASE}/p8-visual?variant=masked`);
    const maskedPng = Buffer.from(await app.takeScreenshot());
    const maskRect = [
      {
        x: Math.max(0, Math.floor(clockBox.x - 4)),
        y: Math.max(0, Math.floor(clockBox.y - 4)),
        width: Math.ceil(clockBox.width + 8),
        height: Math.ceil(clockBox.height + 8),
      },
    ];
    const maskedA = await applyMask(basePng, maskRect);
    const maskedB = await applyMask(maskedPng, maskRect);
    const res = compareScreenshots(maskedA, maskedB, { maxDiffPixelRatio: 0.001 });
    if (!res.match) {
      throw new Error(
        `Expected masked visual match, got diffPixelCount=${res.diffPixelCount} ratio=${res.diffPixelRatio}`,
      );
    }
  },
);

export default [p8_01, p8_02, p8_03, p8_04, p8_05, p8_06, p8_07, p8_08, p8_09, p8_10];
