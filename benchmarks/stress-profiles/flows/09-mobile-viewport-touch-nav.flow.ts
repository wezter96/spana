import { flow } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p9_01 = flow(
  "P9-01: setViewport(390x844) applies mobile layout dimensions",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await expect(tid("vp-info")).toHaveText("390x844");
  },
);

export const p9_02 = flow(
  "P9-02: mobile hamburger menu opens drawer and navigates to Orders",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await expect(tid("mobile-nav-drawer")).toBeHidden();
    await app.tap(tid("menu-toggle"));
    await expect(tid("mobile-nav-drawer")).toBeVisible();
    await app.tap(tid("drawer-nav-orders"));
    await expect(tid("mobile-log")).toHaveText("nav:orders");
    await expect(tid("mobile-nav-drawer")).toBeHidden();
  },
);

export const p9_03 = flow(
  "P9-03: drawer close button dismisses mobile nav drawer cleanly",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await app.tap(tid("menu-toggle"));
    await expect(tid("drawer-close")).toBeVisible();
    await app.tap(tid("drawer-close"));
    await expect(tid("mobile-nav-drawer")).toBeHidden();
  },
);

export const p9_04 = flow(
  "P9-04: auto-scrolls 1400px below fold on 390x844 and taps checkout CTA",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await app.tap(tid("below-fold-cta"));
    await expect(tid("mobile-log")).toHaveText("checkout:done");
  },
);

export const p9_05 = flow(
  "P9-05: explicit mouse.wheel scroll moves viewport down and back up",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await app.mouse.wheel(0, 600);
    await expect.poll(async () => await app.evaluate(() => window.scrollY)).toBeGreaterThan(200);
    await app.mouse.wheel(0, -600);
    await expect.poll(async () => await app.evaluate(() => window.scrollY)).toBe(0);
  },
);

export const p9_06 = flow(
  "P9-06: doubleTap triggers dblclick handler on mobile gesture pad",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await app.doubleTap(tid("gesture-box"));
    await expect(tid("gesture-log")).toHaveText("dblclick");
  },
);

export const p9_07 = flow(
  "P9-07: longPress holds pointer >= 300ms on mobile gesture pad",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await app.longPress(tid("gesture-box"), { duration: 320 });
    await expect(tid("gesture-log")).toHaveText(/^longpress:\d+$/);
  },
);

export const p9_08 = flow(
  "P9-08: swipe gesture across mobile pad registers swipe:left",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    const box = await app.boundingBox(tid("gesture-box"));
    if (!box) throw new Error("Missing gesture-box");
    const cy = box.y + box.height / 2;
    await app.mouse.move(box.x + box.width - 20, cy);
    await app.mouse.down();
    await app.mouse.move(box.x + 20, cy, { steps: 5 });
    await app.mouse.up();
    await expect(tid("gesture-log")).toHaveText("swipe:left");
  },
);

export const p9_09 = flow(
  "P9-09: mid-flow orientation flip (portrait 390x844 -> landscape 844x390)",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await expect(tid("vp-info")).toHaveText("390x844");
    await app.setViewport({ width: 844, height: 390 });
    await expect(tid("vp-info")).toHaveText("844x390");
  },
);

export const p9_10 = flow(
  "P9-10: mobile link navigation plus back() and forward() history",
  { tags: ["p9", "mobile"] },
  async ({ app, expect }) => {
    await app.setViewport({ width: 390, height: 844 });
    await app.openLink(`${BASE}/p9-mobile`);
    await app.tap(tid("subpage-link"));
    await expect(tid("subpage-title")).toHaveText("Mobile Subpage");
    await app.back();
    await expect(tid("menu-toggle")).toBeVisible();
    await app.forward();
    await expect(tid("subpage-title")).toHaveText("Mobile Subpage");
  },
);

export default [p9_01, p9_02, p9_03, p9_04, p9_05, p9_06, p9_07, p9_08, p9_09, p9_10];
