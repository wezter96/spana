import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flow } from "../../../../packages/spana/dist/index.js";

const BASE = `http://127.0.0.1:${process.env.STRESS_PORT || 4410}`;
const here = dirname(fileURLToPath(import.meta.url));
const statePath = resolve(here, "../.auth-state.json");
const tid = (testID: string) => ({ testID });

export default flow("auth.setup: sign in and persist storageState", async ({ app, expect }) => {
  await app.openLink(`${BASE}/p6-login`);
  await app.fill(tid("login-email"), "setup-user@spana.dev");
  await app.fill(tid("login-password"), "setup-secret");
  await app.tap(tid("login-submit"));
  await expect(tid("auth-cookie-state")).toHaveText("cookie:valid");
  await app.saveAuthState(statePath);
});
