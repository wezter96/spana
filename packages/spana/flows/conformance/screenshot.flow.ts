import { flow } from "spana-test";
import { openPlayground } from "./support.js";

/**
 * Proves `takeScreenshot` produces a non-empty image. The artifact itself
 * is written to disk by the flow runner — the assertion here is just that
 * takeScreenshot() completes without throwing. If the driver's screenshot
 * implementation is broken, this flow fails at the `takeScreenshot` call.
 */
export default flow(
  "conformance — takeScreenshot produces an artifact",
  {
    tags: ["conformance", "screenshot"],
    platforms: ["android", "ios"],
    autoLaunch: false,
    artifacts: { captureOnSuccess: true },
  },
  async (ctx) => {
    const { app, expect } = ctx;
    await openPlayground(ctx);

    // Visible anchor before the screenshot so we know the screen rendered.
    await expect({ testID: "playground-title" }).toBeVisible();
    await app.takeScreenshot("conformance-playground");
  },
);
