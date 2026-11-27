import { flow } from "../../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const tid = (testID: string) => ({ testID });

export const smokeAuthed = flow(
  "authed-smoke: consumes setup storageState",
  { tags: ["smoke"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-dashboard`);
    await expect(tid("auth-cookie-state")).toHaveText("cookie:valid");
    await expect(tid("auth-storage-state")).toHaveText("user:setup-user@spana.dev");
  },
);

export const extraAuthed = flow(
  "authed-extra: skipped when --tag smoke is used",
  { tags: ["extra"] },
  async ({ app, expect }) => {
    await app.openLink(`${BASE}/p6-dashboard`);
    await expect(tid("auth-cookie-state")).toHaveText("cookie:valid");
  },
);

export default [smokeAuthed, extraAuthed];
