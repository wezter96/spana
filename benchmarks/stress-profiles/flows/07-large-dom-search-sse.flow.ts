import { byCss, byRole, filterSelector, flow } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p7_01 = flow(
  "P7-01: 4200-row table renders and count() reports all 4200 rows",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await expect(tid("visible-count")).toHaveText("4200");
    const total = await app.count(byCss("tr.data-row"));
    if (total !== 4200) throw new Error(`Expected 4200 rows, got ${total}`);
  },
);

export const p7_02 = flow(
  "P7-02: direct testID query on row 3999 in 4200-row DOM stays fast",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await app.tap(tid("row-btn-3999"));
    await expect(tid("footer-status")).toHaveText("inspected:Inspect SKU-3999");
  },
);

export const p7_03 = flow(
  "P7-03: text selector locates SKU-2500 inside 4200-row table",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await expect({ text: "SKU-2500" }).toBeVisible();
  },
);

export const p7_04 = flow(
  "P7-04: filterSelector with hasText narrows 4200 rows cleanly",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    const target = filterSelector(byCss("tr.data-row"), { hasText: "SKU-4100" });
    await expect(target).toBeVisible();
  },
);

export const p7_05 = flow(
  "P7-05: live search filter shrinks 4200 rows to 1 matching row",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await app.fill(tid("row-filter"), "SKU-3141");
    await expect(tid("visible-count")).toHaveText("1");
    await app.tap(tid("row-btn-3141"));
    await expect(tid("footer-status")).toHaveText("inspected:Inspect SKU-3141");
  },
);

export const p7_06 = flow(
  "P7-06: rapid search mutations settle cleanly without stale reads",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await app.fill(tid("row-filter"), "eu-north");
    await expect(tid("visible-count")).toHaveText("1050");
    await app.fill(tid("row-filter"), "SKU-0042");
    await expect(tid("visible-count")).toHaveText("1");
    await app.clear(tid("row-filter"));
    await expect(tid("visible-count")).toHaveText("4200");
  },
);

export const p7_07 = flow(
  "P7-07: live SSE stream updates DOM and expect().toHaveText awaits final tick",
  { tags: ["p7", "sse"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await app.tap(tid("start-sse"));
    await expect(tid("sse-latest")).toHaveText("sse:4", { timeout: 5000 });
  },
);

export const p7_08 = flow(
  "P7-08: expect.poll tracks live SSE stream convergence and toBeNull",
  { tags: ["p7", "sse"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await expect
      .poll(async () => await app.evaluate(() => document.querySelector("#nonexistent-x")))
      .toBeNull();
    await app.tap(tid("start-sse"));
    await expect
      .poll(async () => await app.getText(tid("sse-latest")), { timeout: 5000 })
      .toBe("sse:4");
  },
);

export const p7_09 = flow(
  "P7-09: auto-scroll past 4200 rows and tap bottom footer CTA",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await app.tap(tid("bottom-footer-cta"));
    await expect(tid("footer-status")).toHaveText("confirmed:4200");
  },
);

export const p7_10 = flow(
  "P7-10: byRole button match inside filtered 4200-row table",
  { tags: ["p7", "large-dom"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p7-large-dom`);
    await app.fill(tid("row-filter"), "SKU-0777");
    await app.tap(byRole("button", { name: "Inspect SKU-0777" }));
    await expect(tid("footer-status")).toHaveText("inspected:Inspect SKU-0777");
  },
);

export default [p7_01, p7_02, p7_03, p7_04, p7_05, p7_06, p7_07, p7_08, p7_09, p7_10];
