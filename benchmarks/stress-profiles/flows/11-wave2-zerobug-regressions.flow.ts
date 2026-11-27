import { byCss, byLabel, flow, inFrame } from "../../../packages/spana/dist/index.js";

const PORT = Number(process.env.STRESS_PORT || 4410);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Profile 11 — Wave-2 Zero-Bug Regression Suite (10 scenarios):
 * Covers async toBeEnabled/toBeDisabled + fieldset/hidden, addInitScript isolation,
 * off-fold { force: true } scrollIntoView, scrollUntilVisible on web, sv-SE NBSP text/hasText,
 * sandboxed same-origin iframe without allow-scripts + frame.evaluate, recursive undefined args
 * in app.evaluate, sanitized default Chrome/ UA, <label for><span> byLabel fill, and Swedish keyboard.type.
 */

export const p11_01_enabled_disabled_async = flow(
  "P11-01: async toBeEnabled / toBeDisabled + fieldset + hidden input",
  { tags: ["p11", "wave2"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave2`);
    await expect({ testID: "w2-async-en" }).toBeEnabled({ timeout: 3_000 });
    await expect({ testID: "w2-async-en" }).not.toBeDisabled({ timeout: 1_000 });
    await expect({ testID: "w2-async-dis" }).toBeDisabled({ timeout: 3_000 });
    await expect({ testID: "w2-async-dis" }).not.toBeEnabled({ timeout: 1_000 });
    await expect({ testID: "w2-fs-btn" }).toBeDisabled({ timeout: 1_000 });
    await expect({ testID: "w2-hidden-file" }).toBeDisabled({ timeout: 1_000 });
  },
);

export const p11_02_initscript_mutates_canvas = flow(
  "P11-02: addInitScript overrides canvas prototype (must stay flow-scoped)",
  { tags: ["p11", "wave2"] },
  async ({ app }) => {
    await app.addInitScript(() => {
      (globalThis as any).HTMLCanvasElement.prototype.getContext = () => null;
    });
    await app.openLink(`${BASE}/wave2`);
    const blocked = await app.evaluate<boolean>(
      'Boolean(document.getElementById("w2-canvas") && document.getElementById("w2-canvas").getContext("2d") === null)',
    );
    if (!blocked) throw new Error("Expected addInitScript override to apply inside Flow 1");
  },
);

export const p11_03_initscript_does_not_leak = flow(
  "P11-03: subsequent flow sees clean unpatched canvas prototype",
  { tags: ["p11", "wave2"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/wave2`);
    const intact = await app.evaluate<boolean>(
      'Boolean(document.getElementById("w2-canvas") && document.getElementById("w2-canvas").getContext("2d") !== null)',
    );
    if (!intact) throw new Error("addInitScript leaked from prior flow!");
  },
);

export const p11_04_force_click_off_fold = flow(
  "P11-04: { force: true } scrolls off-fold aria-disabled button into view before clicking",
  { tags: ["p11", "wave2"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave2`);
    await app.tap({ testID: "w2-off-fold-btn" }, { force: true });
    await expect({ testID: "w2-off-fold-out" }).toContainText("forced-ok:");
    const y = await app.evaluate<number>("window.scrollY");
    if (y < 1000) throw new Error(`Expected scrollY > 1000 after off-fold force tap, got ${y}`);
  },
);

export const p11_05_scroll_until_visible_off_fold = flow(
  "P11-05: scrollUntilVisible actually scrolls off-fold web elements into viewport",
  { tags: ["p11", "wave2"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/wave2`);
    await app.scrollUntilVisible({ testID: "w2-off-fold-btn" });
    const y = await app.evaluate<number>("window.scrollY");
    if (y < 1000) throw new Error(`Expected scrollY > 1000 after scrollUntilVisible, got ${y}`);
  },
);

