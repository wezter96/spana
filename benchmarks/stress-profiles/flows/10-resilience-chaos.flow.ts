import { flow } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p10_01 = flow(
  "P10-01: console log/warn/error events captured accurately",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p10-resilience`);
    await app.tap(tid("emit-console"));
    await expect
      .poll(async () => (await app.getConsoleLogs()).map((l) => l.text).join("|"), {
        timeout: 3000,
      })
      .toContain("stress-error-msg");
    const logs = await app.getConsoleLogs();
    const hasInfo = logs.some((l) => l.text.includes("stress-info-msg"));
    const hasWarn = logs.some((l) => l.text.includes("stress-warn-msg"));
    if (!hasInfo || !hasWarn) {
      throw new Error(`Missing expected console logs: ${JSON.stringify(logs)}`);
    }
  },
);

export const p10_02 = flow(
  "P10-02: uncaught page JS errors captured via getJSErrors()",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p10-resilience`);
    await app.tap(tid("emit-js-error"));
    await expect
      .poll(async () => (await app.getJSErrors()).map((e) => e.message).join("|"), {
        timeout: 3000,
      })
      .toContain("IntentionalChaosRuntimeError");
  },
);

export const p10_03 = flow(
  "P10-03: failed navigation to unreachable port rejects cleanly without unhandled rejection",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    let caught = false;
    try {
      await app.openLink("http://127.0.0.1:1/unreachable", { timeout: 3000 });
    } catch {
      caught = true;
    }
    if (!caught) throw new Error("Expected unreachable navigation to reject");
    // Driver must remain completely healthy after aborted navigation
    await app.openLink(`${BASE}/p10-resilience`);
    await expect(tid("reload-counter")).toHaveText("loads:1");
  },
);

export const p10_04 = flow(
  "P10-04: waitForPopup trigger throw cleans up without unhandled rejection",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p10-resilience`);
    let caught = false;
    try {
      await app.waitForPopup(
        async () => {
          throw new Error("TriggerExploded");
        },
        { timeout: 2000 },
      );
    } catch (err) {
      caught = String(err).includes("TriggerExploded");
    }
    if (!caught) throw new Error("Expected TriggerExploded error");
    await expect(tid("emit-console")).toBeVisible();
  },
);

export const p10_05 = flow(
  "P10-05: waitForDownload captures file and trigger throw cleans up safely",
  { tags: ["p10", "resilience"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p10-resilience`);
    let caught = false;
    try {
      await app.waitForDownload(
        async () => {
          throw new Error("DownloadTriggerBoom");
        },
        { timeout: 2000 },
      );
    } catch (err) {
      caught = String(err).includes("DownloadTriggerBoom");
    }
    if (!caught) throw new Error("Expected DownloadTriggerBoom");

    const dl = await app.waitForDownload(
      async () => {
        await app.tap(tid("download-link"));
      },
      { timeout: 5000 },
    );
    if (!dl.suggestedFilename.includes("stress-report.txt")) {
      throw new Error(`Unexpected download filename: ${dl.suggestedFilename}`);
    }
  },
);

export const p10_06 = flow(
  "P10-06: reload() increments session counter and stays responsive",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p10-resilience`);
    await expect(tid("reload-counter")).toHaveText("loads:1");
    await app.reload();
    await expect(tid("reload-counter")).toHaveText("loads:2");
    await app.reload();
    await expect(tid("reload-counter")).toHaveText("loads:3");
  },
);

export const p10_07 = flow(
  "P10-07: closing an isolated context cleanly rejects no orphan promises",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    const iso = await app.newContext({ url: `${BASE}/p10-resilience` });
    await iso.expect(tid("reload-counter")).toHaveText("loads:1");
    await iso.close();
    // Parent app still healthy
    await app.openLink(`${BASE}/p10-resilience`);
    await expect(tid("reload-counter")).toHaveText("loads:1");
  },
);

export const p10_08 = flow(
  "P10-08: rapid back-to-back openLink navigations abort prior load cleanly",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p1-spa`);
    await app.openLink(`${BASE}/p2-forms`);
    await app.openLink(`${BASE}/p3-hover-visibility`);
    await app.openLink(`${BASE}/p10-resilience`);
    await expect(tid("reload-counter")).toHaveText("loads:1");
  },
);

export const p10_09 = flow(
  "P10-09: missing selector wait times out with clear diagnostic error",
  { tags: ["p10", "resilience"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p10-resilience`);
    let errMsg = "";
    try {
      await app.waitFor(tid("never-gonna-appear"), { timeout: 250 });
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
    }
    if (!errMsg) throw new Error("Expected timeout error on missing element");
    await expect(tid("emit-console")).toBeVisible();
  },
);

export const p10_10 = flow(
  "P10-10: post-chaos screenshot capture and page health check succeed",
  { tags: ["p10", "resilience"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p10-resilience`);
    const png = await app.takeScreenshot();
    if (!png || png.length < 500) {
      throw new Error(`Expected valid PNG screenshot, got ${png?.length ?? 0} bytes`);
    }
    const title = await app.evaluate(() => document.title);
    if (!title.includes("Resilience")) {
      throw new Error(`Unexpected title: ${title}`);
    }
  },
);

export default [p10_01, p10_02, p10_03, p10_04, p10_05, p10_06, p10_07, p10_08, p10_09, p10_10];
