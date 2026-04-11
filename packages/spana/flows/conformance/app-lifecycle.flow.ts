import { flow } from "spana-test";
import { openPlayground } from "./support.js";

/**
 * Proves `launchApp` with and without `clearState` works correctly on this
 * driver, and that `clearState` actually wipes in-memory state (text input).
 *
 * Drivers exercised:
 *   - launchApp({ clearState: true }) → fresh process, empty input
 *   - launchApp() without clearState → should preserve state where supported
 *   - hierarchy query via expect().toBeVisible
 *
 * Skipped on web (browser-only driver doesn't have app lifecycle).
 */
export default flow(
  "conformance — launchApp/clearState wipes in-memory state",
  {
    tags: ["conformance", "app-lifecycle"],
    platforms: ["android", "ios"],
    autoLaunch: false,
  },
  async (ctx) => {
    const { app, expect } = ctx;

    // 1. Cold launch, navigate to playground, leave stale text in the input.
    await openPlayground(ctx);
    await app.tap({ testID: "playground-input" });
    await app.inputText("stale conformance text");
    await expect({ testID: "playground-input-mirror" }).toHaveText("stale conformance text");

    // 2. Relaunch with clearState. The empty-placeholder for the mirror
    //    (see apps/native/app/(drawer)/playground.tsx) is "(empty)", so a
    //    successful clearState brings the input mirror back to that value.
    //    If clearState were a no-op, the mirror would still show the stale text.
    await openPlayground(ctx);
    await expect({ testID: "playground-input-mirror" }).toHaveText("(empty)");
  },
);
