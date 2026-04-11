import { flow } from "spana-test";
import { openPlayground } from "./support.js";

/**
 * Proves `tapAtCoordinate` works: a single tap on a Pressable produces an
 * observable state change. The playground toggle flips details visibility,
 * which gives us a binary state signal to assert on.
 */
export default flow(
  "conformance — tap triggers onPress",
  {
    tags: ["conformance", "tap"],
    platforms: ["android", "ios"],
    autoLaunch: false,
  },
  async (ctx) => {
    const { app, expect } = ctx;
    await openPlayground(ctx);

    // Details should start hidden.
    await expect({ testID: "playground-details-text" }).toBeHidden();

    // Tap toggle → details become visible.
    await app.tap({ testID: "playground-toggle" });
    await app.scrollUntilVisible(
      { testID: "playground-details-text" },
      { timeout: 15_000, maxScrolls: 10 },
    );
    await expect({ testID: "playground-details-text" }).toBeVisible();
  },
);
