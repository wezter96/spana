import { byRole, first, flow, last, nth, within } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p3_01 = flow(
  "P3-01: @media (any-hover: hover) and (hover: hover) are true in headless CDP",
  { tags: ["p3", "hover"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await expect(tid("media-info")).toHaveText("anyHover=true,hover=true,fine=true");
  },
);

export const p3_02 = flow(
  "P3-02: hovering row reveals CSS media-query gated action button",
  { tags: ["p3", "hover"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await app.hover(tid("hover-row"));
    await expect(tid("hover-edit-btn")).toBeVisible();
    await app.tap(tid("hover-edit-btn"));
    await expect(tid("hover-status")).toHaveText("edited");
  },
);

export const p3_03 = flow(
  "P3-03: document.hasFocus() is true via Emulation.setFocusEmulationEnabled",
  { tags: ["p3", "focus"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await expect(tid("focus-status")).toHaveText("hasFocus=true");
  },
);

export const p3_04 = flow(
  "P3-04: keyboard focus updates activeElement and focus-visible state",
  { tags: ["p3", "focus"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await app.focus(tid("focus-btn"));
    await expect(tid("focus-btn")).toBeFocused();
  },
);

export const p3_05 = flow(
  "P3-05: first() skips hidden mobile drawer and clicks visible desktop button",
  { tags: ["p3", "visibility"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await app.tap(first(tid("nav-action")));
    await expect(tid("nav-log")).toHaveText("desktop-0");
  },
);

export const p3_06 = flow(
  "P3-06: nth(1) and last() resolve against visible desktop controls",
  { tags: ["p3", "visibility"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await app.tap(nth(tid("nav-action"), 1));
    await expect(tid("nav-log")).toHaveText("desktop-1");
    await app.tap(last(tid("nav-action")));
    await expect(tid("nav-log")).toHaveText("desktop-1");
  },
);

export const p3_07 = flow(
  "P3-07: within(first(card)) scopes to visible card not hidden drawer",
  { tags: ["p3", "visibility"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await app.tap(within(first(tid("panel-card")), byRole("button", { name: "Open Item" })));
    await expect(tid("nav-log")).toHaveText("visible-card");
  },
);

export const p3_08 = flow(
  "P3-08: app.isVisible(missing) returns false immediately without 1s hang",
  { tags: ["p3", "visibility"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    const t0 = performance.now();
    const vis = await app.isVisible(tid("does-not-exist-xyz"));
    const dt = performance.now() - t0;
    if (vis) throw new Error("Missing element reported visible");
    if (dt > 500) throw new Error(`Expected instant isVisible (<500ms), took ${Math.round(dt)}ms`);
  },
);

export const p3_09 = flow(
  "P3-09: toBeHidden succeeds on hidden mobile drawer element",
  { tags: ["p3", "visibility"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await expect(tid("drawer-only-btn")).toBeHidden();
  },
);

export const p3_10 = flow(
  "P3-10: click right after startViewTransition lands cleanly",
  { tags: ["p3", "visibility"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await app.tap(tid("vt-trigger"));
    await app.tap(tid("vt-target"));
    await expect(tid("vt-log")).toHaveText("clicked-after-vt");
  },
);

export default [p3_01, p3_02, p3_03, p3_04, p3_05, p3_06, p3_07, p3_08, p3_09, p3_10];
