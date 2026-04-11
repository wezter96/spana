import { flow } from "spana-test";
import { openPlayground } from "./support.js";

/**
 * Proves `swipe` / `scroll` move the scroll view far enough to reveal an
 * off-screen sentinel. The sentinel is placed at the bottom of the playground
 * ScrollView specifically as a scroll conformance target.
 */
export default flow(
  "conformance — scroll reveals off-screen sentinel",
  {
    tags: ["conformance", "scroll"],
    platforms: ["android", "ios"],
    autoLaunch: false,
  },
  async (ctx) => {
    const { app, expect } = ctx;
    await openPlayground(ctx);

    // Sentinel starts off-screen at the bottom.
    await app.scrollUntilVisible(
      { testID: "playground-sentinel" },
      { timeout: 20_000, maxScrolls: 15 },
    );
    await expect({ testID: "playground-sentinel" }).toBeVisible({ timeout: 10_000 });
    await expect({ testID: "playground-sentinel-text" }).toHaveText("Bottom Reached");
  },
);
