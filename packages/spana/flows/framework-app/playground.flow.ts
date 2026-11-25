import { flow } from "spana-test";
import { navigateToPlaygroundScreen } from "./support/navigation.js";

export default flow(
  "Framework app - interaction playground showcase",
  {
    tags: ["showcase", "e2e", "framework-app"],
    platforms: ["web", "android", "ios"],
    autoLaunch: false,
    timeout: 90_000,
    artifacts: { captureOnSuccess: true, captureSteps: true },
  },
  async (ctx) => {
    const { app, expect, platform } = ctx;
    await navigateToPlaygroundScreen(ctx);

    await app.tap({ testID: "playground-input" });
    const inputText = platform === "android" ? "Hello spana" : "Hello 👨‍👩‍👧‍👦 cafe\u0301";
    await app.inputText(inputText);
    await expect({ testID: "playground-input-mirror" }).toHaveText(inputText);
    // iOS WDA's hideKeyboard() can't introspect RN keyboards; prefer the
    // explicit Dismiss Keyboard control the app exposes.
    if (platform === "ios") {
      await app.tap({ testID: "playground-dismiss-keyboard" });
    } else {
      await app.dismissKeyboard();
    }
    await app.takeScreenshot("text-input-unicode");

    await app.doubleTap({ testID: "playground-double-tap" });
    await expect({ testID: "playground-double-tap-status" }).toHaveText("Detected");
    await app.takeScreenshot("double-tap");

    await app.longPress({ testID: "playground-long-press" });
    await expect({ testID: "playground-long-press-status" }).toHaveText("Activated");
    await app.takeScreenshot("long-press");

    await app.tap({ testID: "playground-nested-label" });
    await expect({ testID: "playground-nested-status" }).toHaveText("Activated 1x");
    await app.takeScreenshot("nested-target-resolution");

    await expect({ testID: "playground-details-text" }).toBeHidden();
    await app.tap({ testID: "playground-toggle" });
    await app.scrollUntilVisible(
      { testID: "playground-details-text" },
      { timeout: 20_000, maxScrolls: 10 },
    );
    await expect({ testID: "playground-details-text" }).toBeVisible();
    await app.takeScreenshot("section-expanded");

    await app.scrollUntilVisible(
      { testID: "playground-sentinel" },
      { timeout: 20_000, maxScrolls: 10 },
    );
    await expect({ testID: "playground-sentinel" }).toBeVisible({ timeout: 10_000 });
    // Scroll the inner text into view explicitly — on iOS XCUITest the
    // container element can be visible while the child Text is still clipped
    // off the bottom of the screen, which causes toHaveText() to see "(no text)".
    await app.scrollUntilVisible(
      { testID: "playground-sentinel-text" },
      { timeout: 20_000, maxScrolls: 10 },
    );
    await expect({ testID: "playground-sentinel-text" }).toHaveText("Bottom Reached");
    await app.takeScreenshot("scroll-sentinel");
  },
);
