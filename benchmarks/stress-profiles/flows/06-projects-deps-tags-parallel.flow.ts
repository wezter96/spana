import { flow, suite } from "../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const p6_01 = flow(
  "P6-01: login form authenticates and reaches protected dashboard",
  { tags: ["p6", "auth"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-login`);
    await app.fill(tid("login-email"), "alice@spana.dev");
    await app.fill(tid("login-password"), "super-secret-pass");
    await app.tap(tid("login-submit"));
    await expect(tid("auth-cookie-state")).toHaveText("cookie:valid");
    await expect(tid("auth-storage-state")).toHaveText("user:alice@spana.dev");
  },
);

export const p6_02 = flow(
  "P6-02: fresh flow has clean unauthenticated cookie & storage state",
  { tags: ["p6", "isolation"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-dashboard`);
    await expect(tid("auth-cookie-state")).toHaveText("cookie:missing");
    await expect(tid("auth-storage-state")).toHaveText("user:anonymous");
  },
);

export const p6_03 = flow(
  "P6-03: saveAuthState + loadAuthState restores cookies and localStorage",
  { tags: ["p6", "auth"] },
  async ({ app, expect }) => {
    const stateFile = `/tmp/spana-stress-auth-${process.pid}-${Date.now()}.json`;
    await app.openLink(`${BASE}/p6-login`);
    await app.fill(tid("login-email"), "bob@spana.dev");
    await app.fill(tid("login-password"), "pass123");
    await app.tap(tid("login-submit"));
    await expect(tid("auth-cookie-state")).toHaveText("cookie:valid");
    await app.saveAuthState(stateFile);

    await app.clearCookies();
    await app.openLink(`${BASE}/p6-dashboard`);
    await expect(tid("auth-cookie-state")).toHaveText("cookie:missing");

    await app.loadAuthState(stateFile);
    await app.openLink(`${BASE}/p6-dashboard`);
    await expect(tid("auth-cookie-state")).toHaveText("cookie:valid");
    await expect(tid("auth-storage-state")).toHaveText("user:bob@spana.dev");
  },
);

export const p6_04 = flow(
  "P6-04: parallel worker isolation A (localStorage write)",
  { tags: ["p6", "parallel"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-dashboard`);
    await app.evaluate(() => localStorage.setItem("stress_user", "worker-A"));
    await app.reload();
    await expect(tid("auth-storage-state")).toHaveText("user:worker-A");
  },
);

export const p6_05 = flow(
  "P6-05: parallel worker isolation B (clean localStorage)",
  { tags: ["p6", "parallel"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-dashboard`);
    await app.evaluate(() => localStorage.setItem("stress_user", "worker-B"));
    await app.reload();
    await expect(tid("auth-storage-state")).toHaveText("user:worker-B");
  },
);

export const p6_06 = flow(
  "P6-06: setCookies + getCookies roundtrip",
  { tags: ["p6", "auth"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-dashboard`);
    await app.setCookies([{ name: "stress_session", value: "valid", url: `${BASE}/` }]);
    await app.reload();
    await expect(tid("auth-cookie-state")).toHaveText("cookie:valid");
    const cookies = await app.getCookies();
    if (!cookies.some((c) => c.name === "stress_session" && c.value === "valid")) {
      throw new Error("Expected stress_session cookie in getCookies()");
    }
  },
);

export const p6_07 = flow(
  "P6-07: parallel smoke tag filter target",
  { tags: ["p6", "smoke-only"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-dashboard`);
    await expect(tid("worker-marker")).toHaveText("ready");
  },
);

const serialFlows = suite.serial("P6-serial", (s) => {
  s.flow(
    "P6-08: serial step 1 runs before step 2",
    { tags: ["p6", "serial"] },
    async ({ app, expect }) => {
      await app.openLink(`${BASE}/p6-dashboard`);
      await expect(tid("worker-marker")).toHaveText("ready");
    },
  );
  s.flow(
    "P6-09: serial step 2 runs in order",
    { tags: ["p6", "serial"] },
    async ({ app, expect }) => {
      await app.openLink(`${BASE}/p6-dashboard`);
      await expect(tid("worker-marker")).toHaveText("ready");
    },
  );
  s.flow(
    "P6-10: serial step 3 completes group",
    { tags: ["p6", "serial"] },
    async ({ app, expect }) => {
      await app.openLink(`${BASE}/p6-dashboard`);
      await expect(tid("worker-marker")).toHaveText("ready");
    },
  );
});

export default [p6_01, p6_02, p6_03, p6_04, p6_05, p6_06, p6_07, ...serialFlows];
