import { flow } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p5_01 = flow(
  "P5-01: multi-tab popup with active route() does not break next flow navigation",
  { tags: ["p5", "network"] },
  async ({ app, expect }) => {
    await app.route("**/api/items", async (route) => {
      await route.fulfill({ status: 200, json: { source: "routed", items: ["x"] } });
    });
    await app.openLink(`${BASE}/p5-multitab-network`);
    await app.tap(tid("fetch-items-btn"));
    await expect(tid("fetch-result")).toHaveText(/routed/);
    const popupTab = await app.waitForPopup(async () => {
      await app.tap(tid("open-popup-link"));
    });
    const tabIds = await app.getTabIds();
    const popupIdx = tabIds.indexOf(popupTab);
    await app.switchToTab(popupIdx >= 0 ? popupIdx : 1);
    await expect(tid("popup-heading")).toHaveText("Secondary Tab Loaded");
    await app.tap(tid("popup-action"));
    await expect(tid("popup-out")).toHaveText("popup-ok");
    await app.closeTab();
  },
);

export const p5_02 = flow(
  "P5-02: immediate navigation after multi-tab routed flow stays fast (Collie #12)",
  { tags: ["p5", "network"] },
  async ({ app, expect }) => {
    const t0 = performance.now();
    await app.openLink(`${BASE}/p5-multitab-network`);
    const navMs = performance.now() - t0;
    if (navMs > 5000) {
      throw new Error(`Navigation stalled after routed multi-tab flow: ${Math.round(navMs)}ms`);
    }
    await app.tap(tid("fetch-items-btn"));
    await expect(tid("fetch-result")).toHaveText(/source":"server/);
  },
);

export const p5_03 = flow(
  "P5-03: LIFO route.fallback() chains overrides to earlier handler",
  { tags: ["p5", "network"] },
  async ({ app, expect }) => {
    await app.route("**/api/echo", async (route) => {
      await route.continue({
        headers: { ...route.request().headers, "x-extra": "from-first" },
      });
    });
    await app.route("**/api/echo", async (route) => {
      await route.fallback({
        headers: { ...route.request().headers, "x-client": "overridden-by-second" },
      });
    });
    await app.openLink(`${BASE}/p5-multitab-network`);
    await app.tap(tid("fetch-echo-btn"));
    await expect(tid("fetch-result")).toHaveText(/overridden-by-second/);
    await expect(tid("fetch-result")).toHaveText(/from-first/);
  },
);

export const p5_04 = flow(
  "P5-04: unroute(matcher, handler) removes specific handler while keeping others",
  { tags: ["p5", "network"] },
  async ({ app, expect }) => {
    const handlerA = async (route: {
      fulfill: (r: { status: number; json: unknown }) => Promise<void>;
    }) => {
      await route.fulfill({ status: 200, json: { source: "handlerA" } });
    };
    const handlerB = async (route: {
      fulfill: (r: { status: number; json: unknown }) => Promise<void>;
    }) => {
      await route.fulfill({ status: 200, json: { source: "handlerB" } });
    };
    await app.route("**/api/items", handlerA);
    await app.route("**/api/items", handlerB);
    await app.openLink(`${BASE}/p5-multitab-network`);
    await app.tap(tid("fetch-items-btn"));
    await expect(tid("fetch-result")).toHaveText(/handlerB/);

    await app.unroute("**/api/items", handlerB);
    await app.tap(tid("fetch-items-btn"));
    await expect(tid("fetch-result")).toHaveText(/handlerA/);

    await app.unroute("**/api/items");
    await app.tap(tid("fetch-items-btn"));
    await expect(tid("fetch-result")).toHaveText(/source":"server/);
  },
);

export const p5_05 = flow(
  "P5-05: mockNetwork, blockNetwork, and clearNetworkMocks lifecycle",
  { tags: ["p5", "network"] },
  async ({ app, expect }) => {
    await app.mockNetwork("**/api/items", { status: 201, json: { mocked: true } });
    await app.blockNetwork("**/api/blocked-resource");
    await app.openLink(`${BASE}/p5-multitab-network`);
    await app.tap(tid("fetch-items-btn"));
    await expect(tid("fetch-result")).toHaveText(/201:.*mocked":true/);
    await app.tap(tid("fetch-blocked-btn"));
    await expect(tid("fetch-result")).toHaveText(/^blocked:/);

    await app.clearNetworkMocks();
    await app.tap(tid("fetch-items-btn"));
    await expect(tid("fetch-result")).toHaveText(/source":"server/);
  },
);

export const p5_06 = flow(
  "P5-06: addInitScript injects before page script runs",
  { tags: ["p5", "initscript"] },
  async ({ app, expect }) => {
    await app.addInitScript(`window.__STRESS_INIT_TOKEN__ = "injected-secret-42";`);
    await app.openLink(`${BASE}/p5-multitab-network`);
    await expect(tid("init-token")).toHaveText("injected-secret-42");
  },
);

export const p5_07 = flow(
  "P5-07: addInitScript from prior flow does NOT leak into next flow",
  { tags: ["p5", "initscript"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p5-multitab-network`);
    await expect(tid("init-token")).toHaveText("none");
  },
);

export const p5_08 = flow(
  "P5-08: exposeFunction works in flow and newContext supports userAgent & locale",
  { tags: ["p5", "context"] },
  async ({ app, expect }) => {
    await app.exposeFunction("__stressMultiply", (a: number, b: number) => a * b);
    await app.openLink(`${BASE}/p5-multitab-network`);
    await app.tap(tid("call-exposed-btn"));
    await expect(tid("exposed-result")).toHaveText("42");

    const ctx = await app.newContext({
      url: `${BASE}/p5-multitab-network`,
      userAgent: "SpanaStressBot/1.0",
      locale: "sv-SE",
      viewport: { width: 800, height: 600 },
    });
    try {
      await ctx.expect(tid("ua-info")).toHaveText("SpanaStressBot/1.0");
      const width = await ctx.app.evaluate(() => window.innerWidth);
      if (width !== 800) throw new Error(`Expected isolated context width 800, got ${width}`);
    } finally {
      await ctx.close();
    }
  },
);

export const p5_09 = flow(
  "P5-09: app.evaluate preserves undefined positional arguments",
  { tags: ["p5", "evaluate"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p5-multitab-network`);
    const res = await app.evaluate(
      (a: string, b: unknown, c: number) => ({ a, bType: typeof b, bUndef: b === undefined, c }),
      "hello",
      undefined,
      99,
    );
    if (res.a !== "hello" || !res.bUndef || res.bType !== "undefined" || res.c !== 99) {
      throw new Error(`Unexpected evaluate undefined arg result: ${JSON.stringify(res)}`);
    }
  },
);

export const p5_10 = flow(
  "P5-10: waitForRequest and waitForResponse capture live POST echo",
  { tags: ["p5", "network"] },
  async ({ app }) => {
    await app.openLink(`${BASE}/p5-multitab-network`);
    const reqP = app.waitForRequest((r) => r.url.includes("/api/echo") && r.method === "POST");
    const resP = app.waitForResponse((r) => r.url.includes("/api/echo") && r.status === 200);
    await app.tap(tid("fetch-echo-btn"));
    const [req, res] = await Promise.all([reqP, resP]);
    if (req.method !== "POST") throw new Error(`Expected POST, got ${req.method}`);
    const payload = await res.json<{ source: string }>();
    if (payload.source !== "server")
      throw new Error(`Unexpected echo response: ${JSON.stringify(payload)}`);
  },
);

export default [p5_01, p5_02, p5_03, p5_04, p5_05, p5_06, p5_07, p5_08, p5_09, p5_10];
