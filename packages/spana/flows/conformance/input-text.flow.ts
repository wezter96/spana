import { flow } from "spana-test";
import { openPlayground } from "./support.js";

/**
 * Proves `inputText` inserts characters into the focused field, and that
 * the dismiss-keyboard path works on both platforms.
 *
 * On iOS, WDA's `hideKeyboard` can't introspect React Native keyboards —
 * the driver conformance contract on iOS specifically uses the app's
 * explicit Dismiss Keyboard button. On Android, `hideKeyboard` works.
 */
export default flow(
  "conformance — inputText + keyboard dismiss",
  {
    tags: ["conformance", "input-text", "keyboard"],
    platforms: ["android", "ios"],
    autoLaunch: false,
  },
  async (ctx) => {
    const { app, expect, platform } = ctx;
    await openPlayground(ctx);

    // Plain ASCII first so we verify basic character insertion.
    await app.tap({ testID: "playground-input" });
    await app.inputText("conformance");
    await expect({ testID: "playground-input-mirror" }).toHaveText("conformance");

    // Dismiss keyboard via the platform-appropriate path.
    if (platform === "ios") {
      await app.tap({ testID: "playground-dismiss-keyboard" });
    } else {
      await app.dismissKeyboard();
    }

    // After dismissal, the sentinel below the keyboard area should be
    // reachable via scroll — proving the keyboard is no longer covering
    // the lower half of the screen.
    await app.scrollUntilVisible(
      { testID: "playground-sentinel" },
      { timeout: 20_000, maxScrolls: 15 },
    );
    await expect({ testID: "playground-sentinel" }).toBeVisible();
  },
);
