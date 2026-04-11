import { flow } from "spana-test";
import { openPlayground } from "./support.js";

/**
 * Proves `doubleTapAtCoordinate` is distinguishable from two separate taps.
 * The playground double-tap target reports "Detected" only when onLongPress
 * is not triggered AND two taps land within the OS's double-tap window.
 */
export default flow(
  "conformance — doubleTap is detected as a double tap",
  {
    tags: ["conformance", "double-tap"],
    platforms: ["android", "ios"],
    autoLaunch: false,
  },
  async (ctx) => {
    const { app, expect } = ctx;
    await openPlayground(ctx);

    await app.doubleTap({ testID: "playground-double-tap" });
    await expect({ testID: "playground-double-tap-status" }).toHaveText("Detected");
  },
);