export const p11_06_nbsp_whitespace_matching = flow(
  "P11-06: sv-SE NBSP & narrow NBSP text and hasText matching",
  { tags: ["p11", "wave2"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave2`);
    await expect({ text: "4 200 000 kr" }).toBeVisible();
    await expect({ text: "4 200 000 kr", exact: true }).toBeVisible();
    await expect(byCss("div", { hasText: "4 200 000 kr" })).toBeVisible();
    await expect({ testID: "w2-nbsp" }).toHaveText("4 200 000 kr");
    await expect({ testID: "w2-nbsp" }).toContainText("200 000");
    await expect({ text: "9 500 kr", exact: true }).toBeVisible();
  },
);

export const p11_07_sandboxed_same_origin_no_scripts = flow(
  "P11-07: sandbox='allow-same-origin' iframe without allow-scripts query/fill/hidden/evaluate",
  { tags: ["p11", "wave2"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave2`);
    const frame = app.frame({ testID: "w2-sb-noscript" });
    await frame.expect({ testID: "w2-sb-h" }).toHaveText("Sandboxed No-Scripts");
    await frame.fill({ testID: "w2-sb-input" }, "portal-value");
    await frame.expect({ testID: "w2-sb-input" }).toHaveValue("portal-value");
    const res = await frame.evaluate((doc: any, _win: any, suffix: string) => {
      const badge = doc.getElementById("w2-sb-badge");
      if (badge) badge.style.display = "none";
      return `${doc.getElementById("w2-sb-input")?.value}:${suffix}`;
    }, "ok");
    if (res !== "portal-value:ok") throw new Error(`Unexpected frame.evaluate result: ${res}`);
    await expect(
      inFrame({ testID: "w2-sb-noscript" }, { testID: "w2-sb-badge" }),
    ).not.toBeVisible();
  },
);

export const p11_08_evaluate_recursive_undefined = flow(
  "P11-08: app.evaluate preserves nested undefined in arrays & objects",
  { tags: ["p11", "wave2"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/wave2`);
    const ok = await app.evaluate(
      (tuple: [string, string, unknown], obj: { a: number; b?: number }) =>
        tuple.length === 3 &&
        tuple[0] === "GET" &&
        tuple[2] === undefined &&
        "b" in obj &&
        obj.b === undefined,
      ["GET", "/api/items", undefined],
      { a: 1, b: undefined },
    );
    if (!ok) throw new Error("Nested undefined serialization failed in app.evaluate");
  },
);

export const p11_09_clean_default_ua = flow(
  "P11-09: default headless UA strips HeadlessChrome token",
  { tags: ["p11", "wave2"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/wave2`);
    const info = await app.evaluate<{ navUa: string; srvUa: string }>(
      '({ navUa: navigator.userAgent, srvUa: document.getElementById("w2-ua")?.textContent || "" })',
    );
    if (!info.navUa.includes("Chrome/") || info.navUa.includes("HeadlessChrome")) {
      throw new Error(`Unsanitized navigator.userAgent: ${info.navUa}`);
    }
    if (!info.srvUa.includes("Chrome/") || info.srvUa.includes("HeadlessChrome")) {
      throw new Error(`Unsanitized server User-Agent: ${info.srvUa}`);
    }
  },
);

export const p11_10_bylabel_span_and_swedish_type = flow(
  "P11-10: byLabel <label for><span> sibling input + Swedish åäö keyboard.type",
  { tags: ["p11", "wave2"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave2`);
    await app.fill(byLabel("Lägg till en bild: beskriv bilden"), "Kök i ek");
    await expect({ testID: "w2-lbl-in" }).toHaveValue("Kök i ek");
    await app.tap({ testID: "w2-sv-in" });
    await app.keyboard.type("Vårkampanj: 20 % på blandare — åäöÅÄÖ");
    await expect({ testID: "w2-sv-in" }).toHaveValue("Vårkampanj: 20 % på blandare — åäöÅÄÖ");
  },
);

export default [
  p11_01_enabled_disabled_async,
  p11_02_initscript_mutates_canvas,
  p11_03_initscript_does_not_leak,
  p11_04_force_click_off_fold,
  p11_05_scroll_until_visible_off_fold,
  p11_06_nbsp_whitespace_matching,
  p11_07_sandboxed_same_origin_no_scripts,
  p11_08_evaluate_recursive_undefined,
  p11_09_clean_default_ua,
  p11_10_bylabel_span_and_swedish_type,
];
