import { flow } from "../../../packages/spana/src/api/flow.js";

export default flow("Home page", { platforms: ["web"] }, async ({ app, expect }) => {
  await app.openLink("http://localhost:3001/");

  await expect({ testID: "home-screen" }).toBeVisible();
  await expect({ testID: "title-banner" }).toBeVisible();
  await expect({ testID: "api-status-section" }).toBeVisible();
  await expect({ testID: "api-status-heading" }).toBeVisible();

  await app.evaluate(() => {
    console.info("spana web flow ready");
  });

  const consoleLogs = await app.getConsoleLogs();
  if (!consoleLogs.some((entry) => entry.text.includes("spana web flow ready"))) {
    throw new Error("Expected the web flow readiness log to be captured.");
  }

  const jsErrors = await app.getJSErrors();
  if (jsErrors.length > 0) {
    throw new Error(`Unexpected JavaScript errors: ${jsErrors.map((entry) => entry.message).join(", ")}`);
  }
});
