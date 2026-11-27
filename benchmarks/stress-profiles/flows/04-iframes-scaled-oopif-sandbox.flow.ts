import { byCss, flow, inFrame } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p4_01 = flow(
  "P4-01: CSS scale(0.5) same-origin iframe click lands accurately",
  { tags: ["p4", "iframe"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await app.tap(inFrame(tid("scaled-iframe"), tid("same-child-btn")));
    await expect(inFrame(tid("scaled-iframe"), tid("same-child-out"))).toHaveText("same-clicked");
  },
);

export const p4_02 = flow(
  "P4-02: boundingBox of element inside scaled(0.5) iframe is scaled",
  { tags: ["p4", "iframe"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    const frameBox = await app.boundingBox(tid("scaled-iframe"));
    const btnBox = await app.boundingBox(inFrame(tid("scaled-iframe"), tid("same-child-btn")));
    if (!frameBox || !btnBox) throw new Error("Missing frame or child button box");
    if (btnBox.x < frameBox.x || btnBox.x + btnBox.width > frameBox.x + frameBox.width + 2) {
      throw new Error(
        `Scaled child box ${JSON.stringify(btnBox)} outside frame ${JSON.stringify(frameBox)}`,
      );
    }
  },
);

export const p4_03 = flow(
  "P4-03: nested scaled iframes (0.75 * 0.8) click lands accurately",
  { tags: ["p4", "iframe"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await app.tap(inFrame(tid("nested-outer"), tid("nested-btn")));
    await expect(inFrame(tid("nested-outer"), tid("nested-out"))).toHaveText("nested-clicked");
  },
);

export const p4_04 = flow(
  "P4-04: static cross-origin OOPIF tap and text assertion",
  { tags: ["p4", "oopif"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await app.tap(inFrame(tid("oopif-static"), tid("oopif-btn")));
    await expect(inFrame(tid("oopif-static"), tid("oopif-out"))).toHaveText("oopif-clicked");
  },
);

export const p4_05 = flow(
  "P4-05: dynamic OOPIF transitioning from about:blank updates URL via Target.targetInfoChanged",
  { tags: ["p4", "oopif"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await app.tap(inFrame(tid("oopif-dynamic"), tid("oopif-dyn-btn")));
    await expect(inFrame(tid("oopif-dynamic"), tid("oopif-dyn-out"))).toHaveText(
      "oopif-dyn-clicked",
    );
  },
);

export const p4_06 = flow(
  "P4-06: scaled cross-origin OOPIF (0.6) tap lands accurately",
  { tags: ["p4", "oopif"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await app.tap(inFrame(tid("oopif-scaled"), tid("oopif-scaled-btn")));
    await expect(inFrame(tid("oopif-scaled"), tid("oopif-scaled-out"))).toHaveText(
      "oopif-scaled-clicked",
    );
  },
);

export const p4_07 = flow(
  "P4-07: sandbox=allow-scripts srcdoc opaque-origin iframe executes & clicks",
  { tags: ["p4", "sandbox"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await app.tap(inFrame(tid("sandbox-scripts"), tid("sb-btn")));
    await expect(inFrame(tid("sandbox-scripts"), tid("sb-out"))).toHaveText("sandbox-clicked");
  },
);

export const p4_08 = flow(
  "P4-08: sandbox=allow-same-origin (no scripts) iframe reads DOM",
  { tags: ["p4", "sandbox"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await expect(inFrame(tid("sandbox-same-origin"), tid("sb-same-origin-text"))).toHaveText(
      "Same-Origin Sandboxed Content",
    );
  },
);

export const p4_09 = flow(
  "P4-09: late-mounting same-origin iframe becomes interactive after click",
  { tags: ["p4", "iframe"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await app.tap(tid("mount-late-iframe"));
    await app.tap(inFrame(tid("late-same-iframe"), tid("same-child-btn")));
    await expect(inFrame(tid("late-same-iframe"), tid("same-child-out"))).toHaveText(
      "same-clicked",
    );
  },
);

export const p4_10 = flow(
  "P4-10: late-mounting OOPIF and strict sandbox iframe inspection",
  { tags: ["p4", "oopif"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p4-iframes`);
    await expect(byCss('iframe[data-testid="sandbox-strict"]')).toBeVisible();
    await app.tap(tid("mount-late-oopif"));
    await app.tap(inFrame(tid("late-oopif"), tid("oopif-late-btn")));
    await expect(inFrame(tid("late-oopif"), tid("oopif-late-out"))).toHaveText(
      "oopif-late-clicked",
    );
  },
);

export default [p4_01, p4_02, p4_03, p4_04, p4_05, p4_06, p4_07, p4_08, p4_09, p4_10];
