import { byRole, flow } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p2_01 = flow(
  "P2-01: @base-ui pointerdown checks buttons===1 and pointerType===mouse",
  { tags: ["p2", "pointer"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await app.tap(tid("baseui-trigger"));
    await expect(tid("baseui-log")).toHaveText("opened:mouse:1");
    await app.tap(tid("baseui-item-1"));
    await expect(tid("baseui-log")).toHaveText("item:Export CSV");
  },
);

export const p2_02 = flow(
  "P2-02: fieldset/legend resolves as role=group with accessible name",
  { tags: ["p2", "forms"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    const group = byRole("group", { name: "Billing Address" });
    await expect(group).toBeVisible();
    await expect(group).toHaveAccessibleName("Billing Address");
  },
);

export const p2_03 = flow(
  "P2-03: byRole pressed filter distinguishes aria-pressed true/false",
  { tags: ["p2", "forms"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await expect(byRole("button", { name: "Bold", pressed: true })).toBeVisible();
    await expect(byRole("button", { name: "Italic", pressed: false })).toBeVisible();
    await app.tap(byRole("button", { name: "Italic", pressed: false }));
    await expect(byRole("button", { name: "Italic", pressed: true })).toBeVisible();
  },
);

export const p2_04 = flow(
  "P2-04: ControlOrMeta+k keyboard shortcut dispatches cleanly",
  { tags: ["p2", "keys"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await app.tap(tid("shortcut-input"));
    await app.keyboard.press("ControlOrMeta+k");
    const log = await app.getText(tid("shortcut-log"));
    if (!/(Ctrl|Meta)\+k\(KeyK\)/.test(log)) {
      throw new Error(`Unexpected ControlOrMeta+k log: ${log}`);
    }
  },
);

export const p2_05 = flow(
  "P2-05: F2 and F12 function keys dispatch properly",
  { tags: ["p2", "keys"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await app.tap(tid("shortcut-input"));
    await app.keyboard.press("F2");
    await expect(tid("shortcut-log")).toHaveText("F2(F2)");
    await app.keyboard.press("F12");
    await expect(tid("shortcut-log")).toHaveText("F12(F12)");
  },
);

export const p2_06 = flow(
  "P2-06: Control+Shift+p and Alt+. chord shortcuts",
  { tags: ["p2", "keys"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await app.tap(tid("shortcut-input"));
    await app.keyboard.press("Control+Shift+p");
    await expect(tid("shortcut-log")).toHaveText(/Ctrl\+Shift\+[pP]\(KeyP\)/);
    await app.keyboard.press("Alt+.");
    await expect(tid("shortcut-log")).toHaveText("Alt+.(Period)");
  },
);

export const p2_07 = flow(
  "P2-07: held modifier keyDown(Control) applies to tap click",
  { tags: ["p2", "keys"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await app.keyboard.down("Control");
    try {
      await app.tap(tid("mod-click-btn"));
    } finally {
      await app.keyboard.up("Control");
    }
    await expect(tid("mod-click-log")).toHaveText("ctrl=true,shift=false,alt=false");
  },
);

export const p2_08 = flow(
  "P2-08: stepped mouse drag moves resizer handle with intermediate moves",
  { tags: ["p2", "pointer"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p2-forms`);
    const box = await app.boundingBox(tid("resizer-handle"));
    if (!box) throw new Error("Missing resizer handle box");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await app.mouse.move(startX, startY);
    await app.mouse.down();
    await app.mouse.move(startX + 120, startY, { steps: 6 });
    await app.mouse.up();
    const text = await app.getText(tid("resizer-log"));
    const m = /moves:(\d+),x:(\d+)/.exec(text);
    if (!m || Number(m[1]) < 5 || Number(m[2]) < 100) {
      throw new Error(`Expected >=5 intermediate moves and x>=100, got: ${text}`);
    }
  },
);

export const p2_09 = flow(
  "P2-09: HTML5 dragTo moves pointer and drops payload onto target",
  { tags: ["p2", "pointer"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await app.dragTo(tid("drag-source"), tid("drag-target"));
    await expect(tid("drag-log")).toHaveText("dropped:Task Alpha:hover=true");
  },
);

export const p2_10 = flow(
  "P2-10: controlled input fill, clear, selectOption, and checkbox toggle",
  { tags: ["p2", "forms"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p2-forms`);
    await app.fill(tid("street-input"), "42 Sveavagen");
    await expect(tid("street-input")).toHaveValue("42 Sveavagen");
    await app.clear(tid("street-input"));
    await app.fill(tid("street-input"), "99 Kungsgatan");
    await expect(tid("street-input")).toHaveValue("99 Kungsgatan");
    await app.selectOption(tid("country-select"), "se");
    await expect(tid("country-select")).toHaveValue("se");
    await app.check(tid("agree-box"));
    await expect(tid("agree-box")).toBeChecked();
  },
);

export default [p2_01, p2_02, p2_03, p2_04, p2_05, p2_06, p2_07, p2_08, p2_09, p2_10];
