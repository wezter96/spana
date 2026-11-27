import { byCss, byLabel, byRole, flow } from "../../../packages/spana/dist/index.js";

const PORT = Number(process.env.STRESS_PORT || 4410);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Profile 12 — Wave-3 Zero-Bug Polish & Bolagy/Monotirith Regressions (10 scenarios):
 * Covers setEmulation({ locale }) UA preservation + userAgent, cached repeated axe-core audits,
 * mobile DPR/touch setViewport, includeHidden on count/isChecked/getAttribute, httpCredentials
 * Basic Auth over Direct CDP, lastNavigationStatus(), CORS preflight OPTIONS auto-handling in
 * route(), opacity:0 hover-revealed byRole+focus, JS keyword "return" in selector strings,
 * half-clipped button click coordinates, RegExp byLabel uploadFile, and implicit ARIA roles.
 */

export const p12_01_locale_preserves_ua = flow(
  "P12-01: setEmulation({ locale }) preserves sanitized Chrome UA and custom userAgent",
  { tags: ["p12", "wave3"] },
  async ({ app }) => {
    await app.setEmulation({ locale: "sv-SE" });
    await app.openLink(`${BASE}/wave3-headers`);
    const ua = await app.getText({ testID: "w3-ua" });
    if (!ua.includes("Chrome/") || ua.includes("HeadlessChrome")) {
      throw new Error(`Expected sanitized Chrome UA after locale emulation, got: ${ua}`);
    }
    await app.setEmulation({ userAgent: "StressWave3UA/1.0" });
    await app.setEmulation({ locale: "de-DE" });
    await app.openLink(`${BASE}/wave3-headers`);
    const customUa = await app.getText({ testID: "w3-ua" });
    const al = await app.getText({ testID: "w3-al" });
    if (customUa !== "StressWave3UA/1.0" || !al.toLowerCase().includes("de-de")) {
      throw new Error(`Expected StressWave3UA/1.0 + de-DE, got ua=${customUa} al=${al}`);
    }
  },
);

export const p12_02_cached_axe_audits = flow(
  "P12-02: repeated toPassAccessibilityAudit reuses injected cached axe-core without re-injection",
  { tags: ["p12", "wave3"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave3`);
    await expect(byCss("body")).toPassAccessibilityAudit();
    await app.evaluate("window.axe.__stressMarker = 'reused'");
    await expect(byCss("body")).toPassAccessibilityAudit();
    const marker = await app.evaluate<string>("window.axe && window.axe.__stressMarker");
    if (marker !== "reused") {
      throw new Error(`Expected axe instance to be reused without re-injection, got ${marker}`);
    }
  },
);

export const p12_03_mobile_viewport_and_include_hidden = flow(
  "P12-03: mobile setViewport (DPR/touch) + includeHidden on count/isChecked/getAttribute",
  { tags: ["p12", "wave3"] },
  async ({ app }) => {
    await app.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await app.openLink(`${BASE}/wave3`);
    const m = await app.evaluate<{ dpr: number; touch: boolean }>(
      "({ dpr: window.devicePixelRatio, touch: 'ontouchstart' in window })",
    );
    if (m.dpr !== 2 || !m.touch) {
      throw new Error(`Expected DPR=2 & touch=true, got ${JSON.stringify(m)}`);
    }
    const visCount = await app.count(byRole("checkbox"));
    const allCount = await app.count(byRole("checkbox"), { includeHidden: true });
    if (visCount !== 1 || allCount !== 2) {
      throw new Error(`Expected visible=1, all=2 checkboxes, got ${visCount}/${allCount}`);
    }
    const hiddenChecked = await app.isChecked({ testID: "w3-hid-chk" }, { includeHidden: true });
    const hiddenAttr = await app.getAttribute({ testID: "w3-hid-chk" }, "data-meta", {
      includeHidden: true,
    });
    if (!hiddenChecked || hiddenAttr !== "w3-secret") {
      throw new Error(`Expected hidden checkbox checked + data-meta=w3-secret`);
    }
  },
);

export const p12_04_http_credentials_basic_auth = flow(
  "P12-04: Direct CDP httpCredentials handles HTTP 401 Basic Auth and rejects wrong creds cleanly",
  { tags: ["p12", "wave3"] },
  async ({ app }) => {
    const authed = await app.newContext({
      httpCredentials: { username: "stress", password: "wave3" },
    });
    try {
      await authed.app.openLink(`${BASE}/wave3-basic-auth`);
      if (authed.app.lastNavigationStatus() !== 200) {
        throw new Error(`Expected 200 with valid creds, got ${authed.app.lastNavigationStatus()}`);
      }
      const txt = await authed.app.getText({ testID: "w3-auth-ok" });
      if (txt !== "Wave 3 Authed") throw new Error(`Unexpected body: ${txt}`);
    } finally {
      await authed.close();
    }

    const denied = await app.newContext({
      httpCredentials: { username: "stress", password: "wrong" },
    });
    try {
      await denied.app.openLink(`${BASE}/wave3-basic-auth`);
      if (denied.app.lastNavigationStatus() !== 401) {
        throw new Error(`Expected 401 with bad creds, got ${denied.app.lastNavigationStatus()}`);
      }
    } finally {
      await denied.close();
    }
  },
);

export const p12_05_last_navigation_status = flow(
  "P12-05: app.lastNavigationStatus() reports 200, 404, and 302->200 accurately",
  { tags: ["p12", "wave3"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/wave3`);
    if (app.lastNavigationStatus() !== 200) {
      throw new Error(`Expected 200, got ${app.lastNavigationStatus()}`);
    }
    await app.openLink(`${BASE}/wave3-status-404`);
    if (app.lastNavigationStatus() !== 404) {
      throw new Error(`Expected 404, got ${app.lastNavigationStatus()}`);
    }
    await app.openLink(`${BASE}/wave3-redirect`);
    if (app.lastNavigationStatus() !== 200) {
      throw new Error(`Expected 200 after 302 redirect, got ${app.lastNavigationStatus()}`);
    }
  },
);

