import { byCss, byRole, filterSelector, flow } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p1_01 = flow(
  "P1-01: async SPA hydration button becomes actionable",
  { tags: ["p1", "spa"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await app.tap(tid("hydrated-cta"));
    await expect(tid("hydrated-msg")).toHaveText("Hydration Click Confirmed");
  },
);

export const p1_02 = flow(
  "P1-02: React split text nodes match exact normalized string",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await expect({ text: "Alice (15 min)" }).toBeVisible();
    await expect(tid("split-badge")).toHaveText("Alice (15 min)");
  },
);

export const p1_03 = flow(
  "P1-03: React split text nodes match RegExp text selector",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await expect({ text: /Alice\s*\(\d+\s*min\)/ }).toBeVisible();
  },
);

export const p1_04 = flow(
  "P1-04: Markdown paragraph with autolinked anchor matches full text",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await expect({ text: /Visit https:\/\/spana\.dev\/docs for guides/ }).toBeVisible();
  },
);

export const p1_05 = flow(
  "P1-05: Markdown list item with inline strong/em matches normalized text",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await expect({ text: "Rule 1: Always normalize split text nodes" }).toBeVisible();
    await expect({ text: /Rule 2:\s+Support nested inline markup/ }).toBeVisible();
  },
);

export const p1_06 = flow(
  "P1-06: text selector does NOT falsely match text input value",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await expect(tid("draft-input")).toHaveValue("UniqueInputValueOnly");
    const matchedInputValue = await app.isVisible({ text: "UniqueInputValueOnly" });
    if (matchedInputValue) {
      throw new Error("Expected { text } NOT to match <input type=text> .value");
    }
  },
);

export const p1_07 = flow(
  "P1-07: text selector DOES match input type=submit value and clicks it",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await app.tap({ text: "Publish Draft Now" });
    await expect(tid("submit-status")).toHaveText("published:UniqueInputValueOnly");
  },
);

export const p1_08 = flow(
  "P1-08: toHaveText supports RegExp on dynamic counter",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await app.tap(tid("bump-counter"));
    await app.tap(tid("bump-counter"));
    await expect(tid("dynamic-counter")).toHaveText(/^Items:\s*2$/);
  },
);

export const p1_09 = flow(
  "P1-09: hasText filter works across CSS text-transform uppercase",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    const card = filterSelector(byCss(".upper-item"), { hasText: "alpha release" });
    await expect(card).toBeVisible();
    const upperCard = filterSelector(byCss(".upper-item"), { hasText: "ALPHA RELEASE" });
    await expect(upperCard).toBeVisible();
  },
);

export const p1_10 = flow(
  "P1-10: hasNotText excludes transformed card and selects sibling",
  { tags: ["p1", "text"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    const other = filterSelector(byCss(".upper-item"), { hasNotText: "alpha release" });
    await expect(other).toHaveText(/beta preview v1/i);
    await expect(byRole("heading", { name: "SPA Hydration Lab" })).toBeVisible();
  },
);

export default [p1_01, p1_02, p1_03, p1_04, p1_05, p1_06, p1_07, p1_08, p1_09, p1_10];
