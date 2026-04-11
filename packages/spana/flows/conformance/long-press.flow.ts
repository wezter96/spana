import { flow } from "spana-test";
import { openPlayground } from "./support.js";

/**
 * Proves `longPressAtCoordinate` triggers onLongPress (rather than being
 * interpreted as a regular tap). The playground long-press target flips to
 * "Activated" only when the press exceeds the OS long-press threshold.
 */
export default flow(
  "conformance — longPress triggers onLongPress",
  {
    tags: ["conformance", "long-press"],
    platforms: ["android", "ios"],
    autoLaunch: false,
  },
  async (ctx) => {
    const { app, expect } = ctx;
    await openPlayground(ctx);

    await app.longPress({ testID: "playground-long-press" });
    await expect({ testID: "playground-long-press-status" }).toHaveText("Activated");
  },
);