export const p12_06_route_cors_preflight = flow(
  "P12-06: app.route() automatically answers CORS preflight OPTIONS for mocked POST APIs",
  { tags: ["p12", "wave3"] },
  async ({ app, expect }) => {
    await app.route("**/api/ping", async (route) => {
      await route.fulfill({
        status: 200,
        json: { pong: "wave3-ok" },
        headers: { "access-control-allow-origin": "*" },
      });
    });
    await app.openLink(`${BASE}/wave3`);
    await app.tap({ testID: "w3-cors-trigger" });
    await expect({ testID: "w3-cors-out" }).toHaveText("cors:wave3-ok");
  },
);

export const p12_07_opacity_zero_and_select_option = flow(
  "P12-07: opacity:0 hover-revealed controls visible + focusable and closed select options resolvable",
  { tags: ["p12", "wave3"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave3`);
    await expect(byRole("button", { name: "Reveal Menu Action" })).toBeVisible();
    await app.focus(byRole("button", { name: "Reveal Menu Action" }));
    await expect({ testID: "w3-focus-out" }).toHaveText("focused-ok");
    const optCount = await app.count(byRole("option", { name: "Sweden" }));
    if (optCount !== 1) throw new Error(`Expected 1 Sweden option, got ${optCount}`);
  },
);

export const p12_08_return_keyword_and_regex_upload = flow(
  "P12-08: 'VAT return' selector string + uploadFile(byLabel(/regex/))",
  { tags: ["p12", "wave3"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave3`);
    await app.tap(byRole("button", { name: "VAT return" }));
    await expect({ testID: "w3-vat-out" }).toHaveText("vat-ok");
    await app.uploadFile(byLabel(/upload quarterly receipt/i), {
      name: "q4-receipt.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("receipt-content"),
    });
    await expect({ testID: "w3-file-out" }).toHaveText("q4-receipt.pdf");
  },
);

export const p12_09_half_clipped_button_click = flow(
  "P12-09: half-clipped element in overflow:hidden container clicks visible clipped point",
  { tags: ["p12", "wave3"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/wave3`);
    await app.tap({ testID: "w3-clip-btn" });
    await expect({ testID: "w3-clip-out" }).toHaveText("clip-ok");
  },
);

export const p12_10_implicit_aria_roles_and_ctx_skip_guard = flow(
  "P12-10: implicit ARIA roles (table+caption, figure+figcaption, meter, output) + false ctx.skip guard",
  { tags: ["p12", "wave3"] },
  async ({ app, expect, skip }) => {
    skip(false, "should not skip when false");
    await app.openLink(`${BASE}/wave3`);
    await expect(byRole("table", { name: "Accounting Summary" })).toBeVisible();
    await expect(byRole("figure", { name: "Annual Balance Figure" })).toBeVisible();
    await expect(byRole("meter", { name: "Quota Used" })).toBeVisible();
    await expect(byRole("status", { name: "Net Result" })).toBeVisible();
  },
);

export default [
  p12_01_locale_preserves_ua,
  p12_02_cached_axe_audits,
  p12_03_mobile_viewport_and_include_hidden,
  p12_04_http_credentials_basic_auth,
  p12_05_last_navigation_status,
  p12_06_route_cors_preflight,
  p12_07_opacity_zero_and_select_option,
  p12_08_return_keyword_and_regex_upload,
  p12_09_half_clipped_button_click,
  p12_10_implicit_aria_roles_and_ctx_skip_guard,
];
